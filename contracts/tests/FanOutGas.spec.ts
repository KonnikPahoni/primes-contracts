// TON PRIMES — D6: gas exhaustion mid-chain on multi-message flows
// (GAUNTLET.md D6).
//
// WHAT A MID-CHAIN GAS FAILURE WOULD LOOK LIKE, AND WHY AN EXIT CODE WOULD NOT
// SHOW IT
//
// A mint fans out: the ledger credits one `credit_tribute` per DISTINCT prime
// factor, pays the treasury, hops to the ratchet, hops to the registrar on a
// prime, deploys the item and mints the rebate. Each leg carries its own fixed
// gas budget out of §4.1's 0.10 GRAM gas-&-ops line. If the fan-out outgrew that
// budget, the mint itself would still succeed — the ledger's own compute phase
// is cheap — and some downstream legs would simply never be delivered. **The
// symptom is a missing credit, not a thrown error.** So the assertion here is
// that every leg LANDED, measured as credited value, not that nothing threw.
//
// THE BOUND, AND THE PREMISE UNDER IT. CONCEPT.md §3.2 bounds the fan-out by
// ω(n), the count of distinct prime factors, and calls it a theorem:
//
//   "Because minting is sequential, n ≈ total mints ever, so realistic fan-out
//    is ≤ 8 recipients... This is a theorem, not a parameter; it cannot be
//    exceeded by adversarial input."
//
// The arithmetic is right and the conclusion follows FROM ITS PREMISE — but the
// premise is sequentiality, and D-30's auction lane is precisely a way to reach
// a number without minting everything below it. The reservable cap is
// ~4.29e13, and ω = 12 lives comfortably under it (the smallest ω = 12 number is
// 7.42e12). Nothing in `executeMint` bounds the factor loop either: it asserts
// `idx > 0`, a floor, and has no ceiling.
//
// So the interesting question is not "is the theorem true" — it is true of the
// HEAD lane, where reaching ω = 9 would take a quarter of a billion mints — but
// "what does the fan-out actually cost at the ω the OTHER lane can reach", which
// is a measurement nobody had taken. This file takes it, using the `seedHead` /
// `seedPrimes` harness seam whose own comment says it exists for exactly this:
// "the whole of the §12 gas question... would otherwise mean minting ten
// thousand numbers in a sandbox."
import { Blockchain, SandboxContract, TreasuryContract } from '@ton/sandbox';
import { Cell, toNano, Transaction } from '@ton/core';
import '@ton/test-utils';
import { compile } from '@ton/blueprint';
import { PrimesLedger, FactorEntry } from '../wrappers/PrimesLedger';
import { PrimesRatchet } from '../wrappers/PrimesRatchet';
import { PrimesRegistrar } from '../wrappers/PrimesRegistrar';
import { PrimesCollection } from '../wrappers/PrimesCollection';
import { PrimesJettonMaster } from '../wrappers/PrimesJettonMaster';

const MINT_PRICE = toNano('1');
const GAS_OPS_AMOUNT = toNano('0.20'); // §4.1's gas & ops line, D-117 (sim-derived; SimCrossCheck pins it)
const TRIBUTE_DIVISOR_AMOUNT = toNano('0.08');
/** `primes_market.tolk`'s AUCTIONABLE_MAX — what the auction lane can reach. */
const AUCTIONABLE_MAX = 42_949_672_959_999n;

const totalFees = (r: any): bigint =>
    r.transactions.reduce((a: bigint, t: Transaction) => a + t.totalFees.coins, 0n);

/**
 * A squarefree composite with exactly `k` distinct prime factors, deliberately
 * NOT a primorial.
 *
 * The first `k` primes multiply to the k-th primorial, which is an era boundary
 * (§7) and fires the era ceremony on top of the ordinary fan-out — extra legs
 * that have nothing to do with ω. Measuring the cost curve on primorials would
 * conflate the two, so the last factor is swapped for 43, a prime outside the
 * run. That keeps ω exactly `k` while leaving the number ordinary.
 */
function omegaNumber(k: number): { n: bigint; primes: bigint[] } {
    const base = [2, 3, 5, 7, 11, 13, 17, 19, 23, 29, 31];
    const primes = [...base.slice(0, k - 1), 43].map(BigInt);
    return { n: primes.reduce((a, b) => a * b, 1n), primes };
}

/**
 * D6.1 — THE DERIVATION §3.2 NOW RESTS ON, pinned so the sentence cannot go stale
 * again the way its predecessor did.
 *
 * The old paragraph derived "ω ≤ 8" from "minting is sequential, so n ≈ total mints
 * ever", called it a theorem, and said it could not be exceeded by adversarial
 * input. D-30's auction lane deleted the premise — any number up to the reservable
 * cap is purchasable on day one — and nothing failed, because a prose justification
 * has nothing that can fail. §3.2 now derives the bound from the cap instead, which
 * is a claim about two integers, so it is checkable, so it is checked here.
 *
 * Deliberately arithmetic-only and outside the sandbox `describe` below: this is not
 * a measurement, it is the reason the measurements stop at ω = 12.
 */
describe('TON PRIMES — D6.1: the omega bound is derived from AUCTIONABLE_MAX', () => {
    /** The k-th primorial: the SMALLEST number with k distinct prime factors. */
    const primorial = (k: number): bigint =>
        [2n, 3n, 5n, 7n, 11n, 13n, 17n, 19n, 23n, 29n, 31n, 37n, 41n]
            .slice(0, k)
            .reduce((a, b) => a * b, 1n);

    it('ω = 13 is UNREACHABLE — the smallest such number is past the cap', () => {
        // 41# = 304,250,263,527,210. Seven times the cap, so no entry point can ever
        // present a 13-distinct-factor number. This is the half that makes ≤ 12 a
        // bound rather than an expectation.
        expect(primorial(13)).toBe(304_250_263_527_210n);
        expect(primorial(13)).toBeGreaterThan(AUCTIONABLE_MAX);
    });

    it('ω = 12 IS reachable — so it is the ω the sizing has to admit', () => {
        // 37# = 7,420,738,134,810, comfortably under the cap. The bound is tight:
        // if this ever went the other way the document would be claiming more
        // headroom than the number line gives.
        expect(primorial(12)).toBe(7_420_738_134_810n);
        expect(primorial(12)).toBeLessThan(AUCTIONABLE_MAX);
    });

    it('the head lane really would need ~223 million mints to reach ω = 9', () => {
        // Why "≤ 8" survives as the head lane's EXPECTATION even though it is not a
        // bound. 23# = 223,092,870, and on the sequential line n ≈ total mints ever,
        // so ω = 9 at the head is a quarter of a billion mints away. The figure is
        // pinned because §3.2 quotes it as the reason ≤ 8 is still worth stating.
        expect(primorial(9)).toBe(223_092_870n);
        expect(primorial(8)).toBe(9_699_690n);
    });

    it('AUCTIONABLE_MAX is 2^32 · 10^4 − 1, which is what makes the bound checkable', () => {
        // The cap is a formula, not a magic number, and the whole derivation above
        // is only as good as this line. D-11/D-18, and `getAuctionableMax()` on the
        // market publishes it.
        expect(AUCTIONABLE_MAX).toBe(2n ** 32n * 10n ** 4n - 1n);
    });
});

describe('TON PRIMES — D6: the tribute fan-out lands whole, at every ω the lanes can reach', () => {
    let blockchain: Blockchain;
    let deployer: SandboxContract<TreasuryContract>;
    let genesisScript: SandboxContract<TreasuryContract>;
    let treasuryWallet: SandboxContract<TreasuryContract>;
    let minter: SandboxContract<TreasuryContract>;
    let codes: Record<string, Cell>;
    let ledger: SandboxContract<PrimesLedger>;

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

    /**
     * Deploy with the head parked ON `n` and only `n`'s own prime factors marked.
     *
     * This is the harness seam the wrapper documents: reaching ω = 12 by minting
     * is not a sandbox operation, it is 8·10¹² of them. Seeding the head and
     * marking the primes the test needs gets to the same state in one deploy,
     * and it is the SAME state a won auction lot would settle into — the
     * settlement path runs the identical `executeMint` factor loop.
     */
    async function deployAtHead(head: bigint, seedPrimes: bigint[]) {
        blockchain = await Blockchain.create();
        blockchain.now = 1_770_000_000;
        deployer = await blockchain.treasury('deployer');
        genesisScript = await blockchain.treasury('genesisScript');
        treasuryWallet = await blockchain.treasury('treasury');
        minter = await blockchain.treasury('minter', { balance: toNano('500') });

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
                    // The head and the marked primes are DEPLOY config, not
                    // genesis-seed message fields: the bitmap and π(n) are baked
                    // into the initial storage cell, which is the only way to
                    // reach a 12-digit head without walking to it.
                    seedHead: head,
                    seedPrimes,
                },
                codes.ledger
            )
        );
        await ledger.sendDeploy(deployer.getSender(), toNano('40'));
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
            seedHead: head,
            value: toNano('0.2'),
        });
        await ledger.sendIgnite(genesisScript.getSender(), { owner: deployer.address, value: toNano('0.3') });
    }

    type FanOut = {
        omega: number;
        n: bigint;
        credited: bigint;
        fees: bigint;
        legs: number;
    };

    /** Mint `n` at the head and measure what its fan-out actually delivered. */
    async function measure(k: number): Promise<FanOut> {
        const { n, primes } = omegaNumber(k);
        await deployAtHead(n, primes);
        expect(await ledger.getHead()).toBe(n);

        const brBefore = await ledger.getLiabilityBreakdown();
        let forfeitedBefore = 0n;
        for (const p of primes) forfeitedBefore += await ledger.getForfeited(p);

        const factors: FactorEntry[] = primes.map((p) => ({
            prime: p,
            exponent: 1,
            s: BigInt(Math.floor(Math.sqrt(Number(p)))),
        }));
        const r = await ledger.sendMint(minter.getSender(), {
            n,
            kind: 0,
            factors,
            referralKey: 0,
            beneficiary: null,
            value: MINT_PRICE,
        });
        expect(r.transactions).toHaveTransaction({ to: ledger.address, success: true });

        const brAfter = await ledger.getLiabilityBreakdown();
        let forfeitedAfter = 0n;
        for (const p of primes) forfeitedAfter += await ledger.getForfeited(p);

        return {
            omega: k,
            n,
            // Everything §3.2's divisor half actually delivered — as an item
            // credit or as a §6 point 2 forfeit. A leg lost to gas appears here
            // as a shortfall, and nowhere else.
            credited:
                brAfter.tributeOwed -
                brBefore.tributeOwed +
                (brAfter.unroutedHeld - brBefore.unroutedHeld) +
                (forfeitedAfter - forfeitedBefore),
            fees: totalFees(r),
            legs: r.transactions.length,
        };
    }

    const results: FanOut[] = [];

    it('ω = 12 is reachable through the auction lane, so the premise of §3.2\'s bound does not hold there', () => {
        // Stated as its own assertion because it is the reason the rest of this
        // file exists. §3.2's ≤ 8 follows from sequential minting; D-30's lane
        // reaches a number without minting everything below it, and the cap
        // leaves room for ω = 12.
        const { n } = omegaNumber(12);
        expect(n).toBeLessThan(AUCTIONABLE_MAX);
        // ω = 13 is genuinely out of reach — the cap, not the theorem, is what
        // bounds it, and that is worth pinning as the real ceiling.
        const thirteen = [2n, 3n, 5n, 7n, 11n, 13n, 17n, 19n, 23n, 29n, 31n, 37n, 41n].reduce(
            (a, b) => a * b,
            1n
        ); // 13# — the smallest number with 13 distinct factors
        expect(thirteen).toBeGreaterThan(AUCTIONABLE_MAX);
    });

    for (const k of [3, 8, 12]) {
        it(`ω = ${k}: every one of the ${k} tribute legs is delivered, none lost to gas`, async () => {
            const m = await measure(k);
            results.push(m);
            // THE PROPERTY. The divisor half is 0.08 GRAM; every nanoton of it
            // must have reached an item or the treasury. A leg dropped for want
            // of gas would show up as a shortfall here while the mint itself
            // still reported success.
            //
            // Dust aside (D4: each share truncates by under a nanoton, so ω
            // shares lose under ω nanoton in total).
            expect(m.credited).toBeLessThanOrEqual(TRIBUTE_DIVISOR_AMOUNT);
            expect(TRIBUTE_DIVISOR_AMOUNT - m.credited).toBeLessThan(BigInt(k));
        }, 300_000);
    }

    it('reports the measured cost curve, and it stays inside the gas & ops line', async () => {
        // The numbers this file exists to produce. `fees` is the network fee
        // burned across the whole fan-out. It is NOT what §4.1's line pays: it
        // omits every hop's attached value, and on this fixture the seeded primes
        // have no items, so each credit bounces its hop value home. The line's
        // real reconciliation — the ledger's own surplus drop, items deployed, no
        // bounce in the trace — is GasRegression.spec.ts's D-117 worst-case block
        // (MISTAKES.md 2026-09-22). This check only bounds the burn.
        expect(results.length).toBe(3);
        for (const r of results) {
            console.log(
                `[fan-out] omega=${r.omega} n=${r.n} legs=${r.legs} fees=${r.fees} credited=${r.credited}`
            );
        }
        const worst = results.reduce((a, r) => (r.fees > a ? r.fees : a), 0n);
        expect({ worst: worst < GAS_OPS_AMOUNT }).toEqual({ worst: true });

        // The metric is sensitive — "it fits" is a measurement, not a coincidence
        // of a number that never moves. The worst row costs well over twice the
        // cheapest.
        const best = results.reduce((a, r) => (r.fees < a ? r.fees : a), worst);
        expect(worst).toBeGreaterThan(best * 2n);

        // The curve is not a function of ω alone: the fee also depends on the
        // numbers themselves — each factor's Miller-Rabin, the `s = ⌊√p⌋`
        // arithmetic, how deep the dictionary writes go. Until GAUNTLET V34 cut
        // Miller-Rabin to seven bases below ψ₇, ω = 8 here cost MORE than ω = 12
        // (its large factors dominated); it no longer does. So the cost cannot be
        // extrapolated from ω, which is the mistake a "≤ 8 recipients" bound
        // invites, and the safe statement is the measured worst case against the
        // line above, and nothing narrower.
    }, 60_000);
});
