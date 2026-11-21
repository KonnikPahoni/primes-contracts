import { toNano } from '@ton/core';
import '@ton/test-utils';
import { deployStack } from './helpers/stack';
import * as fs from 'fs';
import * as path from 'path';

/** D-156's cap, from `shared/params.json` — the parameter authority (CLAUDE.md rule 3). */
const S_MAX = BigInt(
    JSON.parse(
        fs.readFileSync(path.join(__dirname, '..', '..', 'shared', 'params.json'), 'utf-8'),
    ).rebate.S_MAX_nanoprimes,
);

/**
 * D-156's logistic taper, in the SAME integer order the contract uses — multiply
 * before dividing, one truncation. Written as the relationship rather than a
 * re-measured constant, so this still fails if the taper stops being applied to
 * the donation path (which is permissionless, and therefore the path a cap must
 * not miss).
 */
const tapered = (x: bigint, s: bigint): bigint => (s >= S_MAX ? 0n : (x * (S_MAX - s)) / S_MAX);
import { PrimesJettonWallet } from '../wrappers/PrimesJettonWallet';

/**
 * The genesis launch order: seed -> donate -> ignite.
 *
 * `genesisPipeline.ts` step 7 seeds `T = 0` (D-46 point 2 — no founder TON is
 * deposited) and `S = 11,000,000` PRIMES (D-166), so `p_f = T/S` is ZERO until D-92's
 * 240 TON `donate_floor` lands. That donation is a separate permissionless
 * call, and until this suite's guard existed nothing stopped `ignite` from
 * opening minting in between.
 *
 * Why that ordering is load-bearing rather than tidy: the rebate is
 * `R = k * I * S / T` (math-note §2) — emit `k` times the injection, priced at
 * the floor — which is unbounded as `T -> 0`. A `T > 0` guard means the FIRST
 * mint after such a launch emits nothing; it also means that mint sets `T` to
 * one injection (~0.75 TON) against the entire genesis supply, and hands the
 * SECOND minter a floor near zero. Measured below: 20% of the supply for
 * 1 TON, against 0.28% once the donation has landed.
 */
describe('genesis launch order (D-92, ledger_floor_unbacked)', () => {
    it('refuses to ignite while the floor has no backing', async () => {
        const s = await deployStack({ seedT: 0n });

        expect(s.igniteResult.transactions).toHaveTransaction({
            to: s.ledger.address,
            exitCode: 218, // ledger_floor_unbacked
        });
        expect((await s.ledger.getLaunch()).launched).toBe(false);

        // And the refusal is the whole protection: nothing mints behind it.
        await s.mint(s.alice, 4n, 0, [{ prime: 2n, exponent: 2 }]);
        expect(await s.ledger.getFloorDen()).toEqual(1_200_000_000_000_000n);
    }, 180_000);

    it('launches on donated tranches, and prices the rebate off them', async () => {
        // Partial donations, in sequence — the op is incremental by
        // construction, so a testnet-sized launch can fund itself in pieces.
        const s = await deployStack({ seedT: 0n, donateBeforeIgnite: [toNano('100'), toNano('140')] });

        expect((await s.ledger.getLaunch()).launched).toBe(true);
        expect(await s.ledger.getFloorNum()).toEqual(toNano('240'));

        const S1 = await s.ledger.getFloorDen();
        await s.mint(s.bob, 4n, 0, [{ prime: 2n, exponent: 2 }]);
        const emitted = (await s.ledger.getFloorDen()) - S1;

        console.log(`donated-first: emitted_on_first_mint=${emitted} (${(Number(emitted) / Number(S1)) * 100}% of supply)`);
        // 28 bps. The same mint against an unbacked floor emits 2000 bps — the
        // 71x this guard exists to prevent.
        expect((emitted * 10_000n) / S1).toBeLessThan(50n);
    }, 180_000);
});

/**
 * D-156: the taper alone does not bound `S` on the donation path — it keeps
 * `e·(S_MAX − S)/S_MAX`, which exceeds the headroom `S_MAX − S` once `e > S_MAX`,
 * i.e. for any donation over `S_MAX/L` = 120,000 TON. The headroom clamp in
 * `handleDonateFloor` is what makes "S never exceeds S_MAX" true there.
 */
describe('donate_floor cannot carry S past S_MAX (D-156)', () => {
    it('lands S exactly on S_MAX and still credits T with the whole donation', async () => {
        const s = await deployStack({ seedS: S_MAX / 2n });
        const donation = toNano('300000'); // e = X·L = 3e18 > S_MAX: the taper alone overshoots
        const whale = await s.blockchain.treasury('whale', { balance: donation + toNano('10') });

        const T0 = await s.ledger.getFloorNum();
        const S0 = await s.ledger.getFloorDen();
        expect(tapered(donation * 10_000n, S0)).toBeGreaterThan(S_MAX - S0); // the bug's precondition

        const r = await s.ledger.sendDonateFloor(whale.getSender(), {
            amount: donation,
            value: donation + toNano('0.1'),
        });

        expect(r.transactions).not.toHaveTransaction({ aborted: true });
        expect(await s.ledger.getFloorDen()).toBe(S_MAX);
        expect(await s.ledger.getFloorNum()).toBe(T0 + donation);
        // §5: the floor did not fall.
        expect((T0 + donation) * S0).toBeGreaterThanOrEqual(T0 * S_MAX);
    }, 180_000);

    it('a head mint on a dust-backed launch lands S on S_MAX, not past it (2026-11-08 audit)', async () => {
        // `ignite` asks only `T > 0`. At 0.0001 TON of backing, p_f·S_MAX is far under
        // the 0.65 TON injection, so the tapered rebate alone overshoots the headroom;
        // the mint path's own headroom clamp is what keeps the bound.
        const s = await deployStack({ seedT: 0n, donateBeforeIgnite: [toNano('0.0001')] });
        expect((await s.ledger.getLaunch()).launched).toBe(true);
        await s.mint(s.bob, 4n, 0, [{ prime: 2n, exponent: 2 }]);
        expect(await s.ledger.getFloorDen()).toBe(S_MAX);
    }, 180_000);
});

/**
 * D-52 / GAUNTLET.md R11 finding (a) — a bounced `JettonMint` parks its emission
 * instead of losing it, and `S` is never decremented to paper over it.
 *
 * `handleDonateFloor` counts the donor's PRIMES into `S` and THEN sends the
 * mint, exactly as `executeMint`'s rebate leg does. A bounce therefore leaves
 * `S` counting PRIMES no wallet holds.
 *
 * `S` is NOT rolled back, and that is the design rather than a shortfall.
 * `CLAUDE.md` and CONCEPT.md §3.3 say `S` is never decremented, and math-note
 * §2's conservatism corollary says why the rule is one-directional: `p_f = T/S`
 * must UNDERSTATE backing so a reader who recomputes against circulating supply
 * always gets a better number than the headline. Phantom PRIMES in `S` push
 * `p_f` down — the safe side. A rollback would push it up.
 *
 * So the emission is parked in `unminted_mints` and published by
 * `getUnmintedHeld()`, and `retry_mint` pays it out once whatever broke the
 * mint is fixed. There is no blind re-send on the bounce: every way this send
 * can fail is deterministic (unsealed master, wrong ledger, under-margined
 * value), so an immediate retry would fail identically AND could not report its
 * own outcome, which would corrupt the lane's books.
 *
 * The bounce here is GENUINE, not hand-crafted: the jetton authority is left
 * unsealed, so `MintOp` throws 400 for real. That window is reachable in
 * production precisely because `donate_floor` is gated on nothing (D-91 point
 * 4) — a stranger, or an over-eager genesis operator, can donate before the
 * pipeline's own seal step.
 */
describe('a bounced jetton mint is parked and replayable (D-52, R11 finding a)', () => {
    it('parks the emission, leaves S alone, and retry_mint pays it once the master works', async () => {
        // `seedT: 0n` plus one tranche is the real pipeline's own state
        // (D-46 point 2). It is also the state in which the donation emits at
        // the flat `L` rather than at the floor: D-100 point 1 clamps the
        // emission to `min(X·L, X·S/T)`, and below `p_f = 1/L` the flat rate is
        // the smaller of the two. (Before D-100 the op REFUSED a donation above
        // that boundary, with error 217; it now emits less instead, so this
        // fixture is no longer the only one the op is legal in — just the one
        // where `emitted = X·L` exactly, which is what the arithmetic below
        // assumes.)
        const s = await deployStack({ sealJetton: false, seedT: 0n, donateBeforeIgnite: [toNano('10')] });
        const donation = toNano('10');

        const sBefore = await s.ledger.getFloorDen();
        // D-29's L, then D-156's taper. `X·L` is what the rate would emit; what the
        // contract actually mints is that figure scaled by `(S_MAX − S)/S_MAX`.
        const emitted = tapered(donation * 10_000n, sBefore);
        const heldBefore = await s.ledger.getUnmintedHeld();
        const supplyBefore = (await s.master.getJettonData()).totalSupply;

        const r = await s.ledger.sendDonateFloor(s.alice.getSender(), {
            amount: donation,
            value: donation + toNano('0.1'),
        });

        // The donation itself lands: T rises, S rises, the ledger is happy.
        expect(r.transactions).toHaveTransaction({ to: s.ledger.address, success: true });
        expect(await s.ledger.getFloorNum()).toBeGreaterThan(0n);
        expect(await s.ledger.getFloorDen()).toBe(sBefore + emitted);

        // The mint genuinely failed at the master...
        expect(r.transactions).toHaveTransaction({
            from: s.ledger.address,
            to: s.master.address,
            success: false,
            exitCode: 400, // jetton_authority_sealed — mint is only live post-seal
        });
        // ...and the ledger PARKED it rather than re-sending blind. Exactly one
        // attempt: a second would have failed for the same deterministic reason.
        const attemptsTo = (addr: typeof s.master.address, res: typeof r) =>
            res.transactions.filter(
                (t) =>
                    t.inMessage?.info.type === 'internal' &&
                    !t.inMessage.info.bounced &&
                    t.inMessage.info.dest?.equals(addr)
            ).length;
        expect(attemptsTo(s.master.address, r)).toBe(1);
        expect(await s.ledger.getUnmintedHeld()).toBe(heldBefore + emitted);
        // Nothing was delivered, and `S` did not move a second time in either
        // direction — the bounce arm does not touch it.
        expect(await s.ledger.getFloorDen()).toBe(sBefore + emitted);

        // A retry while the master is STILL broken re-enters the lane rather
        // than vanishing: the send is RichBounce, so the pair is self-correcting.
        const r2 = await s.ledger.sendRetryMint(s.bob.getSender(), {
            to: s.alice.address,
            value: toNano('0.1'),
        });
        expect(attemptsTo(s.master.address, r2)).toBe(1);
        expect(await s.ledger.getUnmintedHeld()).toBe(heldBefore + emitted);

        // Fix what actually broke it, then retry for real. Permissionless:
        // bob pays to deliver alice's PRIMES, and cannot redirect them.
        await s.master.sendSealAuthority(s.genesisScript.getSender(), { value: toNano('0.05') });
        const r3 = await s.ledger.sendRetryMint(s.bob.getSender(), {
            to: s.alice.address,
            value: toNano('0.1'),
        });
        expect(r3.transactions).toHaveTransaction({
            from: s.ledger.address,
            to: s.master.address,
            success: true,
        });

        // The lane is empty, alice holds the PRIMES `S` always claimed she did.
        // `heldBefore` is not zero: the stack's own pre-ignite tranche is
        // alice's too and bounced the same way, and entries SUM per recipient —
        // so one retry settles both debts at once, which is the point of keying
        // the book on the wallet rather than on each failed send.
        expect(await s.ledger.getUnmintedHeld()).toBe(0n);
        const aliceWallet = s.blockchain.openContract(
            PrimesJettonWallet.createFromAddress(await s.master.getWalletAddress(s.alice.address))
        );
        expect((await aliceWallet.getWalletData()).balance).toBe(heldBefore + emitted);

        // ...and the identity this whole lane exists for closes, as a delta so
        // it does not depend on how the fixture seeded genesis:
        //   dS - d(unmintedHeld) == d(totalSupply)   (no burns in this stack)
        const dS = (await s.ledger.getFloorDen()) - sBefore;
        const dHeld = (await s.ledger.getUnmintedHeld()) - heldBefore;
        const dSupply = (await s.master.getJettonData()).totalSupply - supplyBefore;
        expect(dS - dHeld).toBe(dSupply);

        // A second retry for a wallet with nothing parked is a cheap no-op, not
        // a throw — a retry lane that reverts on a race is a worse lane.
        const r4 = await s.ledger.sendRetryMint(s.bob.getSender(), {
            to: s.alice.address,
            value: toNano('0.1'),
        });
        expect(r4.transactions).toHaveTransaction({ to: s.ledger.address, success: true });
        expect(attemptsTo(s.master.address, r4)).toBe(0);
        expect(await s.ledger.getUnmintedHeld()).toBe(0n);
    }, 180_000);
});
