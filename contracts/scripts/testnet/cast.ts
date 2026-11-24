/**
 * TON PRIMES — the gauntlet CAST: twelve throwaway wallets, generated once,
 * funded from the deploy subwallet, swept back at the end.
 *
 * WHY FRESH MNEMONICS AND NOT SUBWALLETS OF THE KEEPER. Half of what this
 * harness has to prove is about DISTINCT PLAYERS — D-106's sybil guard counts a
 * gift recruit only if the ledger's `minterState` has never seen the
 * beneficiary, §4.7's ladder is per-address, §7's era ceremony pays the bounty
 * and the trophy to two different wallets, and an outbid refund is only a real
 * test when the displaced bidder is genuinely somebody else. Subwallets of one
 * mnemonic are distinct ADDRESSES, so they would in fact pass all of that; fresh
 * mnemonics cost one line and remove the question entirely.
 *
 *   npx tsx contracts/scripts/testnet/cast.ts new     # generate (refuses to overwrite)
 *   npx tsx contracts/scripts/testnet/cast.ts fund [handle…]   # top every (or only the named) wallet up to its float
 *   npx tsx contracts/scripts/testnet/cast.ts list    # addresses + balances
 *   npx tsx contracts/scripts/testnet/cast.ts sweep   # return everything to the funder
 *   npx tsx contracts/scripts/testnet/cast.ts owner   # the OWNER's own wallet, handle `P`
 *
 * THE ONE WALLET THAT IS NOT THROWAWAY: handle `P`, the owner's. It lives in its
 * own file, `.owner.json`, because everything above is scratch and this is not —
 * the owner imports its 24 words into a wallet app once and connects it to
 * primes.live for good, so it must survive `cast new`, and `sweep` must leave it
 * alone. Reusing one address across geneses is safe for exactly the reason the
 * comment above gives in reverse: `minterState` is per-DEPLOYMENT, so a fresh
 * genesis has never seen `P` either, and D-106's `!isFound` newcomer window opens
 * for it on every set. `readCast()` merges it in, so every script that takes a
 * handle takes `P` with no further wiring.
 *
 * The file lands at `.cast.json` in the repo root and is GITIGNORED — it holds
 * twelve live mnemonics. It is scratch: losing it costs the leftover floats and
 * nothing else, which is the point of a throwaway cast.
 */
import fs from 'fs';
import path from 'path';
import { Address, fromNano, toNano } from '@ton/core';
import { WalletContractV4 } from '@ton/ton';
import { mnemonicNew, mnemonicToPrivateKey } from '@ton/crypto';
import { REPO, makeClient, openDeployWallet, openWallet, retry, type WalletVersion } from './sender';

const CAST_FILE = path.join(REPO, '.cast.json');
/** The owner's own wallet. Separate file so `cast new` cannot clobber it. */
const OWNER_FILE = path.join(REPO, '.owner.json');
/** Float for `P`: enough to mint, gift, build and still pay gas on /earn. */
const OWNER_FLOAT = '25';

/**
 * The roles `TESTNET_MASTER_PLAN.md` §3 names, with the float each one needs.
 * `K` is NOT here: it is the deploy subwallet itself, the funder, and it already
 * holds the budget.
 */
const ROLES: { name: string; ton: string; why: string }[] = [
    { name: 'A', ton: '20', why: 'recruiter — six gift mints, opens the prime lot, owns the trophy' },
    { name: 'B', ton: '6', why: 'primorial minter, deliberately NOT A (§7 pays two wallets)' },
    { name: 'C', ton: '8', why: 'outbidder — a displaced-bid refund is only real from a stranger' },
    // 40, not 60: `TESTNET_MASTER_PLAN.md` §4 sizes phase 5 at 15 GRAM of swap plus
    // ~25 of two-sided LP, so 40 is the WORK and the other 20 was headroom. Trimmed
    // 2026-09-19 when two abandoned geneses took ~40 GRAM out of the wave's budget.
    // Raise it back when the budget allows; the whole table is the one place to do it.
    { name: 'L', ton: '30', why: 'LP + governance — moves the pool price, deposits two-sided' },
    { name: 'S', ton: '3', why: 'staker (D-34: live but inert, so this proves a no-op)' },
    // 8, not 2. `F` was written as the wallet that sends ONE permissionless
    // flush, and `run.ts` has since made it the stranger for every op whose
    // point is that anyone may send it: `ops.ts all`/`sweep-ops`/`vest`, both
    // phase-7 lot closes (0.5 each), `money.ts dividend`, the timelock
    // `execute`/`retry`, `bounty.ts retry-scan`, `collections.ts ask`,
    // `lpGovernance.ts expire` — and the whole of phase 10, which is ~2.8 GRAM of
    // mock/arm/forge sends on its own. That sums to ~5 GRAM against a 2 GRAM
    // float, so the run would have failed mid-phase-10 on `sender.ts`'s balance
    // guard with no step left that re-runs `cast.ts fund`. Budget: +6 GRAM on
    // §4's floats line (78 -> 84), all of it swept back at the end.
    { name: 'F', ton: '8', why: 'the stranger — every permissionless op in phases 3,4,7,9,10 is sent from here' },
    // R2..R6 hold 0.5, not 2: they only ever RECEIVE. A gift mint is paid by the
    // giver and an invite generator is deployed out of the minter's own value, so
    // a recruit never sends anything and a 2 GRAM float was 7.5 GRAM of the wave's
    // budget parked where nothing spends it. R1 is the exception and keeps a real
    // float — it is the one that burns its newcomer window down with self-mints.
    { name: 'R1', ton: '6', why: 'recruit — and the one that burns its own newcomer window down with three self-mints, so it needs three 1 GRAM mints of float, not one' },
    { name: 'R2', ton: '0.5', why: 'recruit — also the re-gift, which must NOT count twice' },
    { name: 'R3', ton: '0.5', why: 'recruit' },
    { name: 'R4', ton: '0.5', why: 'recruit' },
    { name: 'R5', ton: '0.5', why: 'recruit' },
    { name: 'R6', ton: '0.5', why: 'recruit — the sixth, where the §4.7 ladder tier changes' },
];

/**
 * `version` is OPTIONAL and absent means `v4r2`, which is what `cast.ts new` mints and what
 * every generated cast wallet is. It exists for `.owner.json`, where the human's own wallet
 * app decides the contract — a W5 seed derives a different address than the same seed under
 * v4, so an entry that does not say which one it is gets driven at the wrong account
 * (`sender.ts`'s `WalletVersion` has the measured addresses).
 */
type CastEntry = {
    name: string;
    mnemonic: string[];
    address: string;
    float: string;
    why: string;
    version?: WalletVersion;
};
type CastFile = { createdAt: string; subwalletId: string; wallets: CastEntry[] };

/**
 * The cast in the shape the pre-existing `*Live.ts` phase scripts already read —
 * `{ handle, role, address, mnemonic }` with the mnemonic as ONE space-joined
 * string. Those scripts predate this file and each carries its own `cast.json`
 * reader; rather than teach six of them a second format (or, worse, write a
 * second file full of live mnemonics next to the first), they take this.
 */
export function readCast(): {
    handle: string;
    role: string;
    address: string;
    mnemonic: string;
    version?: WalletVersion;
}[] {
    const rows = load().wallets.map((w) => ({
        handle: w.name,
        role: w.why,
        address: w.address,
        mnemonic: w.mnemonic.join(' '),
        version: w.version,
    })) as { handle: string; role: string; address: string; mnemonic: string; version?: WalletVersion }[];
    const owner = readOwner();
    if (owner) rows.push(owner);
    return rows;
}

/** The owner's wallet, or null before `cast.ts owner` has ever run. */
export function readOwner(): {
    handle: string;
    role: string;
    address: string;
    mnemonic: string;
    version?: WalletVersion;
} | null {
    const o = readOwnerEntry();
    if (!o) return null;
    return {
        handle: o.name,
        role: o.why,
        address: o.address,
        mnemonic: o.mnemonic.join(' '),
        version: o.version,
    };
}

/**
 * THE ONE READER FOR `.owner.json`, and the one place its shape is checked.
 *
 * WHY IT VALIDATES. On 2026-09-21 the file was found holding the JSON of a
 * SPREAD STRING — `{"0":"p","1":"u",…}`, 135 numeric keys, i.e. the mnemonic as
 * one string passed through `{...s}` by something outside this file (nothing in
 * this repo writes it but `cmdOwner` below, which writes a real `CastEntry`).
 * `readOwner()` then did `o.mnemonic.join(' ')` on `undefined` and every
 * testnet script died with `Cannot read properties of undefined (reading
 * 'join')` — `walletFor()` in `chain.ts` calls `readCast()`, which calls this,
 * unconditionally. So ONE bad byte in the owner's file bricked all twelve cast
 * handles, and the error named neither the file nor the shape.
 *
 * IT THROWS, IT DOES NOT WARN-AND-SKIP. Returning null on a malformed file
 * would let the run continue with eleven wallets and fail at whichever later
 * phase happens to want `P` — far from the cause, which is exactly the class of
 * failure this harness exists to stop. `null` means ONE thing: no file yet.
 *
 * The path is a parameter only so a test can hand it a malformed file without
 * going anywhere near the real one; every caller here takes the default.
 */
export function readOwnerEntry(file: string = OWNER_FILE): CastEntry | null {
    if (!fs.existsSync(file)) return null;
    let parsed: unknown;
    try {
        parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
        throw ownerFileError(file, 'not valid JSON at all');
    }
    const e = parsed as Partial<CastEntry> | null;
    if (
        !e ||
        typeof e !== 'object' ||
        Array.isArray(e) ||
        typeof e.name !== 'string' ||
        typeof e.address !== 'string' ||
        !Array.isArray(e.mnemonic) ||
        e.mnemonic.length !== 24 ||
        e.mnemonic.some((w) => typeof w !== 'string')
    ) {
        throw ownerFileError(file, describeShape(parsed));
    }
    // A version this file does not understand is refused rather than silently falling back
    // to v4: the fallback derives a DIFFERENT, real, fundable address, which is precisely
    // the failure `WalletVersion` was added to stop.
    if (e.version !== undefined && e.version !== 'v4r2' && e.version !== 'v5r1') {
        throw ownerFileError(file, `an unknown wallet version ${JSON.stringify(e.version)}`);
    }
    return e as CastEntry;
}

/** What the file holds, said WITHOUT quoting it — the content is a live seed phrase. */
function describeShape(v: unknown): string {
    if (v === null) return 'null';
    if (Array.isArray(v)) return 'an array of ' + v.length;
    if (typeof v !== 'object') return 'a bare ' + typeof v;
    const keys = Object.keys(v as object);
    if (keys.length > 0 && keys.every((k) => /^\d+$/.test(k))) {
        return (
            'an object with ' +
            keys.length +
            ' consecutively-numbered keys — that is the JSON of a SPREAD STRING (`{...someString}`), ' +
            'almost certainly the mnemonic joined and then spread'
        );
    }
    return 'an object with keys [' + keys.slice(0, 8).join(', ') + '] and no usable 24-word `mnemonic` array';
}

function ownerFileError(file: string, got: string): Error {
    return new Error(
        file +
            ' is not an owner wallet: it holds ' +
            got +
            '. Expected {"name","mnemonic":[24 words],"address","float","why"} — the shape `cast.ts owner` writes. ' +
            'THIS FILE IS THE WALLET: do not delete it and re-run `cast.ts owner`, which mints a NEW wallet and ' +
            'abandons the funded one. Restore it from a backup, or rebuild it by hand from the 24 words and check ' +
            'the derived address matches the one the run has been funding -- and note that WHICH address that is ' +
            'depends on `version`: the same seed is one account under v4R2 and a different, equally real one under ' +
            'v5r1 (see `WalletVersion` in sender.ts).'
    );
}

function load(): CastFile {
    if (!fs.existsSync(CAST_FILE)) {
        throw new Error('no cast at ' + CAST_FILE + ' — run "cast.ts new" first');
    }
    return JSON.parse(fs.readFileSync(CAST_FILE, 'utf8'));
}

function short(a: Address): string {
    return a.toString({ testOnly: true, bounceable: false });
}

async function cmdNew() {
    if (fs.existsSync(CAST_FILE)) {
        throw new Error(
            CAST_FILE +
                ' already exists — refusing to overwrite twelve possibly-funded wallets. ' +
                'Run "sweep" first, then delete it by hand.'
        );
    }
    const wallets: CastEntry[] = [];
    for (const role of ROLES) {
        const mnemonic = await mnemonicNew();
        const keyPair = await mnemonicToPrivateKey(mnemonic);
        const w = WalletContractV4.create({ workchain: 0, publicKey: keyPair.publicKey });
        wallets.push({
            name: role.name,
            mnemonic,
            address: short(w.address),
            float: role.ton,
            why: role.why,
        });
        console.log(role.name.padEnd(3) + ' ' + short(w.address) + '  float ' + role.ton + ' GRAM');
    }
    const out: CastFile = {
        createdAt: new Date().toISOString(),
        subwalletId: process.env.PRIMES_DEPLOY_SUBWALLET_ID ?? '',
        wallets,
    };
    fs.writeFileSync(CAST_FILE, JSON.stringify(out, null, 2));
    console.log('\nwrote ' + CAST_FILE + ' (gitignored — it holds live mnemonics)');
}


/**
 * Create the owner's wallet once, or print the one that exists. Idempotent by
 * design: running it twice must never mint a second wallet, because the owner
 * has already imported the first one into a wallet app.
 */
async function cmdOwner() {
    let found = readOwnerEntry();
    if (!found) {
        const mnemonic = await mnemonicNew();
        const keyPair = await mnemonicToPrivateKey(mnemonic);
        const w = WalletContractV4.create({ workchain: 0, publicKey: keyPair.publicKey });
        found = {
            name: 'P',
            mnemonic,
            address: short(w.address),
            float: OWNER_FLOAT,
            why: 'the OWNER’s wallet — imported into a wallet app, connected to primes.live',
        };
        fs.writeFileSync(OWNER_FILE, JSON.stringify(found, null, 2));
        console.log('created ' + OWNER_FILE + ' (gitignored)');
    }
    const entry: CastEntry = found;
    const client = makeClient();
    const bal = await retry(() => client.getBalance(Address.parse(entry.address)), 'balance:P');
    console.log('');
    console.log('handle   P   (testnet only — never fund this from mainnet)');
    console.log('address  ' + entry.address);
    console.log('balance  ' + fromNano(bal) + ' GRAM   (float ' + entry.float + ')');
    console.log('seed     ' + entry.mnemonic.join(' '));
}

async function cmdList() {
    const client = makeClient();
    const cast = load();
    const funder = await openDeployWallet(client);
    const fb = await retry(() => client.getBalance(funder.wallet.address), 'balance:K');
    console.log('K   ' + short(funder.wallet.address) + '  ' + fromNano(fb) + ' GRAM  (funder)');
    const ownerRow = readOwnerEntry();
    for (const w of ownerRow ? [...cast.wallets, ownerRow] : cast.wallets) {
        const bal = await retry(() => client.getBalance(Address.parse(w.address)), 'balance:' + w.name);
        console.log(
            w.name.padEnd(3) + ' ' + w.address + '  ' + fromNano(bal) + ' GRAM  (float ' + w.float + ')  ' + w.why
        );
    }
}

/**
 * Top each wallet UP TO its float — idempotent, so a half-finished fund re-runs
 * safely.
 *
 * THE FLOAT COMES FROM `ROLES`, NOT FROM THE FILE. `.cast.json` stores the float
 * each wallet was created with, and it is created ONCE and then reused for the
 * rest of the set's life — so raising a role's float in the table above did
 * nothing, silently, forever. R1's float was raised from 2 to 8 GRAM for its
 * three self-mints and R1 kept being funded to 2: its second mint failed in the
 * ACTION phase with result 37, which advances the seqno, sends nothing, and
 * leaves no error anywhere the harness looks (found by `txAudit.ts`, 2026-09-17).
 * The stored value stays as the fallback for a role the table no longer names.
 */
/**
 * WHAT THE FUNDER KEEPS. `K` is not in `ROLES` because it "already holds the
 * budget" — but it is also the wallet the phase scripts MINT from, and this
 * function used to pay every float out of it with no floor, leaving whatever
 * happened to remain. On 2026-09-19 that was 0.54 GRAM, and phase 1's next mint
 * refused for want of 1.08. A funder that cannot afford a mint is not funded.
 *
 * 35, NOT 20, SINCE 2026-09-21. The figure above was sized for ONE mint, and
 * `run.ts` makes `K` send far more than one: `money.ts walk 20 K` alone is 20 ×
 * 1.08 = 21.6 GRAM, plus `money.ts referral`/`tribute` (~3-6), `tston.ts buffer 4
 * K` (4), two `timelock.ts queue`s and two `primes.ts send`s (~0.6) — ~30-33 GRAM
 * across the run. A reserve below that funds the cast and then strands the
 * funder halfway through phase 3. Budget consequence: `cast fund` now needs
 * ~15 GRAM more in `K` before it will pay the last float out (§4).
 */
const FUNDER_RESERVE = toNano('35');

async function cmdFund(only: string[] = []) {
    const client = makeClient();
    const cast = load();
    const funder = await openDeployWallet(client);
    const funderBalance = await retry(() => client.getBalance(funder.wallet.address), 'balance:K');
    let budget = funderBalance > FUNDER_RESERVE ? funderBalance - FUNDER_RESERVE : 0n;
    console.log(
        `funder holds ${fromNano(funderBalance)} GRAM; ${fromNano(budget)} available after the ` +
            `${fromNano(FUNDER_RESERVE)} GRAM it keeps to mint with`
    );
    const ownerRow = readOwnerEntry();
    // `fund F L` tops up only those handles: the full float list spends the budget in roster order.
    for (const w of (ownerRow ? [...cast.wallets, ownerRow] : cast.wallets).filter((x) => !only.length || only.includes(x.name))) {
        const addr = Address.parse(w.address);
        const have = await retry(() => client.getBalance(addr), 'balance:' + w.name);
        const want = toNano(ROLES.find((r) => r.name === w.name)?.ton ?? w.float);   // `P` falls through to its own stored float
        if (have >= want) {
            console.log(w.name.padEnd(3) + ' ok (' + fromNano(have) + ' GRAM >= ' + w.float + ')');
            continue;
        }
        const top = want - have;
        if (top > budget) {
            console.log(
                w.name.padEnd(3) +
                    ` SHORT: needs ${fromNano(top)} GRAM and only ${fromNano(budget)} is left above the ` +
                    `funder's reserve. Lower a float in ROLES, or fund K, then re-run.`
            );
            continue;
        }
        budget -= top;
        console.log(w.name.padEnd(3) + ' sending ' + fromNano(top) + ' GRAM -> ' + w.address);
        // NON-BOUNCEABLE, and that is load-bearing: these wallets are
        // UNINITIALISED until their own first send, and a bounceable transfer to
        // an uninit account comes straight back to the funder.
        await funder.sender.send({ to: addr, value: top, bounce: false });
    }
    console.log('funded.');
}

/** Return what is left to the funder, best-effort; a wallet that fails is logged, not fatal. */
/** `sweep` returns every cast wallet's GRAM to the funder; `sweep <handle>` returns one. */
async function cmdSweep() {
    const client = makeClient();
    const cast = load();
    const only = process.argv[3];
    const funder = await openDeployWallet(client);
    for (const w of cast.wallets.filter((x) => !only || x.name === only)) {
        const bal = await retry(() => client.getBalance(Address.parse(w.address)), 'balance:' + w.name);
        if (bal < toNano('0.1')) {
            console.log(w.name.padEnd(3) + ' skip (' + fromNano(bal) + ' GRAM)');
            continue;
        }
        const wallet = await openWallet(client, w.mnemonic);
        const back = bal - toNano('0.05');
        console.log(w.name.padEnd(3) + ' returning ' + fromNano(back) + ' GRAM');
        try {
            await wallet.sender.send({ to: funder.wallet.address, value: back, bounce: false });
        } catch (e: any) {
            console.log(w.name.padEnd(3) + ' sweep failed: ' + (e?.message ?? e));
        }
    }
    console.log('swept.');
}

async function main() {
    const cmd = process.argv[2] ?? 'list';
    if (cmd === 'new') return cmdNew();
    if (cmd === 'fund') return cmdFund(process.argv.slice(3));
    if (cmd === 'list') return cmdList();
    if (cmd === 'sweep') return cmdSweep();   // deliberately NOT `P`: it is the owner's, not the wave's
    if (cmd === 'owner') return cmdOwner();
    throw new Error('unknown command "' + cmd + '" — one of: new, fund, list, sweep');
}

// Guarded, because `readCast` above is imported by other scripts: an unguarded
// `main()` at module scope runs the CLI on import and swallows the importer's
// own argv (`makeInvites.ts 5` died with `unknown command "5"`). Only run when
// this file IS the entrypoint — the same guard `deployGenesis.ts --skew-safe` uses.
if (require.main === module) {
    main().catch((e) => {
        console.error(e?.message ?? e);
        process.exit(1);
    });
}

/**
 * The same shape as `readCast()`, but from a cast file the caller names on the
 * command line rather than from `.cast.json`.
 *
 * The four `phase*Live.ts` scripts each take an optional `<cast.json>` argument and
 * each hand-rolled its own reader for it, and three of the four read the RAW file —
 * `{ wallets: [{ name, why, address, mnemonic: string[] }] }` — straight into a
 * variable typed as the normalised `{ handle, role, address, mnemonic }[]`. The raw
 * file is an object, so the very next line (`cast.find(...)`) threw
 * `cast.find is not a function` for anyone who passed the path the script's own usage
 * line documents. Fixed twice in two different scripts before this; the third time it
 * is one exported function, so the fourth script cannot reintroduce it.
 */
export function normaliseCast(raw: unknown): { handle: string; role: string; address: string; mnemonic: string }[] {
    const wallets = Array.isArray(raw) ? raw : (raw as { wallets?: unknown } | null)?.wallets;
    if (!Array.isArray(wallets)) throw new Error('cast file has no `wallets` array');
    return wallets.map((w: Record<string, any>) => ({
        handle: w.handle ?? w.name,
        role: w.role ?? w.why ?? '',
        address: w.address,
        mnemonic: Array.isArray(w.mnemonic) ? w.mnemonic.join(' ') : w.mnemonic,
    }));
}
