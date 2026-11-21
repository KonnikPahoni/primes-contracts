/**
 * docs/audit/testnet-run-2026-09-14.md Phase 2 — the recruit cohort and the rebate ladder.
 *
 * Exercises every leg of `upliftSumFor` (primes_ledger.tolk:2041) against real,
 * distinct wallets that `minterState` has genuinely never seen, which is the whole
 * point: D-106's recruit edge is guarded by `!isFound` and nothing else, so a run
 * that reuses known addresses proves nothing about it.
 *
 *   npx tsx scripts/phase2RecruitCohortLive.ts <cast.json>
 *
 * TEN MINTS, AND THE COUNT IS LOAD-BEARING. The head is at 15 and the next primorial
 * boundary — the era ceremony Phase 3 needs — is 30. Exactly eleven composites lie
 * between (15,16,18,20,21,22,24,25,26,27,28), so this phase may spend TEN of them and
 * must leave the eleventh for `B` to mint 30. Overshooting does not merely misfile a
 * mint: §7 pays the era bounty to the primorial's MINTER, so it would hand the bounty
 * to whichever wallet happened to be minting. Every stage below is capped for that
 * reason, and `mintHead` refuses to run at or past the boundary.
 *
 * RESUMABLE WITHOUT A PROGRESS FILE — every guard is a chain read:
 *   - gifts done      = `getEraRecruits(A)`, because the gifts run in a fixed order
 *   - re-gift done    = `R1.left < NEWCOMER_WINDOW`, because a re-gift to a wallet the
 *                       ledger HAS seen credits no recruit but still spends one of the
 *                       beneficiary's five (the decrement at :3980 runs before the
 *                       recruit edge would reopen the window at :3988)
 *   - self-mints done = how much further `R1.left` has fallen
 */
import fs from 'fs';
import path from 'path';
import { Address, SendMode, TonClient, WalletContractV4, internal, fromNano } from '@ton/ton';
import { MINT_VALUE_NANOTON, FEE_MARGIN_NANOTON } from '../../shared/values';
import type { Sender, SenderArguments } from '@ton/core';
import { mnemonicToPrivateKey } from '@ton/crypto';
import { PrimesLedger } from '../wrappers/PrimesLedger';
import { normaliseCast, readCast } from './testnet/cast';
import { minterCardAddress } from '../../shared/minterCard';

/** primes_minter_card.tolk EDGE_HOLD: gifts to a card are refused this long after its recruit edge. */
const EDGE_HOLD_S = 300;

const REPO = path.resolve(__dirname, '..', '..');
const TESTNET_ENDPOINT = 'https://testnet.toncenter.com/api/v2/jsonRPC';

// G58: params.mint.mint_price_ton + the shared fee margin — never the exact price, never a guess.
const MINT_VALUE = MINT_VALUE_NANOTON + FEE_MARGIN_NANOTON;
const GIFTS = ['R1', 'R2', 'R3', 'R4', 'R5', 'R6'];
const SELF_MINTS = 3;
/**
 * The primorials, `isPrimorial` (primes_ledger.tolk:1447). A LIST, not one number:
 * this used to be `const ERA_BOUNDARY = 30n`, which is right exactly once. The head
 * crosses 30 the moment the ceremony mints it, and every later run of this phase
 * then refused with "head is 32, at or past the era boundary 30" — an era boundary
 * that is behind us is not a boundary to stop at. Found 2026-09-19, when phase 1
 * had walked the head to 26 and the cohort could not fit six gifts before 30.
 */
const PRIMORIALS = [2n, 6n, 30n, 210n, 2310n, 30030n, 510510n, 9699690n];

/** The first primorial STRICTLY ABOVE `n` — the next boundary, never a passed one. */
function nextEraBoundary(n: bigint): bigint {
    return PRIMORIALS.find((p) => p > n) ?? PRIMORIALS[PRIMORIALS.length - 1];
}

function factorize(n: bigint): { prime: bigint; exponent: number }[] {
    const out: { prime: bigint; exponent: number }[] = [];
    let rem = n;
    for (let d = 2n; d * d <= rem; d++) {
        if (rem % d === 0n) {
            let e = 0;
            while (rem % d === 0n) {
                rem /= d;
                e++;
            }
            out.push({ prime: d, exponent: e });
        }
    }
    if (rem > 1n) out.push({ prime: rem, exponent: 1 });
    return out;
}

async function retry<T>(fn: () => Promise<T>, label: string, n = 6): Promise<T> {
    for (let i = 0; i < n - 1; i++) {
        try {
            return await fn();
        } catch (e: any) {
            console.log(`[retry] ${label} attempt ${i + 1}: ${e?.message ?? e}`);
            await new Promise((r) => setTimeout(r, 3000 + i * 2000));
        }
    }
    return fn();
}

function makeSender(client: TonClient, keyPair: { publicKey: Buffer; secretKey: Buffer }): Sender {
    const wallet = WalletContractV4.create({ workchain: 0, publicKey: keyPair.publicKey });
    const wc = client.open(wallet);
    return {
        address: wallet.address,
        async send(args: SenderArguments) {
            const seqno = await retry(() => wc.getSeqno(), 'getSeqno');
            await retry(
                () =>
                    wc.sendTransfer({
                        seqno,
                        secretKey: keyPair.secretKey,
                        timeout: Math.floor(Date.now() / 1000) + 600,
                        sendMode: SendMode.PAY_GAS_SEPARATELY,
                        messages: [
                            internal({
                                to: args.to,
                                value: args.value,
                                bounce: args.bounce ?? undefined,
                                body: args.body ?? undefined,
                                init: args.init ?? undefined, // D-191: a first mint deploys the minter card
                            }),
                        ],
                    }),
                'sendTransfer'
            );
            let cur = seqno;
            for (let i = 0; cur === seqno && i < 60; i++) {
                await new Promise((r) => setTimeout(r, 5000));
                cur = await retry(() => wc.getSeqno(), 'poll-getSeqno');
            }
            if (cur === seqno) throw new Error(
                    'external not confirmed after ~5 minutes of seqno polling. The usual cause is a ' +
                        'wallet that cannot afford the value this message attaches — an unaffordable send ' +
                        'fails in the action phase (or is dropped) and never advances the seqno. Check the ' +
                        'balance first, then clock skew. (MISTAKES.md 2026-09-17.)'
                );
        },
    };
}

type CastEntry = { handle: string; address: string; mnemonic: string };

async function main() {
    const castFile = process.argv[2];
    // The cast has ONE generator (`scripts/testnet/cast.ts`) and one file,
    // `.cast.json` at the repo root, which `readCast()` returns in this shape. A
    // path argument still overrides it; two files of live mnemonics is one too many.
    const cast: CastEntry[] = castFile
        ? normaliseCast(JSON.parse(fs.readFileSync(castFile, 'utf8')))
        : readCast();
    const entry = (handle: string) => {
        const e = cast.find((c) => c.handle === handle);
        if (!e) throw new Error(`cast.json has no wallet "${handle}"`);
        return e;
    };

    // /\r?\n/, not '\n' — \r is a line terminator to JS regex but not to a Windows
    // .env, and a trailing \r poisons every value (see genesisPrep.ts).
    const envFile = fs.readFileSync(path.join(REPO, '.env'), 'utf8');
    const env = new Map<string, string>();
    for (const line of envFile.split(/\r?\n/)) {
        const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
        if (m) env.set(m[1], m[2].trim().replace(/^"|"$/g, ''));
    }
    const client = new TonClient({
        endpoint: TESTNET_ENDPOINT,
        apiKey: env.get('TONCENTER_API_KEY_TESTNET') || undefined,
    });
    const ledger = client.open(PrimesLedger.createFromAddress(Address.parse(env.get('PRIMES_LEDGER_ADDRESS')!)));

    const addrOf = (handle: string) => Address.parse(entry(handle).address);
    const senderFor = async (handle: string) =>
        makeSender(client, await mnemonicToPrivateKey(entry(handle).mnemonic.trim().split(/\s+/)));

    const A = addrOf('A');
    const R1 = addrOf('R1');
    const aSender = await senderFor('A');
    const r1Sender = await senderFor('R1');

    const showLine = async (label: string, who: Address, n: bigint) => {
        const line = await retry(() => ledger.getUpliftLine(n, who), `getUpliftLine(${label})`);
        const kmax = await retry(() => ledger.getKMaxFor(n, who), `getKMaxFor(${label})`);
        console.log(
            `    ${label} @n=${n}: primeRank=${line.primeRank} primeWindow=${line.primeWindow} ` +
                `newcomer=${line.newcomer} recruitRank=${line.recruitRank} ` +
                `SUMMED=${line.summed} clamped=${line.clamped} kMaxFor=${kmax}`
        );
    };

    /** One mint at the head, from `via`, gifted to `beneficiary` when non-null. */
    const mintHead = async (via: Sender, beneficiary: Address | null, what: string) => {
        const n = await retry(() => ledger.getHead(), 'getHead');
        if (PRIMORIALS.includes(n)) {
            throw new Error(
                `head is ${n}, which IS a primorial — this phase must stop on it. Minting it belongs to ` +
                    'cast wallet B (phase3EraCeremonyLive.ts): §7 pays the era bounty to its MINTER and the ' +
                    `trophy to the era's recruiter, so the two must be different wallets. Run the ceremony, ` +
                    'then re-run this phase to finish the cohort.'
            );
        }
        const factors = factorize(n);
        console.log(`  mint n=${n} (${factors.map((f) => `${f.prime}^${f.exponent}`).join('*')}) — ${what}`);
        await ledger.sendMint(via, { n, kind: 0, factors, referralKey: 0, beneficiary, value: MINT_VALUE });
        await new Promise((r) => setTimeout(r, 25_000));
        const after = await retry(() => ledger.getHead(), 'getHead(after)');
        if (after <= n) throw new Error(`mint did not land — head still ${after}`);
        return after;
    };

    const NEWCOMER_TOTAL = (await retry(() => ledger.getNewcomerWindow(R1), 'getNewcomerWindow(R1)')).total;

    console.log(`ledger ${ledger.address.toString()}`);
    console.log(`head   ${await retry(() => ledger.getHead(), 'head')}   NEWCOMER_WINDOW=${NEWCOMER_TOTAL}`);
    console.log(`A  ${A.toString()}  ${fromNano(await retry(() => client.getBalance(A), 'bal(A)'))} TON`);
    console.log(`R1 ${R1.toString()}  ${fromNano(await retry(() => client.getBalance(R1), 'bal(R1)'))} TON\n`);

    // ---- Stage 1: six gift mints, A -> R1..R6 --------------------------------
    console.log('=== stage 1: the recruit cohort (six §4.5 gift mints from A) ===');
    for (let i = 0; i < GIFTS.length; i++) {
        const done = await retry(() => ledger.getEraRecruits(A), 'getEraRecruits(A)');
        if (done > i) {
            console.log(`  skip gift to ${GIFTS[i]} — A already holds ${done} era recruits`);
            continue;
        }
        await mintHead(aSender, addrOf(GIFTS[i]), `gift to ${GIFTS[i]}`);
        const rank = await retry(() => ledger.getRecruitRank(A), 'getRecruitRank(A)');
        const win = await retry(() => ledger.getNewcomerWindow(addrOf(GIFTS[i])), 'getNewcomerWindow');
        console.log(
            `    A recruits=${rank.recruits} tier=${rank.tier} uplift=${rank.uplift} nextTierAt=${rank.nextTierAt}` +
                ` | ${GIFTS[i]} newcomer window=${win.left}/${win.total} uplift=${win.uplift}`
        );
    }

    // ---- Stage 2: the sybil guard --------------------------------------------
    // Gift R1 a SECOND time. `isRecruit` requires `!isFound` and R1 is now found, so
    // this must credit no recruit — while still spending one of R1's five, because the
    // window is decremented before the recruit edge would reopen it.
    console.log('\n=== stage 2: !isFound — re-gift R1, the recruit count must NOT move ===');
    const w1 = await retry(() => ledger.getNewcomerWindow(R1), 'getNewcomerWindow(R1)');
    if (w1.left < NEWCOMER_TOTAL) {
        console.log(`  skip — R1's window is already ${w1.left}/${NEWCOMER_TOTAL}, so the re-gift has run`);
    } else {
        const before = await retry(() => ledger.getEraRecruits(A), 'getEraRecruits(before)');
        // D-191: R1's card refuses EVERY gift (104) for EDGE_HOLD after its recruit edge
        // was sent, and publishes no get-method for when that was. So read the edge's own
        // timestamp off the card's transactions and wait it out on chain time — the G93 run
        // re-gifted 3 minutes after the edge and the card threw 104.
        const card = minterCardAddress(ledger.address, R1);
        const txs = await retry(() => client.getTransactions(card, { limit: 20 }), 'card txs(R1)');
        const edge = txs.find((t) => t.inMessage?.info.type === 'internal' && !t.inMessage.info.src.equals(R1));
        if (edge) {
            const chainNow = Math.floor(Date.now() / 1000); // the 30 s margin covers this laptop's skew
            const until = edge.now + EDGE_HOLD_S + 30;
            if (chainNow < until) {
                console.log(`  waiting ${until - chainNow}s for R1's edge hold (edge at ${edge.now}, hold ${EDGE_HOLD_S}s)`);
                await new Promise((r) => setTimeout(r, (until - chainNow) * 1000));
            }
        }
        await mintHead(aSender, R1, 're-gift to R1, an address minterState HAS seen');
        const after = await retry(() => ledger.getEraRecruits(A), 'getEraRecruits(after)');
        const win = await retry(() => ledger.getNewcomerWindow(R1), 'getNewcomerWindow(R1,after)');
        console.log(`    A era recruits ${before} -> ${after} (must be unchanged)`);
        console.log(`    R1 newcomer window ${NEWCOMER_TOTAL} -> ${win.left} (the re-gift spends one, and credits nothing)`);
        if (after !== before) {
            throw new Error(
                `SYBIL GUARD FAILED: a second gift to a known address credited a recruit (${before} -> ${after})`
            );
        }
    }

    // ---- Stage 3: R1 spends its own newcomer window ---------------------------
    console.log('\n=== stage 3: the newcomer window burning down (R1 mints for itself) ===');
    const floor = NEWCOMER_TOTAL - 1 - SELF_MINTS; // 5, less the re-gift, less three self-mints
    for (let i = 0; i < SELF_MINTS; i++) {
        const w = await retry(() => ledger.getNewcomerWindow(R1), 'getNewcomerWindow(R1)');
        if (w.left <= floor) {
            console.log(`  skip — R1's window is already at ${w.left}, the floor for this stage`);
            break;
        }
        const n = await retry(() => ledger.getHead(), 'getHead');
        console.log(`  R1 self-mint ${i + 1}/${SELF_MINTS} — window ${w.left}/${w.total} before:`);
        await showLine('R1', R1, n);
        await mintHead(r1Sender, null, 'R1 mints for itself');
        const wa = await retry(() => ledger.getNewcomerWindow(R1), 'getNewcomerWindow(R1,after)');
        console.log(`    window ${w.left} -> ${wa.left}`);
    }

    // ---- Read-back ------------------------------------------------------------
    console.log('\n=== Phase 2 read-back ===');
    const head = await retry(() => ledger.getHead(), 'getHead');
    console.log(`head = ${head}  (next era boundary ${nextEraBoundary(head)}: B mints the primorial in Phase 3)`);
    console.log('era leader   :', await retry(() => ledger.getEraLeader(), 'getEraLeader'));
    console.log('A recruit rank:', await retry(() => ledger.getRecruitRank(A), 'getRecruitRank(A)'));
    await showLine('A ', A, head);
    await showLine('R1', R1, head);
    for (const h of GIFTS) {
        const w = await retry(() => ledger.getNewcomerWindow(addrOf(h)), `getNewcomerWindow(${h})`);
        console.log(`  ${h} newcomer window=${w.left}/${w.total} uplift=${w.uplift}`);
    }
    console.log(`\nA  left with ${fromNano(await retry(() => client.getBalance(A), 'bal(A)'))} TON`);
    console.log(`R1 left with ${fromNano(await retry(() => client.getBalance(R1), 'bal(R1)'))} TON`);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
