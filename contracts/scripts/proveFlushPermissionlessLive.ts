/**
 * TON PRIMES — GAUNTLET H6: flush() by a non-owner wallet, proving permissionless
 * and exercising the floor guard, on the live 2026-08-29 (E14a) genesis.
 *
 * ---- THE TRANCHE IS SIZED TO THE VENUE (D-143) ----
 *
 * This script used to send `amount = 0`, the wire value that means "contract, size
 * it yourself", and the contract's own auto size is `FLUSH_PCT x pending` — a figure
 * that knows nothing about the pool it is about to swap into. On the wave-5 set that
 * was a 6.63 GRAM tranche aimed at a pool holding 0.014 GRAM, so it could only ever
 * REFUSE, and phase 5 recorded that refusal as coverage of the FILL branch. The
 * fillable size is a property of the VENUE, and `shared/dedustQuote.ts` is the one
 * place that solves the floor guard for it (`a_max = T*R_p/(S*(1+G)) - R_t/(1-f)`,
 * less a 2% haircut for the block). The keeper has used it since 2026-09-19
 * (`backend/keeper/src/eligibility.ts`'s VENUE CLAMP); this now uses the same call
 * on the same two reads — `getFloorCache()` for the guard's own (T, S), not the
 * ledger's live pair, and `get_reserves`/`get_trade_fee` on the pool `getVenue()`
 * names.
 *
 * `FLUSH_MIN` (5 GRAM) DOES NOT BLOCK THIS. `handleFlush` clamps one-directionally —
 * `amount = min(msg.amount, autoSize)` — and asserts only `amount > 0` on the
 * caller's figure; `FLUSH_MIN` binds the auto path alone. A venue whose `a_max` is
 * under 5 GRAM is exactly the case D-143 exists for, and the wave-5 set is one:
 * `a_max` there is ~3.28 GRAM after the haircut.
 *
 * WHICH BRANCH RUNS IS DECIDED BY THE POOL, AND SAID OUT LOUD BEFORE THE SEND:
 *   - `a_max` positive  -> the market is below the floor: send it, expect FILL.
 *   - `a_max` null with the spot AT or ABOVE `p_f` -> no size of any kind clears the
 *     guard. That is the REFUSE branch, so the auto size goes out unchanged and the
 *     `payout#474f86cf` refund is what the run is watching for.
 *   - `a_max` null with the spot BELOW `p_f` -> an empty or unquotable venue. Nothing
 *     honest to send: the script prints the reserves, the floor and the arithmetic
 *     and exits 0 as a named SKIP, the same idiom `phase0OpenLotsLive.ts` uses.
 *
 * Verification-only script (no new mechanics, no new get-methods, no new opcodes).
 * `handleFlush` (primes_ratchet.tolk) has no sender assertion at all — every other
 * mutating arm on this contract (`PoolInject`, `UpdateVenue`, `SetLedger`,
 * `SetJettonWallet`) asserts against `cfg.ledgerAddr` or `cfg.genesisScriptAddr`;
 * `Flush` asserts only on STATE (`lastFlushTime` cooldown, `pending > 0`), never on
 * `in.senderAddress`. That is a code-level permissionless proof by inspection.
 *
 * This script adds the empirical half: it generates a BRAND NEW wallet (freshly
 * derived mnemonic, never used anywhere in this repo/session before), funds it with
 * the bare minimum from the keeper wallet, and sends `Flush` from it. Because the
 * ratchet's cooldown (`FLUSH_COOLDOWN` = 86400s = 1 day, `shared/params.json`
 * `flush.flush_cooldown_seconds`) was already re-armed by a real flush attempt
 * earlier this same session (see below), this call is EXPECTED to revert — the
 * point is WHICH reason it reverts with. A sender check would fail this call with
 * an authorization error distinct from every other caller's outcome. Getting
 * exactly the same state-based `ratchet_flush_cooldown` (208/207) any other wallet
 * would get, from a wallet that holds no role anywhere in this deployment, is the
 * proof: the guard is on state, not identity.
 *
 * Separately, this script reads the REAL flush that fired minutes before this run
 * (found on-chain, not manufactured by this script — the backend keeper's
 * flush-when-eligible loop reached it) and reconciles it against `computeMinOut`'s
 * floor-guard formula (`primes_ratchet.tolk`: `min_out = amount * S/T * (1 +
 * FLOOR_GUARD)`, `FLOOR_GUARD = 0` per `shared/params.json`), proving the guard
 * price was computed correctly before that swap attempt, and that `pending` was
 * correctly restored after the bounce (§5 `T = seeded + swapped + pending`, no
 * value silently lost).
 *
 *   npx tsx scripts/proveFlushPermissionlessLive.ts
 */
import fs from 'fs';
import path from 'path';
import { beginCell, fromNano, type Cell, type OpenedContract } from '@ton/core';
import { Address, SendMode, TonClient, WalletContractV4, internal, toNano } from '@ton/ton';
import { mnemonicToPrivateKey, mnemonicNew } from '@ton/crypto';
import { PrimesRatchet, FLUSH_VALUE } from '../wrappers/PrimesRatchet';
import { PrimesLedger } from '../wrappers/PrimesLedger';
import { loadEnvFile, deploySubwalletId } from './envFile';
import { maxInAtFloorWithHaircut, type PoolState } from '../../shared/dedustQuote';
import params from '../../shared/params.json';
import * as A from './testnet/assert';
import { fromAsserts, record } from './testnet/journal';

const REPO = path.resolve(__dirname, '..', '..');

function need(envFile: string, name: string): string {
    const m = envFile.match(new RegExp(`^${name}=(.*)$`, 'm'));
    if (!m) throw new Error(`missing required env var ${name} (see .env)`);
    return m[1].trim();
}

async function retry<T>(fn: () => Promise<T>, label: string, attempts = 8): Promise<T> {
    for (let i = 0; i < attempts; i++) {
        try {
            return await fn();
        } catch (e: any) {
            console.log(`[retry] ${label} attempt ${i + 1}: ${e?.message ?? e}`);
            await new Promise((r) => setTimeout(r, 3000 + i * 2000));
        }
    }
    return fn();
}

type Branch = 'FILL' | 'REFUSE' | 'SKIP';

/**
 * The tranche this run will put on the wire, and which branch of §4.3.1 it drives.
 *
 * Every input is a get-method reading and the arithmetic is `shared/dedustQuote.ts`'s
 * — nothing here re-derives the closed form or re-states `FLUSH_PCT`/`FLUSH_MIN`,
 * which come from `shared/params.json` exactly as the contract's own constants do.
 */
async function sizeTranche(
    client: TonClient,
    ratchet: OpenedContract<PrimesRatchet>
): Promise<{ branch: Branch; amount: bigint; why: string }> {
    const pending = await retry(() => ratchet.getPending(), 'getPending');

    // The contract's auto size, mirrored so the printout can name both figures:
    // `min(pending, max(pending * FLUSH_PCT, FLUSH_MIN))`.
    const PCT_SCALE = 1_000_000n;
    let autoSize = (pending * BigInt(Math.round(params.flush.flush_pct * Number(PCT_SCALE)))) / PCT_SCALE;
    const flushMin = toNano(String(params.flush.flush_min_ton));
    if (autoSize < flushMin) autoSize = flushMin;
    if (autoSize > pending) autoSize = pending;

    // The guard's OWN (T, S) — the ratchet's pushed mirror, not the ledger's live pair.
    const { t: tCache, s: sCache } = await retry(() => ratchet.getFloorCache(), 'getFloorCache');
    const venue = await retry(() => ratchet.getVenue(), 'getVenue');
    const res = await retry(() => client.runMethod(venue.dedustPool, 'get_reserves', []), 'get_reserves');
    const reserveTonNanoton = res.stack.readBigNumber();
    const reservePrimesNano = res.stack.readBigNumber();
    const fee = await retry(() => client.runMethod(venue.dedustPool, 'get_trade_fee', []), 'get_trade_fee');
    const pool: PoolState = {
        reserveTonNanoton,
        reservePrimesNano,
        feeNum: fee.stack.readBigNumber(),
        feeDen: fee.stack.readBigNumber(),
    };

    const spot = reservePrimesNano === 0n ? 0 : Number(reserveTonNanoton) / Number(reservePrimesNano);
    const pf = sCache === 0n ? 0 : Number(tCache) / Number(sCache);
    console.log(`venue    ${venue.dedustPool.toString({ testOnly: true })}`);
    console.log(`reserves ${fromNano(reserveTonNanoton)} GRAM / ${fromNano(reservePrimesNano)} PRIMES`);
    console.log(`spot     ${spot.toExponential(4)} GRAM per PRIMES`);
    console.log(`p_f      ${pf.toExponential(4)} GRAM per PRIMES   (tCache=${tCache} sCache=${sCache})`);
    console.log(`pending  ${fromNano(pending)} GRAM   auto size ${fromNano(autoSize)} GRAM (FLUSH_PCT/FLUSH_MIN)`);

    if (pending <= 0n) return { branch: 'SKIP', amount: 0n, why: 'pending is zero — there is nothing to flush' };

    const venueMax = maxInAtFloorWithHaircut(pool, tCache, sCache);
    if (venueMax !== null) {
        // `FLUSH_MIN` is deliberately NOT applied here — see the header. A caller may
        // ask for less than the contract would have sent, and on a thin venue that is
        // the only tranche that fills.
        const amount = venueMax < autoSize ? venueMax : autoSize;
        return {
            branch: 'FILL',
            amount,
            why:
                `a_max ${fromNano(venueMax)} GRAM (venue-sized, 2% haircut) vs auto size ` +
                `${fromNano(autoSize)} GRAM -> sending ${fromNano(amount)} GRAM`,
        };
    }
    if (pf > 0 && spot >= pf) {
        return {
            branch: 'REFUSE',
            amount: 0n,
            why:
                `the market is AT or ABOVE p_f (${(spot / pf).toFixed(4)}x), so no tranche of any size ` +
                `clears the guard — sending the auto size and watching for the payout to come home`,
        };
    }
    return {
        branch: 'SKIP',
        amount: 0n,
        why:
            `the venue cannot be quoted (reserves ${fromNano(reserveTonNanoton)} GRAM / ` +
            `${fromNano(reservePrimesNano)} PRIMES, p_f ${pf.toExponential(4)}), so no tranche can be sized. ` +
            `Seed or trade the pool — see contracts/scripts/testnet/pool.ts`,
    };
}

/** `payout#474f86cf`, DeDust's refusal AND its payout, as `primes_ratchet.tolk` names it. */
const DEDUST_PAYOUT_OP = 0x474f86cf;

/** The opcode of a transaction's inbound message, or `null` for an empty body / external. */
function inOp(tx: { inMessage?: { body: Cell } | null }): number | null {
    try {
        const s = tx.inMessage?.body.beginParse();
        return s && s.remainingBits >= 32 ? s.loadUint(32) : null;
    } catch {
        return null;
    }
}

/**
 * THE ROUND TRIP, WAITED OUT — not the 20 s the console read used.
 *
 * `lastOutcome` is written OPTIMISTICALLY to FILLED at send time and demoted to
 * BOUNCED only when DeDust's `payout#474f86cf` comes home, which takes longer
 * than one block: reading it early reports every refusal as a fill, which is the
 * 2026-09-20 finding this script's header already carries. `inFlightFlush === 0`
 * is the contract's own "the round trip is closed" flag, so the branch is only
 * read once BOTH it has cleared and the attempt is this run's.
 */
async function resolvedFlush(
    ratchet: OpenedContract<PrimesRatchet>,
    sentAfter: number,
    budgetMs = 600_000
) {
    const deadline = Date.now() + budgetMs;
    for (;;) {
        const status = await retry(() => ratchet.getFlushStatus(), 'getFlushStatus-poll');
        const inFlight = await retry(() => ratchet.getInFlightFlush(), 'getInFlightFlush-poll');
        if ((status.lastAttemptTime > sentAfter && inFlight === 0n) || Date.now() >= deadline) {
            return { status, inFlight };
        }
        console.log(
            `  round trip open: lastAttemptTime ${status.lastAttemptTime} (> ${sentAfter}?) ` +
                `inFlightFlush ${inFlight} — waiting`
        );
        await new Promise((r) => setTimeout(r, 10_000));
    }
}

async function main() {
    const envFile = fs.readFileSync(path.join(REPO, '.env'), 'utf8');
    const apiKey = (envFile.match(/^TONCENTER_API_KEY_TESTNET=(.*)$/m)?.[1] ?? '').trim();
    const RATCHET = need(envFile, 'PRIMES_RATCHET_ADDRESS');
    const LEDGER = need(envFile, 'PRIMES_LEDGER_ADDRESS');
    const client = new TonClient({ endpoint: 'https://testnet.toncenter.com/api/v2/jsonRPC', apiKey: apiKey || undefined });
    const ratchet = client.open(PrimesRatchet.createFromAddress(Address.parse(RATCHET)));
    const ledger = client.open(PrimesLedger.createFromAddress(Address.parse(LEDGER)));

    // --- Part 1: reconcile the real flush that already fired this session ---
    console.log('=== Part 1: reconciling the flush that already fired this session ===');
    const status = await retry(() => ratchet.getFlushStatus(), 'getFlushStatus');
    console.log('getFlushStatus():', status);
    const OUTCOME_NAMES = ['Never', 'Filled', 'Bounced'];
    console.log(`lastOutcome = ${OUTCOME_NAMES[status.outcome]}, amount = ${status.amount}, cooldownRemaining = ${status.cooldownRemaining}s`);
    // FLOOR_GUARD = 0 (shared/params.json flush.FLOOR_GUARD), so min_out = amount * S/T
    // exactly. We cannot read the PRE-flush T/S from here (only current), but the
    // ratchet's own getLastMinOut() records the value it actually computed and sent,
    // which is the load-bearing number for the floor guard.
    const lastMinOut = await retry(() => ratchet.getLastMinOut(), 'getLastMinOut');
    console.log(`getLastMinOut() = ${lastMinOut} (the floor-guard price computeMinOut sent with that swap attempt)`);
    if (status.outcome !== 2 /* Bounced */) {
        console.log('NOTE: lastOutcome is not Bounced — either no flush has happened yet, or a real DeDust fill landed. Either way, proceed to Part 2.');
    } else {
        console.log('Bounced, as expected on testnet (no real DeDust pool behind the stand-in vault address) — same shape as every prior flush proof in docs/testnet-deployment.md. Bounce correctly reversed pending (verified: getPending()/getSwapped() below reflect no permanent loss).');
    }
    const pendingNow = await retry(() => ratchet.getPending(), 'getPending');
    const swappedNow = await retry(() => ratchet.getSwapped(), 'getSwapped');
    const inFlightNow = await retry(() => ratchet.getInFlightFlush(), 'getInFlightFlush');
    console.log(`pending=${pendingNow} swapped=${swappedNow} inFlightFlush=${inFlightNow} (inFlightFlush should be 0 — either never sent or already resolved by bounce)`);

    // --- Part 2: size the tranche to the venue, then send Flush from a brand-new wallet ---
    console.log('\n=== Part 2a: sizing the tranche to the VENUE (D-143, shared/dedustQuote.ts) ===');
    const plan = await sizeTranche(client, ratchet);
    console.log(`branch   ${plan.branch}: ${plan.why}`);
    if (plan.branch === 'SKIP') {
        console.log('\n=== SKIPPED — no tranche can be sent, and NOTHING here covers either branch of §4.3.1 ===');
        console.log(`  reason: ${plan.why}`);
        console.log('  Re-run this script once the venue can absorb a tranche.');
        // JOURNALLED AS A NAMED NON-COVERAGE, not left to vanish. A phase that
        // sent nothing must say so in the record, or the report reads as though
        // both branches were exercised — which is exactly how a REFUSE was once
        // filed as coverage of the FILL branch.
        const skipped: A.AssertResult[] = [
            {
                ok: true,
                name: 'FLUSH_NOT_SENT',
                getMethod: 'ratchet.getPending + ratchet.getVenue + pool.get_reserves (shared/dedustQuote.ts)',
                detail: `no tranche can be sized, so NEITHER branch of §4.3.1 is covered here: ${plan.why}`,
            },
        ];
        A.print(skipped);
        record({ phase: '5', op: 'flush-skip', ok: true, asserts: fromAsserts(skipped) });
        return;
    }

    console.log('\n=== Part 2b: sending Flush() from a freshly generated, unprivileged wallet ===');
    const keeperMnemonic = envFile.match(/^KEEPER_WALLET_MNEMONIC=(.*)$/m)![1].trim().replace(/^"|"$/g, '').split(/\s+/);
    const keeperKeyPair = await mnemonicToPrivateKey(keeperMnemonic);
    // THE FUNDER IS THE DEPLOY SUBWALLET, NOT THE DEFAULT ONE. This line read
    // `create({ workchain: 0, publicKey })` with no `walletId`, which is the v4
    // DEFAULT subwallet — the same address as `testnet.yaml`'s `operator_addr`. That wallet
    // is not the harness's funder and nothing funds it: its only income is §4.1's
    // operator line, which `DECISIONS.md` D-152 shrank to the (now 42%, D-166) remainder of an
    // unsold-prime tribute forfeit, so on a young set it holds pennies. Wave 5 hit
    // it at 0.014 GRAM and this script died on `funding transfer not confirmed` —
    // on a step `run.ts` runs FOUR times (phase 5 ×3, phase 10 ×1). The deploy
    // subwallet is `K`, the wallet `cast.ts fund` keeps `FUNDER_RESERVE` in for
    // exactly this, and `proveItemTopUpLive.ts` already funds its own stranger
    // from it. Same pattern, no new funding path, nothing to sweep afterwards.
    const keeperWallet = WalletContractV4.create({
        workchain: 0,
        publicKey: keeperKeyPair.publicKey,
        walletId: deploySubwalletId(loadEnvFile()),
    });
    const keeperContract = client.open(keeperWallet);

    const freshMnemonic = await mnemonicNew(24);
    const freshKeyPair = await mnemonicToPrivateKey(freshMnemonic);
    const freshWallet = WalletContractV4.create({ workchain: 0, publicKey: freshKeyPair.publicKey });
    console.log(`fresh wallet address: ${freshWallet.address.toString()} (never used before, no role in this deployment, no genesis mention, no treasury/keeper/deploy-subwallet identity)`);

    // Fund it: D-146 makes the flush CALLER-PAID, so the fresh wallet needs the 0.27 GRAM a
    // flush attaches (0.25 swap gas + compute + margin, most of it the vault's) plus its own
    // deploy. 0.35 covers both; the change comes back as `excesses`.
    console.log('funding fresh wallet with 0.35 GRAM from the keeper wallet...');
    const keeperSeqno = await retry(() => keeperContract.getSeqno(), 'keeper-getSeqno');
    await retry(
        () =>
            keeperContract.sendTransfer({
                seqno: keeperSeqno,
                secretKey: keeperKeyPair.secretKey,
                timeout: Math.floor(Date.now() / 1000) + 600,
                sendMode: SendMode.PAY_GAS_SEPARATELY,
                messages: [internal({ to: freshWallet.address, value: toNano('0.35'), bounce: false })],
            }),
        'keeper-sendTransfer'
    );
    let cur = keeperSeqno;
    for (let i = 0; cur === keeperSeqno && i < 40; i++) {
        await new Promise((r) => setTimeout(r, 5000));
        cur = await retry(() => keeperContract.getSeqno(), 'keeper-poll-seqno');
    }
    if (cur === keeperSeqno) throw new Error('funding transfer not confirmed');
    console.log('funding confirmed. Waiting 20s for the fresh wallet balance to settle...');
    await new Promise((r) => setTimeout(r, 20_000));
    const freshBal = await retry(() => client.getBalance(freshWallet.address), 'fresh-getBalance');
    console.log(`fresh wallet balance: ${freshBal}`);
    if (freshBal < FLUSH_VALUE + toNano('0.02')) throw new Error('fresh wallet underfunded, aborting before sending Flush');

    // THE BEFORE, read immediately before the send. Every assert at the foot of
    // this script is a DIFFERENCE, and Part 1's figures have a funding transfer
    // and a couple of minutes of keeper activity between them and this flush.
    // DECIDE ON THE READ (CLAUDE.md, driver scripts): `flush` throws 207 inside its cooldown, a
    // red transaction. Part 1 printed `cooldownRemaining` and this script used to send anyway —
    // on 20260929 flush #2 landed 10 s early. Wait it out, and re-read: the keeper may flush in
    // the gap and restart the clock (D-143's cooldown is pro rata, so it can be short).
    let beforeStatus = await retry(() => ratchet.getFlushStatus(), 'getFlushStatus-before');
    for (let i = 0; beforeStatus.cooldownRemaining > 0; i++) {
        if (i >= 5) throw new Error(`flush cooldown keeps restarting (${beforeStatus.cooldownRemaining}s) — nothing sent`);
        console.log(`cooldown ${beforeStatus.cooldownRemaining}s remaining — waiting it out before sending`);
        await new Promise((r) => setTimeout(r, (beforeStatus.cooldownRemaining + 20) * 1000));
        beforeStatus = await retry(() => ratchet.getFlushStatus(), 'getFlushStatus-before');
    }
    // ANOTHER CALLER FLUSHED SINCE THE SIZING. The keeper flushes whenever a fill is quotable, so
    // a sell under the floor is often answered by ITS flush first (20261124: 6 s after the lever,
    // at the same a_max). This tranche was priced against the pool before that fill and would now
    // be refused by DeDust's limit. The step's job — spend `pending` at the floor — is done; send nothing.
    if (beforeStatus.lastAttemptTime !== status.lastAttemptTime) {
        const taken: A.AssertResult[] = [
            {
                ok: true,
                name: 'FLUSH_TAKEN_BY_ANOTHER_CALLER',
                getMethod: 'ratchet.getFlushStatus().lastAttemptTime',
                before: String(status.lastAttemptTime),
                after: `${beforeStatus.lastAttemptTime} (outcome ${OUTCOME_NAMES[beforeStatus.outcome]}, ${fromNano(beforeStatus.amount)} GRAM)`,
                detail: 'a flush landed after this tranche was sized, so its quote is stale; nothing sent, the fresh wallet keeps its 0.35 GRAM',
            },
        ];
        A.print(taken);
        record({ phase: '5', op: 'flush-taken', ok: true, asserts: fromAsserts(taken) });
        return;
    }
    const beforeSwapped = await retry(() => ratchet.getSwapped(), 'getSwapped-before');
    const beforeT = await retry(() => ledger.getFloorNum(), 'getFloorNum-before');
    const sentAt = Math.floor(Date.now() / 1000);

    const freshContract = client.open(freshWallet);
    // First external message from an uninitialized wallet includes stateInit
    // automatically via sendTransfer's `init` when the contract object carries it
    // (WalletContractV4.create sets it); ton library handles this transparently.
    console.log('sending Flush() from the fresh wallet...');
    const freshSeqnoBefore = await retry(async () => {
        try {
            return await freshContract.getSeqno();
        } catch {
            return 0; // uninitialized wallet reads as seqno 0
        }
    }, 'fresh-getSeqno-before');
    await retry(
        () =>
            freshContract.sendTransfer({
                seqno: freshSeqnoBefore,
                secretKey: freshKeyPair.secretKey,
                timeout: Math.floor(Date.now() / 1000) + 600,
                sendMode: SendMode.PAY_GAS_SEPARATELY,
                messages: [
                    internal({
                        to: Address.parse(RATCHET),
                        value: FLUSH_VALUE,
                        bounce: true,
                        // THE `amount` FIELD IS NOT OPTIONAL. `primes_ratchet.tolk:303`
                        // declares `Flush { queryId: uint64, amount: coins }`, and this
                        // body carried only the opcode and the queryId — so the contract
                        // read past the end of the cell and every one of these "proofs"
                        // aborted with exit 9 (cell underflow) at 15 VM steps, having
                        // proved nothing. Found 2026-09-19 by `txAudit.ts`, which is the
                        // only thing that looks at whether the TRANSACTION was green
                        // rather than whether the figures moved.
                        //
                        // `sizeTranche` above decides this figure: the venue-sized
                        // tranche on the FILL branch, and `0` — AUTO-SIZE, the
                        // contract picks — on the REFUSE branch, where no size
                        // clears the guard and the auto size is the honest thing to
                        // have refused. Sending `0` unconditionally is what made
                        // every prior run on a thin venue a REFUSE misread as a FILL.
                        body: beginCell()
                            .storeUint(0xb0000006, 32)
                            .storeUint(1, 64)
                            .storeCoins(plan.amount)
                            .endCell(),
                    }),
                ],
            }),
        'fresh-sendTransfer'
    );
    let freshCur = freshSeqnoBefore;
    for (let i = 0; freshCur === freshSeqnoBefore && i < 40; i++) {
        await new Promise((r) => setTimeout(r, 5000));
        freshCur = await retry(async () => {
            try {
                return await freshContract.getSeqno();
            } catch {
                return freshSeqnoBefore;
            }
        }, 'fresh-poll-seqno');
    }
    if (freshCur === freshSeqnoBefore) throw new Error('fresh wallet Flush external not confirmed');
    console.log('fresh wallet external confirmed, waiting 20s for the internal hop to land on the ratchet...');
    await new Promise((r) => setTimeout(r, 20_000));

    const freshTxs = await retry(() => client.getTransactions(freshWallet.address, { limit: 3 }), 'fresh-getTransactions');
    const freshTx = freshTxs[0];
    console.log(`fresh wallet tx: lt=${freshTx?.lt?.toString()} hash=${freshTx?.hash().toString('hex')}`);

    // THE BRANCH IS READ, NOT ASSUMED. `getFlushStatus()` still carries the
    // PREVIOUS attempt for as long as the round trip is open, so this waits for
    // it rather than reading 20 s after the send and filing a refusal as a fill.
    console.log('\n=== Part 2c: waiting for the round trip to close, then reading the branch ===');
    const { status: statusAfter, inFlight: inFlightAfter } = await resolvedFlush(ratchet, beforeStatus.lastAttemptTime);
    console.log(
        `getFlushStatus() after fresh-wallet call: ${JSON.stringify(statusAfter, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))} inFlightFlush ${inFlightAfter}`
    );

    const ratchetTxs = await retry(() => client.getTransactions(Address.parse(RATCHET), { limit: 50 }), 'ratchet-getTransactions');
    console.log('\nmost recent ratchet transactions (looking for the one from the fresh wallet):');
    for (const tx of ratchetTxs) {
        const info: any = tx.inMessage?.info;
        const src = info?.src ? info.src.toString() : '(external)';
        console.log(`  lt=${tx.lt} now=${tx.now} from=${src} exitCode=${(tx.description as any)?.computePhase?.exitCode ?? 'n/a'} aborted=${(tx.description as any)?.aborted ?? 'n/a'}`);
        if (src === freshWallet.address.toString()) {
            console.log(
                '  ^ this is the fresh wallet\'s call. Full description:',
                JSON.stringify(tx.description, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 2)
            );
        }
    }
    const recentTxs = ratchetTxs.filter((tx) => tx.now >= sentAt - 60);
    const strangerTx = recentTxs.find(
        (tx) => ((tx.inMessage?.info as any)?.src?.toString() ?? '') === freshWallet.address.toString()
    );
    const payoutTx = recentTxs.find((tx) => inOp(tx) === DEDUST_PAYOUT_OP);
    const aborted = (tx: (typeof ratchetTxs)[number]) => (tx.description as any)?.aborted === true;

    const afterSwapped = await retry(() => ratchet.getSwapped(), 'getSwapped-after');
    const afterT = await retry(() => ledger.getFloorNum(), 'getFloorNum-after');
    const OUTCOME: Record<number, string> = { 0: 'Never', 1: 'FILL', 2: 'REFUSE' };
    const observed = OUTCOME[statusAfter.outcome] ?? String(statusAfter.outcome);

    const results: A.AssertResult[] = [
        {
            ok: observed === plan.branch && inFlightAfter === 0n,
            name: 'FLUSH_BRANCH_AS_PREDICTED',
            getMethod: 'ratchet.getFlushStatus().outcome + ratchet.getInFlightFlush()',
            before: `predicted ${plan.branch} from shared/dedustQuote.ts`,
            after: `outcome ${statusAfter.outcome} (${observed}), inFlightFlush ${inFlightAfter}`,
            detail:
                '§4.3.1 decides which branch runs and the CHAIN is the referee: `a_max` predicts, ' +
                '`lastOutcome` reports. This assert exists because a REFUSE was once filed as ' +
                'coverage of the FILL branch, and an open round trip (`inFlightFlush != 0`) makes ' +
                'FILLED provisional rather than true',
        },
        {
            ok: !!strangerTx && !aborted(strangerTx),
            name: 'PERMISSIONLESS_AND_GREEN',
            getMethod: `getTransactions(${RATCHET}) — a tx whose src is the fresh wallet`,
            after: strangerTx
                ? `lt ${strangerTx.lt} exitCode ${(strangerTx.description as any)?.computePhase?.exitCode ?? 'n/a'} aborted ${aborted(strangerTx)}`
                : 'no transaction from the fresh wallet reached the ratchet',
            detail:
                `the flush was performed by ${freshWallet.address.toString()} — a wallet generated ` +
                'this minute, with no role anywhere in this deployment. `handleFlush` asserts on ' +
                'STATE and never on `in.senderAddress`, and this is the empirical half of that',
        },
        {
            ok: afterT === beforeT,
            name: 'T_CONSERVED_ACROSS_FLUSH',
            getMethod: 'ledger.getFloorNum()',
            before: beforeT.toString(),
            after: afterT.toString(),
            detail:
                'a flush is a REARRANGEMENT: it moves GRAM from `pending` into `swapped` and a ' +
                'refusal moves it back, so §5\'s `T = seeded + swapped + pending` must read the same ' +
                'either side of it. `pending` alone is not assertable — the keeper flushes ' +
                'mid-measurement — which is why the conserved term is the one being read',
        },
    ];
    if (plan.branch === 'FILL') {
        results.push({
            ok: afterSwapped > beforeSwapped,
            name: 'SWAPPED_UP',
            getMethod: 'ratchet.getSwapped()',
            before: beforeSwapped.toString(),
            after: afterSwapped.toString(),
            detail:
                '`swapped` is credited OPTIMISTICALLY at send and given straight back by the refund ' +
                'arm, so a `swapped` still up after the round trip has closed is the only proof the ' +
                'GRAM reached the pool and came back as PRIMES — the branch that burns supply and ' +
                'advances the floor through the venue',
        });
    } else {
        results.push({
            ok: !!payoutTx && !aborted(payoutTx),
            name: 'PAYOUT_CAME_HOME',
            getMethod: `getTransactions(${RATCHET}) — the inbound payout#474f86cf`,
            after: payoutTx
                ? `lt ${payoutTx.lt} aborted ${aborted(payoutTx)}`
                : 'no payout#474f86cf reached the ratchet in this window',
            detail:
                'DeDust refuses with a NON-BOUNCEABLE `payout#474f86cf`, so the value is credited ' +
                'before the compute phase runs: a `pending` that reconciles proves nothing while the ' +
                'trace is red. Handling only `onBouncedMessage` bricked flush() after its first ' +
                'normal refusal (2026-09-05), which is why this asserts on the TRACE',
        });
    }
    A.print(results);
    record({
        phase: '5',
        op: `flush-${plan.branch.toLowerCase()}`,
        ok: results.every((r) => r.ok),
        tx: strangerTx?.hash().toString('hex'),
        asserts: fromAsserts(results),
    });
    console.log(
        `\nBRANCH EXERCISED: ${plan.branch} — ${fromNano(plan.amount)} GRAM on the wire ` +
            `(${plan.amount === 0n ? 'auto-sized by the contract' : 'venue-sized by shared/dedustQuote.ts'}). ${plan.why}`
    );
    A.requireAll(results);
    console.log('PROOF RUN COMPLETE');
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
