// TON PRIMES — D11: auction griefing — dust bids, self-bidding, opening lots to
// deny the head (GAUNTLET.md D11).
//
// THREE VECTORS, AND THEY HAVE THREE DIFFERENT ANSWERS. Saying which is which
// matters more than the individual tests, because two of the three are defended
// by ECONOMICS rather than by a refusal, and a reviewer looking for asserts
// would conclude the lane is undefended.
//
//   dust bids       REFUSED outright. `minIncrementOn` is a percentage of the
//                   standing bid (D-33's 15%→20% ladder) with a nanoton floor,
//                   and `bid` measures `in.valueCoins` against it. A raise of
//                   one nanoton is not a small raise, it is not a raise.
//
//   holding a lot   ALLOWED, and priced. The anti-snipe extension is the max()
//   open by         form — `closesAt = max(closesAt, now + BID_EXTENSION)` — so
//   re-bidding      a bid never STACKS time, it only pushes the close to 67
//                   minutes out. A griefer can therefore keep a lot open, but
//                   every extension costs another minimum increment, and the
//                   increment is a PERCENTAGE. The defence is that the price
//                   compounds, not that the clock refuses to move.
//
//   self-bidding    ALLOWED, and pointless. Outbidding yourself refunds your own
//                   previous bid and re-escrows a higher one; you extend the
//                   clock and pay the increment to do it. Nothing forbids it
//                   because nothing needs to.
//
//   denying the     ALREADY ANSWERED ELSEWHERE, and not re-litigated here.
//   head            D-45 deleted `MIN_AUCTION_DISTANCE` and made the head SKIP a
//                   reserved composite rather than ever collide with one, so a
//                   lot cannot stall the sequential line. `PrimesMarket.spec.ts`
//                   proves the deleted gates stay gone. The remaining half —
//                   that anyone can buy a permanent storage entry for ~0.02 TON
//                   of gas — is escalated as **D-50** and is a storage-growth
//                   question, not a liveness one.
import { Blockchain, SandboxContract, TreasuryContract } from '@ton/sandbox';
import { Cell, toNano } from '@ton/core';
import '@ton/test-utils';
import { compile } from '@ton/blueprint';
import { PrimesMarket } from '../wrappers/PrimesMarket';
import { PrimesLedger } from '../wrappers/PrimesLedger';
import { PrimesRatchet } from '../wrappers/PrimesRatchet';
import { PrimesRegistrar } from '../wrappers/PrimesRegistrar';
import { PrimesCollection } from '../wrappers/PrimesCollection';
import { PrimesJettonMaster } from '../wrappers/PrimesJettonMaster';
import { testMarketConfig, OPENING_HEAD, RESERVABLE_12, BID_GAS } from './helpers/market';

/** `mkt_bid_below_minimum`. */
const EXIT_BID_BELOW_MIN = 1004;

describe('TON PRIMES — D11: the ascending lane under a griefer', () => {
    let blockchain: Blockchain;
    let deployer: SandboxContract<TreasuryContract>;
    let genesisScript: SandboxContract<TreasuryContract>;
    let treasuryWallet: SandboxContract<TreasuryContract>;
    let opener: SandboxContract<TreasuryContract>;
    let griefer: SandboxContract<TreasuryContract>;
    let codes: Record<string, Cell>;
    let market: SandboxContract<PrimesMarket>;

    beforeAll(async () => {
        codes = {
            item: await compile('PrimesItem'),
            collection: await compile('PrimesCollection'),
            jettonWallet: await compile('PrimesJettonWallet'),
            jettonMaster: await compile('PrimesJettonMaster'),
            ledger: await compile('PrimesLedger'),
            ratchet: await compile('PrimesRatchet'),
            registrar: await compile('PrimesRegistrar'),
            market: await compile('PrimesMarket'),
        };
    });

    beforeEach(async () => {
        blockchain = await Blockchain.create();
        blockchain.now = 1_770_000_000;
        deployer = await blockchain.treasury('deployer');
        genesisScript = await blockchain.treasury('genesisScript');
        treasuryWallet = await blockchain.treasury('treasury');
        opener = await blockchain.treasury('opener', { balance: toNano('20000') });
        griefer = await blockchain.treasury('griefer', { balance: toNano('20000') });

        const collection = blockchain.openContract(
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
        const master = blockchain.openContract(
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
        const ledger = blockchain.openContract(
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
        const ratchet = blockchain.openContract(
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
        const registrar = blockchain.openContract(
            PrimesRegistrar.createFromConfig({ genesisScriptAddr: genesisScript.address }, codes.registrar)
        );
        await registrar.sendDeploy(deployer.getSender(), toNano('5'));

        market = blockchain.openContract(
            PrimesMarket.createFromConfig(
                testMarketConfig({
                    headHint: OPENING_HEAD,
                    ledgerAddr: ledger.address,
                    ratchetAddr: ratchet.address,
                }),
                codes.market
            )
        );
        await market.sendDeploy(deployer.getSender(), toNano('5'));

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
        await ledger.sendSetPeers(genesisScript.getSender(), {
            marketAddr: market.address,
            bountyVaultAddr: treasuryWallet.address,
            value: toNano('0.05'),
        });
        await ledger.sendIgnite(genesisScript.getSender(), { owner: deployer.address, value: toNano('0.3') });
    });

    /** Open an ascending lot on RESERVABLE_12 — D-30: opening IS the first bid. */
    async function openLot() {
        // Phase 3 (PRICING_MODEL_PLAN.md §4): `open_lot` prices a composite off the
        // factorization it is sent, so the quote is asked the same way — the
        // from-`n` quote is a lower bound and would fund the open short.
        const { p0 } = await market.getLotPriceFrom(RESERVABLE_12.n, RESERVABLE_12.factors);
        const r = await market.sendOpenLot(opener.getSender(), {
            n: RESERVABLE_12.n,
            kind: 0, // composite — the ascending lane is composites only (D-22)
            factors: RESERVABLE_12.factors,
            beneficiary: null,
            referralKey: 0,
            value: p0 + toNano('0.2'),
        });
        expect(r.transactions).toHaveTransaction({ to: market.address, success: true });
        return p0;
    }

    // ------------------------------------------------------------------ //
    // Dust bids — refused
    // ------------------------------------------------------------------ //

    describe('dust bids are refused, not merely uneconomic', () => {
        it('a one-nanoton raise over the standing bid is rejected', async () => {
            await openLot();
            const lot = await market.getLot(RESERVABLE_12.n);
            const r = await market.sendBid(griefer.getSender(), {
                n: RESERVABLE_12.n,
                beneficiary: null,
                referralKey: 0,
                value: lot.highBid + 1n,
            });
            expect(r.transactions).toHaveTransaction({
                to: market.address,
                success: false,
                exitCode: EXIT_BID_BELOW_MIN,
            });
            // and the lot is untouched — no bidder change, no clock movement
            const after = await market.getLot(RESERVABLE_12.n);
            expect(after.highBid).toBe(lot.highBid);
            expect(after.closesAt).toBe(lot.closesAt);
        });

        it('anything below the published minimum is rejected, and the minimum is published', async () => {
            // §9.1: the minimum raise is readable, so a griefer's failure is not
            // a surprise and an honest bidder never guesses. `minPayment` IS the
            // number `bid` measures against.
            await openLot();
            const lot = await market.getLot(RESERVABLE_12.n);
            expect(lot.minPayment).toBeGreaterThan(lot.highBid);

            const r = await market.sendBid(griefer.getSender(), {
                n: RESERVABLE_12.n,
                beneficiary: null,
                referralKey: 0,
                value: lot.minPayment - 1n,
            });
            expect(r.transactions).toHaveTransaction({
                to: market.address,
                success: false,
                exitCode: EXIT_BID_BELOW_MIN,
            });
        });

        it('exactly the minimum is ACCEPTED — the boundary is inclusive, so honest bidders are not squeezed', async () => {
            // The control. A guard that rejected the published minimum would
            // make every quoted price a lie by one nanoton.
            await openLot();
            const lot = await market.getLot(RESERVABLE_12.n);
            const r = await market.sendBid(griefer.getSender(), {
                n: RESERVABLE_12.n,
                beneficiary: null,
                referralKey: 0,
                value: lot.minPayment,
            });
            expect(r.transactions).toHaveTransaction({ to: market.address, success: true });
            expect((await market.getLot(RESERVABLE_12.n)).highBid).toBe(lot.minPayment - BID_GAS); // V23
        });
    });

    // ------------------------------------------------------------------ //
    // Holding a lot open — allowed, and priced
    // ------------------------------------------------------------------ //

    describe('holding a lot open is defended by COMPOUNDING PRICE, not by refusal', () => {
        it('the minimum raise is a PERCENTAGE, so each extension costs more than the last', async () => {
            // The economic defence, made concrete. A griefer who re-bids to keep
            // a lot alive is not paying a flat toll — the required raise grows
            // with the standing bid, so the cost of the n-th extension grows
            // geometrically. This is D-33's ladder doing its job.
            await openLot();
            const increments: bigint[] = [];
            for (let i = 0; i < 5; i++) {
                const lot = await market.getLot(RESERVABLE_12.n);
                increments.push(lot.minPayment - lot.highBid);
                const r = await market.sendBid(griefer.getSender(), {
                    n: RESERVABLE_12.n,
                    beneficiary: null,
                    referralKey: 0,
                    value: lot.minPayment,
                });
                expect(r.transactions).toHaveTransaction({ to: market.address, success: true });
            }
            // Strictly rising, every step — not merely bigger at the end.
            for (let i = 1; i < increments.length; i++) {
                expect({ step: i, rising: increments[i] > increments[i - 1] }).toEqual({
                    step: i,
                    rising: true,
                });
            }
            // And meaningfully so: five extensions roughly double the toll.
            expect(increments[4]).toBeGreaterThan((increments[0] * 3n) / 2n);
        }, 120_000);

        it('the anti-snipe extension is the max() form — a bid never STACKS time', async () => {
            // `closesAt = max(closesAt, now + BID_EXTENSION)`. The distinction
            // matters: a `+=` form would let a griefer add 67 minutes per bid
            // and push the close arbitrarily far with cheap early bids. The
            // max() form means an EARLY bid moves the close not at all.
            await openLot();
            const opened = await market.getLot(RESERVABLE_12.n);
            expect(opened.closesAt).toBeGreaterThan(0);

            // A bid placed immediately, days before the close, must not extend.
            const lot = await market.getLot(RESERVABLE_12.n);
            await market.sendBid(griefer.getSender(), {
                n: RESERVABLE_12.n,
                beneficiary: null,
                referralKey: 0,
                value: lot.minPayment,
            });
            expect((await market.getLot(RESERVABLE_12.n)).closesAt).toBe(opened.closesAt);
        });

        it('...and a LATE bid extends to exactly BID_EXTENSION from now, once', async () => {
            const params = await market.getMarketParams();
            await openLot();
            const opened = await market.getLot(RESERVABLE_12.n);

            // Jump to one minute before the close, then bid.
            blockchain.now = opened.closesAt - 60;
            const lot = await market.getLot(RESERVABLE_12.n);
            await market.sendBid(griefer.getSender(), {
                n: RESERVABLE_12.n,
                beneficiary: null,
                referralKey: 0,
                value: lot.minPayment,
            });
            const after = await market.getLot(RESERVABLE_12.n);
            expect(after.closesAt).toBe(blockchain.now! + params.bidExtension);
            // The extension is bounded by the constant, not by how many bids
            // arrived: a second bid in the same second does not add another 67
            // minutes.
            const lot2 = await market.getLot(RESERVABLE_12.n);
            await market.sendBid(griefer.getSender(), {
                n: RESERVABLE_12.n,
                beneficiary: null,
                referralKey: 0,
                value: lot2.minPayment,
            });
            expect((await market.getLot(RESERVABLE_12.n)).closesAt).toBe(after.closesAt);
        }, 120_000);
    });

    // ------------------------------------------------------------------ //
    // Self-bidding — allowed, and pointless
    // ------------------------------------------------------------------ //

    describe('self-bidding is allowed because it needs no defence', () => {
        it('outbidding yourself refunds your own previous bid and costs you the increment', async () => {
            // Nothing forbids it, and nothing needs to: the previous bid comes
            // straight back to the same wallet, and the new one is escrowed at a
            // strictly higher figure. The griefer's only achievement is paying
            // more for the same lot.
            const p0 = await openLot();
            const before = await opener.getBalance();
            const lot = await market.getLot(RESERVABLE_12.n);

            const r = await market.sendBid(opener.getSender(), {
                n: RESERVABLE_12.n,
                beneficiary: null,
                referralKey: 0,
                value: lot.minPayment,
            });
            expect(r.transactions).toHaveTransaction({ to: market.address, success: true });
            // The refund of the previous bid went back to the same wallet.
            expect(r.transactions).toHaveTransaction({ from: market.address, to: opener.address });

            const after = await opener.getBalance();
            // Net: they are out roughly the increment (plus gas), not the whole
            // new bid — which is exactly what makes self-bidding uninteresting.
            const spent = before - after;
            expect(spent).toBeLessThan(lot.minPayment);
            expect(spent).toBeGreaterThan(0n);
            expect((await market.getLot(RESERVABLE_12.n)).highBid).toBe(lot.minPayment - BID_GAS); // V23
            expect(p0).toBeGreaterThan(0n);
        }, 120_000);

        it('a self-bid still has to clear the same minimum — no discount for being the incumbent', async () => {
            await openLot();
            const lot = await market.getLot(RESERVABLE_12.n);
            const r = await market.sendBid(opener.getSender(), {
                n: RESERVABLE_12.n,
                beneficiary: null,
                referralKey: 0,
                value: lot.highBid + 1n,
            });
            expect(r.transactions).toHaveTransaction({
                to: market.address,
                success: false,
                exitCode: EXIT_BID_BELOW_MIN,
            });
        });
    });
});
