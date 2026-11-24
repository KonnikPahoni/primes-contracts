/**
 * TON PRIMES — THE RED-TRANSACTION SWEEP. Walk every account the gauntlet
 * touched and report each transaction an explorer would paint red.
 *
 * WHY A SCRIPT AND NOT A TAB. A run drives ~150 on-chain transactions across
 * two dozen accounts, and every prior wave judged them by their EFFECTS: head
 * moved, `T` went up, the get-method says what it should. That is not the same
 * check. A message can be credited, do its work, and still leave a red trace —
 * the three standard replies this project has eaten (`payout#474f86cf`,
 * `provide_wallet_address#2c76b973`, TEP-74's `excesses#d53276db`) were all
 * NON-BOUNCEABLE, so the value landed, the balances reconciled, and the
 * transaction aborted in the compute phase where nothing but the trace records
 * it. The third one painted every mint the game has ever performed red without
 * moving a single figure this harness reads (MISTAKES.md 2026-09-17).
 *
 * So the rule CLAUDE.md states for the sandbox — assert on the SHAPE OF THE
 * TRACE, not on balances — gets its on-chain counterpart here.
 *
 *   npx tsx contracts/scripts/testnet/txAudit.ts               # core set + cast + items
 *   npx tsx contracts/scripts/testnet/txAudit.ts --since 12h   # only the last 12 hours
 *   npx tsx contracts/scripts/testnet/txAudit.ts --since-utime 1758400000
 *                                                              # ... or from an absolute
 *                                                              # instant; run.ts gates a
 *                                                              # phase on its OWN window
 *   npx tsx contracts/scripts/testnet/txAudit.ts --all         # print green ones too
 *   npx tsx contracts/scripts/testnet/txAudit.ts --no-items    # skip the per-item derivation
 *
 * It exits non-zero when anything is red, so it works as a gate as well as a
 * report.
 *
 * A transaction is RED when the explorer would call it failed:
 *   - `aborted` is set, or
 *   - the compute phase exits non-zero (0 and 1 are both TVM success), or
 *   - the action phase returns a non-zero result code.
 * It is flagged AMBER when it merely RECEIVED a bounce — something upstream
 * failed and this account is where the money came back.
 *
 * Every finding prints its tonviewer link, because the next question is always
 * "show me", and the answer must not be "search for it yourself".
 *
 * OPCODES ARE PRINTED BY NAME, and so is the fan-out. An explorer shows a mint
 * as `0xb0000002` with eight anonymous outbound legs; this shows
 *
 *   op mint 0xb0000002 1.01 GRAM -> mint_item 0xc0000001, forward_to_owner
 *   0xc1000002, bare, bare, bare, mint_op 0xd0000001,
 *   pay_special_number_rebate 0xb0000072, pool_inject 0xb0000050
 *
 * decoded from `shared/opcodes.ts` (see `OP_NAMES` below). The fan-out is there
 * because a MISSING leg is the usual shape of a defect in this system and a
 * per-transaction op alone cannot show one. `bare` is a body-less value
 * transfer — §4.1's operator and treasury fee legs, which carry no opcode at
 * all and therefore no name to print.
 */
import { Address, Cell, Transaction, fromNano } from '@ton/core';
import { TonClient } from '@ton/ton';
import { loadEnvFile, envValue } from '../envFile';
import { makeClient, openDeployWallet, retry } from './sender';
import { dedustNativeVault, operatorAddr } from './chain';
import { readCast } from './cast';
import * as OPCODES from '../../../shared/opcodes';

const VIEWER = 'https://testnet.tonviewer.com/transaction/';

/** Per account, how far back to walk. A run is ~150 transactions in total. */
const MAX_PER_ACCOUNT = 400;
const PAGE = 100;

type Account = { label: string; address: Address; ours: boolean };

function envAddr(name: string): Address | undefined {
    const v = envValue(loadEnvFile(), name);
    return v ? Address.parse(v) : undefined;
}

/**
 * The genesis contracts, the LP sink, and DeDust's three. The
 * DeDust accounts are marked NOT OURS: a refusal there is a legitimate outcome
 * of `flush()` (§4.3.1) and a red trace on a third-party contract is their
 * business, not a defect in this set — but it is still worth seeing, because a
 * RED DeDust transaction is how a malformed swap cell announces itself.
 */
const CORE: { env: string; label: string; ours: boolean }[] = [
    { env: 'PRIMES_COLLECTION_ADDRESS', label: 'collection', ours: true },
    { env: 'PRIMES_JETTON_MASTER_ADDRESS', label: 'jetton master', ours: true },
    { env: 'PRIMES_VENUE_TIMELOCK_ADDRESS', label: 'venue timelock', ours: true },
    { env: 'PRIMES_LEDGER_ADDRESS', label: 'ledger', ours: true },
    { env: 'PRIMES_RATCHET_ADDRESS', label: 'ratchet', ours: true },
    { env: 'PRIMES_REGISTRAR_ADDRESS', label: 'registrar', ours: true },
    { env: 'PRIMES_MARKET_ADDRESS', label: 'market', ours: true },
    { env: 'PRIMES_BOUNTY_VAULT_ADDRESS', label: 'bounty vault', ours: true },
    { env: 'PRIMES_STAKE_ADDRESS', label: 'stake', ours: true },
    { env: 'PRIMES_TREASURY_VESTING_ADDRESS', label: 'treasury vesting', ours: true },
    { env: 'PRIMES_TREASURY_ADDRESS', label: 'treasury', ours: true },
    { env: 'PRIMES_LP_SINK_ADDRESS', label: 'lp sink', ours: true },
    // NOT OURS, and it is a wallet rather than a contract: the 42% forfeit
    // remainder and the TEP-66 royalty land here (D-152 moved §4.1's 5% line to
    // the treasury CONTRACT), but the operator uses the same wallet for
    // everything else it does, so only the messages THIS set sent it are ours to
    // judge. It carried 496 transactions and 158 unrelated failures on the first
    // sweep, which is exactly the noise the filter exists for.
    { env: 'PRIMES_DEDUST_POOL_ADDR', label: 'dedust pool', ours: false },
    { env: 'PRIMES_DEDUST_JETTON_VAULT_ADDR', label: 'dedust jetton vault', ours: false },
];

/**
 * The NFT items are where the excesses class of bug lands, and they are invisible
 * from the collection's own transaction list — a mint's item transaction happens
 * on the ITEM's account. Derived off `get_nft_address_by_index` for every index
 * below the head, which is every number this set has ever minted plus the gaps
 * (an unminted index has no account and is skipped for free).
 */
async function itemAccounts(client: TonClient, collection: Address, upTo: number, prefix: string): Promise<Account[]> {
    const out: Account[] = [];
    for (let i = 0; i <= upTo; i++) {
        // BOTH calls are retried, and that is not boilerplate: an unretried
        // `catch {}` here reads a 429 from the public endpoint as "this index has
        // no item" and drops it from the sweep in silence. The first run of this
        // script covered 4 of the 20 live items that way and said nothing.
        const r = await retry(
            () => client.runMethod(collection, 'get_nft_address_by_index', [{ type: 'int', value: BigInt(i) }]),
            `get_nft_address_by_index(${i})`
        );
        const addr = r.stack.readAddress();
        const st = await retry(() => client.getContractState(addr), `state(${prefix} #${i})`);
        // An index below the head with no account is an UNMINTED number — a
        // prime, or one marked off its line by an auction (D-45) — not an error.
        if (st.state === 'active') out.push({ label: `${prefix} #${i}`, address: addr, ours: true });
    }
    return out;
}

type Verdict = { red: boolean; amber: boolean; why: string };

/**
 * Exactly the rule an explorer applies, spelled out so a disagreement is
 * debuggable — with the one exemption an explorer also makes.
 *
 * A NON-BOUNCEABLE TRANSFER TO AN UNINITIALISED ACCOUNT is `aborted` with the
 * compute phase skipped for `no-state`, and it is not a failure: it is how every
 * wallet in this harness is funded before its own first send (`cast.ts`'s own
 * comment says why the transfer must be non-bounceable). The money is credited,
 * there is simply no code yet to run. Flagging those would put a red line under
 * all twelve cast wallets on every run and train the reader to ignore the report.
 */
function judge(tx: Transaction): Verdict {
    const inBounced = tx.inMessage?.info.type === 'internal' && tx.inMessage.info.bounced;
    const d = tx.description;
    if (d.type !== 'generic') {
        return { red: false, amber: !!inBounced, why: d.type };
    }
    const parts: string[] = [];
    let red = false;

    if (d.computePhase.type === 'skipped') {
        if (d.computePhase.reason === 'no-state' && tx.outMessagesCount === 0) {
            return { red: false, amber: false, why: 'credit to an uninitialised account' };
        }
        parts.push(`compute skipped (${d.computePhase.reason})`);
    } else {
        const code = d.computePhase.exitCode;
        // 0 and 1 are both TVM success; anything else is a throw.
        if (code !== 0 && code !== 1) {
            red = true;
            parts.push(`compute exit ${code}`);
        }
    }
    if (d.actionPhase && d.actionPhase.resultCode !== 0) {
        red = true;
        parts.push(`action result ${d.actionPhase.resultCode}`);
    }
    if (d.aborted) {
        red = true;
        parts.push('aborted');
    }
    if (d.bouncePhase) parts.push(`bounce:${d.bouncePhase.type}`);
    if (inBounced) parts.push('in:BOUNCED');

    return { red, amber: !red && !!inBounced, why: parts.join(' ') || 'ok' };
}

/**
 * A TEXT COMMENT from an address this set does not control is testnet faucet
 * SPAM — "get 300 testnet GRAM, tg: @…" — and every contract here refuses it with
 * `wrong_opcode` (101) from the catch-all every Tolk contract in this repo ends
 * its `match` with. The refusal is correct behaviour and the trace is red on the
 * explorer anyway, so it is reported as spam rather than as a finding.
 *
 * ONLY op 0 is downgraded, and that is the whole point of the narrowness: a
 * PROTOCOL opcode arriving from an address this set does not list is exactly the
 * `excesses#d53276db` shape that painted every mint red (MISTAKES.md
 * 2026-09-17) — it comes from a jetton wallet, which is nobody's listed account.
 * Downgrading by sender rather than by op would have hidden the bug this script
 * exists to find.
 */
function isSpamComment(tx: Transaction, ours: Set<string>): boolean {
    const im = tx.inMessage;
    if (im?.info.type !== 'internal') return false;
    if (ours.has(im.info.src.toRawString())) return false;
    try {
        const s = im.body.beginParse();
        return s.remainingBits >= 32 && s.loadUint(32) === 0;
    } catch {
        return false;
    }
}

/**
 * THE OPCODE REGISTRY, READ BACKWARDS. `shared/opcodes.ts` declares every opcode
 * in this system exactly once; this inverts it so a trace line says `mint` where
 * the chain says `0xb0000002`. Built by `import * as` over that module rather
 * than from a hand-kept list, so a namespace added there is decoded here without
 * being named here — the registry stays the single source of truth in the one
 * direction that matters.
 *
 * The `>= 0x01000000` floor is what separates opcodes from the error codes,
 * tier tables and `MINT_LIMITS` that share the same module: every opcode in the
 * system, standard or ours, is a full 32-bit value (the smallest is TEP-62's
 * `ownership_assigned`, 0x05138d91), and every non-opcode integer there is small.
 *
 * COLLISIONS ARE THE COMMON CASE and usually mean ONE message declared at BOTH
 * ends — `LEDGER.pool_inject` and `RATCHET.pool_inject` are the sender's and the
 * receiver's name for the same 0xb0000050, not two messages. So when every
 * claimant agrees on the local name that is the label. When they DISAGREE on the
 * name (0x05138d91 is TEP-62's `ownership_assigned` and the ratchet's
 * `payout_ownership_assigned` — one message, two vocabularies) all claimants are printed,
 * because which reading applies depends on the receiving account and this script
 * does not guess.
 *
 * There used to be a worse case here and there is not any more: 0x91000001 was
 * `STAKE.set_wallet` AND `VOUCHER.claim_voucher`, two genuinely UNRELATED messages
 * sharing a value across two contracts. GAUNTLET.md X15 moved the voucher to 0x9a
 * and `OpcodeRegistryRule.spec.ts` now fails the build on a value claimed by two
 * namespaces that is not on its allow-list of same-message pairs — so every
 * multi-claimant label this script prints today is one message under two names.
 *
 * THE HEX IS ALWAYS PRINTED TOO, and that is not redundancy: five collapsed
 * labels are ambiguous across the registry — `set_ledger` alone covers five
 * distinct opcodes on five different contracts — and the hex is also what
 * tonviewer shows on the link at the end of the same line.
 */
const OP_NAMES: ReadonlyMap<number, string> = (() => {
    const claims = new Map<number, string[]>();
    const add = (op: unknown, qualified: string) => {
        if (typeof op !== 'number' || !Number.isInteger(op) || op < 0x01000000 || op > 0xffffffff) return;
        claims.set(op, [...(claims.get(op) ?? []), qualified]);
    };
    for (const [ns, val] of Object.entries(OPCODES)) {
        if (typeof val === 'number') add(val, ns);
        else if (val && typeof val === 'object')
            for (const [k, v] of Object.entries(val as Record<string, unknown>)) add(v, `${ns}.${k}`);
    }
    const names = new Map<number, string>();
    for (const [op, qualified] of claims) {
        const locals = [...new Set(qualified.map((q) => q.split('.').pop()!))];
        names.set(op, locals.length === 1 ? locals[0] : qualified.join('|'));
    }
    return names;
})();

/** `0xb0000002` -> `mint 0xb0000002`; an unregistered op keeps the bare hex. */
export function opLabel(op: number): string {
    const hex = '0x' + op.toString(16).padStart(8, '0');
    const name = OP_NAMES.get(op);
    return name ? `${name} ${hex}` : hex;
}

/** The op of a message body, already labelled. `null` body = a bare value transfer. */
function bodyOp(body: Cell | undefined): string {
    if (!body) return 'none';
    try {
        const s = body.beginParse();
        if (s.remainingBits < 32) return 'bare';
        const op = s.loadUint(32);
        return op === 0 ? 'comment' : opLabel(op);
    } catch {
        return '?';
    }
}

function opOf(tx: Transaction): string {
    if (tx.inMessage?.info.type === 'external-in') return 'external';
    return bodyOp(tx.inMessage?.body);
}

/**
 * WHAT THIS TRANSACTION SENT ON. A red transaction is often only legible next to
 * its fan-out — the mint that looks like an opaque `0xb0000002` is `mint` ->
 * `mint_item, mint_op, pool_inject, pay_era_bounty, ...`, and a leg MISSING from
 * that list is the usual shape of the defect. Bare value transfers (the operator
 * and treasury fee legs, which carry no body at all) print as `bare`.
 */
function fanOf(tx: Transaction): string {
    const outs = tx.outMessages.values().filter((m) => m.info.type === 'internal');
    return outs.length === 0 ? '' : ` -> ${outs.map((m) => bodyOp(m.body)).join(', ')}`;
}

/**
 * A shared contract's transaction list is EVERYBODY's. DeDust's testnet vaults
 * carry hundreds of strangers' swaps, and the fee-destination wallet in
 * The operator (`operator_addr`) is whatever wallet the operator happens to use. Judging
 * those wholesale produces a report that is mostly other people's failures — 158
 * of them on the first run of this script, none of them ours. So an account
 * marked NOT OURS is filtered to the messages our own accounts sent it.
 */
function fromOurs(tx: Transaction, ours: Set<string>): boolean {
    const im = tx.inMessage;
    if (im?.info.type !== 'internal') return false;
    return ours.has(im.info.src.toRawString());
}

async function walk(client: TonClient, acct: Account, sinceUtime: number, ours: Set<string>) {
    const rows: { tx: Transaction; v: Verdict }[] = [];
    let spam = 0;
    let lt: string | undefined;
    let hash: string | undefined;
    let seen = 0;
    let oldest: Transaction | undefined;
    for (;;) {
        if (seen >= MAX_PER_ACCOUNT) throw new Error(`over ${MAX_PER_ACCOUNT} tx in the window — raise MAX_PER_ACCOUNT`);
        // archival first; toncenter's testnet archival pool goes down for hours
        // ("542 no workers available", 2026-11-21). The plain nodes then serve a run's own
        // recent window but 500 ("lt not in db") on any page that reaches an older tx, so
        // the fallback halves the page until it fits inside what they still hold.
        let limit = PAGE;
        const cursor = lt && hash ? { lt, hash } : {};
        const page: Transaction[] = await retry(
            async () => {
                try {
                    return await client.getTransactions(acct.address, { limit: PAGE, ...cursor, archival: true });
                } catch (archivalErr) {
                    // A continuation page repeats its cursor, so it needs l >= 2 to advance at all.
                    for (let l = PAGE; l >= (lt ? 2 : 1); l = Math.floor(l / 2)) {
                        try {
                            const got = await client.getTransactions(acct.address, { limit: l, ...cursor });
                            limit = l;
                            return got;
                        } catch {
                            /* shrink */
                        }
                    }
                    // Never read an unservable continuation page as the end of history: the loop
                    // only asks for one while the last tx was still inside the window, so an
                    // empty answer here would print a short count as a clean sweep.
                    throw lt
                        ? new Error(`history truncated at lt ${lt}: archival down (${(archivalErr as Error).message}), plain nodes cannot serve older pages`)
                        : archivalErr;
                }
            },
            `getTransactions:${acct.label}`,
            4
        );
        // A continuation page repeats its cursor transaction as the first entry.
        const fresh = lt ? page.slice(1) : page;
        let done = false;
        for (const tx of fresh) {
            if (tx.now < sinceUtime) {
                done = true;
                break;
            }
            oldest = tx;
            seen++;
            if (!acct.ours && !fromOurs(tx, ours)) continue;
            if (isSpamComment(tx, ours)) {
                spam++;
                continue;
            }
            rows.push({ tx, v: judge(tx) });
        }
        if (done) break;
        if (fresh.length < limit - 1) {
            // Out of pages before crossing the window's start. That is the whole history only
            // if the oldest tx read is the account's first; a plain node's short page is not.
            if (oldest && oldest.prevTransactionLt !== 0n)
                throw new Error(`history truncated at lt ${oldest.lt}: the node returned a short page`);
            break;
        }
        const last = fresh[fresh.length - 1];
        lt = last.lt.toString();
        hash = last.hash().toString('base64');
    }
    return { rows, spam };
}

const UNIT_SECS: Record<string, number> = { m: 60, h: 3600, d: 86400 };

function parseSince(arg: string | undefined): number {
    if (!arg) return 0;
    const m = /^(\d+)([mhd])$/.exec(arg);
    if (!m) throw new Error('--since takes <n>m, <n>h or <n>d, e.g. --since 12h');
    return Math.floor(Date.now() / 1000) - Number(m[1]) * UNIT_SECS[m[2]];
}

/**
 * `--since` is RELATIVE TO NOW, which is what a hand-run sweep wants and exactly
 * what a caller auditing ONE window of a long run does not: by the time phase 5
 * ends, "the last 6 hours" still contains phase 2. `--since-utime <unix>` is the
 * same lower bound expressed absolutely, so `run.ts` can hand over the moment the
 * phase it is gating actually started (see `audit()` there).
 */
function parseSinceUtime(arg: string | undefined): number {
    if (!arg) return 0;
    const t = Number(arg);
    if (!Number.isInteger(t) || t <= 0) throw new Error('--since-utime takes a unix timestamp in seconds');
    return t;
}

/** The lower bound of the sweep, as a unix time. `0` = walk everything. */
export function sinceBound(argv: string[]): number {
    const i = argv.indexOf('--since');
    const j = argv.indexOf('--since-utime');
    // Both given: the LATER bound wins, so neither form can widen the other.
    return Math.max(
        parseSince(i >= 0 ? argv[i + 1] : undefined),
        parseSinceUtime(j >= 0 ? argv[j + 1] : undefined)
    );
}

async function main() {
    const argv = process.argv.slice(2);
    const showAll = argv.includes('--all');
    const since = sinceBound(argv);
    const client = makeClient();

    const accounts: Account[] = [];
    for (const c of CORE) {
        const a = envAddr(c.env);
        if (a) accounts.push({ label: c.label, address: a, ours: c.ours });
        else console.log(`(skipping ${c.label}: ${c.env} not in /.env)`);
    }
    // Per-network constants, from shared/networks/testnet.yaml rather than /.env. Both NOT OURS
    // (see CORE's notes): the operator is a wallet, the vault is DeDust's.
    accounts.push({ label: 'operator payout', address: operatorAddr(), ours: false });
    accounts.push({ label: 'dedust native vault', address: dedustNativeVault(), ours: false });

    const funder = await openDeployWallet(client);
    accounts.push({ label: 'K (deploy wallet)', address: funder.wallet.address, ours: true });
    try {
        for (const w of readCast()) {
            accounts.push({ label: `${w.handle} (cast)`, address: Address.parse(w.address), ours: true });
        }
    } catch {
        console.log('(no .cast.json — skipping the cast wallets)');
    }

    // D-168: a claim, relock, expire or withdraw runs on the owner's CHILD — the stake
    // position and the LP position are per-wallet contracts, invisible from the master's
    // transaction list. Derived for every wallet above; an owner who never staked or
    // deposited has no account there and is skipped.
    const stakeAddr = envAddr('PRIMES_STAKE_ADDRESS');
    const treasuryAddr = envAddr('PRIMES_TREASURY_ADDRESS');
    const { PrimesStake } = await import('../../wrappers/PrimesStake');
    const { PrimesTreasury } = await import('../../wrappers/PrimesTreasury');
    const { minterCardAddress } = await import('../../../shared/minterCard');
    const ledgerAddrForCards = envAddr('PRIMES_LEDGER_ADDRESS');
    for (const owner of accounts.filter((a) => a.label.endsWith('(cast)') || a.label.startsWith('K ')).map((a) => a.address)) {
        const kids: [string, Address | undefined][] = [
            ['stake position', stakeAddr && (await retry(() => client.open(PrimesStake.createFromAddress(stakeAddr)).getStakePositionAddress(owner), 'getStakePositionAddress'))],
            ['lp position', treasuryAddr && (await retry(() => client.open(PrimesTreasury.createFromAddress(treasuryAddr)).getPositionAddress(owner), 'getPositionAddress'))],
            // D-191: every mint lands on the beneficiary's MINTER CARD first, and a card
            // refusal (104, an edge in flight) is red there and nowhere else (G93 run).
            ['minter card', ledgerAddrForCards && minterCardAddress(ledgerAddrForCards, owner)],
        ];
        for (const [label, addr] of kids) {
            if (!addr) continue;
            const st = await retry(() => client.getContractState(addr), `state(${label})`);
            if (st.state !== 'uninitialized') accounts.push({ label: `${label} of ${owner.toString().slice(0, 8)}`, address: addr, ours: true });
        }
    }

    const collection = envAddr('PRIMES_COLLECTION_ADDRESS');
    if (collection && !argv.includes('--no-items')) {
        const { PrimesLedger } = await import('../../wrappers/PrimesLedger');
        const ledgerAddr = envAddr('PRIMES_LEDGER_ADDRESS');
        const head = ledgerAddr
            ? await retry(() => client.open(PrimesLedger.createFromAddress(ledgerAddr)).getHead(), 'getHead')
            : 0;
        console.log(`deriving NFT item accounts for index 0..${head} ...`);
        accounts.push(...(await itemAccounts(client, collection, Number(head), 'item')));
    }

    console.log(`\nsweeping ${accounts.length} accounts${since ? `, since ${new Date(since * 1000).toISOString()}` : ''}\n`);

    let total = 0;
    let spamTotal = 0;
    const red: string[] = [];
    const amber: string[] = [];
    const unread: string[] = [];
    const unreadOurs: string[] = [];

    const ourRaw = new Set(accounts.filter((a) => a.ours).map((a) => a.address.toRawString()));
    for (const acct of accounts) {
        // A THIRD-PARTY account toncenter cannot page (DeDust's shared native vault 500s on
        // testnet, 2026-11-21) is reported unread, not fatal; one of OURS is reported and fails the run.
        const walked = await walk(client, acct, since, ourRaw).catch((e) => {
            const why = (e as Error).message;
            if (acct.ours) {
                console.log(`UNREAD ${acct.label.padEnd(21)}   ${why} — OURS, the sweep is incomplete`);
                unreadOurs.push(acct.label);
                return null;
            }
            console.log(`UNREAD ${acct.label.padEnd(21)}   rpc refused (${why}) — third-party, not counted`);
            unread.push(acct.label);
            return null;
        });
        if (!walked) continue;
        const { rows, spam } = walked;
        total += rows.length;
        spamTotal += spam;
        const bad = rows.filter((r) => r.v.red);
        const warn = rows.filter((r) => r.v.amber);
        const mark = bad.length ? 'RED  ' : warn.length ? 'amber' : 'ok   ';
        console.log(
            `${mark} ${acct.label.padEnd(22)} ${rows.length.toString().padStart(4)} tx` +
                (bad.length ? `  ${bad.length} FAILED` : '') +
                (warn.length ? `  ${warn.length} received a bounce` : '') +
                (spam ? `  ${spam} faucet-spam comment${spam === 1 ? '' : 's'} refused` : '') +
                (acct.ours ? '' : '  (third-party — only messages from this set)')
        );
        for (const r of bad) {
            const line =
                `  ${acct.label} · ${new Date(r.tx.now * 1000).toISOString()} · op ${opOf(r.tx)}${fanOf(r.tx)} · ` +
                `${r.v.why} · ${VIEWER}${r.tx.hash().toString('hex')}`;
            console.log(line);
            red.push(line);
        }
        for (const r of warn) {
            const line =
                `  ${acct.label} · ${new Date(r.tx.now * 1000).toISOString()} · op ${opOf(r.tx)}${fanOf(r.tx)} · ` +
                `${r.v.why} · ${VIEWER}${r.tx.hash().toString('hex')}`;
            console.log(line);
            amber.push(line);
        }
        if (showAll) {
            for (const r of rows.filter((x) => !x.v.red && !x.v.amber)) {
                const value =
                    r.tx.inMessage?.info.type === 'internal' ? fromNano(r.tx.inMessage.info.value.coins) : '-';
                console.log(
                    `       ${new Date(r.tx.now * 1000).toISOString()} op ${opOf(r.tx)} ${value} GRAM` +
                        `${fanOf(r.tx)} ${VIEWER}${r.tx.hash().toString('hex')}`
                );
            }
        }
    }

    console.log(`\n${total} transactions · ${red.length} FAILED · ${amber.length} received a bounce` +
        (unread.length ? ` · ${unread.length} third-party unread (${unread.join(', ')})` : '') +
        (unreadOurs.length ? ` · INCOMPLETE, ${unreadOurs.length} of ours unread (${unreadOurs.join(', ')})` : ''));
    if (unreadOurs.length) process.exitCode = 1;
    if (red.length) {
        console.log('\nEvery failed transaction, again:');
        red.forEach((l) => console.log(l));
        process.exitCode = 1;
    }
}

if (require.main === module) {
    main().catch((e) => {
        console.error(e?.message ?? e);
        process.exit(1);
    });
}
