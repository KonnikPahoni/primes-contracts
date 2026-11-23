// TON PRIMES — GAUNTLET.md V2.1: the DeDust swap round-tripped against a
// schema-faithful counterparty, not just a treasury stand-in.
//
// `WireFormatDeDustSwap.spec.ts` (V2) proves the outbound cell MATCHES DeDust
// v2's published schema. This file proves the ratchet's OWN fill/bounce
// handling round-trips correctly when the counterparty actually behaves like a
// DeDust vault would: `mock_dedust_vault.tolk` parses the real schema and
// either fills (a genuine TransferNotification back, exercising the
// `TransferNotification` handler's fill-detection — GAUNTLET B2.1) or refuses
// (a genuine `payout#474f86cf` back, exercising the `DedustPayout` handler's
// reversal). The refusal used to be modelled as a TVM throw and a bounce; that
// is not what DeDust does, and this file asserting that it was is what hid the
// missing handler — see DEDUST_PAYOUT_OP in primes_ratchet.tolk. Still not a live DeDust pool — see the mock's own header
// comment and `docs/audit/known-limitations.md` for what that would still take.
import { Blockchain, SandboxContract, TreasuryContract, internal } from '@ton/sandbox';
import { Address, beginCell, Cell, toNano } from '@ton/core';
import '@ton/test-utils';
import { compile } from '@ton/blueprint';
import { PrimesLedger } from '../wrappers/PrimesLedger';
import { PrimesRatchet, FlushOutcome, FLUSH_VALUE } from '../wrappers/PrimesRatchet';
import { PrimesRegistrar } from '../wrappers/PrimesRegistrar';
import { PrimesCollection } from '../wrappers/PrimesCollection';
import { PrimesJettonMaster } from '../wrappers/PrimesJettonMaster';
import { MockDedustVault } from '../wrappers/MockDedustVault';

const MINT_PRICE = toNano('1');
const OPENING_HEAD = 4n;

describe('GAUNTLET.md V2.1 — flush() round-trips against a schema-faithful DeDust vault', () => {
    let blockchain: Blockchain;
    let deployer: SandboxContract<TreasuryContract>;
    let genesisScript: SandboxContract<TreasuryContract>;
    let treasuryWallet: SandboxContract<TreasuryContract>;
    let timelockWallet: SandboxContract<TreasuryContract>;
    let poolStub: SandboxContract<TreasuryContract>;
    let minter: SandboxContract<TreasuryContract>;

    let itemCode: Cell;
    let collectionCode: Cell;
    let walletCode: Cell;
    let masterCode: Cell;
    let ledgerCode: Cell;
    let ratchetCode: Cell;
    let registrarCode: Cell;
    let mockVaultCode: Cell;

    let collection: SandboxContract<PrimesCollection>;
    let master: SandboxContract<PrimesJettonMaster>;
    let ledger: SandboxContract<PrimesLedger>;
    let ratchet: SandboxContract<PrimesRatchet>;
    let registrar: SandboxContract<PrimesRegistrar>;
    let mockVault: SandboxContract<MockDedustVault>;

    beforeAll(async () => {
        itemCode = await compile('PrimesItem');
        collectionCode = await compile('PrimesCollection');
        walletCode = await compile('PrimesJettonWallet');
        masterCode = await compile('PrimesJettonMaster');
        ledgerCode = await compile('PrimesLedger');
        ratchetCode = await compile('PrimesRatchet');
        registrarCode = await compile('PrimesRegistrar');
        mockVaultCode = await compile('MockDedustVault');
    });

    beforeEach(async () => {
        blockchain = await Blockchain.create();
        blockchain.now = 1_770_000_000;
        deployer = await blockchain.treasury('deployer');
        genesisScript = await blockchain.treasury('genesisScript');
        treasuryWallet = await blockchain.treasury('treasury');
        timelockWallet = await blockchain.treasury('timelock');
        poolStub = await blockchain.treasury('dedustPool');
        minter = await blockchain.treasury('minter', { balance: toNano('10000') });

        collection = blockchain.openContract(
            PrimesCollection.createFromConfig(
                { nextIndex: 2n, itemCode, ledgerAddr: deployer.address, genesisScriptAddr: genesisScript.address },
                collectionCode
            )
        );
        await collection.sendDeploy(deployer.getSender(), toNano('5'));

        master = blockchain.openContract(
            PrimesJettonMaster.createFromConfig(
                { ledgerAddr: deployer.address, genesisScriptAddr: genesisScript.address, walletCode },
                masterCode
            )
        );
        await master.sendDeploy(deployer.getSender(), toNano('5'));

        ledger = blockchain.openContract(
            PrimesLedger.createFromConfig(
                {
                    a: {
                        collectionAddr: collection.address,
                        jettonMasterAddr: master.address,
                        treasuryAddr: treasuryWallet.address,
                        itemCode,
                    },
                    b: { genesisScriptAddr: genesisScript.address },
                },
                ledgerCode
            )
        );
        await ledger.sendDeploy(deployer.getSender(), toNano('10'));

        registrar = blockchain.openContract(
            PrimesRegistrar.createFromConfig({ genesisScriptAddr: genesisScript.address }, registrarCode)
        );
        await registrar.sendDeploy(deployer.getSender(), toNano('5'));

        // priceNum/priceDen start at 0/1 — every swap rejects until a test sets
        // a real price, so "fills by accident" cannot happen.
        mockVault = blockchain.openContract(
            MockDedustVault.createFromConfig({ owner: deployer.address, priceNum: 0n, priceDen: 1n }, mockVaultCode)
        );
        await mockVault.sendDeploy(deployer.getSender(), toNano('5'));

        ratchet = blockchain.openContract(
            PrimesRatchet.createFromConfig(
                {
                    venueTimelockAddr: timelockWallet.address,
                    genesisScriptAddr: genesisScript.address,
                    dedustNativeVault: mockVault.address,
                    dedustPool: poolStub.address,
                    primesJettonVault: mockVault.address,
                },
                ratchetCode
            )
        );
        await ratchet.sendDeploy(deployer.getSender(), toNano('10'));

        await collection.sendSetLedger(genesisScript.getSender(), { ledgerAddr: ledger.address, value: toNano('0.05') });
        await master.sendSetLedger(genesisScript.getSender(), { ledgerAddr: ledger.address, value: toNano('0.05') });
        await ratchet.sendSetLedger(genesisScript.getSender(), { ledgerAddr: ledger.address, value: toNano('0.05') });
        await registrar.sendSetLedger(genesisScript.getSender(), { ledgerAddr: ledger.address, value: toNano('0.05') });
        // The mock stands in for the ratchet's own PRIMES jetton wallet too —
        // its TransferNotification is what the fill-detection trusts (GAUNTLET
        // B2.1's forged-vs-real distinction).
        await ratchet.sendSetJettonWallet(genesisScript.getSender(), {
            jettonWalletAddr: mockVault.address,
            value: toNano('0.05'),
        });
        await ledger.sendSetSinks(genesisScript.getSender(), {
            ratchetAddr: ratchet.address,
            registrarAddr: registrar.address,
            value: toNano('0.05'),
        });
        await ledger.sendGenesisSeed(genesisScript.getSender(), {
            seedT: toNano('1000'),
            seedS: 1_200_000_000_000_000n,
            seedHead: OPENING_HEAD,
            value: toNano('0.05'),
        });
        await ledger.sendSetPeers(genesisScript.getSender(), {
            marketAddr: deployer.address,
            bountyVaultAddr: treasuryWallet.address,
            value: toNano('0.05'),
        });
        await ledger.sendIgnite(genesisScript.getSender(), { owner: deployer.address, value: toNano('0.3') });

        // Feed `pending` so flush has something to move.
        await ledger.sendMint(minter.getSender(), {
            n: OPENING_HEAD,
            kind: 0,
            factors: [{ prime: 2n, exponent: 2, s: 1n }],
            referralKey: 0,
            beneficiary: null,
            value: MINT_PRICE,
        });
    });

    it('FILL: at-or-above the floor guard, the mock replies and inFlightFlush clears', async () => {
        const T = await ledger.getFloorNum();
        const S = await ledger.getFloorDen();
        // Exactly at the floor price: FLOOR_GUARD is 0, so limit == amount*S/T
        // and this is the boundary case (>=), not a comfortable margin.
        await mockVault.sendSetPrice(deployer.getSender(), { priceNum: S, priceDen: T, value: toNano('0.05') });

        const r = await ratchet.sendFlush(minter.getSender(), { value: FLUSH_VALUE });
        expect(r.transactions).toHaveTransaction({ from: ratchet.address, to: mockVault.address, success: true });
        expect(r.transactions).toHaveTransaction({ from: mockVault.address, to: ratchet.address, success: true });
        // No bounce anywhere in this transaction chain.
        expect(r.transactions.some((t) => t.inMessage?.info?.type === 'internal' && (t.inMessage.info as any).bounced)).toBe(
            false
        );

        expect(await ratchet.getInFlightFlush()).toBe(0n);
        expect((await ratchet.getFlushStatus()).outcome).toBe(FlushOutcome.Filled);
    });

    it('REJECT: below the floor guard, the mock pays out and the refund restores pending/swapped', async () => {
        const pendingBefore = await ratchet.getPending();
        const swappedBefore = await ratchet.getSwapped();
        // Half the floor price: guaranteed below `limit`.
        const T = await ledger.getFloorNum();
        const S = await ledger.getFloorDen();
        await mockVault.sendSetPrice(deployer.getSender(), { priceNum: S / 2n, priceDen: T, value: toNano('0.05') });

        const r = await ratchet.sendFlush(minter.getSender(), { value: FLUSH_VALUE });
        // A SLIPPAGE REFUSAL DOES NOT BOUNCE. The mock's own transaction
        // SUCCEEDS and hands the GRAM back with `payout#474f86cf`, because that
        // is what mainnet does — see DEDUST_PAYOUT_OP in primes_ratchet.tolk
        // for the traces. This assertion used to demand `exitCode: 1204` and a
        // bounced message, and it passing was the only reason the ratchet's
        // missing `DedustPayout` handler went unnoticed: every sandbox test
        // agreed with every other sandbox test and all of them disagreed with
        // the chain.
        expect(r.transactions).toHaveTransaction({ to: mockVault.address, success: true });
        const payout = r.transactions.find(
            (t) =>
                t.inMessage?.info?.type === 'internal' &&
                t.inMessage.info.dest?.equals(ratchet.address) &&
                t.inMessage.body.beginParse().remainingBits >= 32 &&
                t.inMessage.body.beginParse().preloadUint(32) === 0x474f86cf
        );
        expect(payout).toBeDefined();
        // NON-bounceable, and the ratchet must ACCEPT it rather than throw:
        // a throw here would keep the GRAM (it is credited before compute) while
        // leaving the accounting half-reverted forever.
        expect((payout!.inMessage!.info as any).bounced).toBe(false);
        expect(payout!.description.type === 'generic' && payout!.description.aborted).toBe(false);
        // No bounced message anywhere — the thing this path used to rely on.
        expect(
            r.transactions.find(
                (t) => t.inMessage?.info?.type === 'internal' && (t.inMessage.info as any).bounced === true
            )
        ).toBeUndefined();

        expect(await ratchet.getInFlightFlush()).toBe(0n);
        expect(await ratchet.getPending()).toBe(pendingBefore); // fully restored
        expect(await ratchet.getSwapped()).toBe(swappedBefore); // fully restored
        expect((await ratchet.getFlushStatus()).outcome).toBe(FlushOutcome.Bounced);
    });

    it('GAUNTLET V11: a REFUSED flush does not burn the 24h cooldown — a second flush is legal immediately after', async () => {
        // Same below-floor setup as the REJECT case above, so this attempt
        // genuinely bounces too — no `blockchain.now` advance between the two
        // sends, which is exactly the window `FLUSH_COOLDOWN` (86400s) used to
        // block for a full day on nothing but a single bounce, permissionlessly
        // repeatable by anyone since `flush()` has no sender gate.
        const T = await ledger.getFloorNum();
        const S = await ledger.getFloorDen();
        await mockVault.sendSetPrice(deployer.getSender(), { priceNum: S / 2n, priceDen: T, value: toNano('0.05') });

        const first = await ratchet.sendFlush(minter.getSender(), { value: FLUSH_VALUE });
        expect(first.transactions).toHaveTransaction({ to: mockVault.address, success: true });
        expect(await ratchet.getPending()).toBeGreaterThan(0n); // restored, so a second attempt has something to flush

        // BEFORE this fix, this throws 207 (ratchet_flush_cooldown) — the
        // bounce above never reset `lastFlushTime`, so the 24h window it just
        // opened was still running. Asserting the SAME price rejection twice
        // (not 207) is what proves the cooldown gate itself, not the price
        // guard, is what changed.
        const second = await ratchet.sendFlush(minter.getSender(), { value: FLUSH_VALUE });
        expect(second.transactions).toHaveTransaction({ to: ratchet.address, success: true }); // handleFlush itself ran
        expect(second.transactions).not.toHaveTransaction({ to: ratchet.address, success: false, exitCode: 207 });
        expect(second.transactions).toHaveTransaction({ to: mockVault.address, success: true });
    });

    it('GAUNTLET V15: a second flush is REFUSED while the first round trip is still open', async () => {
        // The failure this guards. `handleFlush` used to OVERWRITE `inFlightFlush`
        // with the new amount. So if swap A were still in flight when swap B
        // started, A's later bounce would restore B's amount into
        // `pending`/`swapped` — §5's `T = seeded + swapped + pending` identity
        // silently wrong, on the one contract whose §3.4 claim is that the
        // identity is checkable in a single get-call.
        //
        // Reaching that state needs a swap that neither fills nor reverts, which
        // is the mock's third outcome (`silent`): it accepts a well-formed swap
        // and never answers. A price is set FIRST and deliberately left
        // fill-worthy, so nothing here can be mistaken for a slippage rejection.
        const T = await ledger.getFloorNum();
        const S = await ledger.getFloorDen();
        await mockVault.sendSetPrice(deployer.getSender(), { priceNum: S, priceDen: T, value: toNano('0.05') });
        await mockVault.sendSetSilent(deployer.getSender(), { silent: true, value: toNano('0.05') });

        // A hundredth of the auto size, so the pro-rata cooldown it incurs (~864 s)
        // runs out well inside the flush's own stale window (FLUSH_STALE_TIMEOUT).
        const first = await ratchet.sendFlush(minter.getSender(), {
            value: FLUSH_VALUE,
            amount: (await ratchet.getPending()) / 100n,
        });
        // The vault accepted it...
        expect(first.transactions).toHaveTransaction({ from: ratchet.address, to: mockVault.address, success: true });
        // ...and answered with neither a fill nor a bounce, so the trip is open.
        expect(first.transactions).not.toHaveTransaction({ from: mockVault.address, to: ratchet.address });
        const inFlight = await ratchet.getInFlightFlush();
        expect(inFlight).toBeGreaterThan(0n);

        // Clear the cooldown so THIS assert is the only thing left that can
        // refuse the second flush — otherwise 207 would mask 223 and the test
        // would pass without the guard existing. Still inside the stale window.
        const cd = (await ratchet.getFlushStatus()).cooldownRemaining;
        expect(cd).toBeLessThan(await ratchet.getFlushStaleSec());
        blockchain.now = blockchain.now! + cd + 1;

        const second = await ratchet.sendFlush(minter.getSender(), { value: FLUSH_VALUE });
        expect(second.transactions).toHaveTransaction({ to: ratchet.address, success: false, exitCode: 223 });
        // No second swap was sent, and the first trip's amount is untouched —
        // the pre-fix behaviour would have overwritten it here.
        expect(second.transactions).not.toHaveTransaction({ from: ratchet.address, to: mockVault.address });
        expect(await ratchet.getInFlightFlush()).toBe(inFlight);
    });

    /** Open a round trip that neither fills nor refuses: the mock accepts the swap and stays silent. */
    async function openSilentFlush(amount = 0n) {
        const T = await ledger.getFloorNum();
        const S = await ledger.getFloorDen();
        await mockVault.sendSetPrice(deployer.getSender(), { priceNum: S, priceDen: T, value: toNano('0.05') });
        await mockVault.sendSetSilent(deployer.getSender(), { silent: true, value: toNano('0.05') });
        const pendingBefore = await ratchet.getPending();
        const swappedBefore = await ratchet.getSwapped();
        await ratchet.sendFlush(minter.getSender(), { value: FLUSH_VALUE, amount });
        const inFlight = await ratchet.getInFlightFlush();
        expect(inFlight).toBeGreaterThan(0n);
        return { inFlight, pendingBefore, swappedBefore };
    }

    it("a stranger's PRIMES transfer does not close the round trip — the refusal after it is still restored", async () => {
        // The attack: while a flush is in flight, send the ratchet 1 nanoPRIMES.
        // Its own wallet notifies it honestly — the WALLET check passes — and the
        // tracker used to clear on that alone. DeDust's refusal then arrived with
        // nothing in flight and its GRAM, a whole FLUSH_PCT tranche, was stranded
        // in the gas buffer. `mockVault` is the ratchet's jetton wallet here, so a
        // notification FROM it naming someone else is exactly that transfer.
        const { inFlight, pendingBefore, swappedBefore } = await openSilentFlush();
        const stranger = await blockchain.treasury('primes-stranger');
        const note = (amount: bigint, jettonSender: typeof stranger.address) =>
            blockchain.sendMessage(
                internal({
                    from: mockVault.address,
                    to: ratchet.address,
                    value: toNano('0.1'),
                    body: beginCell()
                        .storeUint(0x7362d09c, 32)
                        .storeUint(0, 64)
                        .storeCoins(amount)
                        .storeAddress(jettonSender)
                        .storeUint(0, 1)
                        .endCell(),
                })
            );

        const r = await note(1n, stranger.address);
        expect(r.transactions).not.toHaveTransaction({ to: ratchet.address, aborted: true }); // the burn-back to the mock aborts; the mock is not a wallet
        expect(await ratchet.getInFlightFlush()).toBe(inFlight);

        // The refusal lands next and is recognised as ours.
        await blockchain.sendMessage(
            internal({
                from: mockVault.address,
                to: ratchet.address,
                value: inFlight,
                bounce: false,
                body: beginCell().storeUint(0x474f86cf, 32).storeUint(0, 64).storeUint(0, 1).endCell(),
            })
        );
        expect(await ratchet.getInFlightFlush()).toBe(0n);
        expect(await ratchet.getPending()).toBe(pendingBefore);
        expect(await ratchet.getSwapped()).toBe(swappedBefore);
    });

    it('a round trip that never settles expires after the flush stale window and stops blocking flush', async () => {
        // A flush the venue DROPPED, or one whose fill notification never ran (DeDust
        // forwarding no GRAM with the payout), can never be answered, and 223 and 230
        // would then refuse flush, stake and unstake. (A venue change mid-flight used
        // to be a third cause, and one anyone could force — audit R2-M1; the trip now
        // keeps the venue it was sent to, see the R2-M1 block below. What is left is a
        // venue that really says nothing, which nobody but the venue can arrange.)
        // After FLUSH_STALE_TIMEOUT (1 h, six swap deadlines) it closes AS FILLED —
        // `swapped` keeps it, `pending` gets nothing back, the direction that
        // cannot overstate `pending`. It was D-155's 72 h exit timeout before.
        // A hundredth of `pending`: something left to move afterwards, and a
        // pro-rata cooldown (~864 s) short enough not to mask 223 below.
        const { inFlight, pendingBefore, swappedBefore } = await openSilentFlush((await ratchet.getPending()) / 100n);
        await mockVault.sendSetSilent(deployer.getSender(), { silent: false, value: toNano('0.05') });
        const start = blockchain.now!;
        const stale = await ratchet.getFlushStaleSec();
        expect(stale).toBe(3600);

        // Still open one second short of the timeout: V15's refusal holds.
        blockchain.now = start + stale - 1;
        const early = await ratchet.sendFlush(minter.getSender(), { value: FLUSH_VALUE });
        expect(early.transactions).toHaveTransaction({ to: ratchet.address, success: false, exitCode: 223 });

        blockchain.now = start + stale;
        const late = await ratchet.sendFlush(minter.getSender(), { value: FLUSH_VALUE });
        expect(late.transactions).not.toHaveTransaction({ to: ratchet.address, aborted: true }); // the burn-back to the mock aborts; the mock is not a wallet
        expect(late.transactions).toHaveTransaction({ from: mockVault.address, to: ratchet.address, success: true });
        // The stale trip stayed swapped; the new one filled and cleared itself.
        expect(await ratchet.getInFlightFlush()).toBe(0n);
        expect((await ratchet.getSwapped()) - swappedBefore).toBe(inFlight + (await ratchet.getFlushStatus()).amount);
        expect(await ratchet.getPending()).toBe(pendingBefore - (await ratchet.getSwapped()) + swappedBefore);
    });

    it('a fill notification carrying too little GRAM for the burn still closes the round trip', async () => {
        // The clear and the burn share one transaction, and the burn rides only the
        // GRAM DeDust forwarded. With too little left for the burn's forward fee the
        // action phase used to fail and roll the clear back, so the flush stayed
        // "in flight" and 223/230 held until the stale window. Testnet forwards
        // ~0.1566 GRAM on a fill; this sends just enough for compute and nothing more.
        const { inFlight } = await openSilentFlush();
        const minOut = await ratchet.getLastMinOut();
        const fill = (value: bigint) =>
            blockchain.sendMessage(
                internal({
                    from: mockVault.address, // the ratchet's PRIMES wallet here
                    to: ratchet.address,
                    value,
                    bounce: false,
                    body: beginCell()
                        .storeUint(0x7362d09c, 32)
                        .storeUint(0, 64)
                        .storeCoins(minOut)
                        .storeAddress(mockVault.address) // and DeDust's PRIMES vault
                        .storeUint(0, 1)
                        .endCell(),
                })
            );

        // Measure the notification's compute fee on a well-funded copy, then rewind.
        const snap = blockchain.snapshot();
        const rich = await fill(toNano('0.2'));
        const tx = rich.transactions.find(
            (t) => t.inMessage?.info.type === 'internal' && t.inMessage.info.dest.equals(ratchet.address)
        )!;
        if (tx.description.type !== 'generic' || tx.description.computePhase.type !== 'vm') throw new Error('no compute');
        const gasFees = tx.description.computePhase.gasFees;
        await blockchain.loadFrom(snap);
        expect(await ratchet.getInFlightFlush()).toBe(inFlight);

        const poor = await fill(gasFees + 1n);
        expect(poor.transactions).not.toHaveTransaction({ to: ratchet.address, aborted: true });
        expect(await ratchet.getInFlightFlush()).toBe(0n);
    });

    // =====================================================================
    // Audit R2-M1 (2026-11-19) — a flush is answered by the venue it was SENT to
    // =====================================================================
    //
    // `UpdateVenue` did not look at `inFlightFlush`, and the two reply arms
    // authenticated against the CURRENT venue. So: `Flush` (20% of `pending`
    // leaves and will be refused), then the timelock's permissionless `Execute`.
    // The old vault's refund landed after the venue moved, threw 100 on a
    // non-bounceable message — the GRAM stayed, in the gas buffer — and the stale
    // window closed the trip as filled. Nobody profits; anyone could do it.
    //
    // NOT fixed by refusing `UpdateVenue` while a flush is open: a 1-nanoton flush
    // costs no cooldown (the D-146 test below), and a venue that answers nothing —
    // the case migrations exist for — holds each one for the whole stale window,
    // re-opened in the same transaction that closes it. That refusal could be held
    // open for ever. Instead the open trip keeps its own two reply addresses and
    // the change lands at once: it is never delayed (bound: 0), and the first flush
    // to the NEW venue waits at most `FLUSH_STALE_TIMEOUT` behind a silent old one.
    //
    // The harness's timelock is a plain wallet, so `update_venue` is sent directly;
    // the real `execute -> update_venue` hop is `VenueGovernance.spec.ts`'s.
    const PAYOUT = beginCell().storeUint(0x474f86cf, 32).storeUint(0, 64).storeUint(0, 1).endCell();

    const updateVenue = (nativeVault: Address, pool: Address, primesVault: Address) =>
        timelockWallet.send({
            to: ratchet.address,
            value: toNano('0.03'),
            body: beginCell()
                .storeUint(0xb0000010, 32)
                .storeUint(0, 64)
                .storeAddress(nativeVault)
                .storeAddress(pool)
                .storeAddress(primesVault)
                .endCell(),
        });

    /** `payout#474f86cf` from `vault`: a refusal handing the swap's input back. */
    const payoutFrom = (vault: Address, value: bigint) =>
        blockchain.sendMessage(internal({ from: vault, to: ratchet.address, value, bounce: false, body: PAYOUT }));

    /** The ratchet's own PRIMES wallet (the mock) reporting `amount` paid in by `primesVault`. */
    const fillFrom = (primesVault: Address, amount: bigint) =>
        blockchain.sendMessage(
            internal({
                from: mockVault.address,
                to: ratchet.address,
                value: toNano('0.1'),
                bounce: false,
                body: beginCell()
                    .storeUint(0x7362d09c, 32)
                    .storeUint(0, 64)
                    .storeCoins(amount)
                    .storeAddress(primesVault)
                    .storeUint(0, 1)
                    .endCell(),
            })
        );

    /** A second venue: its own (silent) native vault, pool and PRIMES vault — none of them the mock. */
    async function newVenue(tag: string) {
        const nativeVault = blockchain.openContract(
            MockDedustVault.createFromConfig(
                { owner: deployer.address, priceNum: 1n, priceDen: 1n, silent: true },
                mockVaultCode
            )
        );
        await nativeVault.sendDeploy(deployer.getSender(), toNano('5'));
        const pool = await blockchain.treasury(`pool-${tag}`);
        const primesVault = await blockchain.treasury(`primes-vault-${tag}`);
        return { nativeVault: nativeVault.address, pool: pool.address, primesVault: primesVault.address };
    }

    it('R2-M1: a REFUSAL that crosses a venue change still restores pending — nothing is stranded', async () => {
        const solvencyBefore = await ratchet.getSolvency();
        // Nothing in flight: the reply pair is the venue's own, unpinned.
        expect(await ratchet.getFlushReplyVenue()).toMatchObject({ pinned: false });
        expect((await ratchet.getFlushReplyVenue()).dedustNativeVault.equals(mockVault.address)).toBe(true);
        const { inFlight, pendingBefore, swappedBefore } = await openSilentFlush();
        expect(await ratchet.getFlushReplyVenue()).toMatchObject({ pinned: false }); // open, but on the current venue
        const next = await newVenue('a');

        // The change lands while the trip is open. It is not refused and not delayed.
        const moved = await updateVenue(next.nativeVault, next.pool, next.primesVault);
        expect(moved.transactions).toHaveTransaction({ from: timelockWallet.address, to: ratchet.address, success: true });
        expect(moved.transactions).not.toHaveTransaction({ aborted: true });
        expect((await ratchet.getVenue()).dedustNativeVault.equals(next.nativeVault)).toBe(true);
        expect(await ratchet.getInFlightFlush()).toBe(inFlight);
        // §9.1: who settles the open trip is published — the OLD pair, flagged as pinned.
        const pin = await ratchet.getFlushReplyVenue();
        expect(pin.pinned).toBe(true);
        expect(pin.dedustNativeVault.equals(mockVault.address)).toBe(true);
        expect(pin.primesJettonVault.equals(mockVault.address)).toBe(true);

        // The OLD vault's refund arrives after it — accepted, not thrown on.
        const refund = await payoutFrom(mockVault.address, inFlight);
        expect(refund.transactions).toHaveTransaction({ from: mockVault.address, to: ratchet.address, success: true });
        expect(refund.transactions).not.toHaveTransaction({ aborted: true });
        expect(await ratchet.getInFlightFlush()).toBe(0n);
        expect(await ratchet.getPending()).toBe(pendingBefore);
        expect(await ratchet.getSwapped()).toBe(swappedBefore);
        expect((await ratchet.getFlushStatus()).outcome).toBe(FlushOutcome.Bounced);
        // Settled: the pin is inert and the published pair is the new venue's.
        const settled = await ratchet.getFlushReplyVenue();
        expect(settled.pinned).toBe(false);
        expect(settled.dedustNativeVault.equals(next.nativeVault)).toBe(true);
        expect(settled.primesJettonVault.equals(next.primesVault)).toBe(true);
        // What the pin costs, measured: `update_venue` with a trip open, and the pinned refund.
        const gasOf = (r: any) =>
            (r.transactions.find((t: any) => t.inMessage?.info?.dest?.equals?.(ratchet.address)).description as any)
                .computePhase.gasUsed as bigint;
        console.log(`[gas] R2-M1 update_venue (flush in flight, pins) ${gasOf(moved)}, pinned payout refund ${gasOf(refund)}`);
        expect(gasOf(moved)).toBeLessThan(10_000n);
        expect(gasOf(refund)).toBeLessThan(12_000n);
        // §3.4 in one get-call: the liability is whole again and the tranche is not
        // sitting uncounted in the gas buffer (stranded, it showed as +inFlight here).
        const solvencyAfter = await ratchet.getSolvency();
        expect(solvencyAfter.liability).toBe(solvencyBefore.liability);
        expect(solvencyAfter.delta).toBeGreaterThanOrEqual(0n);
        const drift = solvencyAfter.delta - solvencyBefore.delta;
        expect(drift < toNano('0.05') && drift > -toNano('0.05')).toBe(true);
        expect(inFlight).toBeGreaterThan(toNano('0.05')); // so the line above can tell

        // THE NEXT flush goes to the new venue, and only the new venue answers it.
        const again = await ratchet.sendFlush(minter.getSender(), { value: FLUSH_VALUE });
        expect(again.transactions).toHaveTransaction({ from: ratchet.address, to: next.nativeVault, success: true });
        expect(again.transactions).not.toHaveTransaction({ from: ratchet.address, to: mockVault.address });
        const open = await ratchet.getInFlightFlush();
        expect(open).toBeGreaterThan(0n);
        expect((await ratchet.getFlushReplyVenue()).pinned).toBe(false); // the new trip dropped the pin
        const stale = await payoutFrom(mockVault.address, open); // the old vault has no say now
        expect(stale.transactions).toHaveTransaction({ to: ratchet.address, success: false, exitCode: 100 });
        expect(await ratchet.getInFlightFlush()).toBe(open);
        const ours = await payoutFrom(next.nativeVault, open);
        expect(ours.transactions).not.toHaveTransaction({ aborted: true });
        expect(await ratchet.getInFlightFlush()).toBe(0n);
        expect(await ratchet.getPending()).toBe(pendingBefore);
    });

    it('R2-M1: a FILL that crosses a venue change closes the trip at once and is counted as burned', async () => {
        const { inFlight, pendingBefore, swappedBefore } = await openSilentFlush();
        const minOut = await ratchet.getLastMinOut();
        const burnedBefore = (await ratchet.getBurnStats()).burnedPrimes;
        const next = await newVenue('b');
        await updateVenue(next.nativeVault, next.pool, next.primesVault);

        // The NEW venue's PRIMES vault cannot answer for a trip it never saw...
        const forged = await fillFrom(next.primesVault, minOut);
        expect(forged.transactions).not.toHaveTransaction({ to: ratchet.address, aborted: true }); // the burn-back to the mock aborts; the mock is not a wallet
        expect(await ratchet.getInFlightFlush()).toBe(inFlight);

        // ...the OLD one's proceeds are the fill: closed now, not an hour later.
        const fill = await fillFrom(mockVault.address, minOut);
        expect(fill.transactions).not.toHaveTransaction({ to: ratchet.address, aborted: true });
        console.log(
            `[gas] R2-M1 pinned fill notification ${
                (fill.transactions.find((t: any) => t.inMessage?.info?.dest?.equals?.(ratchet.address))!.description as any)
                    .computePhase.gasUsed
            }`
        );
        expect(await ratchet.getInFlightFlush()).toBe(0n);
        expect(await ratchet.getSwapped()).toBe(swappedBefore + inFlight);
        expect(await ratchet.getPending()).toBe(pendingBefore - inFlight);
        expect((await ratchet.getFlushStatus()).outcome).toBe(FlushOutcome.Filled);
        expect((await ratchet.getBurnStats()).burnedPrimes).toBe(burnedBefore + minOut);
    });

    it('R2-M1: tiny flushes cannot hold a venue change back — it lands at once, twice, and the dust trip still settles', async () => {
        // The griefing the "refuse while in flight" fix would have invited: a
        // 1-nanoton flush, free of cooldown, kept open against a silent venue.
        const { inFlight, pendingBefore, swappedBefore } = await openSilentFlush(1n);
        expect(inFlight).toBe(1n);
        expect((await ratchet.getFlushStatus()).cooldownRemaining).toBe(0);

        // Bound on the delay to the change itself: zero. Two changes inside one trip.
        const first = await newVenue('c');
        const second = {
            ...first,
            pool: (await blockchain.treasury('pool-d')).address,
            primesVault: (await blockchain.treasury('primes-vault-d')).address,
        };
        for (const v of [first, second]) {
            const r = await updateVenue(v.nativeVault, v.pool, v.primesVault);
            expect(r.transactions).not.toHaveTransaction({ aborted: true });
            const venue = await ratchet.getVenue();
            expect(venue.dedustPool.equals(v.pool)).toBe(true);
            expect(venue.primesJettonVault.equals(v.primesVault)).toBe(true);
        }

        // The attacker cannot stack a second trip on the first (223), so one dust
        // trip is all there ever is to hold anything.
        const stacked = await ratchet.sendFlush(minter.getSender(), { value: FLUSH_VALUE, amount: 1n });
        expect(stacked.transactions).toHaveTransaction({ to: ratchet.address, success: false, exitCode: 223 });

        // Bound on the first flush to the NEW venue: FLUSH_STALE_TIMEOUT behind a
        // silent old vault. One second short it is still 223; at the bound it goes,
        // to the new native vault.
        const snap = blockchain.snapshot();
        const start = blockchain.now!;
        const stale = await ratchet.getFlushStaleSec();
        blockchain.now = start + stale - 1;
        const early = await ratchet.sendFlush(minter.getSender(), { value: FLUSH_VALUE });
        expect(early.transactions).toHaveTransaction({ to: ratchet.address, success: false, exitCode: 223 });
        blockchain.now = start + stale;
        const late = await ratchet.sendFlush(minter.getSender(), { value: FLUSH_VALUE });
        expect(late.transactions).toHaveTransaction({ from: ratchet.address, to: second.nativeVault, success: true });
        await blockchain.loadFrom(snap);
        blockchain.now = start;

        // And if the ORIGINAL vault does answer, the trip it answers is still the one
        // pinned at the first change — the second change did not re-pin it.
        const refund = await payoutFrom(mockVault.address, toNano('0.2'));
        expect(refund.transactions).not.toHaveTransaction({ aborted: true });
        expect(await ratchet.getInFlightFlush()).toBe(0n);
        expect(await ratchet.getPending()).toBe(pendingBefore);
        expect(await ratchet.getSwapped()).toBe(swappedBefore);
    });

    it('given_out is refused, exactly as real DeDust refuses it — not simulated by this mock', async () => {
        // Not reachable through handleFlush (it always sends given_in), so this
        // proves the MOCK's own fidelity to the documented schema rather than
        // anything about the ratchet — a sanity check on the test double itself.
        const T = await ledger.getFloorNum();
        const S = await ledger.getFloorDen();
        await mockVault.sendSetPrice(deployer.getSender(), { priceNum: S, priceDen: T, value: toNano('0.05') });

        const r = await minter.send({
            to: mockVault.address,
            value: toNano('1.1'),
            bounce: false,
            body: beginCell()
                .storeUint(0xea06185d, 32)
                .storeUint(0, 64)
                .storeCoins(toNano('1'))
                .storeAddress(poolStub.address)
                .storeUint(1, 1) // given_out — not given_in
                .storeCoins(0n)
                .storeUint(0, 1)
                .storeRef(
                    beginCell()
                        .storeUint(blockchain.now! + 600, 32)
                        .storeAddress(ratchet.address)
                        .storeUint(0, 2)
                        .storeUint(0, 1)
                        .storeUint(0, 1)
                        .endCell()
                )
                .endCell(),
        });
        expect(r.transactions).toHaveTransaction({ to: mockVault.address, success: false, exitCode: 1201 });
    });

    // ---- The refusal path's own guards. The two cases above prove a REFUSED
    //      flush recovers; these two prove the handler that recovers it cannot
    //      be driven by anyone else, and cannot wedge when there is nothing to
    //      recover.

    it('a payout#474f86cf from anyone but the venue vault is refused (wrong_sender)', async () => {
        // The handler has no queryId correlation — the sender gate IS the
        // correlation, so it is the whole of the authentication and a test that
        // does not pin it leaves the accounting forgeable: a stranger could
        // otherwise credit `pending` and clear `inFlightFlush` at will.
        const stranger = await blockchain.treasury('payout-stranger');
        const r = await stranger.send({
            to: ratchet.address,
            value: toNano('1'),
            bounce: false,
            body: beginCell().storeUint(0x474f86cf, 32).storeUint(0, 64).storeUint(0, 1).endCell(),
        });
        expect(r.transactions).toHaveTransaction({ to: ratchet.address, success: false, exitCode: 100 });
    });

    it('a payout with no round trip open is ACCEPTED and credits nothing — it must not throw', async () => {
        // `payout` is sent NON-bounceable, so a throw here would keep the GRAM
        // (it is credited in the credit phase, before compute) while reporting
        // the transaction as aborted — the exact half-state this handler exists
        // to prevent. And it must not invent backing either: `pending` is
        // mirrored by `T` on the LEDGER, which this contract cannot move, so
        // crediting unattributable GRAM would break §5's identity rather than
        // restore it.
        expect(await ratchet.getInFlightFlush()).toBe(0n);
        const pendingBefore = await ratchet.getPending();
        const swappedBefore = await ratchet.getSwapped();

        const r = await blockchain.sendMessage(
            internal({
                from: mockVault.address,
                to: ratchet.address,
                value: toNano('1'),
                bounce: false,
                body: beginCell().storeUint(0x474f86cf, 32).storeUint(0, 64).storeUint(0, 1).endCell(),
            })
        );

        expect(r.transactions).toHaveTransaction({ to: ratchet.address, success: true });
        expect(await ratchet.getPending()).toBe(pendingBefore);
        expect(await ratchet.getSwapped()).toBe(swappedBefore);
        expect(await ratchet.getInFlightFlush()).toBe(0n);
    });

    // =====================================================================
    // VENUE-DEPTH SIZING (2026-09-19) — `flush#b0000006`'s `amount`
    // =====================================================================
    //
    // The contract sizes its tranche off `pending` and prices `min_out` off the
    // POOL, and nothing connected the two: a tranche larger than the venue
    // could absorb bounced against a guard doing exactly its job, with the SPOT
    // price below the floor and the swap's AVERAGE execution price above it.
    // Measured on testnet at 7.7x above, spot 2.1x below, against a pool whose
    // entire PRIMES reserve was 7.2x short of `min_out`.
    //
    // TVM has no synchronous cross-contract call and DeDust publishes reserves
    // as a get-method, so the contract cannot read the venue. The CALLER sizes
    // the tranche and the contract clamps it. The mock vault prices linearly
    // rather than on a curve, so what is provable HERE is the clamp's own
    // contract — one-directional, pro-rata cooldown, `min_out` tracking the
    // chosen amount — while the curve arithmetic that picks the number is
    // proven in `webapp/src/components/FlushBrief/floorSizing.test.ts` against
    // the live pool's readings.

    /** `min(pending, max(pending * FLUSH_PCT, FLUSH_MIN))`, the contract's own rule. */
    const autoSizeOf = (pending: bigint) => {
        const pct = (pending * 200000000n) / 1000000000n;
        const raised = pct < toNano('5') ? toNano('5') : pct;
        return raised > pending ? pending : raised;
    };

    /** Price the mock exactly at the floor, which is the guard's boundary case. */
    const priceAtFloor = async () => {
        const T = await ledger.getFloorNum();
        const S = await ledger.getFloorDen();
        await mockVault.sendSetPrice(deployer.getSender(), { priceNum: S, priceDen: T, value: toNano('0.05') });
        return { T, S };
    };

    it('SIZING: a caller-supplied amount below the auto size is what gets swapped', async () => {
        await priceAtFloor();
        const pending = await ratchet.getPending();
        const auto = autoSizeOf(pending);
        const asked = auto / 4n;
        expect(asked).toBeGreaterThan(0n);

        const r = await ratchet.sendFlush(minter.getSender(), { value: FLUSH_VALUE, amount: asked });
        expect(r.transactions).toHaveTransaction({ from: ratchet.address, to: mockVault.address, success: true });

        // The ledger entries moved by the ASKED amount, not the auto size.
        expect((await ratchet.getFlushStatus()).amount).toBe(asked);
        expect(await ratchet.getPending()).toBe(pending - asked);
        expect(await ratchet.getSwapped()).toBe(asked);
    });

    it('SIZING: the amount is a CEILING the caller may lower, never raise', async () => {
        await priceAtFloor();
        const pending = await ratchet.getPending();
        const auto = autoSizeOf(pending);

        // Asking for ten times the register must not widen the tranche. A
        // permissionless caller may only ever ask for LESS, which is what makes
        // a stranger-chosen size safe at all.
        await ratchet.sendFlush(minter.getSender(), { value: FLUSH_VALUE, amount: pending * 10n });
        expect((await ratchet.getFlushStatus()).amount).toBe(auto);
        expect(await ratchet.getSwapped()).toBe(auto);
    });

    it('SIZING: 0 means "size it yourself" — every pre-existing caller is unchanged', async () => {
        await priceAtFloor();
        const auto = autoSizeOf(await ratchet.getPending());
        await ratchet.sendFlush(minter.getSender(), { value: FLUSH_VALUE }); // no amount
        expect((await ratchet.getFlushStatus()).amount).toBe(auto);
    });

    /**
     * THE GUARD IS PER-UNIT, which is the whole safety argument for letting a
     * stranger pick the size: `min_out = amount * S / T` is LINEAR in `amount`,
     * so no choice of amount can buy a nanoton above `p_f`. Asserted against
     * the contract's own published `lastMinOut`, not recomputed here.
     */
    it('SIZING: min_out tracks the chosen amount exactly, so the price cannot be gamed', async () => {
        const { T, S } = await priceAtFloor();
        const asked = autoSizeOf(await ratchet.getPending()) / 4n;
        await ratchet.sendFlush(minter.getSender(), { value: FLUSH_VALUE, amount: asked });
        expect(await ratchet.getLastMinOut()).toBe((asked * S) / T);
    });

    /**
     * THE COOLDOWN IS CHARGED PRO RATA, and it has to be. `FLUSH_COOLDOWN` rate
     * limits GRAM THROUGHPUT, not call count — key it to the call and a stranger
     * asking for one nanoton spends the whole day's allowance and locks the
     * real flush out behind it. A quarter-size tranche locks a quarter of the
     * window.
     */
    it('COOLDOWN: a quarter-size tranche locks a quarter of the window, not the whole day', async () => {
        await priceAtFloor();
        const auto = autoSizeOf(await ratchet.getPending());
        const asked = auto / 4n;
        await ratchet.sendFlush(minter.getSender(), { value: FLUSH_VALUE, amount: asked });

        // `cooldownSec * amount / autoSize`, in the contract's own integer order.
        // Restated here rather than written as 21600: `pending` is not a round
        // number, so `auto / 4n` truncates and a quarter of the day comes out at
        // 21599 — which is the arithmetic being correct, and hard-coding the
        // ideal would be a test asserting a rounding bug it does not have.
        const expected = Number((86400n * asked) / auto);
        expect(expected).toBeGreaterThan(21_000);
        expect(expected).toBeLessThan(22_000);
        expect(Number((await ratchet.getFlushStatus()).cooldownRemaining)).toBe(expected);

        // And the window really does open there: one second short throws 207,
        // one second on does not.
        blockchain.now = 1_770_000_000 + expected - 1;
        const early = await ratchet.sendFlush(minter.getSender(), { value: FLUSH_VALUE, amount: asked });
        expect(early.transactions).toHaveTransaction({ to: ratchet.address, success: false, exitCode: 207 });

        blockchain.now = 1_770_000_000 + expected;
        const ok = await ratchet.sendFlush(minter.getSender(), { value: FLUSH_VALUE, amount: asked });
        expect(ok.transactions).not.toHaveTransaction({ to: ratchet.address, success: false, exitCode: 207 });
        expect(ok.transactions).toHaveTransaction({ from: ratchet.address, to: mockVault.address, success: true });
    });

    it('COOLDOWN: a full-size tranche still locks the whole day, exactly as before', async () => {
        await priceAtFloor();
        await ratchet.sendFlush(minter.getSender(), { value: FLUSH_VALUE });
        expect(Number((await ratchet.getFlushStatus()).cooldownRemaining)).toBe(86400);
    });

    // =====================================================================
    // GAUNTLET.md G39 / DECISIONS.md D-146 — THE DRAIN, CLOSED BY CALLER-PAYS.
    //
    // Until D-146 these tests asserted the defect: a one-nanoton FILL incurred
    // zero cooldown (D-143's pro-rata arithmetic truncates) and every call spent
    // 0.20 GRAM of the ratchet's own gas buffer. The owner signed CALLER PAYS
    // (2026-09-22): the pro-rata cooldown stays exactly as it was, and the cost
    // moves to the caller, so the one-nanoton loop is now the caller's own
    // money and the buffer — `balance − pending` — cannot move down on any call.
    // =====================================================================

    // (The trace assertions below are scoped to the RATCHET: the mock vault also
    // stands in for the PRIMES wallet and refuses the burn-back with 101, which
    // is a property of the fixture, not of the contract under test.)
    async function buffer(): Promise<bigint> {
        return (await blockchain.getContract(ratchet.address)).balance - (await ratchet.getPending());
    }

    /** D-143's pro-rata cooldown is kept: a 1-nanoton tranche still incurs zero seconds and
     *  may repeat in the same second. What changed is WHO PAYS: each call's
     *  `DEDUST_SWAP_GAS` rides out of the caller's value and the change comes back, so the
     *  buffer ends every call where it began. */
    it('D-146: a 1-nanoton flush is repeatable, and the CALLER pays for it — the buffer never falls', async () => {
        const T = await ledger.getFloorNum();
        const S = await ledger.getFloorDen();
        await mockVault.sendSetPrice(deployer.getSender(), { priceNum: S, priceDen: T, value: toNano('0.05') });

        const before = await buffer();
        const callerBefore = await minter.getBalance();
        const first = await ratchet.sendFlush(minter.getSender(), { value: FLUSH_VALUE, amount: 1n });
        expect(first.transactions).not.toHaveTransaction({ on: ratchet.address, aborted: true });
        const mid = await buffer();

        const status = await ratchet.getFlushStatus();
        expect(status.outcome).toBe(FlushOutcome.Filled);
        expect(status.amount).toBe(1n);
        expect(status.cooldownRemaining).toBe(0); // D-143 unchanged

        // THE OWNER'S RULE: the gas & fees reserve is not affected by the call.
        expect(mid).toBeGreaterThanOrEqual(before);
        // ...because the caller paid the vault's gas.
        expect(callerBefore - (await minter.getBalance())).toBeGreaterThan(toNano('0.19'));

        const again = await ratchet.sendFlush(minter.getSender(), { value: FLUSH_VALUE, amount: 1n });
        expect(again.transactions).toHaveTransaction({ from: minter.address, to: ratchet.address, success: true });
        expect(again.transactions).not.toHaveTransaction({ on: ratchet.address, aborted: true });
        expect(await buffer()).toBeGreaterThanOrEqual(mid);
    });

    /** The change comes back: a caller who attaches 10 GRAM pays what the call costs and no
     *  more, and the buffer still does not move. */
    it('D-146: an over-funded flush returns the change to the caller', async () => {
        const T = await ledger.getFloorNum();
        const S = await ledger.getFloorDen();
        await mockVault.sendSetPrice(deployer.getSender(), { priceNum: S, priceDen: T, value: toNano('0.05') });

        const before = await buffer();
        const r = await ratchet.sendFlush(minter.getSender(), { value: toNano('10'), amount: 1n });
        expect(r.transactions).not.toHaveTransaction({ on: ratchet.address, aborted: true });
        expect(r.transactions).toHaveTransaction({ from: ratchet.address, to: minter.address, op: 0xd53276db });
        expect(await buffer()).toBeGreaterThanOrEqual(before);
    });

    /** Under-funded is a NAMED refusal (225), before anything moves. */
    it('D-146: a flush attaching less than DEDUST_SWAP_GAS + compute is refused 225 and moves nothing', async () => {
        const pendingBefore = await ratchet.getPending();
        const r = await ratchet.sendFlush(minter.getSender(), { value: FLUSH_VALUE - toNano('0.02') });
        expect(r.transactions).toHaveTransaction({ to: ratchet.address, exitCode: 225 });
        expect(await ratchet.getPending()).toBe(pendingBefore);
        expect(await ratchet.getInFlightFlush()).toBe(0n);
    });

    /** The CONTROL: a full-size tranche charges the whole day and the next call is refused
     *  with `ratchet_flush_cooldown`. */
    it('G39 control: a FULL-SIZE flush charges the whole cooldown and the next is refused 207', async () => {
        const T = await ledger.getFloorNum();
        const S = await ledger.getFloorDen();
        await mockVault.sendSetPrice(deployer.getSender(), { priceNum: S, priceDen: T, value: toNano('0.05') });

        await ratchet.sendFlush(minter.getSender(), { value: FLUSH_VALUE }); // amount 0 = auto-size
        expect((await ratchet.getFlushStatus()).cooldownRemaining).toBe(86_400);

        const after = (await blockchain.getContract(ratchet.address)).balance;
        const again = await ratchet.sendFlush(minter.getSender(), { value: FLUSH_VALUE });
        expect(again.transactions).toHaveTransaction({ to: ratchet.address, exitCode: 207 });
        // Refused before anything moved, so the buffer is untouched.
        expect((await blockchain.getContract(ratchet.address)).balance).toBe(after);
    });

    /** A refusal cycle: DeDust's `payout#474f86cf` hands the value back to the ratchet, so the
     *  buffer ends the cycle UP. (Against the mock, which returns the full value.) */
    it('G39: a REFUSED flush does not drain the buffer — the ratchet ends the cycle up', async () => {
        const T = await ledger.getFloorNum();
        const S = await ledger.getFloorDen();
        await mockVault.sendSetPrice(deployer.getSender(), { priceNum: S / 2n, priceDen: T, value: toNano('0.05') });

        const before = await buffer();
        const r = await ratchet.sendFlush(minter.getSender(), { value: FLUSH_VALUE });
        expect(r.transactions).not.toHaveTransaction({ on: ratchet.address, aborted: true });

        expect((await ratchet.getFlushStatus()).outcome).toBe(FlushOutcome.Bounced);
        expect(await buffer()).toBeGreaterThanOrEqual(before);
    });
});
