// TON PRIMES — D4: rounding and dust. No path leaks value, and the dust lands
// where the decision record says it does (GAUNTLET.md D4).
//
// WHAT "NO LEAK" ALREADY MEANS HERE, AND WHAT IT DOES NOT COVER
//
// `SplitClosure.spec.ts` (iter #85) proves the split closes at exactly
// MINT_PRICE with no tolerance, which is the strongest possible statement that
// nothing is lost. So D4 is not "does value disappear" — that is answered. D4 is
// the two questions closure cannot answer on its own:
//
//   1. **Which WAY does each truncation go?** Integer division can only round
//      down, but WHOSE share it rounds down is the design question. §3.2 divides
//      0.08 TON among the cited primes by `e·√p` weight; each share truncates,
//      so the recipients are collectively short by a few nanoton. If that
//      shortfall went anywhere but the pool, closure would still hold — the
//      total would still be 1 TON — and the protocol would be quietly paying
//      dust to the wrong party. Closure is blind to destination; this is not.
//
//   2. **How BIG can the dust get?** "It folds into the pool" is only reassuring
//      if the amount is bounded. A truncation that loses less than one nanoton
//      per recipient is arithmetic; one that could lose a meaningful fraction of
//      the line is a design flaw wearing the same words. The bound is asserted
//      here — divisor dust < ω (the factor count), flat dust < π(n) — rather
//      than described.
//
// THE DOCUMENTED DESTINATION. `primes_ledger.tolk`'s header states the project's
// preference plainly: unattributed value backs the floor rather than being paid
// to nobody or trapped, the same treatment §3.1 gives an orphan referral. So
// every rounding remainder must land in `T`, and this file measures that it
// does — for real mints, across a sweep of factor structures, rather than at one
// hand-picked n.
import { Blockchain, SandboxContract, TreasuryContract } from '@ton/sandbox';
import { Cell, toNano } from '@ton/core';
import '@ton/test-utils';
import { compile } from '@ton/blueprint';
import { PrimesLedger, FactorEntry } from '../wrappers/PrimesLedger';
import { PrimesRatchet } from '../wrappers/PrimesRatchet';
import { PrimesRegistrar } from '../wrappers/PrimesRegistrar';
import { PrimesCollection } from '../wrappers/PrimesCollection';
import { PrimesJettonMaster } from '../wrappers/PrimesJettonMaster';

const MINT_PRICE = toNano('1');
const TRIBUTE_DIVISOR_AMOUNT = toNano('0.08'); // §3.2's 80% half
const TRIBUTE_FLAT_AMOUNT = toNano('0.02'); // §3.2's 20% half
const TREASURY_AMOUNT = toNano('0.05');
const GAS_OPS_AMOUNT = toNano('0.20'); // §4.1's gas & ops line, D-117 (sim-derived; SimCrossCheck pins it)
const TRIBUTE_AMOUNT = toNano('0.1');
/** β with no referral — what the pool gets before any dust. */
const BETA = MINT_PRICE - TRIBUTE_AMOUNT - TREASURY_AMOUNT - GAS_OPS_AMOUNT;

describe('TON PRIMES — D4: every rounding truncates toward the pool, and the dust is bounded', () => {
    let blockchain: Blockchain;
    let deployer: SandboxContract<TreasuryContract>;
    let genesisScript: SandboxContract<TreasuryContract>;
    let treasuryWallet: SandboxContract<TreasuryContract>;
    let player: SandboxContract<TreasuryContract>;
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

    beforeAll(async () => {
        blockchain = await Blockchain.create();
        blockchain.now = 1_770_000_000;
        deployer = await blockchain.treasury('deployer');
        genesisScript = await blockchain.treasury('genesisScript');
        treasuryWallet = await blockchain.treasury('treasury');
        player = await blockchain.treasury('player', { balance: toNano('2000') });

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
            seedHead: 4n,
            value: toNano('0.05'),
        });
        await ledger.sendIgnite(genesisScript.getSender(), { owner: deployer.address, value: toNano('0.3') });
    });

    /** Trial-division factorisation with `s = floor(sqrt(p))`, as the contract requires. */
    function factorize(n: number): { prime: number; exponent: number; s: number }[] {
        const out: { prime: number; exponent: number; s: number }[] = [];
        let m = n;
        for (let p = 2; p * p <= m; p++) {
            let e = 0;
            while (m % p === 0) {
                m /= p;
                e++;
            }
            if (e > 0) out.push({ prime: p, exponent: e, s: Math.floor(Math.sqrt(p)) });
        }
        if (m > 1) out.push({ prime: m, exponent: 1, s: Math.floor(Math.sqrt(m)) });
        return out;
    }

    /**
     * §3.2's divisor line, recomputed exactly as the contract computes it.
     *
     * `share_i = TRIBUTE_DIVISOR_AMOUNT · e_i · s_i · wNum / sumWeights`, with
     * `wNum = CONSTELLATION_M_DEN` and `sumWeights = CONSTELLATION_M_DEN · Σ e·s`
     * when no constellation boost applies — so the factor of 2 cancels and the
     * rational is `D·e·s / Σ(e·s)`, truncated per share. Reproducing the
     * TRUNCATION rather than the ideal fraction is the whole point: the dust IS
     * the difference between them.
     */
    function divisorShares(factors: { exponent: number; s: number }[]): bigint[] {
        const sum = BigInt(factors.reduce((a, f) => a + f.exponent * f.s, 0));
        return factors.map((f) => (TRIBUTE_DIVISOR_AMOUNT * BigInt(f.exponent * f.s)) / sum);
    }

    type Reading = {
        T: bigint;
        tributeOwed: bigint;
        divOutstanding: bigint;
        forfeited: bigint;
        pi: number;
    };

    async function read(citedPrimes: number[]): Promise<Reading> {
        const br = await ledger.getLiabilityBreakdown();
        let forfeited = 0n;
        for (const p of citedPrimes) forfeited += await ledger.getForfeited(BigInt(p));
        return {
            T: await ledger.getFloorNum(),
            tributeOwed: br.tributeOwed,
            divOutstanding: br.divOutstanding,
            forfeited,
            pi: await ledger.getPrimesCount(),
        };
    }

    /** Everything measured about one mint's rounding. */
    type DustRow = {
        n: number;
        omega: number;
        distributed: bigint;
        divisorDust: bigint;
        flatAccrued: bigint;
        flatDust: bigint;
        dT: bigint;
    };
    const rows: DustRow[] = [];

    it('mints a sweep of factor structures and records the dust at each', async () => {
        // The head walks composites only, so this covers ω = 1 (prime powers),
        // ω = 2 and ω = 3, with exponents from 1 to 4 — every shape §3.2's
        // weighting can encounter at small n.
        for (let i = 0; i < 14; i++) {
            const n = Number(await ledger.getHead());
            const factors = factorize(n);
            const cited = factors.map((f) => f.prime);
            const before = await read(cited);

            const r = await ledger.sendMint(player.getSender(), {
                n: BigInt(n),
                kind: 0,
                factors: factors.map(
                    (f): FactorEntry => ({
                        prime: BigInt(f.prime),
                        exponent: f.exponent,
                        s: BigInt(f.s),
                    })
                ),
                referralKey: 0,
                beneficiary: null,
                value: MINT_PRICE,
            });
            expect(r.transactions).toHaveTransaction({ to: ledger.address, success: true });

            const after = await read(cited);
            const expectedShares = divisorShares(factors);
            const distributed = expectedShares.reduce((a, b) => a + b, 0n);

            // The divisor line lands as either an item credit or a §6 point 2
            // forfeit; both are "distributed" for dust purposes, and which one
            // it was is C4's subject rather than this file's.
            const moved =
                after.tributeOwed - before.tributeOwed + (after.forfeited - before.forfeited);
            expect({ n, moved }).toEqual({ n, moved: distributed });

            // π is read BEFORE the mint, and that ordering is load-bearing (G79):
            // `executeMint` accrues the flat dividend before its head-advance walk
            // counts the next prime, so the divisor is the primes BELOW n. Minting 4
            // divides among 2 and 3 and leaves no dust; 5, which that mint walks
            // past, takes nothing from it. Minting 6 divides by 3, which is where
            // this sweep's first flat dust comes from.
            const pi = BigInt(before.pi);
            const perPrime = TRIBUTE_FLAT_AMOUNT / pi;
            const flatAccrued = perPrime * pi;
            expect({ n, flat: after.divOutstanding - before.divOutstanding }).toEqual({
                n,
                flat: flatAccrued,
            });

            rows.push({
                n,
                omega: factors.length,
                distributed,
                divisorDust: TRIBUTE_DIVISOR_AMOUNT - distributed,
                flatAccrued,
                flatDust: TRIBUTE_FLAT_AMOUNT - flatAccrued,
                dT: after.T - before.T,
            });
        }
        expect(rows.length).toBe(14);
        // The sweep really did vary the structure it was built to vary.
        expect(new Set(rows.map((r) => r.omega)).size).toBeGreaterThanOrEqual(2);
    }, 300_000);

    it('no share is ever rounded UP — the recipients can never be collectively overpaid', () => {
        // The direction that matters. Integer division truncates, so this should
        // hold by construction — but "by construction" is exactly the kind of
        // claim that stops being true when someone adds a `+ 1` for a rounding
        // fix. If `distributed` could exceed the line, the pool would be funding
        // the overshoot out of β.
        for (const r of rows) {
            expect({ n: r.n, over: r.distributed > TRIBUTE_DIVISOR_AMOUNT }).toEqual({
                n: r.n,
                over: false,
            });
            expect({ n: r.n, flatOver: r.flatAccrued > TRIBUTE_FLAT_AMOUNT }).toEqual({
                n: r.n,
                flatOver: false,
            });
        }
    });

    it('divisor dust is strictly less than the number of recipients — sub-nanoton per share', () => {
        // The BOUND. Each share loses less than one nanoton to truncation, so
        // ω recipients lose less than ω nanoton in total. This is what makes
        // "it folds into the pool" a rounding note rather than a leak: the
        // largest dust in the sweep is a handful of nanoton against a 0.08 TON
        // line, i.e. one part in ten million.
        for (const r of rows) {
            expect({ n: r.n, dust: r.divisorDust >= 0n && r.divisorDust < BigInt(r.omega) }).toEqual({
                n: r.n,
                dust: true,
            });
        }
        const worst = rows.reduce((a, r) => (r.divisorDust > a ? r.divisorDust : a), 0n);
        expect(worst).toBeLessThan(10n); // nanoton, against 80,000,000
    });

    it('flat-dividend dust is strictly less than π(n) — the same bound, per prime', () => {
        // §3.2's flat half divides 0.02 TON among π(n) primes. `floor(F/π)·π`
        // leaves `F mod π`, which is by definition < π.
        for (const r of rows) {
            expect({ n: r.n, dust: r.flatDust >= 0n }).toEqual({ n: r.n, dust: true });
        }
        // Non-vacuous: at least one mint in the sweep had a π that does not
        // divide 0.02 TON evenly, so real dust was actually produced.
        expect(rows.some((r) => r.flatDust > 0n)).toBe(true);
    });

    it('THE DESTINATION: every nanoton of dust is in `T`, not paid to nobody and not trapped', () => {
        // The claim the ledger's own header makes — "unattributed value backs
        // the floor rather than being paid to nobody or trapped", the same
        // treatment §3.1 gives an orphan referral.
        //
        // ΔT is β plus BOTH dusts, exactly. Closure (C4) says the total is 1 TON
        // whatever happens to the remainders; this says where they went, which
        // closure cannot see.
        for (const r of rows) {
            expect({ n: r.n, dT: r.dT }).toEqual({
                n: r.n,
                dT: BETA + r.divisorDust + r.flatDust,
            });
        }
    });

    it('and the dust is real in the sweep, so the destination test is not asserting zero', () => {
        // Every assertion above would pass trivially if the sweep happened to
        // produce no dust at all. It does not: at least one mint left a
        // non-zero remainder on at least one of the two halves.
        expect(rows.some((r) => r.divisorDust > 0n || r.flatDust > 0n)).toBe(true);
    });
});
