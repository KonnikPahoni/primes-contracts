/**
 * docs/audit/testnet-run-2026-09-14.md Phase 3 — the era ceremony at the primorial boundary, and the
 * trophy transfer that follows it. Closes `GAUNTLET.md` H7.
 *
 *   npx tsx scripts/phase3EraCeremonyLive.ts <cast.json>
 *
 * §7's ceremony pays TWO rewards to TWO DIFFERENT WALLETS out of one transaction, and
 * proving that is the whole point of the cast:
 *
 *   - the **era bounty** goes to the primorial's MINTER — `B` here — as a `PayEraBounty`
 *     to the bounty vault, priced at `T`/`S` AFTER this mint, i.e. at the floor the mint
 *     that triggered the ceremony just established (primes_ledger.tolk:4353);
 *   - **permanent naming rights** over the same primorial go to the era's top RECRUITER
 *     — `A`, with six recruits — as an `AwardEraTrophy` to the registrar, sent beside
 *     `PayEraBounty` rather than out of it, sharing no arithmetic with it (:2471).
 *
 * A single-wallet run cannot tell those apart, which is why `A` and `B` are different
 * wallets and why `B` is a stranger to the recruit ladder.
 *
 * Then D-14's transfer: the trophy is the ONE naming right in this system that moves,
 * and only its current holder can move it. A prime's naming right is permanent and the
 * registrar refuses it — `getTrophy(n).transferable` is the flag that says which is
 * which.
 */
import fs from 'fs';
import path from 'path';
import { Address, SendMode, TonClient, WalletContractV4, internal, fromNano, toNano } from '@ton/ton';
import { MINT_VALUE_NANOTON, FEE_MARGIN_NANOTON } from '../../shared/values';
import type { Sender, SenderArguments } from '@ton/core';
import { mnemonicToPrivateKey } from '@ton/crypto';
import { PrimesLedger } from '../wrappers/PrimesLedger';
import { PrimesRegistrar } from '../wrappers/PrimesRegistrar';
import { PrimesBountyVault } from '../wrappers/PrimesBountyVault';
import { normaliseCast, readCast } from './testnet/cast';
import { openWallet } from './testnet/sender';
import { hydrateProcessEnv } from './envFile';

// W10. This script carries its own inline `.env` line-loop inside `main()`, which runs too
// late for any module-scope `process.env.PRIMES_*` read — and `PRIMES_CEREMONY_N` is now
// exactly that. The shared hydrator runs at import time and never overwrites a var the shell
// set, so the inline loop below becomes a no-op and `PRIMES_CEREMONY_N=6 npx tsx …` still
// wins. `tools/check-scripts-hydrate-env.test.mjs` is what caught the omission.
hydrateProcessEnv();

const REPO = path.resolve(__dirname, '..', '..');
const TESTNET_ENDPOINT = 'https://testnet.toncenter.com/api/v2/jsonRPC';

/**
 * The boundary this run closes. `isPrimorial` (primes_ledger.tolk:1452) knows eight:
 * 6, 30, 210, 2310, 30030, 510510, 9699690, 223092870. A ceremony fires at whichever one
 * the head reaches, so which one a run uses is a question of where the head IS, not of the
 * mechanic — and on a fresh genesis that is **6**, two mints after ignition (the head skips
 * 5, which is prime). This was a file constant pinned at 30 because the set it was written
 * against had already walked there; reaching 30 from a fresh genesis costs seventeen
 * composite mints and proves nothing the boundary at 6 does not.
 */
const PRIMORIAL = BigInt(process.env.PRIMES_CEREMONY_N ?? '30');
/** A primorial's factorization is its definition: every prime below it, once. */
function primorialFactors(n: bigint): { prime: bigint; exponent: number }[] {
    const out: { prime: bigint; exponent: number }[] = [];
    let rest = n;
    for (let p = 2n; rest > 1n; p++) {
        let e = 0;
        while (rest % p === 0n) {
            rest /= p;
            e++;
        }
        if (e > 0) out.push({ prime: p, exponent: e });
    }
    return out;
}
const PRIMORIAL_FACTORS = primorialFactors(PRIMORIAL);

/**
 * §4.5 GIFT MINT, and on era 0 it is the only way the ceremony has a trophy to award.
 *
 * `season.leaderCount == 0` means nobody activated a recruit this era, so the primorial is
 * left unnamed and no recipient is invented. On a fresh genesis era 0 is TWO MINTS LONG,
 * so there is no room to recruit before the boundary. But the recruit credit and the trophy
 * award happen in the SAME mint handler, credit first (primes_ledger.tolk:3961, then :4549),
 * so the boundary mint can itself be the gift that creates the recruiter. The bounty then
 * follows the BENEFICIARY and the trophy follows the PAYER — two different wallets out of
 * one transaction, which is exactly what §7 says and what this script exists to tell apart.
 *
 * Set to a cast handle (e.g. `R1`). Unset = a plain mint, which is what a later era wants.
 */
const GIFT_TO = process.env.PRIMES_CEREMONY_GIFT_TO;
// G58: params.mint.mint_price_ton + the shared fee margin — never the exact price, never a guess.
const MINT_VALUE = MINT_VALUE_NANOTON + FEE_MARGIN_NANOTON;

async function retry<T>(fn: () => Promise<T>, label: string, n = 6): Promise<T> {
    for (let i = 0; i < n - 1; i++) {
        try {
            return await fn();
        } catch (e: any) {
            console.log(`[retry] ${label}: ${e?.message ?? e}`);
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

type CastEntry = { handle: string; address: string; mnemonic: string; version?: 'v4r2' | 'v5r1' };

async function main() {
    const castFile = process.argv[2];
    // The cast has ONE generator (`scripts/testnet/cast.ts`) and one file,
    // `.cast.json` at the repo root, which `readCast()` returns in this shape. A
    // path argument still overrides it; two files of live mnemonics is one too many.
    // The same defect `phase0OpenLotsLive.ts` carried: the on-disk file is
    // `{wallets:[{name, mnemonic: string[]}]}` and every reader here wants
    // `{handle, mnemonic: string}`. `readCast()` is the normaliser, and the explicit-path
    // branch bypassed it — so passing the path this script's own usage line documents threw
    // `cast.find is not a function`.
    const cast: CastEntry[] = castFile
        ? normaliseCast(JSON.parse(fs.readFileSync(castFile, 'utf8')))
        : readCast();
    const entry = (h: string) => {
        const e = cast.find((c) => c.handle === h);
        if (!e) throw new Error(`cast.json has no wallet "${h}"`);
        return e;
    };

    const env = new Map<string, string>();
    for (const line of fs.readFileSync(path.join(REPO, '.env'), 'utf8').split(/\r?\n/)) {
        const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
        if (m) env.set(m[1], m[2].trim().replace(/^"|"$/g, ''));
    }
    const client = new TonClient({
        endpoint: TESTNET_ENDPOINT,
        apiKey: env.get('TONCENTER_API_KEY_TESTNET') || undefined,
    });
    const ledger = client.open(PrimesLedger.createFromAddress(Address.parse(env.get('PRIMES_LEDGER_ADDRESS')!)));
    const registrar = client.open(
        PrimesRegistrar.createFromAddress(Address.parse(env.get('PRIMES_REGISTRAR_ADDRESS')!))
    );
    const vault = client.open(
        PrimesBountyVault.createFromAddress(Address.parse(env.get('PRIMES_BOUNTY_VAULT_ADDRESS')!))
    );

    const A = Address.parse(entry('A').address); // the era's top recruiter
    // The minter is `B` unless PRIMES_CEREMONY_MINTER names another handle — e.g. the owner's W5
    // play wallet `P`, so the era bounty lands where a human will look for it. Any handle but `A`
    // keeps §7's two rewards on two wallets; the sender carries the entry's wallet version.
    const minter = process.env.PRIMES_CEREMONY_MINTER ?? 'B';
    if (minter === 'A') throw new Error('PRIMES_CEREMONY_MINTER must not be A: §7 pays the bounty and the trophy to two wallets');
    const B = Address.parse(entry(minter).address); // the primorial's minter
    const C = Address.parse(entry('C').address); // the trophy's next holder
    const bSender = (await openWallet(client, entry(minter).mnemonic.trim().split(/\s+/), undefined, entry(minter).version)).sender;
    const aSender = makeSender(client, await mnemonicToPrivateKey(entry('A').mnemonic.trim().split(/\s+/)));

    console.log(`A (top recruiter) ${A.toString()}`);
    console.log(`B (minter)        ${B.toString()}  ${fromNano(await retry(() => client.getBalance(B), 'bal(B)'))} GRAM`);
    console.log(`C (next holder)   ${C.toString()}\n`);

    // ---- Stage 1: B mints the primorial --------------------------------------
    const head = await retry(() => ledger.getHead(), 'getHead');
    if (head !== PRIMORIAL) {
        // Either Phase 2 undershot and a composite is still in the way, or something
        // already minted 30 — both need a human, not a retry.
        const trophy = await retry(() => registrar.getTrophy(PRIMORIAL), 'getTrophy');
        if (head > PRIMORIAL && trophy.holder) {
            console.log(`the ceremony has already run — head=${head}, trophy holder ${trophy.holder.toString()}`);
        } else {
            throw new Error(`head is ${head}, expected ${PRIMORIAL}. Phase 2 must leave the head ON the boundary.`);
        }
    } else {
        const leaderBefore = await retry(() => ledger.getEraLeader(), 'getEraLeader');
        const scheduleBefore = await retry(() => vault.getEraSchedule(PRIMORIAL), 'getEraSchedule');
        const payoutsBefore = await retry(() => vault.getVaultPayouts(), 'getVaultPayouts');
        const Tb = await retry(() => ledger.getFloorNum(), 'getFloorNum');
        const Sb = await retry(() => ledger.getFloorDen(), 'getFloorDen');
        console.log('--- BEFORE ---');
        console.log(`  era leader: ${leaderBefore.leader?.toString()} with ${leaderBefore.recruits} recruits`);
        console.log(`  era schedule for ${PRIMORIAL}:`, scheduleBefore);
        console.log(`  vault payouts:`, payoutsBefore);
        console.log(`  T=${Tb} S=${Sb} p_f=${Number(Tb) / Number(Sb)}`);
        console.log(`  trophy on ${PRIMORIAL}:`, await retry(() => registrar.getTrophy(PRIMORIAL), 'getTrophy'));

        const giftTo = GIFT_TO ? Address.parse(entry(GIFT_TO).address) : null;
        const factorWords = PRIMORIAL_FACTORS.map((f) => `${f.prime}${f.exponent > 1 ? '^' + f.exponent : ''}`).join('*');
        if (giftTo) {
            // A pays and is credited the recruit; `giftTo` receives the number AND the era
            // bounty. Two wallets out of one transaction — see GIFT_TO's note above.
            console.log(`\nA gift-mints the primorial n=${PRIMORIAL} (${factorWords}) to ${GIFT_TO}...`);
            await ledger.sendMint(aSender, {
                n: PRIMORIAL,
                kind: 0,
                factors: PRIMORIAL_FACTORS,
                referralKey: 0,
                beneficiary: giftTo,
                value: MINT_VALUE,
            });
        } else {
            console.log(`\nB mints the primorial n=${PRIMORIAL} (${factorWords})...`);
            await ledger.sendMint(bSender, {
                n: PRIMORIAL,
                kind: 0,
                factors: PRIMORIAL_FACTORS,
                referralKey: 0,
                beneficiary: null, // NOT a gift: the bounty follows the beneficiary, and the
                // beneficiary of a plain mint is the minter itself.
                value: MINT_VALUE,
            });
        }
        console.log('waiting 45s — the ceremony fans out to the vault AND the registrar...');
        await new Promise((r) => setTimeout(r, 45_000));

        const Ta = await retry(() => ledger.getFloorNum(), 'getFloorNum(after)');
        const Sa = await retry(() => ledger.getFloorDen(), 'getFloorDen(after)');
        console.log('\n--- AFTER ---');
        console.log(`  head = ${await retry(() => ledger.getHead(), 'getHead(after)')}`);
        console.log(`  T=${Ta} S=${Sa} p_f=${Number(Ta) / Number(Sa)}`);
        console.log(`  ratchet theorem (T_after*S_before > T_before*S_after): ${Ta * Sb > Tb * Sa}`);
        console.log(`  era schedule for ${PRIMORIAL}:`, await retry(() => vault.getEraSchedule(PRIMORIAL), 'sched'));
        console.log(`  vault payouts:`, await retry(() => vault.getVaultPayouts(), 'payouts'));
        console.log(`  era leader now:`, await retry(() => ledger.getEraLeader(), 'leader'));
        console.log(`  A era recruits now: ${await retry(() => ledger.getEraRecruits(A), 'eraRecruits(A)')}`);
    }

    // ---- Stage 2: who holds the trophy ---------------------------------------
    console.log('\n=== the trophy: naming rights to the RECRUITER, not the minter ===');
    const trophy = await retry(() => registrar.getTrophy(PRIMORIAL), 'getTrophy');
    console.log(`  getTrophy(${PRIMORIAL}): holder=${trophy.holder?.toString()} transferable=${trophy.transferable}`);
    console.log(`  A (recruiter) = ${A.toString()}`);
    console.log(`  B (minter)    = ${B.toString()}`);
    if (!trophy.holder) throw new Error('no trophy holder after the ceremony — AwardEraTrophy did not land');
    const holderIsA = trophy.holder.equals(A);
    console.log(`  holder is A (the recruiter): ${holderIsA}${holderIsA ? '' : '  <-- MISMATCH'}`);
    // A RE-RUN finds the trophy with C: stage 3 below already moved it A -> C, and only A
    // could have sent that move, so C holding it proves stage 2 held at the time.
    if (!holderIsA && !trophy.holder.equals(C)) {
        throw new Error(`the trophy went to ${trophy.holder.toString()}, not to the era's top recruiter ${A.toString()}`);
    }

    // ---- Stage 3: D-14's transfer --------------------------------------------
    console.log('\n=== D-14: the trophy moves, and only its holder can move it ===');
    if (trophy.holder.equals(C)) {
        console.log('  skip — C already holds it, the transfer has run');
    } else {
        await registrar.sendTransferTrophy(aSender, {
            primorial: PRIMORIAL,
            newHolder: C,
            value: toNano('0.08'), // gas only: nothing is escrowed and no fee is taken
        });
        await new Promise((r) => setTimeout(r, 30_000));
        const after = await retry(() => registrar.getTrophy(PRIMORIAL), 'getTrophy(after)');
        console.log(`  getTrophy(${PRIMORIAL}) now: holder=${after.holder?.toString()} transferable=${after.transferable}`);
        console.log(`  moved A -> C: ${after.holder ? after.holder.equals(C) : false}`);
        if (!after.holder || !after.holder.equals(C)) {
            throw new Error('the trophy did not move to C');
        }
    }

    console.log(`\nB left with ${fromNano(await retry(() => client.getBalance(B), 'bal(B)'))} GRAM`);
    console.log(`A left with ${fromNano(await retry(() => client.getBalance(A), 'bal(A)'))} GRAM`);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
