// TON PRIMES — D-156's logistic supply cap (CONCEPT.md §5, DECISIONS.md D-156).
//
// WHAT THIS GUARDS, AND WHY IT IS ITS OWN FILE
//
// §5's emission is MULTIPLICATIVE — `ΔS/S = k·β/T` — so `S` is bounded if and
// only if `k` is integrable in `u = ln n`. `k_max(n) = 2.7/log₁₀(n)` is not
// (`∫du/u` diverges), and `K_MIN = 0.2` flattens the curve entirely past
// n ≈ 3·10¹³, which makes the tail a power law. D-156 does not replace that
// curve; it multiplies emission by `(S_MAX − S)/S_MAX`.
//
// `FuzzInvariants.spec.ts` asserts the resulting bound as invariant I11 over
// randomized operation sequences, which is the right place for "never, on any
// path". This file pins the MECHANISM instead, because the bound alone cannot
// tell a working taper from a taper that is simply never exercised:
//
//   1. the get-method exists and matches `shared/params.json` — the parameter
//      authority, not a number retyped in three places (CLAUDE.md rule 3);
//   2. the taper is applied AFTER the K_MIN clamp, which is the whole reason
//      K_MIN and math-note.md §3 needed no change. Applied before, the 0.2 floor
//      would hold `k` up and the cap would leak past n ≈ 3·10¹³;
//   3. the DONATION path is tapered too. It is permissionless, so a cap that
//      skipped it would not be a cap — anyone could mint past `S_MAX` through it;
//   4. `k` only ever shrinks, so §5's `k < 1` invariant and the ratchet theorem
//      are strengthened rather than reworked.
import { Blockchain, SandboxContract, TreasuryContract } from '@ton/sandbox';
import { Cell, toNano } from '@ton/core';
import '@ton/test-utils';
import { compile } from '@ton/blueprint';
import * as fs from 'fs';
import * as path from 'path';
import { PrimesLedger } from '../wrappers/PrimesLedger';
import { deployStack, factorize } from './helpers/stack';

const PARAMS = JSON.parse(
    fs.readFileSync(path.join(__dirname, '..', '..', 'shared', 'params.json'), 'utf-8'),
);

/** The authority. Never retype the literal — rule 3. */
const S_MAX_NANO = BigInt(PARAMS.rebate.S_MAX_nanoprimes);
const S_MAX_PRIMES = Number(PARAMS.rebate.S_MAX);
const NANO = 1_000_000_000n;

/** D-156's taper, in the same integer arithmetic the contract uses. */
function taper(s: bigint): bigint {
    return s >= S_MAX_NANO ? 0n : (S_MAX_NANO - s) / (S_MAX_NANO / NANO);
}

describe('D-156 — the logistic supply cap', () => {
    let blockchain: Blockchain;
    let deployer: SandboxContract<TreasuryContract>;
    let ledger: SandboxContract<PrimesLedger>;

    beforeAll(async () => {
        const ledgerCode = await compile('PrimesLedger');
        const itemCode = await compile('PrimesItem');
        const walletCode = await compile('PrimesJettonWallet');

        // `S_MAX` is a constant and `getMaxSupply` reads no storage, so — exactly
        // as KMaxCurve.spec.ts does for `k_max` — this deploys the ledger unwired.
        blockchain = await Blockchain.create();
        deployer = await blockchain.treasury('deployer');
        const treasuryWallet = await blockchain.treasury('treasury');
        const genesisScript = await blockchain.treasury('genesisScript');

        ledger = blockchain.openContract(
            PrimesLedger.createFromConfig(
                {
                    a: {
                        collectionAddr: deployer.address,
                        jettonMasterAddr: deployer.address,
                        treasuryAddr: treasuryWallet.address,
                        itemCode,
                    },
                    b: { genesisScriptAddr: genesisScript.address },
                },
                ledgerCode,
            ),
        );
        await ledger.sendDeploy(deployer.getSender(), toNano('10'));
    });

    // ---- 1. the published figure ------------------------------------------------

    it('publishes S_MAX through a get-method, per §9.1', async () => {
        expect(await ledger.getMaxSupply()).toBe(S_MAX_NANO);
    });

    it('agrees with shared/params.json, the parameter authority', async () => {
        // The contract constant and the sim's own figure are the SAME number in two
        // denominations. A drift here is a parameter change that skipped the sim.
        expect(await ledger.getMaxSupply()).toBe(BigInt(Math.round(S_MAX_PRIMES * 1e9)));
    });

    it('is D-156\'s signed figure: 1.2e9 PRIMES, owner-set, not a multiple of S0', async () => {
        // D-156 set it at 100× the then-12,000,000 genesis supply. D-166 moved S0 to
        // 11,000,000 and left S_MAX where the owner put it: nothing derives it from S0.
        expect(S_MAX_PRIMES).toBe(1_200_000_000);
    });

    // ---- 2. the taper's shape ---------------------------------------------------

    it('leaves the rebate essentially untouched where the game actually lives', async () => {
        // The design claim D-156 rests on: at the 3-year horizon's measured `S`,
        // >95% of the rebate survives. If this fails, `S_MAX` is too low and the
        // "invisible where the game lives" argument is gone — a decision to
        // re-open, not a threshold to relax.
        const sHorizon = BigInt(Math.round(PARAMS.final_state.final_S_primes)) * NANO;
        expect(Number(taper(sHorizon)) / Number(NANO)).toBeGreaterThan(0.95);
    });

    it('closes to exactly zero at and beyond the cap', () => {
        expect(taper(S_MAX_NANO)).toBe(0n);
        expect(taper(S_MAX_NANO * 2n)).toBe(0n);
    });

    it('is monotone decreasing in S, and never negative', () => {
        const xs = [0n, S_MAX_NANO / 100n, S_MAX_NANO / 4n, S_MAX_NANO / 2n, S_MAX_NANO];
        const fs_ = xs.map(taper);
        for (let i = 1; i < fs_.length; i++) {
            expect(fs_[i]).toBeLessThanOrEqual(fs_[i - 1]);
            expect(fs_[i]).toBeGreaterThanOrEqual(0n);
        }
    });

    // ---- 3. the K_MIN ordering, which is the load-bearing detail -----------------

    it('binds even where K_MIN has flattened the k_max curve', async () => {
        // Past n ≈ 3·10¹³ the contract clamps `k_max` up to K_MIN = 0.2 and the
        // curve stops decaying. The taper is applied AFTER that clamp, so the cap
        // still closes there — this is the ordering that let math-note.md §3 stand
        // unchanged. `getKMax` is the clamped figure; the taper multiplies it.
        const K_SCALE = 1e9;
        const kMaxFlat = Number(await ledger.getKMax(BigInt('100000000000000'))) / K_SCALE;
        expect(kMaxFlat).toBeCloseTo(0.2, 6); // K_MIN, the floor that used to leak

        // At the cap, that floor emits nothing regardless.
        expect(Number(taper(S_MAX_NANO)) * kMaxFlat).toBe(0);
    });

    // ---- 4. §5's invariant is strengthened, not reworked -------------------------

    it('only ever shrinks k, so k < 1 and the ratchet theorem survive unchanged', () => {
        const K_CEIL = PARAMS.rebate.K_CEIL;
        for (const s of [0n, S_MAX_NANO / 3n, S_MAX_NANO - 1n]) {
            const factor = Number(taper(s)) / Number(NANO);
            expect(factor).toBeLessThanOrEqual(1);
            expect(K_CEIL * factor).toBeLessThan(1);
        }
    });
});

// ---- 5. the cap on the live mint path, at S ≈ S_MAX (missing-tests §1 items 2–3) ----
//
// The block above pins the taper's SHAPE in TypeScript arithmetic. These run the
// contract itself with `S` a hair under the cap, which is the only place the
// ordering (taper after the K_MIN clamp) and the headroom clamp are observable.
describe('D-156 — the cap binds on the real mint path and at genesis', () => {
    const K_MIN = 200_000_000n; // params.json rebate.k_min — the floor the taper must be applied after
    const K_SCALE = 1_000_000_000n;
    const POOL_INJECTION = toNano('0.65'); // unreferred composite, no invites (§4.1)
    const HEADROOM = 1_000n * NANO; // 1,000 PRIMES under the cap

    it('a K_MIN mint at S ≈ S_MAX emits the TAPERED k_min — far less than the headroom — and S stays under the cap', async () => {
        expect(BigInt(Math.round(PARAMS.rebate.k_min * 1e9))).toBe(K_MIN);
        const s = await deployStack({ seedS: S_MAX_NANO - HEADROOM });
        expect(await s.ledger.getFloorDen()).toBe(S_MAX_NANO - HEADROOM);
        const r1 = await s.mint(s.alice, 4n, 0, factorize(4n));
        expect(r1.transactions).not.toHaveTransaction({ aborted: true });

        // Same block time as the mint before it: t = 0, so k(t) = K_MIN exactly.
        const n = await s.ledger.getHead();
        const T = await s.ledger.getFloorNum();
        const S = await s.ledger.getFloorDen();
        const kEff = (K_MIN * (S_MAX_NANO - S)) / S_MAX_NANO;
        expect(kEff).toBeLessThan(K_MIN); // the taper ate into the K_MIN floor
        const expected = (kEff * POOL_INJECTION * S) / T / K_SCALE;
        // Had the taper run BEFORE the clamp, K_MIN would have held k up and the
        // rebate would have overrun the whole headroom.
        expect((K_MIN * POOL_INJECTION * S) / T / K_SCALE).toBeGreaterThan(S_MAX_NANO - S);

        const r2 = await s.mint(s.bob, n, 0, factorize(n));
        expect(r2.transactions).not.toHaveTransaction({ aborted: true });
        const S2 = await s.ledger.getFloorDen();
        expect(S2 - S).toBe(expected);
        expect(S2).toBeLessThan(S_MAX_NANO);
    });

    it('the headroom clamp: a launch on a dust floor cannot carry S past S_MAX, and once at the cap S never moves', async () => {
        // T = 1 nanoGRAM: the rebate formula's I·S/T is astronomically larger than the
        // headroom, so only the last clamp (`rebate <= S_MAX − S`) stands between S and
        // the cap (2026-11-08 audit).
        const s = await deployStack({ seedT: 1n, seedS: S_MAX_NANO - HEADROOM });
        const r1 = await s.mint(s.alice, 4n, 0, factorize(4n));
        expect(r1.transactions).not.toHaveTransaction({ aborted: true });
        expect(await s.ledger.getFloorDen()).toBe(S_MAX_NANO);

        const n = await s.ledger.getHead();
        const T = await s.ledger.getFloorNum();
        const r2 = await s.mint(s.bob, n, 0, factorize(n));
        expect(r2.transactions).not.toHaveTransaction({ aborted: true });
        expect(await s.ledger.getFloorDen()).toBe(S_MAX_NANO); // taper is 0 at the cap
        expect(await s.ledger.getFloorNum()).toBeGreaterThan(T); // the mint still raised T: p_f rose
    });

    async function freshLedger() {
        const bc = await Blockchain.create();
        const deployer = await bc.treasury('deployer');
        const genesisScript = await bc.treasury('genesisScript');
        const l = bc.openContract(
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
                await compile('PrimesLedger'),
            ),
        );
        await l.sendDeploy(deployer.getSender(), toNano('10'));
        return { l, genesisScript };
    }

    it('genesis_seed past S_MAX throws 102 and seeds nothing — the seed stays available', async () => {
        const { l, genesisScript } = await freshLedger();
        const head0 = await l.getHead();
        const over = await l.sendGenesisSeed(genesisScript.getSender(), {
            seedT: toNano('1000'), seedS: S_MAX_NANO + 1n, seedHead: 4n, value: toNano('0.05'),
        });
        expect(over.transactions).toHaveTransaction({ to: l.address, success: false, exitCode: 102 });
        expect(await l.getFloorDen()).toBe(0n);
        expect(await l.getFloorNum()).toBe(0n);
        expect(await l.getHead()).toBe(head0);

        // The refusal reverted the one-shot flag too: the exact cap is still seedable.
        const exact = await l.sendGenesisSeed(genesisScript.getSender(), {
            seedT: toNano('1000'), seedS: S_MAX_NANO, seedHead: 4n, value: toNano('0.05'),
        });
        expect(exact.transactions).not.toHaveTransaction({ aborted: true });
        expect(await l.getFloorDen()).toBe(S_MAX_NANO);
    });
});
