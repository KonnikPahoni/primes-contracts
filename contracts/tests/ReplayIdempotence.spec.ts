// TON PRIMES — D2: replay / duplicate delivery of the same message
// (GAUNTLET.md D2).
//
// WHY THIS IS A REAL ADVERSARY AND NOT A THOUGHT EXPERIMENT
//
// TON gives no exactly-once guarantee to anything outside a single transaction.
// A deploy script that times out and retries, a keeper that re-fires, a bounce
// handler that re-sends, an operator running the same wiring step twice because
// the first appeared to fail — every one of those delivers a byte-identical
// message a second time. The question D2 asks is what the contract does the
// second time, and the answer must be the same for all of them: **nothing that
// moves state.**
//
// WHAT WAS THERE. Seven scattered cases, each written for its own reason and
// each proving one arm: the founder seed rejects a second one (`FeeLines`), an
// a drained dividend
// claim is a no-op (`PrimesGenesisMint`), an already-retried credit ID is a
// cheap no-op (`RetryCredit`), an out-of-order voucher settles once
// (`PrimesVoucher`). Good tests; not a pass. Nothing said what the OTHER arms do,
// and there was no shared statement of what "handled a replay correctly" even
// means.
//
// WHAT THIS ADDS. One definition and one table. The definition:
//
//   A replay is handled correctly when the second delivery leaves the
//   protocol's observable state EXACTLY as the first left it — whether it
//   throws, or succeeds as a no-op. Which of the two it does is an
//   implementation choice; that state does not move is the invariant.
//
// So the assertion is on a state vector rather than on an exit code, and a
// handler that "succeeds" while double-crediting fails here even though it
// threw nothing, which is the failure a code-based test would miss.
//
// KNOWN GAP, DELIBERATELY NOT PAPERED OVER: `RecordMint` has no guard against a
// second write for the same `n` — that is GAUNTLET B5.1, escalated as D-51, and
// `RecordMintBounceGap.spec.ts` documents it. It is not re-tested here; a table
// that quietly included a known-broken arm as "covered" would be worse than one
// that names it.
import { Blockchain, SandboxContract, TreasuryContract } from '@ton/sandbox';
import { Address, beginCell, Cell, Sender, toNano } from '@ton/core';
import { PrimesVoucher } from '../wrappers/PrimesVoucher';
import { PrimesVenueTimelock } from '../wrappers/PrimesVenueTimelock';
import { PrimesItem } from '../wrappers/PrimesItem';
import '@ton/test-utils';
import { compile } from '@ton/blueprint';
import { PrimesLedger, FactorEntry } from '../wrappers/PrimesLedger';
import { PrimesRatchet, FLUSH_VALUE } from '../wrappers/PrimesRatchet';
import { PrimesRegistrar } from '../wrappers/PrimesRegistrar';
import { PrimesCollection } from '../wrappers/PrimesCollection';
import { PrimesJettonMaster } from '../wrappers/PrimesJettonMaster';
import { deployStack } from './helpers/stack';

const MINT_PRICE = toNano('1');
const OPENING_HEAD = 4n;

describe('TON PRIMES — D2: a replayed message never moves state twice', () => {
    let blockchain: Blockchain;
    let deployer: SandboxContract<TreasuryContract>;
    let genesisScript: SandboxContract<TreasuryContract>;
    let treasuryWallet: SandboxContract<TreasuryContract>;
    let player: SandboxContract<TreasuryContract>;

    let codes: Record<string, Cell>;
    let collection: SandboxContract<PrimesCollection>;
    let master: SandboxContract<PrimesJettonMaster>;
    let ledger: SandboxContract<PrimesLedger>;
    let ratchet: SandboxContract<PrimesRatchet>;
    let registrar: SandboxContract<PrimesRegistrar>;

    beforeAll(async () => {
        codes = {
            item: await compile('PrimesItem'),
            collection: await compile('PrimesCollection'),
            jettonWallet: await compile('PrimesJettonWallet'),
            jettonMaster: await compile('PrimesJettonMaster'),
            ledger: await compile('PrimesLedger'),
            ratchet: await compile('PrimesRatchet'),
            registrar: await compile('PrimesRegistrar'),
        };
    });

    beforeEach(async () => {
        blockchain = await Blockchain.create();
        blockchain.now = 1_770_000_000;
        deployer = await blockchain.treasury('deployer');
        genesisScript = await blockchain.treasury('genesisScript');
        treasuryWallet = await blockchain.treasury('treasury');
        player = await blockchain.treasury('player', { balance: toNano('500') });

        collection = blockchain.openContract(
            PrimesCollection.createFromConfig(
                {
                    nextIndex: 2n,
                    itemCode: codes.item,
                    ledgerAddr: deployer.address,
                    genesisScriptAddr: genesisScript.address,
                },
                codes.collection
            )
        );
        await collection.sendDeploy(deployer.getSender(), toNano('5'));

        master = blockchain.openContract(
            PrimesJettonMaster.createFromConfig(
                {
                    ledgerAddr: deployer.address,
                    genesisScriptAddr: genesisScript.address,
                    walletCode: codes.jettonWallet,
                },
                codes.jettonMaster
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
                        itemCode: codes.item,
                    },
                    b: { genesisScriptAddr: genesisScript.address },
                },
                codes.ledger
            )
        );
        await ledger.sendDeploy(deployer.getSender(), toNano('20'));

        ratchet = blockchain.openContract(
            PrimesRatchet.createFromConfig(
                {
                    venueTimelockAddr: deployer.address,
                    genesisScriptAddr: genesisScript.address,
                    dedustNativeVault: deployer.address,
                    dedustPool: deployer.address,
                    primesJettonVault: deployer.address,
                },
                codes.ratchet
            )
        );
        await ratchet.sendDeploy(deployer.getSender(), toNano('10'));

        registrar = blockchain.openContract(
            PrimesRegistrar.createFromConfig({ genesisScriptAddr: genesisScript.address }, codes.registrar)
        );
        await registrar.sendDeploy(deployer.getSender(), toNano('5'));

        await ratchet.sendSetLedger(genesisScript.getSender(), { ledgerAddr: ledger.address, value: toNano('0.05') });
        await registrar.sendSetLedger(genesisScript.getSender(), { ledgerAddr: ledger.address, value: toNano('0.05') });
        await ledger.sendSetSinks(genesisScript.getSender(), {
            ratchetAddr: ratchet.address,
            registrarAddr: registrar.address,
            value: toNano('0.05'),
        });
        await collection.sendSetLedger(genesisScript.getSender(), { ledgerAddr: ledger.address, value: toNano('0.05') });
        await master.sendSetLedger(genesisScript.getSender(), { ledgerAddr: ledger.address, value: toNano('0.05') });
        await master.sendSealAuthority(genesisScript.getSender(), { value: toNano('0.05') });
        await ledger.sendGenesisSeed(genesisScript.getSender(), {
            seedT: toNano('1000'),
            seedS: 1_200_000_000_000_000n,
            seedHead: OPENING_HEAD,
            value: toNano('0.05'),
        });
        await ledger.sendIgnite(genesisScript.getSender(), { owner: deployer.address, value: toNano('0.3') });
    });

    // ------------------------------------------------------------------ //
    // The definition of "handled a replay correctly"
    // ------------------------------------------------------------------ //

    /**
     * The protocol's observable state, in one reading.
     *
     * Deliberately NOT contract balances: a replayed message costs gas whether it
     * throws or no-ops, so balances legitimately move and including them would
     * make every row fail for the wrong reason. Everything here is a declared
     * quantity — supply, backing, liability, counters — and none of it may move
     * on a duplicate delivery.
     */
    async function snapshot(): Promise<Record<string, string>> {
        const br = await ledger.getLiabilityBreakdown();
        const ops = await ledger.getOperatorTotals();
        return {
            'ledger.T': (await ledger.getFloorNum()).toString(),
            'ledger.S': (await ledger.getFloorDen()).toString(),
            'ledger.head': (await ledger.getHead()).toString(),
            'ledger.primesCount': String(await ledger.getPrimesCount()),
            'ledger.divAcc': (await ledger.getDivAcc()).toString(),
            'ledger.seedT': (await ledger.getSeedT()).toString(),
            'ledger.tributeOwed': br.tributeOwed.toString(),
            'ledger.unroutedHeld': br.unroutedHeld.toString(),
            'ledger.divOutstanding': br.divOutstanding.toString(),
            'ledger.treasuryPaid': ops.treasuryPaidTotal.toString(),
            'ledger.opsSwept': ops.opsSweptTotal.toString(),
            'ratchet.pending': (await ratchet.getPending()).toString(),
            'ratchet.swapped': (await ratchet.getSwapped()).toString(),
        };
    }

    /**
     * Deliver the same message a second time and require that nothing moved.
     *
     * The assertion is on STATE, not on an exit code. A handler that throws and a
     * handler that succeeds as a no-op are both correct; a handler that
     * "succeeds" while crediting something twice is not, and only a state check
     * catches that one.
     */
    async function replayIsInert(label: string, send: () => Promise<unknown>) {
        const before = await snapshot();
        await send();
        const after = await snapshot();
        expect({ label, state: after }).toEqual({ label, state: before });
    }

    // ------------------------------------------------------------------ //
    // One-shot wiring and genesis — what a retrying deploy script replays
    // ------------------------------------------------------------------ //

    describe('the one-shot wiring messages, all already applied by the fixture', () => {
        it('SetSinks on the ledger', async () => {
            await replayIsInert('ledger.set_sinks', () =>
                ledger.sendSetSinks(genesisScript.getSender(), {
                    // Deliberately DIFFERENT addresses: a replay that merely
                    // re-applied the same values would look inert whatever the
                    // guard does. Pointing the sinks at the deployer means an
                    // unguarded handler would visibly repoint them.
                    ratchetAddr: deployer.address,
                    registrarAddr: deployer.address,
                    value: toNano('0.05'),
                })
            );
            // and the sinks still name the real peers
            const sinks = await ledger.getSinks();
            expect(sinks.ratchetAddr.equals(ratchet.address)).toBe(true);
            expect(sinks.registrarAddr.equals(registrar.address)).toBe(true);
        });

        it('SetLedger on the ratchet', async () => {
            await replayIsInert('ratchet.set_ledger', () =>
                ratchet.sendSetLedger(genesisScript.getSender(), {
                    ledgerAddr: deployer.address,
                    value: toNano('0.05'),
                })
            );
        });

        it('SetLedger on the registrar', async () => {
            await replayIsInert('registrar.set_ledger', () =>
                registrar.sendSetLedger(genesisScript.getSender(), {
                    ledgerAddr: deployer.address,
                    value: toNano('0.05'),
                })
            );
        });

        it('SetLedger on the collection', async () => {
            await replayIsInert('collection.set_ledger', () =>
                collection.sendSetLedger(genesisScript.getSender(), {
                    ledgerAddr: deployer.address,
                    value: toNano('0.05'),
                })
            );
        });

        it('SetLedger on the jetton master', async () => {
            await replayIsInert('master.set_ledger', () =>
                master.sendSetLedger(genesisScript.getSender(), {
                    ledgerAddr: deployer.address,
                    value: toNano('0.05'),
                })
            );
        });

        it('SealAuthority on the jetton master', async () => {
            await replayIsInert('master.seal_authority', () =>
                master.sendSealAuthority(genesisScript.getSender(), { value: toNano('0.05') })
            );
        });

        it('GenesisSeed on the ledger — a second seed must not re-credit T', async () => {
            // The one with real money behind it: a replayed seed that landed
            // would inflate the floor's numerator by a founder allocation nobody
            // sent twice. Replayed with DIFFERENT figures for the same reason as
            // SetSinks above.
            await replayIsInert('ledger.genesis_seed', () =>
                ledger.sendGenesisSeed(genesisScript.getSender(), {
                    seedT: toNano('999'),
                    seedS: 7n,
                    seedHead: 100n,
                    value: toNano('0.05'),
                })
            );
            expect(await ledger.getSeedT()).toBe(toNano('1000'));
        });

        it('Ignite on the ledger — Unity is minted once', async () => {
            // §6 point 0. A second ignite that landed would mint a second Unity
            // and re-flip a flag that is meant to be terminal.
            await replayIsInert('ledger.ignite', () =>
                ledger.sendIgnite(genesisScript.getSender(), { owner: player.address, value: toNano('0.3') })
            );
            expect((await ledger.getLaunch()).launched).toBe(true);
        });
    });

    // ------------------------------------------------------------------ //
    // Player and crank paths — what a retrying wallet or keeper replays
    // ------------------------------------------------------------------ //

    describe('the money-moving paths', () => {
        const FACTORS_4: FactorEntry[] = [{ prime: 2n, exponent: 2, s: 1n }];

        async function mintFour() {
            const r = await ledger.sendMint(player.getSender(), {
                n: 4n,
                kind: 0,
                factors: FACTORS_4,
                referralKey: 0,
                beneficiary: null,
                value: MINT_PRICE,
            });
            expect(r.transactions).toHaveTransaction({ to: ledger.address, success: true });
            return r;
        }

        it('Mint of the same n — the head has moved, so the replay cannot land', async () => {
            await mintFour();
            // The replay carries its own GRAM, as a real duplicate would. Nothing
            // may be credited for it: no second item, no second injection.
            await replayIsInert('ledger.mint(4)', () =>
                ledger.sendMint(player.getSender(), {
                    n: 4n,
                    kind: 0,
                    factors: FACTORS_4,
                    referralKey: 0,
                    beneficiary: null,
                    value: MINT_PRICE,
                })
            );
            expect(await ledger.getHead()).toBeGreaterThan(4n);
        });

        it('ClaimDividend for an unsold prime — refused, and the replay moves nothing either', async () => {
            // §3.2's flat dividend. `claimable(p) = div_acc - entry[p]`, and a
            // claim RE-STAMPS `entry[p]` — the arm where a missing guard would
            // be most expensive, since `div_acc` is global and monotone and a
            // double claim pays a prime twice out of a pool sized for one.
            //
            // THIS FIXTURE HAS NO MARKET, so under D-20 every prime in it is
            // eligible-but-unsold: 2 and 3 from the genesis walk, 5 from the
            // head advance. Their items are only deployed when the lot is BOUGHT
            // (D-90 mints in the closing transaction), so `claim_dividend` here
            // hits error 219 — the guard that stops the credit being sent to a
            // nonexistent item, bouncing, and being filed under `p = 0` where
            // `retry_credit` can never route it again.
            //
            // A refusal is a correct replay outcome by this file's own
            // definition: what matters is that state does not move, not which
            // of throw/no-op the handler chooses. The SOLD-prime path — first
            // claim credits, replay is a cheap no-op — is covered in
            // `PrimesGenesisMint.spec.ts`, which has the market fixture.
            await mintFour();
            const claimableBefore = await ledger.getClaimableDividend(2n);
            const stampBefore = await ledger.getDivEntry(2n);
            const first = await ledger.sendClaimDividend(player.getSender(), { p: 2n, value: toNano('0.05') });
            expect(first.transactions).toHaveTransaction({ to: ledger.address, success: false, exitCode: 219 });
            await replayIsInert('ledger.claim_dividend', () =>
                ledger.sendClaimDividend(player.getSender(), { p: 2n, value: toNano('0.05') })
            );
            // the stamp never moved, so the accrual is intact and still owed to
            // whoever eventually buys the lot — deferred, not forfeited
            expect(await ledger.getDivEntry(2n)).toBe(stampBefore);
            expect(await ledger.getClaimableDividend(2n)).toBe(claimableBefore);
            // and there was something to claim — otherwise the row proves nothing
            expect(claimableBefore).toBeGreaterThan(0n);
        });

        it('SweepOps — the second sweep finds nothing new above the reserve', async () => {
            await mintFour();
            await ledger.sendSweepOps(player.getSender(), { value: toNano('0.05') });
            const sweptAfterFirst = (await ledger.getOperatorTotals()).opsSweptTotal;
            await replayIsInert('ledger.sweep_ops', () =>
                ledger.sendSweepOps(player.getSender(), { value: toNano('0.05') })
            );
            expect((await ledger.getOperatorTotals()).opsSweptTotal).toBe(sweptAfterFirst);
        });

        it('SyncHead — a permissionless crank, inert on repetition by construction', async () => {
            await mintFour();
            await ledger.sendSyncHead(player.getSender(), { value: toNano('0.05') });
            await replayIsInert('ledger.sync_head', () =>
                ledger.sendSyncHead(player.getSender(), { value: toNano('0.05') })
            );
        });

        it('Flush inside the cooldown — the second is refused and `pending` is untouched', async () => {
            await mintFour();
            await ratchet.sendFlush(player.getSender(), { value: FLUSH_VALUE });
            await replayIsInert('ratchet.flush', () =>
                ratchet.sendFlush(player.getSender(), { value: FLUSH_VALUE })
            );
        });
    });

    // ------------------------------------------------------------------ //
    // The definition is only worth something if it can fail
    // ------------------------------------------------------------------ //

    it('the snapshot is sensitive: a REAL state change is detected', async () => {
        // A vector that could not go red would make every row above vacuous.
        // A genuine mint must move it — and this is the control that says so.
        const before = await snapshot();
        await ledger.sendMint(player.getSender(), {
            n: 4n,
            kind: 0,
            factors: [{ prime: 2n, exponent: 2, s: 1n }],
            referralKey: 0,
            beneficiary: null,
            value: MINT_PRICE,
        });
        const after = await snapshot();
        expect(after).not.toEqual(before);
        // and specifically the components a double-credit would move
        expect(BigInt(after['ledger.T'])).toBeGreaterThan(BigInt(before['ledger.T']));
        expect(BigInt(after['ledger.head'])).toBeGreaterThan(BigInt(before['ledger.head']));
    });
});

// `set_peers` (ledger.tolk handleSetPeers) names the ONE sender of `mint_won_lot`,
// `settle_prime_clearing`, `mark_off_head` and the bounty-vault calls. A replay or a
// stranger that could re-point it would hand the market's mint authority to anyone.
describe('TON PRIMES — D2: SetPeers on the ledger is one-shot and genesis-only', () => {
    it('a replay from the genesis script is refused (104) and the peers do not move', async () => {
        const s = await deployStack();
        const attacker = await s.blockchain.treasury('attacker');
        const peers = async () => {
            const p = await s.ledger.getPeers();
            return { market: p.marketAddr.toString(), vault: p.bountyVaultAddr.toString(), peersSet: p.peersSet };
        };
        const before = await peers();
        expect(before).toEqual({ market: s.market.address.toString(), vault: s.vault.address.toString(), peersSet: 1 });

        const r = await s.ledger.sendSetPeers(s.genesisScript.getSender(), {
            marketAddr: attacker.address,
            bountyVaultAddr: attacker.address,
            value: toNano('0.05'),
        });
        expect(r.transactions).toHaveTransaction({ to: s.ledger.address, success: false, exitCode: 104 });
        expect(await peers()).toEqual(before);
    });

    it('a stranger is refused (100) BEFORE wiring, and the genesis script can still wire it', async () => {
        const bc = await Blockchain.create();
        const deployer = await bc.treasury('deployer');
        const genesisScript = await bc.treasury('genesisScript');
        const attacker = await bc.treasury('attacker');
        const market = await bc.treasury('market');
        const ledger = bc.openContract(
            PrimesLedger.createFromConfig(
                {
                    a: {
                        collectionAddr: deployer.address,
                        jettonMasterAddr: deployer.address,
                        treasuryAddr: deployer.address,
                        itemCode: await compile('PrimesItem'),
                    },
                    b: { genesisScriptAddr: genesisScript.address },
                },
                await compile('PrimesLedger')
            )
        );
        await ledger.sendDeploy(deployer.getSender(), toNano('10'));
        expect((await ledger.getPeers()).peersSet).toBe(0);

        const r = await ledger.sendSetPeers(attacker.getSender(), {
            marketAddr: attacker.address,
            bountyVaultAddr: attacker.address,
            value: toNano('0.05'),
        });
        expect(r.transactions).toHaveTransaction({ to: ledger.address, success: false, exitCode: 100 });
        expect((await ledger.getPeers()).peersSet).toBe(0);

        const ok = await ledger.sendSetPeers(genesisScript.getSender(), {
            marketAddr: market.address,
            bountyVaultAddr: market.address,
            value: toNano('0.05'),
        });
        expect(ok.transactions).not.toHaveTransaction({ aborted: true });
        const after = await ledger.getPeers();
        expect(after.peersSet).toBe(1);
        expect(after.marketAddr.equals(market.address)).toBe(true);
    });
});

// The one-shot setters the table above does not reach: the voucher's vault, the
// registrar's collection (and its ledger from a stranger), and the venue
// timelock's ratchet — the address `execute` sends `update_venue` to, so the one
// that governs where the flush venue can be re-pointed (CLAUDE.md, D-194). Each is
// proved the same way: a stranger is refused (100) BEFORE wiring, the genesis
// script wires it, and a replay with a DIFFERENT target is refused (104). The
// state check is the account's whole data cell, so "refused" cannot hide a write.
describe('TON PRIMES — D2: every other one-shot setter refuses a stranger (100) and a replay (104)', () => {
    let bc: Blockchain;
    let deployer: SandboxContract<TreasuryContract>;
    let genesisScript: SandboxContract<TreasuryContract>;
    let stranger: SandboxContract<TreasuryContract>;

    beforeEach(async () => {
        bc = await Blockchain.create();
        deployer = await bc.treasury('deployer');
        genesisScript = await bc.treasury('genesisScript');
        stranger = await bc.treasury('stranger');
    });

    async function dataOf(addr: Address): Promise<string> {
        const st = (await bc.getContract(addr)).accountState;
        if (st?.type !== 'active') throw new Error(`${addr} is not active`);
        return st.state.data!.hash().toString('hex');
    }

    async function provesOneShot(addr: Address, send: (via: Sender, target: Address) => Promise<any>) {
        const first = (await bc.treasury('target-1')).address;
        const second = (await bc.treasury('target-2')).address;
        const fresh = await dataOf(addr);

        const s = await send(stranger.getSender(), stranger.address);
        expect(s.transactions).toHaveTransaction({ to: addr, success: false, exitCode: 100 }); // wrong_sender
        expect(await dataOf(addr)).toBe(fresh);

        const ok = await send(genesisScript.getSender(), first);
        expect(ok.transactions).not.toHaveTransaction({ aborted: true });
        const wired = await dataOf(addr);
        expect(wired).not.toBe(fresh);

        const replay = await send(genesisScript.getSender(), second);
        expect(replay.transactions).toHaveTransaction({ to: addr, success: false, exitCode: 104 }); // already_processed
        expect(await dataOf(addr)).toBe(wired);
        return first;
    }

    it('voucher set_vault', async () => {
        const voucher = bc.openContract(
            PrimesVoucher.createFromConfig(
                {
                    signerPubkey: Buffer.alloc(32, 7),
                    vaultAddr: genesisScript.address, // placeholder, as genesis deploys it
                    genesisScriptAddr: genesisScript.address,
                    receiptCode: await compile('PrimesClaimReceipt'),
                    maxPerWallet: 1_000_000_000n, // R2-M2; any figure — this spec is about the wiring
                },
                await compile('PrimesVoucher')
            )
        );
        await voucher.sendDeploy(deployer.getSender(), toNano('1'));
        expect((await voucher.getVault()).vaultSet).toBe(false);
        // Unwired, the program can pay nobody: a claim is refused before any signature check (715).
        const early = await voucher.sendClaim(stranger.getSender(), {
            cumulativeTotal: 1n, validUntil: 2_000_000_000, signature: Buffer.alloc(64), value: toNano('0.3'),
        });
        expect(early.transactions).toHaveTransaction({ to: voucher.address, success: false, exitCode: 715 }); // voucher_vault_unset
        const vault = await provesOneShot(voucher.address, (via, t) => voucher.sendSetVault(via, { vaultAddr: t, value: toNano('0.05') }));
        const v = await voucher.getVault();
        expect(v.vaultSet).toBe(true);
        expect(v.vaultAddr.equals(vault)).toBe(true);
    });

    it('registrar set_collection, and set_ledger from a stranger', async () => {
        const registrar = bc.openContract(
            PrimesRegistrar.createFromConfig({ genesisScriptAddr: genesisScript.address }, await compile('PrimesRegistrar'))
        );
        await registrar.sendDeploy(deployer.getSender(), toNano('1'));
        const collection = await provesOneShot(registrar.address, (via, t) =>
            registrar.sendSetCollection(via, { collectionAddr: t, value: toNano('0.05') })
        );
        const p = await registrar.getPeers();
        expect(p.collectionSet).toBe(1);
        expect(p.collectionAddr!.equals(collection)).toBe(true);

        // set_ledger's replay is in the table above; its stranger refusal is here.
        const before = await dataOf(registrar.address);
        const s = await registrar.sendSetLedger(stranger.getSender(), { ledgerAddr: stranger.address, value: toNano('0.05') });
        expect(s.transactions).toHaveTransaction({ to: registrar.address, success: false, exitCode: 100 });
        expect(await dataOf(registrar.address)).toBe(before);
    });

    it('venue timelock set_ratchet — the update_venue target', async () => {
        const timelock = bc.openContract(
            PrimesVenueTimelock.createFromConfig(
                {
                    proposerAddr: deployer.address,
                    governanceAddr: deployer.address,
                    ratchetAddr: deployer.address, // placeholder pre-SetRatchet (D11)
                    genesisScriptAddr: genesisScript.address,
                },
                await compile('PrimesVenueTimelock')
            )
        );
        await timelock.sendDeploy(deployer.getSender(), toNano('1'));
        await provesOneShot(timelock.address, (via, t) => timelock.sendSetRatchet(via, { ratchetAddr: t, value: toNano('0.05') }));
    });
});

// §6 point 2 / D-196: a prime behind the head sells ONCE. The market's sold bit
// is the first guard; `executeMint`'s 235 is the one "where the money lands".
// It is reached here by REPLAYING the market's own real `settle_prime_clearing`
// for a prime that already sold. The replay is sent non-bounceable so the
// assertion is the ledger's refusal alone — the market's bounce arm for that
// opcode is `BounceCoverage.spec.ts`'s subject.
describe('TON PRIMES — D2: a replayed prime settle is refused where the money lands (235)', () => {
    it('settle_prime_clearing for a prime already sold behind the head', async () => {
        const s = await deployStack();
        const p = 3n;
        expect(await s.ledger.getHead()).toBeGreaterThan(p);
        const bought = await s.acquire(s.alice, p);
        const settle = bought.transactions.find(
            (t: any) =>
                t.inMessage?.info?.type === 'internal' &&
                t.inMessage.info.src.equals(s.market.address) &&
                t.inMessage.info.dest.equals(s.ledger.address) &&
                t.inMessage.body.beginParse().preloadUint(32) === 0xb0000024
        );
        expect(settle).toBeDefined();
        expect(settle.description.aborted).toBe(false);
        const item = s.blockchain.openContract(PrimesItem.createFromAddress(await s.ledger.getItemAddress(p)));
        expect((await item.getNumberData()).owner.equals(s.alice.address)).toBe(true);
        const T = await s.ledger.getFloorNum();
        const S = await s.ledger.getFloorDen();

        const msg = settle.inMessage;
        const r = await s.blockchain.sendMessage({ ...msg, info: { ...msg.info, bounce: false } });
        expect(r.transactions).toHaveTransaction({ from: s.market.address, to: s.ledger.address, success: false, exitCode: 235 }); // ledger_prime_already_owned
        expect(r.transactions).not.toHaveTransaction({ from: s.ledger.address, to: s.collection.address });
        expect((await item.getNumberData()).owner.equals(s.alice.address)).toBe(true);
        expect(await s.ledger.getFloorNum()).toBe(T);
        expect(await s.ledger.getFloorDen()).toBe(S);
    });
});
