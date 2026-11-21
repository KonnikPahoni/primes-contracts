/**
 * TON PRIMES — the three money paths §4.1 pays out on, asserted on a live chain:
 * REFERRAL, TRIBUTE and the FLAT DIVIDEND.
 *
 * What was already proven before this file: a resolvable `referralKey = 4` paid
 * 0.0996 TON and an unresolvable `= 1` paid nothing (the since-deleted `proveReferralLive.ts`,
 * which prints and asserts nothing but the head), and the five-way split
 * reconciled against the fee meters (`proveCompositeSplitLive.ts`).
 *
 * What nothing proved, and this does:
 *
 *  - **An excluded referral key is indistinguishable from no key.** GAUNTLET V7
 *    added two exclusions — a key naming a MARKED-BUT-UNSOLD prime, and a key
 *    naming a RESERVED (auctioned) composite — precisely because both used to
 *    forward 0.1 TON to an address with no contract on it. Neither has ever
 *    been fired on chain. Nor has a key AHEAD of the head.
 *  - **The excluded line folds into the pool** rather than to the team (§3.1,
 *    §4.1). Measured as the closure quantity below, not asserted by eye.
 *  - **Tribute accrues to a √p factor's owner.** The deleted `proveTributeClaimLive.ts`
 *    starts from whatever `owed` already is; nothing reads an item's `owed`
 *    ACROSS a mint that cites it.
 *  - **The flat dividend accrues.** `getDivAcc` / `getDivEntry` /
 *    `getClaimableDividend` have never been read across a mint on chain.
 *  - **`claim_dividend` is permissionless.** It has only ever been fired by the
 *    prime's own owner, which proves the happy path and not the gate.
 *
 * THE CLOSURE QUANTITY. A single mint's β is not comparable between two mints —
 * forfeits and tribute resolution differ with the factors. What IS comparable is
 *
 *     closure = Δpending + Δforfeited + ΔtributeOwed + ΔdivOutstanding
 *
 * every term of which is a published get-method. The referral line is the only
 * other §4.1 destination that varies between these cases, so `closure` differs
 * by exactly `REFERRAL_AMOUNT` between a resolvable key and an excluded one, and
 * by ZERO between an excluded key and no key at all. That equality is the assert.
 *
 *   npx tsx contracts/scripts/testnet/money.ts referral [handle]
 *   npx tsx contracts/scripts/testnet/money.ts tribute  [handle]
 *   npx tsx contracts/scripts/testnet/money.ts dividend <p> [handle]
 *   npx tsx contracts/scripts/testnet/money.ts claim    <p> [handle]
 *   npx tsx contracts/scripts/testnet/money.ts walk     <count> [handle]
 *   npx tsx contracts/scripts/testnet/money.ts gift     <to> [handle]   # §4.5 gift mint (G54)
 *   npx tsx contracts/scripts/testnet/money.ts refer    <key> [handle]  # head mint citing key (G54)
 *
 * `claim` is the OWNER-ONLY half of the pair `dividend` opens: `claim_dividend`
 * credits the ITEM, and only `ITEM.claim_tribute` from the owner moves it out to
 * a wallet. Nothing in the run had ever sent it with a journal row — the one
 * driver, `proveTributeClaimLive.ts` (now deleted), was optional, hardcoded to the keeper key
 * and a prime nobody owns on a fresh set.
 *
 * `walk` is §3's HEAD WALK: `count` plain composite mints at the head, so the
 * sequential line advances far enough for the descending lane to have opened
 * prime lots of its own. It is `mintHead` in a loop and nothing else — the
 * per-mint asserts are the ratchet ones every mint owes.
 */
import { Address, fromNano, toNano } from '@ton/core';
import { MINT_VALUE_NANOTON, FEE_MARGIN_NANOTON } from '../../../shared/values';
import { TonClient } from '@ton/ton';
import { PrimesItem } from '../../wrappers/PrimesItem';
import { isqrt, type FactorEntry } from '../../../shared/factors';
import { retry, type Wallet } from './sender';
import { addr, contracts, snapshot, walletFor, type Contracts } from './chain';
import * as A from './assert';
import { fromAsserts, record } from './journal';

const REFERRAL_AMOUNT = toNano('0.1');
// G58: params.mint.mint_price_ton + the shared fee margin — never the exact price, never a guess.
const MINT_VALUE = MINT_VALUE_NANOTON + FEE_MARGIN_NANOTON;
const SETTLE_MS = 30_000;

export function isPrime(n: bigint): boolean {
    if (n < 2n) return false;
    for (let d = 2n; d * d <= n; d++) if (n % d === 0n) return false;
    return true;
}

export function factorize(n: bigint): FactorEntry[] {
    const out: FactorEntry[] = [];
    let rem = n;
    for (let d = 2n; d * d <= rem; d++) {
        if (rem % d === 0n) {
            let e = 0;
            while (rem % d === 0n) {
                rem /= d;
                e++;
            }
            out.push({ prime: d, exponent: e, s: isqrt(d) });
        }
    }
    if (rem > 1n) out.push({ prime: rem, exponent: 1, s: isqrt(rem) });
    return out;
}

const ton = (v: bigint) => (Number(v) / 1e9).toFixed(9);

/**
 * The four published terms that close over a mint, read in one pass.
 *
 * THE FIRST TERM IS `T`, NOT `pending`, AND THAT IS THE WHOLE POINT OF THIS
 * COMMENT. It read `pending` until 2026-09-20, when the wave-4 run reported
 * `REFERRAL_EXCLUDED_1009` broken: a mint carrying a key AHEAD OF THE HEAD
 * injected 0.006216431 TON less than a no-key mint, with every other term
 * identical. It had not. The ledger's `pool_inject#b0000050` for that mint
 * declared the full 750000003 nanoton, exactly as its neighbours did — and
 * nineteen seconds later, INSIDE this function's own 30s settle window, the
 * keeper (`KEEPER_INTERVAL_MS=60000`) sent a venue-clamped `flush()` of exactly
 * 6216434 nanoton, which `primes_ratchet.tolk:692` takes OUT of `pending` and
 * `:699` puts into `swapped`.
 *
 * `flush()` is permissionless by design (§4.3.1) and the keeper runs against
 * every live set, so `pending` is a figure a third party may move between any
 * two reads this harness makes. `T = seedT + swapped + pending` (§5, D-26) is
 * the identity `assert.tIdentity` already checks every step, and a flush moves
 * value BETWEEN two of its terms — so `T` is flush-invariant by construction,
 * while still rising by exactly the pool injection on every mint. Reading it
 * keeps the assert's meaning ("differs by exactly `REFERRAL_AMOUNT`") and makes
 * the measurement immune to the one actor the protocol invites in.
 *
 * The alternative — stopping the keeper for the duration of a money run — was
 * rejected: it makes the run depend on an operator action, and the property
 * worth having is a measurement that survives a live chain, not a quiet one.
 */
async function closureTerms(c: Contracts, factors: FactorEntry[]) {
    const s = await snapshot(c);
    let forfeited = 0n;
    for (const f of factors) {
        forfeited += await retry(() => c.ledger.getForfeited(f.prime), `getForfeited(${f.prime})`);
    }
    return {
        // Kept for the per-mint log line below, which is a reading, not an assert.
        pending: s.pending,
        forfeited,
        tributeOwed: s.liability.tributeOwed,
        divOutstanding: s.liability.divOutstanding,
        snap: s,
        total: s.T + forfeited + s.liability.tributeOwed + s.liability.divOutstanding,
    };
}

/** Mint the current head as a composite, returning the closure delta. */
async function mintHead(c: Contracts, w: Wallet, referralKey: number, label: string, beneficiary: Address | null = null) {
    const n = await retry(() => c.ledger.getHead(), 'getHead');
    if (isPrime(n)) {
        throw new Error(
            `head ${n} is PRIME — the core loop cannot mint it sequentially (§4.4: a prime opens a ` +
                `descending lot). Walk the head past it first, or re-run when it has moved.`
        );
    }
    const factors = factorize(n);
    const before = await closureTerms(c, factors);
    console.log(
        `\n[${label}] mint n=${n} referralKey=${referralKey} factors ` +
            factors.map((f) => `${f.prime}^${f.exponent}`).join('·')
    );
    await c.ledger.sendMint(w.sender, {
        n,
        kind: 0,
        factors,
        referralKey,
        beneficiary,
        value: MINT_VALUE,
    });
    await new Promise((r) => setTimeout(r, SETTLE_MS));
    const after = await closureTerms(c, factors);
    const headAfter = await retry(() => c.ledger.getHead(), 'getHead(after)');
    if (headAfter <= n) throw new Error(`[${label}] head did not advance — still ${headAfter}`);
    const closure = after.total - before.total;
    console.log(
        `[${label}] closure ${ton(closure)} TON  (ΔT ${ton(after.snap.T - before.snap.T)} · ` +
            `Δpending ${ton(after.pending - before.pending)}${
                after.snap.T - before.snap.T !== after.pending - before.pending
                    ? ' — a flush moved pending mid-window; ΔT is the honest one'
                    : ''
            } · ` +
            `Δforfeit ${ton(after.forfeited - before.forfeited)} · Δtribute ` +
            `${ton(after.tributeOwed - before.tributeOwed)} · Δdiv ${ton(after.divOutstanding - before.divOutstanding)})`
    );
    return { n, factors, before, after, closure };
}

async function ownerOf(c: Contracts, n: bigint): Promise<Address | null> {
    try {
        const itemAddr = await retry(() => c.ledger.getItemAddress(n), `getItemAddress(${n})`);
        const item = c.client.open(PrimesItem.createFromAddress(itemAddr));
        const { owner } = await retry(() => item.getNumberData(), `getNumberData(${n})`);
        return owner;
    } catch {
        return null; // no contract there — exactly what the exclusions protect against
    }
}

/**
 * Case 1 of the referral run: pick a key for each exclusion off the CHAIN, never
 * off a hardcoded list. A key the chain does not currently exclude is skipped
 * with its reason rather than silently proving nothing.
 */
async function pickExcludedKeys(c: Contracts, head: bigint) {
    const out: { key: number; why: string }[] = [];
    for (let p = 2n; p < head && out.length < 1; p++) {
        if (!isPrime(p)) continue;
        const unsold = await retry(() => c.ledger.isPrimeUnsold(p), `isPrimeUnsold(${p})`);
        if (unsold) out.push({ key: Number(p), why: `marked-but-unsold prime ${p} (V7)` });
    }
    for (let n = 2n; n < head && out.length < 2; n++) {
        if (isPrime(n)) continue;
        const reserved = await retry(() => c.ledger.isNumberOffHead(n), `isNumberOffHead(${n})`);
        if (reserved === 1) out.push({ key: Number(n), why: `reserved/auctioned composite ${n} (V7)` });
    }
    out.push({ key: Number(head) + 1000, why: 'a key ahead of the head' });
    return out;
}

async function cmdReferral(c: Contracts, handle: string) {
    const w = await walletFor(c.client, handle);
    const head = await retry(() => c.ledger.getHead(), 'getHead');
    const excluded = await pickExcludedKeys(c, head);
    console.log(`referral run from ${handle} ${w.wallet.address.toString({ testOnly: true })}`);
    console.log('excluded keys this set offers:');
    for (const e of excluded) console.log(`  ${e.key} — ${e.why}`);

    // BASELINE: no key at all. Everything else is measured against this mint.
    const base = await mintHead(c, w, 0, 'baseline key=0');
    const results: A.AssertResult[] = [];

    for (const e of excluded) {
        const refereeBefore = await ownerOf(c, BigInt(e.key));
        const balBefore = refereeBefore ? await A.balance(refereeBefore) : 0n;
        const run = await mintHead(c, w, e.key, `excluded key=${e.key}`);
        const balAfter = refereeBefore ? await A.balance(refereeBefore) : 0n;
        results.push({
            ok: run.closure === base.closure,
            name: `REFERRAL_EXCLUDED_${e.key}`,
            getMethod:
                'ratchet.getPending + ledger.getForfeited + ledger.getLiabilityBreakdown ' +
                '(isPrimeUnsold / isNumberOffHead / getHead are the exclusion inputs)',
            before: ton(base.closure),
            after: ton(run.closure),
            detail:
                `${e.why}: closure ${ton(run.closure)} vs baseline ${ton(base.closure)} — ` +
                (run.closure === base.closure
                    ? 'indistinguishable from no key, so the 0.1 TON folded to the pool'
                    : `DIFFERS by ${ton(run.closure - base.closure)}`),
        });
        if (refereeBefore) {
            results.push({
                ok: balAfter === balBefore,
                name: `REFERRAL_NO_PAYOUT_${e.key}`,
                getMethod: `item(${e.key}).getNumberData().owner balance`,
                before: ton(balBefore),
                after: ton(balAfter),
                detail: `excluded key must pay nobody; Δ ${ton(balAfter - balBefore)}`,
            });
        }
    }

    // And the resolvable side, against the same baseline: closure must be
    // exactly REFERRAL_AMOUNT lower, because that 0.1 left for a real owner.
    const resolvable = await firstResolvableKey(c, head, w.wallet.address);
    if (resolvable === null) {
        console.log('no resolvable referral key on this set (no sold, owned number below the head)');
    } else {
        const owner = await ownerOf(c, BigInt(resolvable));
        const balBefore = owner ? await A.balance(owner) : 0n;
        const run = await mintHead(c, w, resolvable, `resolvable key=${resolvable}`);
        const balAfter = owner ? await A.balance(owner) : 0n;
        results.push({
            ok: base.closure - run.closure === REFERRAL_AMOUNT,
            name: 'REFERRAL_PAID',
            getMethod: 'ratchet.getPending + ledger.getLiabilityBreakdown, vs the baseline mint',
            before: ton(base.closure),
            after: ton(run.closure),
            detail: `closure lower by ${ton(base.closure - run.closure)}, expected exactly ${ton(REFERRAL_AMOUNT)}`,
        });
        if (owner && !owner.equals(w.wallet.address)) {
            const paid = balAfter - balBefore;
            results.push({
                ok: paid > REFERRAL_AMOUNT - toNano('0.002') && paid <= REFERRAL_AMOUNT,
                name: 'REFERRAL_ARRIVED',
                getMethod: `item(${resolvable}).getNumberData().owner balance`,
                detail: `owner received ${ton(paid)} TON (0.1 less two forward fees)`,
            });
        } else if (owner) {
            // NOT a failure and NOT silence: the payment is already proved by
            // REFERRAL_PAID above, which reads the pool rather than a wallet. What
            // cannot be done here is ATTRIBUTE it, because this wallet's balance
            // also carries the mint it just paid for.
            console.log(
                `  SKIP REFERRAL_ARRIVED   key ${resolvable} is owned by the minter itself, so its ` +
                    `balance delta is the mint (-${fromNano(MINT_VALUE)}) plus the referral (+0.1) and isolates neither. ` +
                    `REFERRAL_PAID proves the payout from the pool side. Re-run after phase 2 gives ` +
                    `a number to a wallet that is not paying.`
            );
        }
    }

    const s = await snapshot(c);
    results.push(A.tIdentity(s), A.solvency(s), A.sMonotone(base.before.snap, s), A.floorUp(base.before.snap, s));
    record({ phase: '1', op: 'referral-exclusions', ok: results.every((r) => r.ok), asserts: fromAsserts(results) });
    A.requireAll(results);
}

/** A number below the head that is minted and owned — the only valid key shape. */
async function firstResolvableKey(c: Contracts, head: bigint, payer?: Address): Promise<number | null> {
    // TWO PASSES, and the order is the whole point. `REFERRAL_ARRIVED` measures the
    // key owner's BALANCE, so a key whose owner is the wallet paying for the mint
    // cannot be measured at all: that balance moves by `-mint + referral` and the
    // referral is invisible inside it. On a fresh set every number below the head
    // is owned by the deploy wallet, which is also the minter, so the naive first
    // match is always the unmeasurable one (2026-09-19: read `-0.976 TON` and
    // called it a failed payout, on a run where the closure assert had just proved
    // the 0.1 TON left the pool exactly).
    const candidates: bigint[] = [];
    for (let n = 2n; n < head; n++) {
        if (isPrime(n)) {
            const unsold = await retry(() => c.ledger.isPrimeUnsold(n), `isPrimeUnsold(${n})`);
            if (unsold) continue;
        } else {
            const reserved = await retry(() => c.ledger.isNumberOffHead(n), `isNumberOffHead(${n})`);
            if (reserved === 1) continue;
        }
        const owner = await ownerOf(c, n);
        if (!owner) continue;
        if (payer && !owner.equals(payer)) return Number(n); // measurable: a third party
        candidates.push(n);
    }
    return candidates.length ? Number(candidates[0]) : null;
}

/**
 * TRIBUTE: mint a composite that cites a SOLD prime and watch that prime's item
 * `owed` rise by its weighted share, and the flat dividend accrue.
 */
async function cmdTribute(c: Contracts, handle: string) {
    const w = await walletFor(c.client, handle);
    const head = await retry(() => c.ledger.getHead(), 'getHead');
    if (isPrime(head)) throw new Error(`head ${head} is prime — walk it past first`);
    const factors = factorize(head);

    const owedBefore = new Map<string, bigint>();
    const sold: FactorEntry[] = [];
    for (const f of factors) {
        const unsold = await retry(() => c.ledger.isPrimeUnsold(f.prime), `isPrimeUnsold(${f.prime})`);
        if (unsold) continue;
        const itemAddr = await retry(() => c.ledger.getItemAddress(f.prime), `getItemAddress(${f.prime})`);
        const item = c.client.open(PrimesItem.createFromAddress(itemAddr));
        try {
            owedBefore.set(f.prime.toString(), await retry(() => item.getOwed(), `getOwed(${f.prime})`));
            sold.push(f);
        } catch {
            /* not deployed yet — not a tribute destination */
        }
    }
    const divAccBefore = await retry(() => c.ledger.getDivAcc(), 'getDivAcc');
    const primesCount = BigInt(await retry(() => c.ledger.getPrimesCount(), 'getPrimesCount'));
    const before = await snapshot(c);

    console.log(
        `minting ${head} — ${sold.length} of ${factors.length} cited factors are SOLD and should accrue tribute`
    );
    await c.ledger.sendMint(w.sender, {
        n: head,
        kind: 0,
        factors,
        referralKey: 0,
        beneficiary: null,
        value: MINT_VALUE,
    });
    await new Promise((r) => setTimeout(r, SETTLE_MS));

    const results: A.AssertResult[] = [];
    const sumWeights = factors.reduce((a, f) => a + BigInt(f.exponent) * (f.s ?? isqrt(f.prime)), 0n);
    const divisorPot = toNano('0.08');
    for (const f of sold) {
        const itemAddr = await retry(() => c.ledger.getItemAddress(f.prime), `getItemAddress(${f.prime})`);
        const item = c.client.open(PrimesItem.createFromAddress(itemAddr));
        const now = await retry(() => item.getOwed(), `getOwed(after,${f.prime})`);
        const was = owedBefore.get(f.prime.toString()) ?? 0n;
        const expect = (divisorPot * BigInt(f.exponent) * (f.s ?? isqrt(f.prime))) / sumWeights;
        results.push({
            ok: now - was === expect,
            name: `TRIBUTE_SHARE_${f.prime}`,
            getMethod: `item(${f.prime}).getOwed()`,
            before: ton(was),
            after: ton(now),
            detail:
                `Δ ${ton(now - was)}, expected 0.08·e·s/Σ(e·s) = ${ton(expect)} ` +
                `(e ${f.exponent}, s ${f.s ?? isqrt(f.prime)}, Σ ${sumWeights})`,
        });
    }
    const after = await snapshot(c);
    const divAccAfter = await retry(() => c.ledger.getDivAcc(), 'getDivAcc(after)');
    const perPrime = primesCount > 0n ? toNano('0.02') / primesCount : 0n;
    results.push({
        ok: divAccAfter - divAccBefore === perPrime,
        name: 'DIVIDEND_ACCRUAL',
        getMethod: 'ledger.getDivAcc + ledger.getPrimesCount',
        before: divAccBefore.toString(),
        after: divAccAfter.toString(),
        detail: `ΔdivAcc ${divAccAfter - divAccBefore}, expected 0.02/π = ${perPrime} over ${primesCount} primes`,
    });
    results.push({
        ok: after.liability.tributeOwed >= before.liability.tributeOwed,
        name: 'TRIBUTE_DECLARED',
        getMethod: 'ledger.getLiabilityBreakdown().tributeOwed',
        before: ton(before.liability.tributeOwed),
        after: ton(after.liability.tributeOwed),
        detail: `the ledger custodies what the items are owed; Δ ${ton(after.liability.tributeOwed - before.liability.tributeOwed)}`,
    });
    results.push(A.tIdentity(after), A.solvency(after), A.floorUp(before, after), A.sMonotone(before, after));
    record({ phase: '1', op: 'tribute-accrual', ok: results.every((r) => r.ok), asserts: fromAsserts(results) });
    A.requireAll(results);
}

/**
 * DIVIDEND: `claim_dividend` is permissionless (§3.2.1) — it credits the PRIME's
 * item, not the caller, so anyone may pay its gas. It has only ever been fired
 * by the prime's own owner, which does not test the gate. Fire it from `F`.
 */
async function cmdDividend(c: Contracts, p: bigint, handle: string) {
    const w = await walletFor(c.client, handle);
    const claimableBefore = await retry(() => c.ledger.getClaimableDividend(p), `getClaimableDividend(${p})`);
    const entryBefore = await retry(() => c.ledger.getDivEntry(p), `getDivEntry(${p})`);
    const divAcc = await retry(() => c.ledger.getDivAcc(), 'getDivAcc');
    const itemAddr = await retry(() => c.ledger.getItemAddress(p), `getItemAddress(${p})`);
    const item = c.client.open(PrimesItem.createFromAddress(itemAddr));
    const owedBefore = await retry(() => item.getOwed(), 'getOwed');
    const before = await snapshot(c);
    console.log(
        `claiming the dividend of prime ${p} from ${handle} (who owns nothing) — claimable ${ton(claimableBefore)} TON`
    );
    // Decide on the read: a prime minted after the last head mint has accrued nothing, and a
    // claim of 0 proves no sweep (the G93 run sent one straight after the lot closed).
    if (claimableBefore <= 0n) {
        // A prime AHEAD of the head accrues nothing (getClaimableDividend: `p >= head` reads 0;
        // the flat dividend divides by π below the head, §3.2). An auction-won prime on testnet is
        // always ahead, so the claim is recorded as that reading, not sent.
        if (BigInt(before.head) <= p) {
            const results: A.AssertResult[] = [
                {
                    ok: claimableBefore === 0n,
                    name: 'NO_DIVIDEND_AHEAD_OF_THE_HEAD',
                    getMethod: 'ledger.getClaimableDividend + getHead',
                    after: `claimable ${ton(claimableBefore)}, head ${before.head} <= ${p}`,
                    detail: 'a prime ahead of the head is outside π(head) and accrues no flat dividend — read, not sent',
                },
            ];
            record({ phase: '7', op: `claim-dividend-${p}`, ok: true, asserts: fromAsserts(results), note: 'read only: prime ahead of the head' });
            A.print(results);
            return;
        }
        throw new Error(`prime ${p} has accrued no dividend (claimable ${claimableBefore}) — nothing to sweep. Nothing sent.`);
    }
    await c.ledger.sendClaimDividend(w.sender, { p, value: toNano('0.06') });
    await new Promise((r) => setTimeout(r, SETTLE_MS));

    const claimableAfter = await retry(() => c.ledger.getClaimableDividend(p), `getClaimableDividend(after,${p})`);
    const entryAfter = await retry(() => c.ledger.getDivEntry(p), `getDivEntry(after,${p})`);
    const owedAfter = await retry(() => item.getOwed(), 'getOwed(after)');
    const after = await snapshot(c);
    const results: A.AssertResult[] = [
        {
            ok: claimableAfter === 0n && claimableBefore > 0n,
            name: 'DIVIDEND_SWEPT',
            getMethod: `ledger.getClaimableDividend(${p})`,
            before: ton(claimableBefore),
            after: ton(claimableAfter),
            detail: 'a permissionless claim drains the prime’s accrued share to zero',
        },
        {
            ok: entryAfter === divAcc || entryAfter > entryBefore,
            name: 'DIVIDEND_ENTRY_RESTAMPED',
            getMethod: `ledger.getDivEntry(${p}) vs ledger.getDivAcc()`,
            before: entryBefore.toString(),
            after: entryAfter.toString(),
            detail: `divEntry moves to divAcc (${divAcc}) so the same share cannot be claimed twice`,
        },
        {
            ok: owedAfter - owedBefore === claimableBefore,
            name: 'DIVIDEND_CREDITED_TO_ITEM',
            getMethod: `item(${p}).getOwed()`,
            before: ton(owedBefore),
            after: ton(owedAfter),
            detail: `the claim pays the ITEM, not the caller: Δowed ${ton(owedAfter - owedBefore)}`,
        },
        A.tIdentity(after),
        A.solvency(after),
        A.sMonotone(before, after),
    ];
    record({ phase: '1', op: `claim-dividend-${p}`, ok: results.every((r) => r.ok), asserts: fromAsserts(results) });
    A.requireAll(results);
}


/**
 * §4.7's owner-only claim. `claim_dividend` (above) pays the ITEM; this is the
 * only op that moves an item's `owed` to a wallet, and it is gated
 * `senderAddress == owner` (throw 300). Asserts the owed line goes to zero and
 * that the ledger's declared tribute liability drops by the same amount — the
 * custody hand-off, not just a balance that grew.
 */
async function cmdClaim(c: Contracts, p: bigint, handle: string) {
    const w = await walletFor(c.client, handle);
    const itemAddr = await retry(() => c.ledger.getItemAddress(p), `getItemAddress(${p})`);
    const item = c.client.open(PrimesItem.createFromAddress(itemAddr));
    const owedBefore = await retry(() => item.getOwed(), 'getOwed');
    const before = await snapshot(c);
    const liabBefore = await retry(() => c.ledger.getLiabilityBreakdown(), 'getLiabilityBreakdown');
    if (owedBefore === 0n) {
        // Read, not sent, when nothing could have accrued: a prime ahead of the head earns no
        // flat dividend (§3.2) and no head composite can cite it, so an auction-won prime on a
        // testnet run is owed nothing. Anywhere else a 0 is a finding, and stops the run.
        if (BigInt(before.head) <= p) {
            const results: A.AssertResult[] = [
                {
                    ok: true,
                    name: 'NOTHING_OWED_AHEAD_OF_THE_HEAD',
                    getMethod: `item(${p}).getOwed() + ledger.getHead`,
                    after: `owed 0, head ${before.head} <= ${p}`,
                    detail: 'no tribute or dividend can reach a prime ahead of the head — read, not sent',
                },
            ];
            record({ phase: '7', op: `claim-tribute-${p}`, ok: true, asserts: fromAsserts(results), note: 'read only: prime ahead of the head' });
            A.print(results);
            return;
        }
        throw new Error(`${p} owes its owner nothing (getOwed 0) — a claim would move nothing; nothing sent`);
    }
    console.log(`claiming ${ton(owedBefore)} TON of tribute on ${p} from ${handle} (the owner)`);
    await item.sendClaimTribute(w.sender, { value: toNano('0.12') });
    await new Promise((r) => setTimeout(r, SETTLE_MS));
    const owedAfter = await retry(() => item.getOwed(), 'getOwed(after)');
    const after = await snapshot(c);
    const liabAfter = await retry(() => c.ledger.getLiabilityBreakdown(), 'getLiabilityBreakdown(after)');
    const results: A.AssertResult[] = [
        {
            ok: owedBefore > 0n && owedAfter === 0n,
            name: 'TRIBUTE_CLAIMED',
            getMethod: `item(${p}).getOwed()`,
            before: ton(owedBefore),
            after: ton(owedAfter),
            detail: 'the owner-only claim drains the item to zero',
        },
        {
            ok: liabBefore.tributeOwed - liabAfter.tributeOwed === owedBefore,
            name: 'TRIBUTE_LIABILITY_RELEASED',
            getMethod: 'ledger.getLiabilityBreakdown().tributeOwed',
            before: ton(liabBefore.tributeOwed),
            after: ton(liabAfter.tributeOwed),
            detail: 'the ledger stops custodying exactly what the item stopped being owed',
        },
        A.tIdentity(after),
        A.solvency(after),
        A.sMonotone(before, after),
    ];
    record({ phase: '7', op: `claim-tribute-${p}`, ok: results.every((r) => r.ok), asserts: fromAsserts(results) });
    A.requireAll(results);
}

/** §3 phase 3's head walk: `count` plain composite mints, each fully asserted. */
async function cmdWalk(c: Contracts, count: number, handle: string) {
    const w = await walletFor(c.client, handle);
    for (let i = 0; i < count; i++) {
        const before = await snapshot(c);
        const r = await mintHead(c, w, 0, `walk ${i + 1}/${count}`);
        const after = await snapshot(c);
        const results = [A.tIdentity(after), A.solvency(after), A.sMonotone(before, after), A.floorUp(before, after)];
        record({
            phase: '3',
            op: `walk-mint-${r.n}`,
            ok: results.every((x) => x.ok),
            asserts: fromAsserts(results),
        });
        A.requireAll(results);
    }
    const head = await retry(() => c.ledger.getHead(), 'getHead(final)');
    console.log(`
head is now ${head} after ${count} mints`);
}

/**
 * §4.5 GIFT: one head mint paid by `handle`, owned by `to` from block one. G54 drives the
 * owner `P` through it. Decided on the read BEFORE the send: a beneficiary whose newcomer
 * window is already open has been gifted on this set, so `!isFound` would credit nothing.
 */
async function cmdGift(c: Contracts, to: string, handle: string) {
    const w = await walletFor(c.client, handle);
    // `to` is a cast handle or a raw address: a recruit only has to be an address `minterState`
    // has never seen, and a fresh one needs no mnemonic because a recruit never sends anything.
    const dest = Address.isFriendly(to) || Address.isRaw(to) ? Address.parse(to) : (await walletFor(c.client, to)).wallet.address;
    const win = await retry(() => c.ledger.getNewcomerWindow(dest), 'getNewcomerWindow');
    if (win.left > 0) throw new Error(`${to} already has a newcomer window (${win.left}/${win.total}) — a gift would credit no recruit; nothing sent`);
    const rankBefore = await retry(() => c.ledger.getRecruitRank(w.wallet.address), 'getRecruitRank');
    const before = await snapshot(c);
    const r = await mintHead(c, w, 0, `gift ${handle} -> ${to}`, dest);
    const after = await snapshot(c);
    const rank = await retry(() => c.ledger.getRecruitRank(w.wallet.address), 'getRecruitRank(after)');
    const winAfter = await retry(() => c.ledger.getNewcomerWindow(dest), 'getNewcomerWindow(after)');
    const owner = await ownerOf(c, r.n);
    console.log(`  ${handle} recruits ${rankBefore.recruits} -> ${rank.recruits} tier ${rank.tier} · ${to} window ${winAfter.left}/${winAfter.total} · #${r.n} owner ${owner?.toString({ testOnly: true })}`);
    const results: A.AssertResult[] = [
        { ok: rank.recruits === rankBefore.recruits + 1, name: 'GIFT_CREDITS_ONE_RECRUIT', getMethod: 'ledger.getRecruitRank', before: String(rankBefore.recruits), after: String(rank.recruits), detail: 'D-106: a gift to an address minterState has never seen is +1 recruit' },
        { ok: !!owner && owner.equals(dest), name: 'GIFT_OWNED_BY_BENEFICIARY', getMethod: 'item.getNumberData', before: to, after: owner?.toString() ?? 'none', detail: '§4.5: a gifted number is owned by its beneficiary from block one' },
        A.tIdentity(after), A.solvency(after), A.sMonotone(before, after), A.floorUp(before, after),
    ];
    record({ phase: 'G54', op: `gift-${r.n}-${handle}-to-${to}`, ok: results.every((x) => x.ok), asserts: fromAsserts(results) });
    A.requireAll(results);
}

/** One head mint by `handle` citing `referralKey` — G54 step 5's referral cohort. */
async function cmdRefer(c: Contracts, key: number, handle: string) {
    const owner = await ownerOf(c, BigInt(key));
    if (!owner) throw new Error(`#${key} has no owner on this set — the key would not resolve; nothing sent`);
    const w = await walletFor(c.client, handle);
    const before = await snapshot(c);
    const r = await mintHead(c, w, key, `${handle} mints citing #${key}`);
    const after = await snapshot(c);
    const results = [A.tIdentity(after), A.solvency(after), A.sMonotone(before, after), A.floorUp(before, after)];
    record({ phase: 'G54', op: `refer-mint-${r.n}-key-${key}-${handle}`, ok: results.every((x) => x.ok), asserts: fromAsserts(results) });
    A.requireAll(results);
}

async function main() {
    const [cmd, ...rest] = process.argv.slice(2);
    const c = contracts();
    if (cmd === 'referral') return cmdReferral(c, rest[0] ?? 'K');
    if (cmd === 'tribute') return cmdTribute(c, rest[0] ?? 'K');
    if (cmd === 'dividend') {
        if (!rest[0]) throw new Error('usage: money.ts dividend <p> [handle]');
        return cmdDividend(c, BigInt(rest[0]), rest[1] ?? 'F');
    }
    if (cmd === 'claim') {
        if (!rest[0]) throw new Error('usage: money.ts claim <p> [handle]');
        return cmdClaim(c, BigInt(rest[0]), rest[1] ?? 'A');
    }
    if (cmd === 'walk') {
        if (!rest[0]) throw new Error('usage: money.ts walk <count> [handle]');
        return cmdWalk(c, Number(rest[0]), rest[1] ?? 'K');
    }
    if (cmd === 'walk-to') {
        // Plain mints until the head reaches <n> — phase 2's cohort lands wherever phase 1
        // left the head (28 on 20261121), and the ceremony needs it ON the primorial.
        if (!rest[0]) throw new Error('usage: money.ts walk-to <n> [handle]');
        const target = BigInt(rest[0]);
        // One mint at a time, re-reading the head: it skips primes AND auctioned numbers,
        // and overshooting onto <n> would hand §7's minter bounty to this wallet.
        let head = await retry(() => c.ledger.getHead(), 'getHead');
        if (head >= target) return console.log(`head ${head} is already at or past ${target} — nothing sent`);
        while (head < target) {
            await cmdWalk(c, 1, rest[1] ?? 'K');
            head = await retry(() => c.ledger.getHead(), 'getHead');
        }
        return;
    }
    if (cmd === 'gift') {
        if (!rest[0]) throw new Error('usage: money.ts gift <to handle|address> [handle]');
        return cmdGift(c, rest[0], rest[1] ?? 'K');
    }
    if (cmd === 'refer') {
        if (!rest[0]) throw new Error('usage: money.ts refer <key> [handle]');
        return cmdRefer(c, Number(rest[0]), rest[1] ?? 'K');
    }
    console.log(
        'usage: money.ts referral|tribute [handle] · dividend <p> [handle] · claim <p> [handle] · walk <count> [handle] · gift <to> [handle] · refer <key> [handle]'
    );
}

if (require.main === module) {
    main().catch((e) => {
        console.error(e?.message ?? e);
        process.exit(1);
    });
}

// A TonClient import is kept for the type of `contracts().client` consumers.
export type { TonClient };
