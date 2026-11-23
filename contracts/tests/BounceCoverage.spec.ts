// TON PRIMES — D7: bounce handling, every outbound message's failure path
// (GAUNTLET.md D7, CONCEPT.md §12).
//
// TON delivers no failure synchronously. A send the destination refuses — wrong
// opcode, out of gas, uninitialised, throwing — comes back as a BOUNCE: a
// separate inbound message arriving later at the sender. So every one of the 63
// outbound sends has a second code path, and D7 asks whether it exists and what
// it does.
//
// WHY "DOES IT HANDLE THE BOUNCE" IS THE WRONG QUESTION ON ITS OWN
//
// The first version of the generator behind this asked whether each sender's
// `onBouncedMessage` dispatches on the bounced opcode, and reported nine sends
// where it does not. Reading all nine showed the question was wrong: a contract
// that sends only ONE kind of bounceable message has nothing to dispatch on, and
// several of those handlers do full reversal work without a single `opcode ==`
// — the item restores `owed`, the voucher walks its high-water mark back down.
// What actually distinguishes a gap is an EMPTY handler, so that is what the
// table records.
//
// AND AN EMPTY HANDLER IS NOT AUTOMATICALLY A GAP EITHER. Seven sends come from
// contracts whose bounce handler does nothing, and six of them are right to:
// either there is no state on that side to restore (the collection holds no
// head or refund state — the ledger does), or the recovery deliberately lives
// somewhere else (the shard's settle-ack is recovered by the ROUTER's bounce
// path sending `shard_unsettle` back with the value; the timelock's venue update
// is recovered by its permissionless `retry_update_venue` arm).
//
// So the table cannot mechanically decide correctness. What it can do — and what
// this spec enforces — is make the set of empty handlers a NAMED list with a
// reason each, so the seventh case cannot hide among the six.
//
// THE SEVENTH CASE, CLOSED (GAUNTLET.md B11.1, D-53, iter #10). `primes_stake`'s
// handler used to be empty, on the premise that `RichBounceBody` returns only
// the first 256 bits of the original body — false, per D-53's own iteration
// #74 correction, and now fixed the same way `primes_voucher.tolk` already
// did: `destination`/`amount` parsed straight out of `rich.originalBody`, the
// staker's position restored in the same transaction. `KNOWN_UNREPAIRED` is
// empty as a result — there is no longer a seventh case, only the six that
// were always right to be empty.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { Blockchain, SandboxContract, TreasuryContract, createShardAccount, createEmptyShardAccount } from '@ton/sandbox';
import { Address, Cell, beginCell, internal, toNano } from '@ton/core';
import '@ton/test-utils';
import { compile } from '@ton/blueprint';
import { PrimesLedger, LedgerOpcodes, encodeFactors, FactorEntry } from '../wrappers/PrimesLedger';
import { PrimesCollection } from '../wrappers/PrimesCollection';
import { PrimesItem } from '../wrappers/PrimesItem';
import { ERRORS, LEDGER } from '../../shared/opcodes';
import { PrimesJettonMaster } from '../wrappers/PrimesJettonMaster';
import { internal as sandboxInternal } from '@ton/sandbox';
import { deployStack, Stack } from './helpers/stack';
import { winLot, RESERVABLE_12 } from './helpers/market';
import { buildCloseLotMessage } from '../../shared/messages';

const REPO = join(__dirname, '..', '..');
const CONTRACTS_DIR = join(REPO, 'contracts', 'contracts');
const DOC = join(REPO, 'docs', 'audit', 'bounce-coverage.md');

type Row = { file: string; line: number; fn: string; body: string; handler: string; rich: boolean };

function readTable(): Row[] {
    const md = readFileSync(DOC, 'utf8');
    const rows: Row[] = [];
    let rich = true;
    for (const line of md.split('\n')) {
        if (line.startsWith('## NoBounce')) rich = false;
        if (line.startsWith('## Limits')) break;
        const m = line.match(/^\| `([^`]+)` \| (\d+) \| `([^`]+)` \| `([^`]*)` \| `[^`]*` \|(?: (.*) \|)?$/);
        if (m) rows.push({ file: m[1], line: Number(m[2]), fn: m[3], body: m[4], handler: m[5] ?? '', rich });
    }
    return rows;
}

/**
 * The sends whose sender has an EMPTY bounce handler, and why each is safe —
 * except the one that is not. Keyed by `file::body` so the entry survives the
 * line moving.
 */
const EMPTY_HANDLER_OK: Record<string, string> = {
    'primes_venue_timelock.tolk::UpdateVenue':
        'recovery is the permissionless `retry_update_venue` arm, which re-sends a matured, already-fired action',
};

/**
 * The bounce paths known to be UNREPAIRED. Three are escalated in DECISIONS.md;
 * the fourth is filed as D7.1 by the iteration that wrote this file. Named as a
 * closed set so a fifth cannot arrive quietly.
 */
const KNOWN_UNREPAIRED: string[] = [];

describe('TON PRIMES — D7: every outbound send has a failure path, and the gaps are named', () => {
    const rows = readTable();
    const rich = rows.filter((r) => r.rich);
    const key = (r: Row) => `${r.file}::${r.body}`;

    it('the generated table is current — regenerating it changes nothing', () => {
        const before = readFileSync(DOC, 'utf8');
        execFileSync(process.execPath, [join(REPO, 'tools', 'bounce-coverage.mjs')], { cwd: REPO });
        expect(readFileSync(DOC, 'utf8')).toBe(before);
    }, 60_000);

    it('covers every outbound send, and both modes are genuinely in use', () => {
        // 72 before D-90 deleted `primes_market_shard.tolk` and the market's
        // whole `shard_*` send family with it.
        expect(rows.length).toBeGreaterThanOrEqual(63);
        expect(rich.length).toBeGreaterThan(20);
        expect(rows.filter((r) => !r.rich).length).toBeGreaterThan(20);
    });

    it('every contract that can send at all has an onBouncedMessage — a bounce can never throw', () => {
        // A bounce arriving at a contract with no handler is an unhandled
        // exception on a message nobody sent deliberately. Every contract here
        // has one, several purely so that cannot happen.
        const senders = new Set(rows.map((r) => r.file));
        for (const f of senders) {
            const src = readFileSync(join(CONTRACTS_DIR, f), 'utf8');
            expect({ file: f, hasHandler: src.includes('fun onBouncedMessage') }).toEqual({
                file: f,
                hasHandler: true,
            });
        }
        expect(senders.size).toBeGreaterThanOrEqual(15);
    });

    it('THE CLAIM: every RichBounce send whose sender has an empty handler is on the named list', () => {
        const empty = rich.filter((r) => r.handler.includes('empty'));
        const unaccounted = empty
            .filter((r) => !(key(r) in EMPTY_HANDLER_OK) && !KNOWN_UNREPAIRED.includes(key(r)))
            .map((r) => `${r.file}:${r.line} ${r.body}`);
        expect(unaccounted).toEqual([]);
        // Non-vacuous: there really are empty handlers to account for. Was 7
        // before B11.1/D-53 closed the stake transfer's (iter #10), 6 until
        // D-90 deleted the shard's `ShardSettleAck` along with the shard, and 5
        // until D-106 deleted the collection's `GrantClaim`/`GrantReclaim` with
        // patron mode, and 4 until D-193 gave the constellations collection a
        // bounce arm (the discovery-claim relay), and 3 until V28/D-199 gave the
        // main collection one (a refused `Populate` relayed to the retry lane) —
        // its old entry here, "the LEDGER records the failure", was false: the
        // ledger never saw an item-side refusal, and 2 until D-202 deleted the
        // generators collection's `Populate`. One remains, correctly empty (see
        // the module note above).
        expect(empty.length).toBeGreaterThanOrEqual(1);
    });

    it('G56: every self-named response field has an excesses arm (CLAUDE.md reply rule)', () => {
        // The generator exits 1 on a MISSING row, so the gate catches it first; this
        // pins the table non-vacuous. Ten sites at filing: the vault's four `payOut`s,
        // the master, the ratchet's three, the sink, the treasury's `sendJetton`.
        const md = readFileSync(DOC, 'utf8');
        const section = md.slice(md.indexOf('## Self-named response'), md.indexOf('## Limits'));
        const sites = section.split('\n').filter((l) => /^\| `primes_/.test(l));
        expect(sites.length).toBeGreaterThanOrEqual(9); // 10 until D-212 deleted the burn sink's
        expect(sites.filter((l) => l.includes('MISSING'))).toEqual([]);
    });

    it('and no reason is dead — each names a send that still exists', () => {
        const live = new Set(rich.map(key));
        const dead = [...Object.keys(EMPTY_HANDLER_OK), ...KNOWN_UNREPAIRED].filter((k) => !live.has(k));
        expect(dead).toEqual([]);
    });

    it('the UNREPAIRED set is empty — the stake transfer gap closed in B11.1/D-53', () => {
        // Was exactly one send (`primes_stake.tolk::JettonTransfer`, "nobody is
        // home at all"). GAUNTLET.md B11.1 (iter #10) closed it the same way
        // `primes_voucher.tolk` already handled its own case, so the empty-set
        // is now the honest answer rather than a placeholder.
        expect(KNOWN_UNREPAIRED).toEqual([]);
        const staked = rich.find((r) => key(r) === 'primes_stake.tolk::JettonTransfer');
        expect(staked).toBeDefined();
        expect(staked!.handler).not.toContain('empty');
    });

    it('the stake handler dispatches on the recovered opcode, not a documented gap', () => {
        // B11.1/D-53: the fix parses `JettonTransfer` (0x0f8a7ea5) straight out
        // of `rich.originalBody` and restores the position — the same technique
        // `primes_voucher.tolk` already proved, not a new journal.
        const src = readFileSync(join(CONTRACTS_DIR, 'primes_stake.tolk'), 'utf8');
        const handler = src.slice(src.indexOf('fun onBouncedMessage'));
        expect(handler).toMatch(/0x0f8a7ea5/);
        expect(handler).toMatch(/JettonTransfer/);
    });

    it('the value-bearing NoBounce sends are payments to possibly-dormant wallets, by design', () => {
        // NoBounce is the right choice when the destination may not exist yet:
        // GRAM credited to an uninitialised address accumulates as its balance
        // rather than vanishing. The split's outward legs are exactly that case
        // — a treasury, a referral item's owner, an operator wallet that may
        // never have transacted. Spot-checked on the ledger, where the choice is
        // densest, so that "NoBounce everywhere" cannot creep into a path that
        // needs a reversal.
        const src = readFileSync(join(CONTRACTS_DIR, 'primes_ledger.tolk'), 'utf8');
        // D-106 deleted the patron leg, which used to be the one that spelt the
        // reason out; §4.1's 5% treasury leg carries it now (D-152).
        expect(src).toMatch(/NoBounce, and this is the reason[\s\S]{0,300}accumulates as its balance/);
        // And the legs that DO need a reversal are RichBounce: the item deploy
        // (V1: no longer rolls back `head` — see `onBouncedMessage`'s own note)
        // and the tribute credit (moves to the retry lane).
        const richBodies = rich.filter((r) => r.file === 'primes_ledger.tolk').map((r) => r.body);
        expect(richBodies).toContain('CreditTribute');
    });
});

describe('V1 (gauntlet, 2026-09-09): a bounced MintItem touches `head` on no path', () => {
    // The collection is deliberately WIRED WRONG — left unwired, its placeholder
    // ledger the deployer rather than the real ledger's address, so the collection's own
    // `sender == ledgerAddr` check (primes_collection.tolk) rejects every
    // `MintItem` the ledger sends it, and GRAM bounces each one back (RichBounce)
    // as a genuine, TVM-produced bounce — not a hand-forged message. That
    // misconfiguration is a "genuinely bounced" technique applied to a fresh
    // stack rather than an existing suite's.
    //
    // `handleIgnite` sets `meters.launched = 1` BEFORE it sends Unity's own
    // MintItem (primes_ledger.tolk), so ignite itself completes even though its
    // item deploy bounces — which means every one of the four paths below can
    // be driven off ONE broken stack instead of four.
    let blockchain: Blockchain;
    let deployer: SandboxContract<TreasuryContract>;
    let genesisScript: SandboxContract<TreasuryContract>;
    let treasuryWallet: SandboxContract<TreasuryContract>;
    let marketStub: SandboxContract<TreasuryContract>;
    let vaultStub: SandboxContract<TreasuryContract>;
    let minter: SandboxContract<TreasuryContract>;

    let itemCode: Cell;
    let collectionCode: Cell;
    let walletCode: Cell;
    let masterCode: Cell;
    let ledgerCode: Cell;

    let collection: SandboxContract<PrimesCollection>;
    let master: SandboxContract<PrimesJettonMaster>;
    let ledger: SandboxContract<PrimesLedger>;

    const SEED_HEAD = 10n; // walks 2..9, marking 2,3,5,7 prime; head opens on the composite 10
    const SEED_T = toNano('200');
    const SEED_S = 4_000_000_000_000_000n;
    const RACE_CREDIT_ID = 777n;
    const RACE_CREDIT = toNano('0.01');

    beforeAll(async () => {
        itemCode = await compile('PrimesItem');
        collectionCode = await compile('PrimesCollection');
        walletCode = await compile('PrimesJettonWallet');
        masterCode = await compile('PrimesJettonMaster');
        ledgerCode = await compile('PrimesLedger');
    });

    beforeEach(async () => {
        blockchain = await Blockchain.create();
        deployer = await blockchain.treasury('deployer');
        genesisScript = await blockchain.treasury('genesisScript');
        treasuryWallet = await blockchain.treasury('treasury');
        marketStub = await blockchain.treasury('marketStub');
        vaultStub = await blockchain.treasury('vaultStub');
        minter = await blockchain.treasury('minter');

        collection = blockchain.openContract(
            PrimesCollection.createFromConfig(
                { nextIndex: 2n, itemCode, ledgerAddr: deployer.address, genesisScriptAddr: genesisScript.address },
                collectionCode
            )
        );
        await collection.sendDeploy(deployer.getSender(), toNano('5'));
        // THE MISWIRE: the collection is left UNWIRED (`ledgerSet = 0`, its
        // placeholder ledger is the deployer), so it rejects every `MintItem`
        // the real ledger sends. Unwired rather than wired to a stranger since
        // D-117: the retry-lane case below then FIXES it with the one-shot
        // `SetLedger`, which a stranger-wired collection could never accept again.

        master = blockchain.openContract(
            PrimesJettonMaster.createFromConfig(
                { ledgerAddr: deployer.address, genesisScriptAddr: genesisScript.address, walletCode },
                masterCode
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
                        itemCode,
                    },
                    b: { genesisScriptAddr: genesisScript.address },
                    // V32: a credit for 97 parked in the retry lane, for the race case below.
                    seedUnroutedCredits: [{ creditId: RACE_CREDIT_ID, p: 97n, amount: RACE_CREDIT }],
                },
                ledgerCode
            )
        );
        await ledger.sendDeploy(deployer.getSender(), toNano('10'));

        await master.sendSetLedger(genesisScript.getSender(), { ledgerAddr: ledger.address, value: toNano('0.05') });
        await master.sendSealAuthority(genesisScript.getSender(), { value: toNano('0.05') });
        // No ratchet/registrar in this stack — nothing under test here touches
        // either, and `sendSetSinks` accepts any address for a fixture that
        // will never call the sink paths (T/S bookkeeping doesn't route
        // through them for a mint that bounces before it gets that far... in
        // fact it does route T/S regardless of the bounce, but neither sink
        // needs to be a real contract to receive the resulting sends since
        // this suite never asserts on them).
        await ledger.sendSetSinks(genesisScript.getSender(), {
            ratchetAddr: deployer.address,
            registrarAddr: deployer.address,
            value: toNano('0.05'),
        });

        await ledger.sendGenesisSeed(genesisScript.getSender(), {
            seedT: SEED_T,
            seedS: SEED_S,
            seedHead: SEED_HEAD,
            value: toNano('0.2'),
        });
        await ledger.sendSetPeers(genesisScript.getSender(), {
            marketAddr: marketStub.address,
            bountyVaultAddr: vaultStub.address,
            value: toNano('0.05'),
        });
    });

    /** ignite, then assert its own bounced Unity deploy is a real bounce and touches nothing on `head`. */
    async function igniteAndExpectBounce() {
        const before = await ledger.getHead();
        const r = await ledger.sendIgnite(genesisScript.getSender(), { owner: deployer.address, value: toNano('0.3') });
        expectBounceFrom(r.transactions, collection.address, ledger.address);
        expect(await ledger.getHead()).toBe(before);
        return r;
    }

    it('ignite: Unity\'s MintItem bounces, head is untouched (never advanced by ignite at all)', async () => {
        await igniteAndExpectBounce();
    });

    it('sync_launch is caller-funded: under LAUNCH_HOP_GAS throws 103, a funded repeat costs the ledger nothing', async () => {
        await igniteAndExpectBounce();
        blockchain.now = Math.floor(Date.now() / 1000) + 60; // freeze time: no storage fee between reads
        const short = await ledger.sendSyncLaunch(minter.getSender(), { value: toNano('0.005') });
        expect(short.transactions).toHaveTransaction({ to: ledger.address, success: false, exitCode: 103 });
        const before = (await blockchain.getContract(ledger.address)).balance;
        for (let i = 0; i < 3; i++) {
            const r = await ledger.sendSyncLaunch(minter.getSender(), { value: toNano('0.01') });
            expect(r.transactions).not.toHaveTransaction({ aborted: true });
            expect(r.transactions).toHaveTransaction({ from: ledger.address, to: marketStub.address, success: true });
        }
        expect((await blockchain.getContract(ledger.address)).balance).toBeGreaterThanOrEqual(before);
    });

    it('direct head mint: MintItem bounces, head stays exactly where the walk left it', async () => {
        await igniteAndExpectBounce();
        const head = await ledger.getHead(); // 10 = 2 * 5
        const r = await ledger.sendMint(minter.getSender(), {
            n: head,
            kind: 0,
            factors: [
                { prime: 2n, exponent: 1, s: 1n },
                { prime: 5n, exponent: 1, s: 2n },
            ],
            referralKey: 0,
            beneficiary: null,
            value: toNano('1.1'),
        });
        expectBounceFrom(r.transactions, collection.address, ledger.address);
        // The walk really advanced past 10: 11 is prime (skipped and marked),
        // so the new head is at least 12.
        const headAfterMint = await ledger.getHead();
        expect(headAfterMint).toBeGreaterThan(head);
        // The bounce is IN r.transactions already (same transaction chain as
        // the mint — the collection's rejection and its bounce both happen
        // before this call resolves). Re-reading `head` afterwards is the
        // assertion: the bounce did not additionally roll it back.
        expect(await ledger.getHead()).toBe(headAfterMint);
    });

    it('D-117: a bounced MintItem pays NO split line; its body and held split are parked, and retry_item mints the number to the same owner', async () => {
        await igniteAndExpectBounce();
        const head = await ledger.getHead(); // 10 = 2 * 5; 2 and 5 are unsold at genesis -> forfeits
        const liabilityBefore = await ledger.getLiabilityBreakdown();
        const r = await ledger.sendMint(minter.getSender(), {
            n: head,
            kind: 0,
            factors: [
                { prime: 2n, exponent: 1, s: 1n },
                { prime: 5n, exponent: 1, s: 2n },
            ],
            referralKey: 0,
            beneficiary: null,
            value: toNano('1.1'),
        });
        expectBounceFrom(r.transactions, collection.address, ledger.address);
        // THE TRACE, not the balances: no line left, and nothing in the chain aborted.
        expect(r.transactions).not.toHaveTransaction({ from: ledger.address, to: treasuryWallet.address });
        expect(r.transactions).not.toHaveTransaction({ from: ledger.address, to: minter.address });
        expect(r.transactions).not.toHaveTransaction({ on: ledger.address, aborted: true });
        // The held split (5% treasury + the 8% divisor tribute, less the nanoton the
        // divisor split rounds into `T`) is DECLARED in the retry lane, not owed as tribute.
        const parked = await ledger.getLiabilityBreakdown();
        expect(parked.tributeOwed).toBe(liabilityBefore.tributeOwed);
        const held = parked.unroutedHeld - liabilityBefore.unroutedHeld;
        expect(held).toBeLessThanOrEqual(toNano('0.13'));
        expect(held).toBeGreaterThanOrEqual(toNano('0.13') - 2n);
        // G68b: the parked n is findable from outside. (Unity, #1, bounced at ignite in this
        // fixture too, so the walk from 0 finds it first.)
        expect(await ledger.getNextUnroutedItem(0n)).toBe(1n);
        expect(await ledger.getNextUnroutedItem(2n)).toBe(head);
        expect(await ledger.getNextUnroutedItem(head + 1n)).toBe(-1n);

        // The fault is fixed (the collection finally learns its ledger), and anyone retries.
        await collection.sendSetLedger(genesisScript.getSender(), { ledgerAddr: ledger.address, value: toNano('0.05') });
        const itemAddr = await ledger.getItemAddress(head);
        const retry = await ledger.sendRetryItem(deployer.getSender(), { n: head, value: toNano('0.05') });
        expect(retry.transactions).toHaveTransaction({ from: ledger.address, to: collection.address, success: true });
        expect(retry.transactions).toHaveTransaction({ from: collection.address, to: itemAddr, deploy: true, success: true });
        // V28: the receipt comes from the ITEM, once it is populated — never from the collection.
        expect(retry.transactions).toHaveTransaction({ from: itemAddr, to: ledger.address, op: LEDGER.mint_confirmed, success: true });
        expect(retry.transactions).not.toHaveTransaction({ from: collection.address, to: ledger.address });
        // ...and only NOW is the treasury line paid, once — the 5% and, since G81, the
        // forfeit's 58% in the same message (2 and 5 are unsold here).
        const forfeit = (await ledger.getForfeited(2n)) + (await ledger.getForfeited(5n));
        expect(retry.transactions).toHaveTransaction({
            from: ledger.address,
            to: treasuryWallet.address,
            value: toNano('0.05') + (forfeit * 5800n) / 10_000n,
        });
        expect(retry.transactions).not.toHaveTransaction({ aborted: true });
        const item = blockchain.openContract(PrimesItem.createFromAddress(itemAddr));
        expect((await item.getNftData()).ownerAddress.equals(minter.address)).toBe(true);
        expect((await ledger.getLiabilityBreakdown()).unroutedHeld).toBe(liabilityBefore.unroutedHeld);
        expect(await ledger.getNextUnroutedItem(2n)).toBe(-1n);

        // A second retry of the same n is a cheap no-op: nothing left to send.
        const again = await ledger.sendRetryItem(deployer.getSender(), { n: head, value: toNano('0.05') });
        expect(again.transactions).not.toHaveTransaction({ from: ledger.address, to: collection.address });
        expect(again.transactions).not.toHaveTransaction({ aborted: true });
    });

    it('V28: an item that refuses Populate pays NO split line; the collection relays the mint to the retry lane, keeps nothing, and retry_item pays each line once', async () => {
        await igniteAndExpectBounce();
        // The collection is wired this time, so the collection accepts `MintItem`
        // and the refusal is the ITEM's — the case D-117 could not see.
        await collection.sendSetLedger(genesisScript.getSender(), { ledgerAddr: ledger.address, value: toNano('0.05') });
        const head = await ledger.getHead(); // 10 = 2 * 5
        const itemAddr = await ledger.getItemAddress(head);
        // item(10) already exists and throws on every message: item code over empty
        // data, so `Populate`'s storage load fails in compute.
        await blockchain.setShardAccount(itemAddr, createShardAccount({
            address: itemAddr, code: itemCode, data: beginCell().endCell(), balance: toNano('0.01'),
        }));
        const collectionBefore = (await blockchain.getContract(collection.address)).balance;
        const liabilityBefore = await ledger.getLiabilityBreakdown();
        const mint = () => ledger.sendMint(minter.getSender(), {
            n: head,
            kind: 0,
            factors: [
                { prime: 2n, exponent: 1, s: 1n },
                { prime: 5n, exponent: 1, s: 2n },
            ],
            referralKey: 0,
            beneficiary: null,
            value: toNano('1.1'),
        });
        const r = await mint();
        expectBounceFrom(r.transactions, itemAddr, collection.address);
        expect(r.transactions).toHaveTransaction({ from: collection.address, to: ledger.address, op: LEDGER.mint_item_refused, success: true });
        // THE TRACE: no receipt, no line, and nothing but the refusing item aborted.
        expect(r.transactions).not.toHaveTransaction({ op: LEDGER.mint_confirmed });
        expect(r.transactions).not.toHaveTransaction({ from: ledger.address, to: treasuryWallet.address });
        expect(r.transactions).not.toHaveTransaction({ on: ledger.address, aborted: true });
        expect(r.transactions).not.toHaveTransaction({ on: collection.address, aborted: true });
        // The collection holds none of the bounced mint GRAM (storage rent aside).
        const collectionAfter = (await blockchain.getContract(collection.address)).balance;
        expect(collectionAfter).toBeLessThanOrEqual(collectionBefore);
        expect(collectionBefore - collectionAfter).toBeLessThan(toNano('0.0001'));
        // Parked exactly as a bounced `MintItem` is.
        expect(await ledger.getNextUnroutedItem(2n)).toBe(head);
        const parked = await ledger.getLiabilityBreakdown();
        expect(parked.tributeOwed).toBe(liabilityBefore.tributeOwed);
        const held = parked.unroutedHeld - liabilityBefore.unroutedHeld;
        expect(held).toBeLessThanOrEqual(toNano('0.13'));
        expect(held).toBeGreaterThanOrEqual(toNano('0.13') - 2n);

        // The squatter goes away; anyone retries.
        await blockchain.setShardAccount(itemAddr, createEmptyShardAccount(itemAddr));
        const retry = await ledger.sendRetryItem(deployer.getSender(), { n: head, value: await ledger.getRetryItemMinValue(head) });
        expect(retry.transactions).toHaveTransaction({ from: collection.address, to: itemAddr, deploy: true, success: true });
        expect(retry.transactions).toHaveTransaction({ from: itemAddr, to: ledger.address, op: LEDGER.mint_confirmed, success: true });
        expect(retry.transactions).not.toHaveTransaction({ aborted: true });
        // Each line exactly once across both rounds. This fixture's operator IS the
        // treasury wallet, so the 5% line and both forfeit shares (2 and 5 are unsold)
        // all land there: their sum, paid once, is the whole of what arrives.
        const forfeit = (await ledger.getForfeited(2n)) + (await ledger.getForfeited(5n));
        const paidToTreasury = [...r.transactions, ...retry.transactions]
            .filter((t) => t.inMessage?.info.type === 'internal'
                && t.inMessage.info.src.equals(ledger.address)
                && t.inMessage.info.dest.equals(treasuryWallet.address))
            .reduce((sum, t) => sum + (t.inMessage!.info as any).value.coins, 0n);
        expect(paidToTreasury).toBe(toNano('0.05') + forfeit);
        const item = blockchain.openContract(PrimesItem.createFromAddress(itemAddr));
        expect((await item.getNftData()).ownerAddress.equals(minter.address)).toBe(true);
        expect((await ledger.getLiabilityBreakdown()).unroutedHeld).toBe(liabilityBefore.unroutedHeld);
        expect(await ledger.getNextUnroutedItem(2n)).toBe(-1n);
    });

    // V24 follow-up: a retry that bounces again must cost the ledger nothing. Its fee
    // legs (the forward to the collection, the collection's refusal, the bounce home)
    // come out of GRAM the ledger then re-declares in full as `unroutedHeld`, so
    // anything the caller does not cover is a draw on the ledger's own balance.
    it('V24: a retry_item that bounces again costs the ledger nothing, round after round', async () => {
        await igniteAndExpectBounce();
        const head = await ledger.getHead();
        await ledger.sendMint(minter.getSender(), {
            n: head,
            kind: 0,
            factors: [
                { prime: 2n, exponent: 1, s: 1n },
                { prime: 5n, exponent: 1, s: 2n },
            ],
            referralKey: 0,
            beneficiary: null,
            value: toNano('1.1'),
        });
        const surplus = async () => {
            const l = await ledger.getLiabilityBreakdown();
            const owed = l.tributeOwed + l.unroutedHeld + l.divOutstanding + l.treasuryHeld + l.operatorHeld;
            return (await blockchain.getContract(ledger.address)).balance - owed;
        };
        const min = await ledger.getRetryItemMinValue(head);
        // The keeper sends the flat 0.035 plus its 0.05 FEE_MARGIN without reading the
        // quote (backend/keeper/src/chain.ts); a checked factor list must stay inside that.
        expect(min).toBeGreaterThan(toNano('0.035'));
        expect(min).toBeLessThan(toNano('0.085'));
        for (let round = 0; round < 5; round++) {
            const before = await surplus();
            const r = await ledger.sendRetryItem(deployer.getSender(), { n: head, value: min });
            expectBounceFrom(r.transactions, collection.address, ledger.address);
            expect(r.transactions).not.toHaveTransaction({ on: ledger.address, aborted: true });
            expect(await surplus()).toBeGreaterThanOrEqual(before);
        }
        // One nanoton under the quote is refused before anything is sent.
        const short = await ledger.sendRetryItem(deployer.getSender(), { n: head, value: min - 1n });
        expect(short.transactions).toHaveTransaction({ on: ledger.address, exitCode: ERRORS.insufficient_value });
        expect(short.transactions).not.toHaveTransaction({ from: ledger.address, to: collection.address });
    });

    it('mint_won_lot: MintItem bounces, head is unaffected (a won lot never touches it)', async () => {
        await igniteAndExpectBounce();
        const resN = 25n; // composite, ahead of head (10); 25 = 5^2
        await sendMarkOffHead(ledger, marketStub, resN);
        const headBefore = await ledger.getHead();
        const r = await sendMintWonLot(ledger, marketStub, {
            n: resN,
            beneficiary: minter.address,
            referralKey: 0,
            kind: 0,
            factors: [{ prime: 5n, exponent: 2, s: 2n }], // 25 = 5^2
            value: toNano('1.1'),
        });
        expectBounceFrom(r.transactions, collection.address, ledger.address);
        expect(await ledger.getHead()).toBe(headBefore); // settlement is off-head since D-45; still is
    });

    it('mint_won_lot for a number the market never marked off-head is refused (200) — even from the market', async () => {
        await igniteAndExpectBounce();
        const n = 26n; // composite, ahead of head, below the lot frontier, never `mark_off_head`ed
        expect(await ledger.isNumberOffHead(n)).toBe(0);
        const r = await sendMintWonLot(ledger, marketStub, {
            n,
            beneficiary: minter.address,
            referralKey: 0,
            kind: 0,
            factors: [{ prime: 2n, exponent: 1, s: 1n }, { prime: 13n, exponent: 1, s: 3n }],
            value: toNano('1.1'),
        });
        expect(r.transactions).toHaveTransaction({ from: marketStub.address, to: ledger.address, success: false, exitCode: 200 }); // ledger_not_auctioned
        expect(r.transactions).not.toHaveTransaction({ from: ledger.address, to: collection.address });
        expect(await ledger.isNumberOffHead(n)).toBe(0);
    });

    it('V32: retry_item then retry_credit back to back — the credit re-parks behind the deploy, nothing forfeits', async () => {
        await igniteAndExpectBounce();
        // 97's clearing bounces off the miswired collection and parks.
        await ledger.sendSettlePrimeClearing(marketStub.getSender(), {
            n: 97n,
            beneficiary: minter.address,
            referralKey: 0,
            value: toNano('1.1'),
        });
        expect(await ledger.getNextUnroutedItem(2n)).toBe(97n);
        await collection.sendSetLedger(genesisScript.getSender(), { ledgerAddr: ledger.address, value: toNano('0.05') });
        const forfeitBefore = await ledger.getForfeitedBeyondWindow();
        const itemAddr = await ledger.getItemAddress(97n);

        // ONE wallet transaction, two messages: FIFO delivery puts retry_credit's
        // one-hop credit on item(97) before retry_item's two-hop deploy — the race.
        const r = await deployer.sendMessages([
            internal({
                to: ledger.address,
                value: toNano('0.1'),
                body: beginCell().storeUint(LedgerOpcodes.RetryItem, 32).storeUint(0, 64).storeUint(97n, 256).endCell(),
            }),
            internal({
                to: ledger.address,
                value: toNano('0.1'),
                body: beginCell().storeUint(LedgerOpcodes.RetryCredit, 32).storeUint(0, 64).storeUint(RACE_CREDIT_ID, 64).endCell(),
            }),
        ]);
        // The race really happened: the credit bounced off an item with no account yet.
        expectBounceFrom(r.transactions, itemAddr, ledger.address);
        expect(r.transactions).toHaveTransaction({ from: collection.address, to: itemAddr, deploy: true, success: true });
        // ...and was re-parked, not forfeited: no forfeit counted, no operator/treasury payout.
        expect(await ledger.getForfeitedBeyondWindow()).toBe(forfeitBefore);
        expect((await ledger.getLiabilityBreakdown()).unroutedHeld).toBeGreaterThanOrEqual(RACE_CREDIT);
        expect(r.transactions).not.toHaveTransaction({ on: ledger.address, aborted: true });

        // The item exists now; the next retry pays the owner.
        const item = blockchain.openContract(PrimesItem.createFromAddress(itemAddr));
        const owedBefore = await item.getOwed();
        const again = await ledger.sendRetryCredit(deployer.getSender(), { creditId: RACE_CREDIT_ID, value: toNano('0.1') });
        expect(again.transactions).toHaveTransaction({ from: ledger.address, to: itemAddr, success: true });
        expect((await item.getOwed()) - owedBefore).toBe(RACE_CREDIT);
        expect(await ledger.getForfeitedBeyondWindow()).toBe(forfeitBefore);
    });

    it('V32: with no deploy in flight or parked, a credit to an item-less prime still forfeits (D-196 unchanged)', async () => {
        const forfeitBefore = await ledger.getForfeitedBeyondWindow();
        const r = await ledger.sendRetryCredit(deployer.getSender(), { creditId: RACE_CREDIT_ID, value: toNano('0.1') });
        expectBounceFrom(r.transactions, await ledger.getItemAddress(97n), ledger.address);
        expect((await ledger.getForfeitedBeyondWindow()) - forfeitBefore).toBe(RACE_CREDIT);
    });

    it('prime clearing: MintItem bounces, head is unaffected (prime clearing never touched it)', async () => {
        await igniteAndExpectBounce();
        const headBefore = await ledger.getHead();
        const r = await ledger.sendSettlePrimeClearing(marketStub.getSender(), {
            n: 97n,
            beneficiary: minter.address,
            referralKey: 0,
            value: toNano('1.1'),
        });
        expectBounceFrom(r.transactions, collection.address, ledger.address);
        expect(await ledger.getHead()).toBe(headBefore);
    });
});

/** A real, TVM-produced bounce (not a hand-forged one) landed back on `to`. */
function expectBounceFrom(transactions: any[], from: Address, to: Address) {
    const bounce = transactions.find(
        (t) =>
            t.inMessage?.info?.type === 'internal' &&
            t.inMessage.info.bounced === true &&
            t.inMessage.info.src?.equals?.(from) &&
            t.inMessage.info.dest?.equals?.(to)
    );
    expect(bounce).toBeDefined();
}

function sendMarkOffHead(
    ledger: SandboxContract<PrimesLedger>,
    marketStub: SandboxContract<TreasuryContract>,
    n: bigint
) {
    return marketStub.send({
        to: ledger.address,
        value: toNano('0.1'),
        bounce: true,
        body: beginCell().storeUint(LedgerOpcodes.MarkOffHead, 32).storeUint(0, 64).storeUint(n, 256).endCell(),
    });
}

function sendMintWonLot(
    ledger: SandboxContract<PrimesLedger>,
    marketStub: SandboxContract<TreasuryContract>,
    opts: {
        n: bigint;
        beneficiary: Address;
        referralKey: number;
        kind: number;
        factors: FactorEntry[];
        value: bigint;
    }
) {
    return marketStub.send({
        to: ledger.address,
        value: opts.value,
        bounce: true,
        body: beginCell()
            .storeUint(LedgerOpcodes.MintWonLot, 32)
            .storeUint(0, 64)
            .storeUint(opts.n, 256)
            .storeAddress(opts.beneficiary)
            .storeUint(opts.referralKey, 32)
            .storeUint(opts.kind, 1)
            .storeDict(encodeFactors(opts.factors))
            .endCell(),
    });
}

// ---------------------------------------------------------------------------
// The market's two settle-bounce arms (primes_market.tolk onBouncedMessage,
// 0xb0000020 mint_won_lot and 0xb0000024 settle_prime_clearing), run against the
// REAL ledger refusing. `PrimesMarket.spec.ts` V9 explains why a wired stack has no
// natural refusal on this hop; so the close runs one transaction at a time
// (`sendMessageIter`, its own queue), the market's real settle message is taken
// off it, and delivered to the real ledger 1 nanoGRAM under MINT_PRICE — the
// ledger's own `insufficient_value` (103) refuses it, TVM builds the rich bounce
// from the market's own RichBounce flags, and the market's real handler runs.
// ---------------------------------------------------------------------------
describe('market settle bounce: a ledger refusal of the lot mint refunds the winner, bid and premium', () => {
    const MINT_PRICE = toNano('1');
    const RES_GAS = toNano('0.07'); // primes_market.tolk RES_GAS (D-113)
    const CLOSE_LOT_GAS = toNano('0.3');

    async function closeWithRefusedSettle(s: Stack, winner: SandboxContract<TreasuryContract>, n: bigint, settleOp: number) {
        const lot = await s.market.getLot(n);
        expect(lot.found).toBe(true);
        expect(lot.highBidder.equals(winner.address)).toBe(true);
        const premium = lot.highBid - MINT_PRICE - RES_GAS;
        s.blockchain.now = lot.closesAt + 1;

        const it = await s.blockchain.sendMessageIter(
            sandboxInternal({ from: winner.address, to: s.market.address, value: CLOSE_LOT_GAS, body: buildCloseLotMessage({ n }).body }),
            { allowParallel: true }, // its own queue: abandoning it drops the settle we re-deliver below
        );
        const close = (await it.next()).value as any;
        expect(close.inMessage.info.dest.equals(s.market.address)).toBe(true);
        expect(close.description.aborted).toBe(false);
        const settle = [...close.outMessages.values()].find(
            (m: any) => m.info.type === 'internal' && m.info.dest.equals(s.ledger.address),
        ) as any;
        expect(settle).toBeDefined();
        expect(settle.body.beginParse().preloadUint(32)).toBe(settleOp);
        expect(settle.info.bounce).toBe(true);

        const solvencyBefore = await s.market.getSolvency();
        const r = await s.blockchain.sendMessage({ ...settle, info: { ...settle.info, value: { coins: MINT_PRICE - 1n } } });

        expect(r.transactions).toHaveTransaction({ from: s.market.address, to: s.ledger.address, success: false, exitCode: 103 });
        const bounce = r.transactions.find(
            (t: any) => t.inMessage?.info?.type === 'internal' && t.inMessage.info.bounced && t.inMessage.info.dest.equals(s.market.address),
        ) as any;
        expect(bounce).toBeDefined();
        expect(bounce.description.aborted).toBe(false);
        const owed = bounce.inMessage.info.value.coins + (premium > 0n ? premium : 0n);
        // mode 0: the forward fee comes out of the refund's own value
        expect(r.transactions).toHaveTransaction({
            from: s.market.address, to: winner.address, success: true,
            value: (v?: bigint) => v !== undefined && v <= owed && v > owed - toNano('0.01'),
        });
        // the ledger's refusal is the only red transaction
        const red = r.transactions.filter((t: any) => t.description.aborted).map((t: any) => t.inMessage.info.dest.toString());
        expect(red).toEqual([s.ledger.address.toString()]);

        // Nothing minted; the market no longer counts the lot's money as owed.
        const item = await s.blockchain.getContract(await s.ledger.getItemAddress(n));
        expect(item.accountState?.type).not.toBe('active');
        const solvencyAfter = await s.market.getSolvency();
        expect(solvencyAfter.liability).toBeLessThan(solvencyBefore.liability);
        expect(solvencyAfter.delta).toBeGreaterThanOrEqual(0n);
        return { premium, owed };
    }

    it('composite lane (mint_won_lot): the winner gets the returned leg plus the premium', async () => {
        const s = await deployStack();
        const winner = await s.blockchain.treasury('winner');
        const win = await winLot({ blockchain: s.blockchain, market: s.market }, winner, RESERVABLE_12, { openOnly: true });
        expect(win.premium).toBeGreaterThan(0n);
        const { premium } = await closeWithRefusedSettle(s, winner, RESERVABLE_12.n, 0xb0000020);
        expect(premium).toBe(win.premium);
    });

    it('prime lane (settle_prime_clearing): the winner gets the returned leg plus the premium', async () => {
        const s = await deployStack();
        const winner = await s.blockchain.treasury('winner');
        const p = 7n;
        expect(await s.market.getHeadHint()).toBeLessThan(p); // ahead of the head: the ascending lane
        const { p0 } = await s.market.getLotPrice(p);
        const open = await s.market.sendOpenLot(winner.getSender(), {
            n: p, kind: 1, factors: [], beneficiary: null, referralKey: 0, value: p0 + toNano('0.1'),
        });
        expect(open.transactions).not.toHaveTransaction({ aborted: true });
        await closeWithRefusedSettle(s, winner, p, 0xb0000024);
    });
});
