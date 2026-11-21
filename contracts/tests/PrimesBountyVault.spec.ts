// TON PRIMES — bounty vault (CONCEPT.md §3.3/§7, bounty_vault.tlb,
// engineering-spec.md §4.8 / §5 row 6 / §6). v1 scope: era bounties live,
// program bounties spec'd-but-inert (empty genesis allow-list).
import { Blockchain, SandboxContract, TreasuryContract } from '@ton/sandbox';
import { Address, Cell, Dictionary, beginCell, toNano } from '@ton/core';
import '@ton/test-utils';
import { compile } from '@ton/blueprint';
import { PrimesBountyVault } from '../wrappers/PrimesBountyVault';
import { PrimesJettonMaster } from '../wrappers/PrimesJettonMaster';
import { PrimesJettonWallet } from '../wrappers/PrimesJettonWallet';
import { BOUNTY_VAULT, TEP74 } from '../../shared/opcodes';

// params.json genesis.era_bounty_schedule.
/** What the genesis mint funds this vault with in these tests. */
const VAULT_PRIMES = 1_327_374_997_252_625n;

/**
 * The ledger's (T, S) these tests price against, and the floor it implies.
 *
 * DENOMINATION_PLAN P4: the schedule is TON-denominated and the vault pays
 * `bountyTon * S / T`, so every expected amount below is a function of this pair
 * rather than a constant. `S/T = 20,000` is the genesis floor at `L = 10,000`,
 * which makes `maxPrimes` exactly reachable — the cap binds at the opening floor
 * and only ever slackens, which is the property the ratchet guarantees.
 */
const T_AT_GENESIS = toNano('200');            // T₀, the founder seed
const S_AT_GENESIS = 4_000_000n * 1_000_000_000n; // S₀ = T₀·L + V, at L = 10,000 (D-42)
const payout = (bountyTon: bigint, cap: bigint, t = T_AT_GENESIS, s = S_AT_GENESIS) => {
    const raw = (bountyTon * s) / t;
    return raw > cap ? cap : raw;
};

/**
 * V26.1 / D-188 point 3 — how many rows `retryJournal` holds, read off the
 * vault's own storage (no get-method counts them). Layout per
 * `PrimesBountyVault.ts`'s `bountyVaultConfigToCell`.
 */
async function journalRows(blockchain: Blockchain, addr: Address): Promise<number> {
    const st = (await blockchain.getContract(addr)).accountState;
    if (st?.type !== 'active') throw new Error('vault not active');
    const ds = st.state.data!.beginParse();
    ds.loadMaybeRef(); ds.loadMaybeRef(); ds.loadMaybeRef(); // schedule, paidEras, allowlist
    ds.loadCoins(); // fundedPrimes (V26.7)
    ds.loadCoins(); ds.loadUint(32); ds.loadUint(64); ds.loadUint(32);
    const cfg = ds.loadRef().beginParse();
    cfg.loadAddress(); cfg.loadAddress();
    const b = cfg.loadRef().beginParse();
    b.loadAddress(); b.loadUint(8); b.loadAddress(); b.loadRef(); // special (D-202 removed the discovery ref)
    return b.loadDict(Dictionary.Keys.BigUint(64), { serialize: () => {}, parse: () => 0 }).size;
}

/** PRIMES per TON at the genesis floor — `S₀ / T₀`. */
const GENESIS_PRIMES_PER_TON = S_AT_GENESIS / T_AT_GENESIS;

/**
 * `maxPrimes` is DERIVED from `bountyTon`, not chosen: it is what the ceremony
 * buys at the genesis floor, which is the largest it can ever buy because the
 * ratchet only lifts `p_f`. Writing it as an independent literal would let the
 * two drift, and a cap below the opening payout would silently truncate every
 * era from the first one.
 */
const era = (eraBoundary: bigint, bountyTon: bigint) => ({
    eraBoundary,
    bountyTon,
    maxPrimes: bountyTon * GENESIS_PRIMES_PER_TON,
});

const SCHEDULE = [era(6n, 6_636_874_986n), era(30n, 5_309_499_989n), era(210n, 4_313_968_741n)];

describe('TON PRIMES — bounty vault', () => {
    let blockchain: Blockchain;
    let deployer: SandboxContract<TreasuryContract>;
    let genesisScript: SandboxContract<TreasuryContract>;
    let bankStandIn: SandboxContract<TreasuryContract>;
    let winner: SandboxContract<TreasuryContract>;
    let attacker: SandboxContract<TreasuryContract>;

    let walletCode: Cell;
    let masterCode: Cell;
    let vaultCode: Cell;

    let master: SandboxContract<PrimesJettonMaster>;
    let vault: SandboxContract<PrimesBountyVault>;

    beforeAll(async () => {
        walletCode = await compile('PrimesJettonWallet');
        masterCode = await compile('PrimesJettonMaster');
        vaultCode = await compile('PrimesBountyVault');
    });

    beforeEach(async () => {
        blockchain = await Blockchain.create();
        blockchain.now = 1_770_000_000;
        deployer = await blockchain.treasury('deployer');
        genesisScript = await blockchain.treasury('genesisScript');
        bankStandIn = await blockchain.treasury('ledger');
        winner = await blockchain.treasury('winner');
        attacker = await blockchain.treasury('attacker');

        master = blockchain.openContract(
            PrimesJettonMaster.createFromConfig(
                { ledgerAddr: deployer.address, genesisScriptAddr: genesisScript.address, walletCode },
                masterCode
            )
        );
        await master.sendDeploy(deployer.getSender(), toNano('5'));

        vault = blockchain.openContract(
            PrimesBountyVault.createFromConfig(
                {
                    schedule: SCHEDULE,
                    ledgerAddr: bankStandIn.address,
                    jettonMasterAddr: master.address,
                    genesisScriptAddr: genesisScript.address,
                    fundedPrimes: VAULT_PRIMES, // V26.7 — the genesis mint below
                    // v1: EMPTY. "allow-listed at genesis, inert until deployed".
                    allowlist: [],
                },
                vaultCode
            )
        );
        await vault.sendDeploy(deployer.getSender(), toNano('2'));

        // Genesis: pre-fund the vault with real PRIMES (D20) and wire its wallet.
        await master.sendMintGenesis(genesisScript.getSender(), {
            to: vault.address,
            amount: 1_327_374_997_252_625n, // params.json genesis.bounty_vault_size_primes
            value: toNano('0.2'),
        });
        const vaultWalletAddr = await master.getWalletAddress(vault.address);
        await vault.sendSetWallet(genesisScript.getSender(), {
            jettonWalletAddr: vaultWalletAddr,
            value: toNano('0.05'),
        });
    });

    it('is pre-funded with PRIMES at genesis and knows its own wallet (D20/D21)', async () => {
        const cfg = await vault.getVaultConfig();
        expect(cfg.walletSet).toBe(1);
        const wallet = blockchain.openContract(PrimesJettonWallet.createFromAddress(cfg.jettonWalletAddr));
        const data = await wallet.getWalletData();
        expect(data.balance).toBe(1_327_374_997_252_625n);
        expect(data.owner.toString()).toBe(vault.address.toString());

        // one-shot
        const again = await vault.sendSetWallet(genesisScript.getSender(), {
            jettonWalletAddr: cfg.jettonWalletAddr,
            value: toNano('0.05'),
        });
        expect(again.transactions).toHaveTransaction({ to: vault.address, success: false, exitCode: 104 });
    });

    it('pays a scheduled era bounty to the beneficiary, exactly once', async () => {
        const before = await vault.getEraSchedule(6n);
        expect(before.scheduled).toBe(1);
        expect(before.paid).toBe(0);

        const result = await vault.sendPayEraBounty(bankStandIn.getSender(), {
            eraBoundary: 6n,
            beneficiary: winner.address,
            t: T_AT_GENESIS,
            s: S_AT_GENESIS,
            value: toNano('0.1'),
        });
        const cfg = await vault.getVaultConfig();
        expect(result.transactions).toHaveTransaction({ from: vault.address, to: cfg.jettonWalletAddr, success: true });

        const winnerWalletAddr = await master.getWalletAddress(winner.address);
        const winnerWallet = blockchain.openContract(PrimesJettonWallet.createFromAddress(winnerWalletAddr));
        expect((await winnerWallet.getWalletData()).balance).toBe(payout(SCHEDULE[0].bountyTon, SCHEDULE[0].maxPrimes));

        const after = await vault.getEraSchedule(6n);
        expect(after.paid).toBe(1);

        // STORAGE CEILING: a payout that LANDED leaves no journal row behind.
        // One row per rebate, never deleted, filled the account at n ≈ 18k.
        expect((await vault.getDeferredPayouts()).journalKey).toBe(0);
        expect(await vault.getRetryEntry(0n)).toMatchObject({ found: false });

        // idempotent: a replay (e.g. a retried send after a false-negative
        // bounce) cheap-fails without paying twice
        const replay = await vault.sendPayEraBounty(bankStandIn.getSender(), {
            eraBoundary: 6n,
            beneficiary: winner.address,
            t: T_AT_GENESIS,
            s: S_AT_GENESIS,
            value: toNano('0.1'),
        });
        expect(replay.transactions).toHaveTransaction({ to: vault.address, success: true });
        expect(replay.transactions).not.toHaveTransaction({ from: vault.address, to: cfg.jettonWalletAddr });
        expect((await winnerWallet.getWalletData()).balance).toBe(payout(SCHEDULE[0].bountyTon, SCHEDULE[0].maxPrimes));
    });

    // H11 (GAUNTLET, found on testnet 2026-09-14). The vault has exactly one TON
    // income — the 0.015 TON leg the ledger forwards with the payout — and it
    // spends `TRANSFER_GAS` (0.1 TON) of its OWN balance on the jetton hop. It
    // stays solvent only because TEP-74's excess comes home, which it does only
    // while `responseAddr` names the vault and not the beneficiary. Point it at
    // the beneficiary again and the vault bleeds ~0.085 TON per payout until its
    // ACTION phase fails (result 37) and the boundary is forfeit in silence —
    // three real payouts were lost that way before this was caught. So the check
    // is the sign of the balance delta, at the real 0.015 TON the ledger sends.
    it('H11: a payout leaves the vault SOLVENT — the jetton hop’s excess comes back', async () => {
        const balanceOf = async () => (await blockchain.getContract(vault.address)).balance;

        const before = await balanceOf();
        await vault.sendPayEraBounty(bankStandIn.getSender(), {
            eraBoundary: 6n,
            beneficiary: winner.address,       // fresh wallet: the deploy case, the dearest one
            t: T_AT_GENESIS,
            s: S_AT_GENESIS,
            value: toNano('0.015'),            // primes_ledger.tolk's own era-bounty leg
        });
        const after = await balanceOf();
        expect(after).toBeGreaterThan(before);

        // and again to a wallet that already exists, the cheap case
        const mid = await balanceOf();
        await vault.sendPayEraBounty(bankStandIn.getSender(), {
            eraBoundary: 30n,
            beneficiary: winner.address,
            t: T_AT_GENESIS,
            s: S_AT_GENESIS,
            value: toNano('0.015'),
        });
        expect(await balanceOf()).toBeGreaterThan(mid);
    });

    // The OTHER half of H11, and the half that was still broken after it.
    //
    // H11 above established that `responseAddr` must name the VAULT so the
    // jetton hop's change comes home. It does come home — the wallet sends
    // `excesses#d53276db` NoBounce, so the credit phase lands the TON here
    // whatever happens next — but until 2026-09-17 the vault had no arm for that
    // opcode, so the message fell into `else => assert (in.body.isEmpty())` and
    // ABORTED with exit 101 on every single payout.
    //
    // Nothing was lost, which is why H11's own balance assertions above pass
    // either way and why this went unnoticed for three days. What it cost is the
    // trace: measured on testnet 2026-09-17, trace `8c354845…d724a`, a 1 TON mint
    // with every economic leg at exit 0 reads FAILED in Tonviewer, because a
    // trace is red if any transaction in it aborted. The bounty-readiness gate
    // says the audience checks with Tonviewer.
    //
    // So this asserts on the SHAPE OF THE TRACE, which is the thing H11 could
    // not see.
    it('H11b: a payout aborts NOTHING — the wallet’s excesses reply is answered, not thrown at', async () => {
        const r = await vault.sendPayEraBounty(bankStandIn.getSender(), {
            eraBoundary: 6n,
            beneficiary: winner.address,      // fresh wallet: the deploy case, the longest trace
            t: T_AT_GENESIS,
            s: S_AT_GENESIS,
            value: toNano('0.015'),           // primes_ledger.tolk's own era-bounty leg
        });

        // THE REGRESSION, in one assertion. Before the fix: success false,
        // exitCode 101, aborted true — on the leaf, with the payout above it
        // fully successful.
        expect(r.transactions).toHaveTransaction({
            to: vault.address,
            op: TEP74.excesses,
            success: true,
            aborted: false,
        });
        expect(r.transactions).not.toHaveTransaction({ aborted: true });
        expect(r.transactions).not.toHaveTransaction({ exitCode: 101 });

        // The era still paid: accepting the change is not a behaviour change.
        expect((await vault.getEraSchedule(6n)).paid).toBe(1);
    });

    it('accepts a bare excesses from anyone, and still refuses an unknown opcode with 101', async () => {
        // No sender gate, deliberately: nothing moves and the value is credited
        // before the arm runs, so the worst an impostor achieves is funding the
        // vault's gas. Pinned so that adding a gate later is a deliberate change.
        const ok = await attacker.send({
            to: vault.address,
            value: toNano('0.05'),
            bounce: true,
            body: beginCell().storeUint(TEP74.excesses, 32).storeUint(9n, 64).endCell(),
        });
        expect(ok.transactions).toHaveTransaction({
            from: attacker.address, to: vault.address, success: true, aborted: false,
        });
        expect(ok.transactions).not.toHaveTransaction({ inMessageBounced: true });

        // The guard this widened is still a guard.
        const bad = await attacker.send({
            to: vault.address,
            value: toNano('0.05'),
            bounce: true,
            body: beginCell().storeUint(0xdeadbeef, 32).storeUint(0n, 64).endCell(),
        });
        expect(bad.transactions).toHaveTransaction({
            from: attacker.address, to: vault.address, success: false, exitCode: 101,
        });
    });

    // H12 / DECISIONS.md D-129, the sibling of H11 above. H11 stopped the vault
    // DRAINING; this is what happens when it is short anyway. `payOut` spends
    // `TRANSFER_GAS` of the vault's OWN balance, and below that the compute
    // phase still succeeds while the ACTION phase fails with result 37 and
    // reverts the whole transaction. The mint that triggered it survives (the
    // ledger's leg is `BounceMode.NoBounce`, deliberately), so nothing reports
    // anything; `RetryBountyPayout` cannot help because the journal row was
    // written inside the reverted transaction; `onBouncedMessage` cannot either
    // because an action-phase failure is not a bounce. Each trigger is one-shot,
    // so the payout was PERMANENTLY FORFEIT — three real payouts were lost that
    // way on testnet 2026-09-14. The answer signed in D-129 is to journal
    // without sending, so the forfeit becomes a deferral anyone can finish.
    it('H12: a payout the vault cannot afford is JOURNALLED, not forfeited, and a later retry pays it', async () => {
        const vaultAcct = await blockchain.getContract(vault.address);
        // Below `TRANSFER_GAS + STORAGE_FLOOR` (0.1 + 0.05 TON) even after the
        // ledger's own 0.015 TON leg is credited. This is the state H11 found on
        // chain, reached here by fiat rather than by 24 bleeding payouts.
        vaultAcct.balance = toNano('0.05');

        const cfg = await vault.getVaultConfig();
        const short = await vault.sendPayEraBounty(bankStandIn.getSender(), {
            eraBoundary: 6n,
            beneficiary: winner.address,
            t: T_AT_GENESIS,
            s: S_AT_GENESIS,
            value: toNano('0.015'),           // primes_ledger.tolk's own era-bounty leg
        });

        // The transaction SUCCEEDS and sends nothing — the old behaviour was the
        // exact opposite (a reverted transaction that had sent a doomed message).
        expect(short.transactions).toHaveTransaction({ to: vault.address, success: true });
        expect(short.transactions).not.toHaveTransaction({ from: vault.address, to: cfg.jettonWalletAddr });

        // Nothing is claimed that did not happen: the boundary is unpaid, the
        // §3.3 supply figures have not moved, and the debt is VISIBLE (§9.1).
        expect((await vault.getEraSchedule(6n)).paid).toBe(0);
        expect((await vault.getVaultPayouts()).paidTotalPrimes).toBe(0n);
        expect((await vault.getVaultPayouts()).payoutCount).toBe(0);
        const deferred = await vault.getDeferredPayouts();
        expect(deferred.deferredCount).toBe(1);
        expect(deferred.journalKey).toBe(1);   // one key issued, so the scan is 0..0
        // G59: the ROW a scan gates on says the same thing the retry arm would —
        // key 0 retryable, key 1 never written — so a driver decides before it sends.
        expect(await vault.getRetryEntry(0n)).toMatchObject({ found: true, retryable: true, kind: 0, entryKey: 6n });
        expect(await vault.getRetryEntry(1n)).toMatchObject({ found: false, retryable: false });

        // Funded again, anyone may finish it — the retry path is unmodified, which
        // is the whole reason the deferred arm leaves the flag clear.
        vaultAcct.balance = toNano('2');
        // The caller funds the hop (RETRY_PAYOUT_VALUE): short of it is refused
        // with the row still standing, so a bounce loop cannot bleed the vault.
        const shortRetry = await vault.sendRetryBountyPayout(attacker.getSender(), { queryID: 0, value: toNano('0.1') });
        expect(shortRetry.transactions).toHaveTransaction({ to: vault.address, success: false, exitCode: 103 });
        expect(await vault.getRetryEntry(0n)).toMatchObject({ found: true, retryable: true });
        const before = (await blockchain.getContract(vault.address)).balance;
        const retry = await vault.sendRetryBountyPayout(attacker.getSender(), { queryID: 0, value: toNano('0.15') });
        expect(retry.transactions).not.toHaveTransaction({ aborted: true });
        expect(retry.transactions).toHaveTransaction({ from: vault.address, to: cfg.jettonWalletAddr, success: true });
        expect((await blockchain.getContract(vault.address)).balance).toBeGreaterThanOrEqual(before);

        const winnerWallet = blockchain.openContract(
            PrimesJettonWallet.createFromAddress(await master.getWalletAddress(winner.address))
        );
        expect((await winnerWallet.getWalletData()).balance).toBe(payout(SCHEDULE[0].bountyTon, SCHEDULE[0].maxPrimes));
        expect((await vault.getEraSchedule(6n)).paid).toBe(1);
        expect((await vault.getVaultPayouts()).payoutCount).toBe(1);
        expect((await vault.getDeferredPayouts()).deferredCount).toBe(0);

        // And it cannot be paid twice — the retry consumed the row (702), so the
        // journal holds nothing once a payout has landed (the storage ceiling).
        expect(await vault.getRetryEntry(0n)).toMatchObject({ found: false, retryable: false });
        const again = await vault.sendRetryBountyPayout(attacker.getSender(), { queryID: 0, value: toNano('0.15') });
        expect(again.transactions).toHaveTransaction({ to: vault.address, success: false, exitCode: 702 });
    });

    it('§3.3/§11.21: counts what it has paid out, so the dashboard can show it next to burns', async () => {
        // The payout half of the two-number circulating-supply report. Before this counter
        // existed, "how much has the vault paid" could only be inferred by summing the era
        // schedule and assuming every scheduled bounty landed — an assertion, not a read.
        const cold = await vault.getVaultPayouts();
        expect(cold.paidTotalPrimes).toBe(0n);
        expect(cold.payoutCount).toBe(0);

        await vault.sendPayEraBounty(bankStandIn.getSender(), {
            eraBoundary: 6n,
            beneficiary: winner.address,
            t: T_AT_GENESIS,
            s: S_AT_GENESIS,
            value: toNano('0.1'),
        });
        const paid = await vault.getVaultPayouts();
        expect(paid.paidTotalPrimes).toBe(payout(SCHEDULE[0].bountyTon, SCHEDULE[0].maxPrimes));
        expect(paid.payoutCount).toBe(1);

        // Idempotent with `paidEras`: a replay pays nothing and counts nothing, so the two
        // can never disagree about whether an era was settled.
        await vault.sendPayEraBounty(bankStandIn.getSender(), {
            eraBoundary: 6n,
            beneficiary: winner.address,
            t: T_AT_GENESIS,
            s: S_AT_GENESIS,
            value: toNano('0.1'),
        });
        expect((await vault.getVaultPayouts()).payoutCount).toBe(1);

        // The reader's cross-check, and the reason `remaining` is NOT stored here: the
        // vault's own jetton wallet holds it, so `size − paid ≈ balance` costs one call and
        // trusts none of this contract's arithmetic (§3.3).
        const cfg = await vault.getVaultConfig();
        const vaultWallet = blockchain.openContract(PrimesJettonWallet.createFromAddress(cfg.jettonWalletAddr));
        expect((await vaultWallet.getWalletData()).balance).toBe(VAULT_PRIMES - paid.paidTotalPrimes);
    });

    it('does not count a payout that was rejected', async () => {
        await vault.sendPayEraBounty(attacker.getSender(), {
            eraBoundary: 6n,
            beneficiary: attacker.address,
            t: T_AT_GENESIS,
            s: S_AT_GENESIS,
            value: toNano('0.1'),
        });
        await vault.sendPayEraBounty(bankStandIn.getSender(), {
            eraBoundary: 2310n, // not in this deploy's schedule
            beneficiary: winner.address,
            t: T_AT_GENESIS,
            s: S_AT_GENESIS,
            value: toNano('0.1'),
        });
        const stats = await vault.getVaultPayouts();
        expect(stats.paidTotalPrimes).toBe(0n);
        expect(stats.payoutCount).toBe(0);
    });

    // GAUNTLET V5. The queryID on a `Mint` is the PLAYER's own choice, carried
    // verbatim through `executeMint` into `PayEraBounty`/`PaySpecialNumberRebate`
    // — and every send in `webapp/src/chain/messages.ts` defaults it to 0 when
    // the caller doesn't override it, so two real mints crossing two DIFFERENT
    // era boundaries with the webapp's own default queryID is not a contrived
    // attack, it is the ordinary case. Before this fix the second call's
    // `retryJournal.set` would have silently overwritten the first's row.
    it('two era bounties with a DELIBERATELY colliding queryID both land on their own beneficiaries', async () => {
        const COLLIDING_QUERY_ID = 0; // the webapp's own default — see the note above
        const before = await vault.getVaultPayouts();
        expect(before.payoutCount).toBe(0);

        const first = await vault.sendPayEraBounty(bankStandIn.getSender(), {
            eraBoundary: 6n,
            beneficiary: winner.address,
            t: T_AT_GENESIS,
            s: S_AT_GENESIS,
            value: toNano('0.1'),
            queryID: COLLIDING_QUERY_ID,
        });
        const cfg = await vault.getVaultConfig();
        expect(first.transactions).toHaveTransaction({ from: vault.address, to: cfg.jettonWalletAddr, success: true });

        const second = await vault.sendPayEraBounty(bankStandIn.getSender(), {
            eraBoundary: 30n,
            beneficiary: attacker.address, // a DIFFERENT beneficiary, on purpose
            t: T_AT_GENESIS,
            s: S_AT_GENESIS,
            value: toNano('0.1'),
            queryID: COLLIDING_QUERY_ID, // the SAME queryID as the first send
        });
        expect(second.transactions).toHaveTransaction({ from: vault.address, to: cfg.jettonWalletAddr, success: true });

        // Both eras are marked paid — neither write clobbered the other's flag.
        expect((await vault.getEraSchedule(6n)).paid).toBe(1);
        expect((await vault.getEraSchedule(30n)).paid).toBe(1);

        // Both beneficiaries were paid their OWN amount, not each other's or
        // nothing — the failure mode a collision produces is a payout landing
        // on the wrong wallet or vanishing, not merely a wrong total.
        const winnerWallet = blockchain.openContract(
            PrimesJettonWallet.createFromAddress(await master.getWalletAddress(winner.address))
        );
        const attackerWallet = blockchain.openContract(
            PrimesJettonWallet.createFromAddress(await master.getWalletAddress(attacker.address))
        );
        expect((await winnerWallet.getWalletData()).balance).toBe(payout(SCHEDULE[0].bountyTon, SCHEDULE[0].maxPrimes));
        expect((await attackerWallet.getWalletData()).balance).toBe(payout(SCHEDULE[1].bountyTon, SCHEDULE[1].maxPrimes));

        // Two real payouts, counted twice — not one overwriting the other.
        const after = await vault.getVaultPayouts();
        expect(after.payoutCount).toBe(2);
        expect(after.paidTotalPrimes).toBe(
            payout(SCHEDULE[0].bountyTon, SCHEDULE[0].maxPrimes) + payout(SCHEDULE[1].bountyTon, SCHEDULE[1].maxPrimes)
        );
    });

    it('rejects an era bounty from anyone but the ledger', async () => {
        const result = await vault.sendPayEraBounty(attacker.getSender(), {
            eraBoundary: 6n,
            beneficiary: attacker.address,
            t: T_AT_GENESIS,
            s: S_AT_GENESIS,
            value: toNano('0.1'),
        });
        expect(result.transactions).toHaveTransaction({ to: vault.address, success: false, exitCode: 100 });
        expect((await vault.getEraSchedule(6n)).paid).toBe(0);
    });

    it('ignores an unscheduled era boundary without unwinding the caller', async () => {
        const result = await vault.sendPayEraBounty(bankStandIn.getSender(), {
            eraBoundary: 2310n, // not in this deploy's schedule
            beneficiary: winner.address,
            t: T_AT_GENESIS,
            s: S_AT_GENESIS,
            value: toNano('0.1'),
        });
        // cheap-fail, not a throw: engineering-spec §5 row 6 (a bounty must never
        // unwind an already-valid mint)
        expect(result.transactions).toHaveTransaction({ to: vault.address, success: true });
        expect((await vault.getEraSchedule(2310n)).scheduled).toBe(0);
    });

    // ---- DENOMINATION_PLAN P4: the schedule is TON-denominated ----

    it('pays the PRIMES that the era’s TON buys AT THE FLOOR, so a risen floor pays fewer', async () => {
        // The whole reason the schedule stopped being nominal. `p_f` rises ~45x
        // over year one at baseline demand, so a fixed 79,642-PRIMES bounty would
        // be worth 45x its designed value by the time era 30 lands — out of a
        // vault sized once, at genesis, for eight ceremonies.
        //
        // Here the floor has quadrupled (S/T is a quarter of genesis), so the same
        // 6.64 TON ceremony pays a quarter of the PRIMES.
        const t = T_AT_GENESIS * 4n;
        await vault.sendPayEraBounty(bankStandIn.getSender(), {
            eraBoundary: 6n,
            beneficiary: winner.address,
            t,
            s: S_AT_GENESIS,
            value: toNano('0.1'),
        });
        const winnerWalletAddr = await master.getWalletAddress(winner.address);
        const winnerWallet = blockchain.openContract(PrimesJettonWallet.createFromAddress(winnerWalletAddr));
        const paid = (await winnerWallet.getWalletData()).balance;

        expect(paid).toBe(payout(SCHEDULE[0].bountyTon, SCHEDULE[0].maxPrimes, t));
        expect(paid).toBe(payout(SCHEDULE[0].bountyTon, SCHEDULE[0].maxPrimes) / 4n);
        expect(paid).toBeLessThan(SCHEDULE[0].maxPrimes);
    });

    it('CANNOT be drained by a lying (T, S): the genesis-fixed cap bounds every payout', async () => {
        // The ledger is the vault's only authorized sender, but "only authorized"
        // is not "trusted". A snapshot claiming an absurdly low floor would ask for
        // an absurdly large payout; `maxPrimes` is address-determining deploy data,
        // so the worst a wrong snapshot can do is pay the nominal amount.
        await vault.sendPayEraBounty(bankStandIn.getSender(), {
            eraBoundary: 6n,
            beneficiary: winner.address,
            t: 1n, // p_f ≈ 0: "one PRIMES costs nothing, give me the vault"
            s: S_AT_GENESIS,
            value: toNano('0.1'),
        });
        const winnerWalletAddr = await master.getWalletAddress(winner.address);
        const winnerWallet = blockchain.openContract(PrimesJettonWallet.createFromAddress(winnerWalletAddr));
        expect((await winnerWallet.getWalletData()).balance).toBe(SCHEDULE[0].maxPrimes);

        // And the era is still one-shot, so the cap cannot be reached twice.
        expect((await vault.getEraSchedule(6n)).paid).toBe(1);
    });

    it('does not burn an era on a payout that rounds to zero', async () => {
        // A far-future floor so high that the ceremony buys less than one
        // nano-PRIMES. Marking the era paid for nothing would consume a ceremony
        // the schedule funded; leaving it re-armable is the same cheap-fail
        // discipline as an unscheduled boundary.
        const result = await vault.sendPayEraBounty(bankStandIn.getSender(), {
            eraBoundary: 6n,
            beneficiary: winner.address,
            t: S_AT_GENESIS * 1_000_000_000n,
            s: 1n,
            value: toNano('0.1'),
        });
        expect(result.transactions).toHaveTransaction({ to: vault.address, success: true });
        expect((await vault.getEraSchedule(6n)).paid).toBe(0);
        expect((await vault.getVaultPayouts()).payoutCount).toBe(0);
    });

    it('exposes both halves of the schedule, so a reader can recompute the payout (§9.1)', async () => {
        const entry = await vault.getEraSchedule(6n);
        expect(entry.scheduled).toBe(1);
        expect(entry.bountyTon).toBe(SCHEDULE[0].bountyTon);
        expect(entry.maxPrimes).toBe(SCHEDULE[0].maxPrimes);
        // The dashboard's figure is this, and nothing the operator types.
        expect((entry.bountyTon * S_AT_GENESIS) / T_AT_GENESIS).toBe(
            payout(SCHEDULE[0].bountyTon, SCHEDULE[0].maxPrimes)
        );
    });

    it('program bounties are inert in v1: every sender fails the empty allow-list', async () => {
        expect(await vault.isAllowlisted(0n)).toBe(0);
        const result = await vault.sendPayProgramBounty(attacker.getSender(), {
            programTag: 1,
            beneficiary: attacker.address,
            amount: 1000n,
            value: toNano('0.1'),
        });
        expect(result.transactions).toHaveTransaction({ to: vault.address, success: false, exitCode: 700 });
    });

    it('has no withdraw path: an unrecognized opcode from any sender is rejected', async () => {
        const { beginCell } = await import('@ton/core');
        const result = await attacker.send({
            to: vault.address,
            value: toNano('0.1'),
            body: beginCell().storeUint(0xdeadbeef, 32).storeUint(0, 64).endCell(),
        });
        expect(result.transactions).toHaveTransaction({ to: vault.address, success: false, exitCode: 101 });
    });
});

describe('TON PRIMES — bounty vault D-53/B12.1: a genuinely-bounced payout is recoverable, not stranded', () => {
    // A separate deploy, underfunded on purpose: the schedule promises more
    // PRIMES than the vault's own wallet actually holds, so the JettonTransfer
    // hits `primes_jetton_wallet.tolk`'s real `storage.balance >= msg.amount`
    // check (exitCode 103) and bounces for real — not a forged RichBounceBody.
    let blockchain: Blockchain;
    let deployer: SandboxContract<TreasuryContract>;
    let genesisScript: SandboxContract<TreasuryContract>;
    let bankStandIn: SandboxContract<TreasuryContract>;
    let winner: SandboxContract<TreasuryContract>;

    let walletCode: Cell;
    let masterCode: Cell;
    let vaultCode: Cell;

    let master: SandboxContract<PrimesJettonMaster>;
    let vault: SandboxContract<PrimesBountyVault>;

    let accruer: SandboxContract<TreasuryContract>;
    // V26.1: a second track under another tag, so a bounced program payout
    // must find ITS track by the tag in the queryId, not merely "the" entry.
    let otherProgram: SandboxContract<TreasuryContract>;
    const UNDERFUNDED_BALANCE = 1_000_000n; // far below the era's maxPrimes
    const BIG_ERA = { eraBoundary: 999n, bountyTon: toNano('100'), maxPrimes: 100_000_000_000_000n };

    beforeAll(async () => {
        walletCode = await compile('PrimesJettonWallet');
        masterCode = await compile('PrimesJettonMaster');
        vaultCode = await compile('PrimesBountyVault');
    });

    beforeEach(async () => {
        blockchain = await Blockchain.create();
        blockchain.now = 1_770_000_000;
        deployer = await blockchain.treasury('deployer');
        genesisScript = await blockchain.treasury('genesisScript');
        bankStandIn = await blockchain.treasury('ledger');
        winner = await blockchain.treasury('winner');
        accruer = await blockchain.treasury('accruer');
        otherProgram = await blockchain.treasury('otherProgram');

        master = blockchain.openContract(
            PrimesJettonMaster.createFromConfig(
                { ledgerAddr: deployer.address, genesisScriptAddr: genesisScript.address, walletCode },
                masterCode
            )
        );
        await master.sendDeploy(deployer.getSender(), toNano('5'));

        vault = blockchain.openContract(
            PrimesBountyVault.createFromConfig(
                {
                    schedule: [BIG_ERA],
                    ledgerAddr: bankStandIn.address,
                    jettonMasterAddr: master.address,
                    genesisScriptAddr: genesisScript.address,
                    // V26.7: DECLARED to cover the era, while the wallet below is
                    // minted far less — a transient shortfall the declaration cannot
                    // see, so the payout is sent, bounces, and journals.
                    fundedPrimes: BIG_ERA.maxPrimes,
                    // A stand-in program contract under a test tag, for the program-bounty tests.
                    allowlist: [
                        {
                            addressHash: BigInt('0x' + accruer.address.hash.toString('hex')),
                            programTag: 0x434f4e53,
                            remaining: 1_000_000_000n,
                        },
                        {
                            addressHash: BigInt('0x' + otherProgram.address.hash.toString('hex')),
                            programTag: 0x51535453, // "QSTS"
                            remaining: 1n,
                        },
                    ],
                },
                vaultCode
            )
        );
        await vault.sendDeploy(deployer.getSender(), toNano('2'));

        await master.sendMintGenesis(genesisScript.getSender(), {
            to: vault.address,
            amount: UNDERFUNDED_BALANCE,
            value: toNano('0.2'),
        });
        const vaultWalletAddr = await master.getWalletAddress(vault.address);
        await vault.sendSetWallet(genesisScript.getSender(), {
            jettonWalletAddr: vaultWalletAddr,
            value: toNano('0.05'),
        });
    });

    it('clears the flag on a real bounce, then a permissionless retry pays it', async () => {
        // GAUNTLET V5: the journal row's key is no longer the CALLER's own
        // queryID — see JOURNAL_HALF's own comment in primes_bounty_vault.tolk.
        // H12/D-129: nor is it `payoutCount` any more. That field became the
        // public §3.3 figure only; the key comes from `journalKey`, which a
        // bounce's repair path never rolls back (only `paidTotal`/`payoutCount`
        // itself, and the `paidEras` flag, are). Captured explicitly rather
        // than hardcoded so this stays correct if an earlier `it` block ever
        // adds a send before this one.
        const jkey = (await vault.getDeferredPayouts()).journalKey;
        const result = await vault.sendPayEraBounty(bankStandIn.getSender(), {
            eraBoundary: BIG_ERA.eraBoundary,
            beneficiary: winner.address,
            t: T_AT_GENESIS,
            s: S_AT_GENESIS,
            value: toNano('0.1'),
        });
        const cfg = await vault.getVaultConfig();
        // The wallet genuinely rejects (insufficient balance) and bounces back to the vault.
        expect(result.transactions).toHaveTransaction({
            from: cfg.jettonWalletAddr,
            to: vault.address,
            success: true,
        });

        // paidTotal/payoutCount were incremented at send, then rolled back by the bounce.
        expect((await vault.getVaultPayouts()).paidTotalPrimes).toBe(0n);
        expect((await vault.getVaultPayouts()).payoutCount).toBe(0);

        // The flag is cleared, not permanently stuck paid — a fresh
        // `pay_era_bounty` would now go through the normal path again, but here
        // we exercise the dedicated retry instead, which fires from the
        // journal without the ledger re-sending anything.
        expect((await vault.getEraSchedule(BIG_ERA.eraBoundary)).paid).toBe(0);

        // The winner's wallet did not deploy at all — the transfer never left the vault's wallet.
        const winnerWalletAddr = await master.getWalletAddress(winner.address);
        expect((await blockchain.getContract(winnerWalletAddr)).accountState?.type).not.toBe('active');

        // Fund the vault's wallet properly before retrying, then anyone may fire the retry.
        await master.sendMintGenesis(genesisScript.getSender(), {
            to: vault.address,
            amount: BIG_ERA.maxPrimes,
            value: toNano('0.2'),
        });
        const retry = await vault.sendRetryBountyPayout(winner.getSender(), { queryID: jkey, value: toNano('0.15') });
        expect(retry.transactions).toHaveTransaction({ from: vault.address, to: cfg.jettonWalletAddr, success: true });

        const winnerWallet = blockchain.openContract(PrimesJettonWallet.createFromAddress(winnerWalletAddr));
        expect((await winnerWallet.getWalletData()).balance).toBe(BIG_ERA.maxPrimes);
        expect((await vault.getEraSchedule(BIG_ERA.eraBoundary)).paid).toBe(1);
        expect((await vault.getVaultPayouts()).paidTotalPrimes).toBe(BIG_ERA.maxPrimes);
        expect((await vault.getVaultPayouts()).payoutCount).toBe(1);

        // A second retry on the same journal key fails closed — the row is gone.
        const again = await vault.sendRetryBountyPayout(winner.getSender(), { queryID: jkey, value: toNano('0.15') });
        expect(again.transactions).toHaveTransaction({ to: vault.address, success: false, exitCode: 702 });
    });

    it('a journalled row whose era was paid ANOTHER way is refused (703) — never paid twice', async () => {
        // The bounce journals the row and clears `paidEras`; the ledger's own idempotent
        // re-send then pays the era on the normal path. The row is still there, so the
        // retry arm's `paidEras` check is the only thing between it and a second payout.
        const jkey = (await vault.getDeferredPayouts()).journalKey;
        const pay = () =>
            vault.sendPayEraBounty(bankStandIn.getSender(), {
                eraBoundary: BIG_ERA.eraBoundary,
                beneficiary: winner.address,
                t: T_AT_GENESIS,
                s: S_AT_GENESIS,
                value: toNano('0.1'),
            });
        const cfg = await vault.getVaultConfig();
        const bounced = await pay();
        expect(bounced.transactions).toHaveTransaction({ from: cfg.jettonWalletAddr, to: vault.address, inMessageBounced: true, success: true });
        expect(await vault.getRetryEntry(BigInt(jkey))).toMatchObject({ found: true, retryable: true });

        await master.sendMintGenesis(genesisScript.getSender(), { to: vault.address, amount: BIG_ERA.maxPrimes, value: toNano('0.2') });
        const paid = await pay();
        expect(paid.transactions).not.toHaveTransaction({ aborted: true });
        const winnerWallet = blockchain.openContract(PrimesJettonWallet.createFromAddress(await master.getWalletAddress(winner.address)));
        expect((await winnerWallet.getWalletData()).balance).toBe(BIG_ERA.maxPrimes);
        expect((await vault.getEraSchedule(BIG_ERA.eraBoundary)).paid).toBe(1);
        // G59: the row says so before anyone sends — found, but not retryable.
        expect(await vault.getRetryEntry(BigInt(jkey))).toMatchObject({ found: true, retryable: false });
        const payoutsBefore = await vault.getVaultPayouts();

        const retry = await vault.sendRetryBountyPayout(winner.getSender(), { queryID: jkey, value: toNano('0.15') });
        expect(retry.transactions).toHaveTransaction({ to: vault.address, success: false, exitCode: 703 });
        expect(retry.transactions).not.toHaveTransaction({ from: vault.address, to: cfg.jettonWalletAddr });
        expect((await winnerWallet.getWalletData()).balance).toBe(BIG_ERA.maxPrimes);
        expect(await vault.getVaultPayouts()).toEqual(payoutsBefore);
        // and again: still 703, not a 702 from a row the refusal half-consumed
        const twice = await vault.sendRetryBountyPayout(winner.getSender(), { queryID: jkey, value: toNano('0.15') });
        expect(twice.transactions).toHaveTransaction({ to: vault.address, success: false, exitCode: 703 });
    });

    // D-53/B12.1, second half (GAUNTLET B12.2). `pay_program_bounty` debited
    // `allowlist[sender].remaining` and then sent WITHOUT writing a journal row
    // — so a bounce left the program's track short, `paidTotal`/`payoutCount`
    // overstated, and the beneficiary paid nothing. Since V26.1 it journals
    // NOTHING: the bounce arm finds the track by the `programTag` in the
    // transfer's queryId (QID_BOOK) and re-credits it.
    //
    // The allow-list track (1e9 nanoPRIMES) is far above this vault's
    // deliberately underfunded wallet balance (1e6), so the transfer hits
    // `primes_jetton_wallet.tolk`'s real balance check and bounces for real.
    const PROGRAM_TAG = 0x434f4e53;
    const PROGRAM_REMAINING = 1_000_000_000n;

    it('B12.2: a bounced program bounty puts the track back and cannot be replayed', async () => {
        const jkey = (await vault.getDeferredPayouts()).journalKey; // GAUNTLET V5 / H12
        const result = await vault.sendPayProgramBounty(accruer.getSender(), {
            programTag: PROGRAM_TAG,
            beneficiary: winner.address,
            amount: PROGRAM_REMAINING,
            value: toNano('0.1'),
        });
        const cfg = await vault.getVaultConfig();

        // The underfunded wallet rejects and bounces back into the vault.
        expect(result.transactions).toHaveTransaction({
            from: cfg.jettonWalletAddr,
            to: vault.address,
            success: true,
        });

        // Counted at send, rolled back by the bounce — same as the era arm.
        expect((await vault.getVaultPayouts()).paidTotalPrimes).toBe(0n);
        expect((await vault.getVaultPayouts()).payoutCount).toBe(0);

        // `remaining` is restored EXACTLY — `getProgram` reads it (F79, test below);
        // here it is proved by behaviour from both sides: one nanoPRIMES more than the
        // original track is still refused (701 vault_insufficient_balance) —
        const tooMuch = await vault.sendPayProgramBounty(accruer.getSender(), {
            programTag: PROGRAM_TAG,
            beneficiary: winner.address,
            amount: PROGRAM_REMAINING + 1n,
            value: toNano('0.1'),
        });
        expect(tooMuch.transactions).toHaveTransaction({ to: vault.address, success: false, exitCode: 701 });
        // — and the full original track is spendable again.
        const again = await vault.sendPayProgramBounty(accruer.getSender(), {
            programTag: PROGRAM_TAG,
            beneficiary: winner.address,
            amount: PROGRAM_REMAINING,
            value: toNano('0.1'),
        });
        expect(again.transactions).toHaveTransaction({ from: vault.address, to: cfg.jettonWalletAddr });
        expect(again.transactions).not.toHaveTransaction({ to: vault.address, success: false, exitCode: 701 });

        // The beneficiary's wallet never deployed: nothing ever left.
        const winnerWalletAddr = await master.getWalletAddress(winner.address);
        expect((await blockchain.getContract(winnerWalletAddr)).accountState?.type).not.toBe('active');

        // Replay is refused: the bounce arm repaired kind 3 onto its track and
        // never journalled it, so `retry_bounty_payout` has nothing to re-send.
        // G59: the getter says 702 (no row) before the send does.
        expect(await vault.getRetryEntry(BigInt(jkey))).toMatchObject({ found: false, retryable: false });
        expect(await journalRows(blockchain, vault.address)).toBe(0);
        expect((await vault.getDeferredPayouts()).journalKey).toBe(jkey);
        const replay = await vault.sendRetryBountyPayout(winner.getSender(), { queryID: jkey, value: toNano('0.15') });
        expect(replay.transactions).toHaveTransaction({ to: vault.address, success: false, exitCode: 702 });
    });

    it('B12.2: a program bounty that LANDED leaves no row and cannot be replayed (702)', async () => {
        // Fund the wallet properly so the transfer succeeds. Before V26.1 its
        // kind-3 row survived the success; now nothing is written at all.
        await master.sendMintGenesis(genesisScript.getSender(), {
            to: vault.address,
            amount: PROGRAM_REMAINING,
            value: toNano('0.2'),
        });
        const jkey = (await vault.getDeferredPayouts()).journalKey; // GAUNTLET V5 / H12
        await vault.sendPayProgramBounty(accruer.getSender(), {
            programTag: PROGRAM_TAG,
            beneficiary: winner.address,
            amount: PROGRAM_REMAINING,
            value: toNano('0.1'),
        });
        const winnerWallet = blockchain.openContract(
            PrimesJettonWallet.createFromAddress(await master.getWalletAddress(winner.address))
        );
        expect((await winnerWallet.getWalletData()).balance).toBe(PROGRAM_REMAINING);

        expect(await vault.getRetryEntry(BigInt(jkey))).toMatchObject({ found: false, retryable: false });
        expect(await journalRows(blockchain, vault.address)).toBe(0);
        const replay = await vault.sendRetryBountyPayout(winner.getSender(), { queryID: jkey, value: toNano('0.15') });
        expect(replay.transactions).toHaveTransaction({ to: vault.address, success: false, exitCode: 702 });
        // Still paid exactly once.
        expect((await winnerWallet.getWalletData()).balance).toBe(PROGRAM_REMAINING);
        expect((await vault.getVaultPayouts()).payoutCount).toBe(1);
    });

    // D-170 point 4 / F79: `/verify`'s bug-bounty prize is read off `getProgram(tag)`, so
    // the getter must answer the entry by TAG (not by address), name the program contract,
    // and track `remaining` through a payout and a bounce.
    it('F79: getProgram reads an allow-list entry by tag and follows remaining', async () => {
        const accruerHash = BigInt('0x' + accruer.address.hash.toString('hex'));
        expect(await vault.getProgram(PROGRAM_TAG)).toEqual({
            found: true, addrHash: accruerHash, remaining: PROGRAM_REMAINING,
        });
        expect(await vault.getProgram(0x51535453)).toMatchObject({ found: true, remaining: 1n });
        expect(await vault.getProgram(0x53454355)).toEqual({ found: false, addrHash: 0n, remaining: 0n });

        // Bounced (the wallet is underfunded): debited at send, restored by the bounce arm.
        await vault.sendPayProgramBounty(accruer.getSender(), {
            programTag: PROGRAM_TAG, beneficiary: winner.address, amount: PROGRAM_REMAINING, value: toNano('0.1'),
        });
        expect((await vault.getProgram(PROGRAM_TAG)).remaining).toBe(PROGRAM_REMAINING);

        // Landed (300 nanoPRIMES fits the underfunded wallet): the entry drops by exactly that.
        const paid = await vault.sendPayProgramBounty(accruer.getSender(), {
            programTag: PROGRAM_TAG, beneficiary: winner.address, amount: 300n, value: toNano('0.1'),
        });
        expect(paid.transactions).not.toHaveTransaction({ aborted: true });
        expect((await vault.getProgram(PROGRAM_TAG)).remaining).toBe(PROGRAM_REMAINING - 300n);
    });

    // V26.1 / D-188 point 3 — the storage ceiling. Before V26.1 every program
    // payout (every voucher claim) left a row per payout, never deleted: a map
    // with no bound.
    it('V26.1: N landed program payouts leave ZERO journal rows', async () => {
        const N = 5;
        await master.sendMintGenesis(genesisScript.getSender(), {
            to: vault.address,
            amount: 1_000_000_000_000n,
            value: toNano('0.2'),
        });
        const cfg = await vault.getVaultConfig();
        for (let i = 0; i < N; i++) {
            const pay = await vault.sendPayProgramBounty(accruer.getSender(), {
                programTag: PROGRAM_TAG,
                beneficiary: winner.address,
                amount: 1_000n,
                value: toNano('0.1'),
            });
            expect(pay.transactions).toHaveTransaction({ from: vault.address, to: cfg.jettonWalletAddr, success: true });
            expect(pay.transactions).not.toHaveTransaction({ aborted: true });
        }
        const winnerWallet = blockchain.openContract(
            PrimesJettonWallet.createFromAddress(await master.getWalletAddress(winner.address))
        );
        expect((await winnerWallet.getWalletData()).balance).toBe(BigInt(N) * 1_000n);
        expect(await vault.getVaultPayouts()).toMatchObject({
            paidTotalPrimes: BigInt(N) * 1_000n,
            payoutCount: N,
        });
        expect(await journalRows(blockchain, vault.address)).toBe(0);
        expect(await vault.getDeferredPayouts()).toMatchObject({ deferredCount: 0, journalKey: 0 });
    });

    it("V26.1: a bounced program payout re-credits ITS track by tag, not another program's", async () => {
        // The other track holds 1 nanoPRIMES. Bounce a CONS payout; if the
        // repair landed on the wrong entry, the other program could now send
        // more than its 1, and CONS could not send its full track again.
        await vault.sendPayProgramBounty(accruer.getSender(), {
            programTag: PROGRAM_TAG,
            beneficiary: winner.address,
            amount: PROGRAM_REMAINING,
            value: toNano('0.1'),
        });
        const other = await vault.sendPayProgramBounty(otherProgram.getSender(), {
            programTag: 0x51535453,
            beneficiary: winner.address,
            amount: 2n,
            value: toNano('0.1'),
        });
        expect(other.transactions).toHaveTransaction({ to: vault.address, success: false, exitCode: 701 });
        const full = await vault.sendPayProgramBounty(accruer.getSender(), {
            programTag: PROGRAM_TAG,
            beneficiary: winner.address,
            amount: PROGRAM_REMAINING,
            value: toNano('0.1'),
        });
        expect(full.transactions).toHaveTransaction({ from: vault.address, to: (await vault.getVaultConfig()).jettonWalletAddr });
        expect(full.transactions).not.toHaveTransaction({ to: vault.address, success: false });
        expect(await journalRows(blockchain, vault.address)).toBe(0);
    });

    it('rejects a retry with no journalled queryID', async () => {
        const result = await vault.sendRetryBountyPayout(winner.getSender(), { queryID: 777, value: toNano('0.15') });
        expect(result.transactions).toHaveTransaction({ to: vault.address, success: false, exitCode: 702 });
    });
});

// V26.7 / D-188 point 3. An EXHAUSTED vault must not journal: before this, once
// the wallet ran dry every later special rebate (one per head-minted composite)
// bounced off it and wrote a `retryJournal` row, unbounded. The vault now refuses
// what `fundedPrimes - paidTotal` cannot cover, before anything is sent.
describe('TON PRIMES — bounty vault V26.7: an exhausted vault cheap-fails, journals nothing', () => {
    let blockchain: Blockchain;
    let genesisScript: SandboxContract<TreasuryContract>;
    let ledger: SandboxContract<TreasuryContract>;
    let winner: SandboxContract<TreasuryContract>;
    let master: SandboxContract<PrimesJettonMaster>;
    let vault: SandboxContract<PrimesBountyVault>;

    // Per point of D(n): 1 TON buys 20,000 PRIMES at the genesis floor below.
    const PER_POINT = { tier: 0, bountyTon: toNano('1'), maxPrimes: 20_000n * 1_000_000_000n };
    const ONE_REBATE = payout(PER_POINT.bountyTon, PER_POINT.maxPrimes);
    const FUNDED = ONE_REBATE * 5n / 2n; // two rebates fit, the third does not
    const ERA = era(6n, 6_636_874_986n);

    beforeEach(async () => {
        blockchain = await Blockchain.create();
        blockchain.now = 1_770_000_000;
        const deployer = await blockchain.treasury('deployer');
        genesisScript = await blockchain.treasury('genesisScript');
        ledger = await blockchain.treasury('ledger');
        winner = await blockchain.treasury('winner');
        master = blockchain.openContract(
            PrimesJettonMaster.createFromConfig(
                { ledgerAddr: deployer.address, genesisScriptAddr: genesisScript.address, walletCode: await compile('PrimesJettonWallet') },
                await compile('PrimesJettonMaster')
            )
        );
        await master.sendDeploy(deployer.getSender(), toNano('5'));
        vault = blockchain.openContract(
            PrimesBountyVault.createFromConfig(
                {
                    schedule: [ERA],
                    rebateSchedule: [PER_POINT],
                    ledgerAddr: ledger.address,
                    jettonMasterAddr: master.address,
                    genesisScriptAddr: genesisScript.address,
                    fundedPrimes: FUNDED,
                },
                await compile('PrimesBountyVault')
            )
        );
        await vault.sendDeploy(deployer.getSender(), toNano('5'));
        await master.sendMintGenesis(genesisScript.getSender(), { to: vault.address, amount: FUNDED, value: toNano('0.2') });
        await vault.sendSetWallet(genesisScript.getSender(), {
            jettonWalletAddr: await master.getWalletAddress(vault.address),
            value: toNano('0.05'),
        });
    });

    it('drained, N later rebates and the era write 0 rows, abort nothing, and the §9.1 figures stay honest', async () => {
        expect(await vault.getVaultFunded()).toBe(FUNDED);
        const walletAddr = (await vault.getVaultConfig()).jettonWalletAddr;
        const vaultWallet = blockchain.openContract(PrimesJettonWallet.createFromAddress(walletAddr));
        const N = 6;
        for (let i = 0; i < N; i++) {
            const n = 100n + BigInt(i);
            const r = await vault.sendPaySpecialNumberRebate(ledger.getSender(), {
                n, kind: 0, points: 1, beneficiary: winner.address,
                t: T_AT_GENESIS, s: S_AT_GENESIS, value: toNano('0.015'), // the ledger's own NoBounce leg
            });
            expect(r.transactions).not.toHaveTransaction({ aborted: true });
            if (i < 2) {
                expect(r.transactions).toHaveTransaction({ from: vault.address, to: walletAddr, success: true });
                expect((await vault.getRebateSchedule(0, n)).paid).toBe(1);
            } else {
                // Refused unsent: no transfer, so no bounce; and it reads unpaid.
                expect(r.transactions).not.toHaveTransaction({ from: vault.address, to: walletAddr });
                expect((await vault.getRebateSchedule(0, n)).paid).toBe(0);
            }
        }
        const eraR = await vault.sendPayEraBounty(ledger.getSender(), {
            eraBoundary: 6n, beneficiary: winner.address, t: T_AT_GENESIS, s: S_AT_GENESIS, value: toNano('0.015'),
        });
        expect(eraR.transactions).not.toHaveTransaction({ aborted: true });
        expect(eraR.transactions).not.toHaveTransaction({ from: vault.address, to: walletAddr });
        expect((await vault.getEraSchedule(6n)).paid).toBe(0);

        expect(await journalRows(blockchain, vault.address)).toBe(0);
        expect(await vault.getDeferredPayouts()).toMatchObject({ deferredCount: 0, journalKey: 0 });
        const paid = await vault.getVaultPayouts();
        expect(paid).toMatchObject({ paidTotalPrimes: 2n * ONE_REBATE, payoutCount: 2 });
        // The wallet is still the truth, and the declared remainder never overstates it.
        expect((await vaultWallet.getWalletData()).balance).toBe(FUNDED - paid.paidTotalPrimes);
    });
});
