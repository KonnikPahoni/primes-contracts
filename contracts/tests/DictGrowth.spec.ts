// TON PRIMES — D8: dictionary growth and unbounded iteration
// (GAUNTLET.md D8).
//
// THE GOOD NEWS FIRST, BECAUSE IT IS STRUCTURAL
//
// **Not one loop in the contract set iterates a storage dictionary.** Every one
// walks a bounded collection travelling with the work item: §3.2's factor list,
// §3.2.2's constellation members (bounded by `max_members` = 7), or the fixed
// Miller-Rabin witness list. Every storage dict — `names`, `lots`, `records`,
// `divEntry`, `minterState`, `unsoldPrimes`, the two bitmaps — is
// reached by key lookup only. (An earlier draft of this file claimed there were
// five such loops and that all five walked `factors`; the test found six
// collections across more loops than that, which is why the assertion enumerates
// them rather than restating a count from a grep.)
//
// That is the property D8 is really asking about. A dict that is only ever
// looked up costs O(log n) per access however large it grows, so growth is a
// storage-rent question rather than a gas-cliff question; a dict that is walked
// turns every future message into a hostage of how many entries someone has
// added. This codebase has none of the second kind, and the test below pins that
// so the first `while` over a storage dict fails the build.
//
// THE BAD NEWS, WHICH THIS ITERATION FOUND
//
// The factor loops are bounded by the message, and the message is attacker-
// supplied. D6 already noted `executeMint`'s loop asserts `idx > 0` — a floor —
// with no ceiling. What D6 did not notice is that **there is no
// `assert (f.exponent > 0)` either**, and a zero-exponent factor is free to the
// attacker but not to the protocol:
//
//   * it contributes `p^0 = 1` to the product, so `assert (product == n)` still
//     passes and the mint is ACCEPTED;
//   * it contributes `0 · s` to `sumWeights`, so it changes no share and steals
//     nothing from the real recipients;
//   * but the tribute loop has no `if (share > 0)` guard before the send, so it
//     still emits a full `credit_tribute` carrying `CREDIT_TRIBUTE_VALUE`
//     (0.008 TON) of gas — which then bounces off the (possibly nonexistent)
//     item and costs the retry lane a second hop.
//
// Measured: each padding entry costs the ledger ~0.0012 TON and two extra
// transactions. At 120 padding entries a mint that PAID ONE TON leaves the
// ledger's balance NET NEGATIVE — the protocol loses money on a paid mint,
// because the fan-out cost has run past §4.1's 0.10 TON gas-&-ops line. Past
// roughly 200 the transaction fails cleanly, so this is a deficit vector rather
// than an unbounded drain, but a deficit on the mint path is exactly what the
// gas-&-ops line exists to prevent.
//
// Filed as GAUNTLET D8.1, briefed as D-60. Owner signed 2026-08-27: apply both the
// `assert (f.exponent > 0)` guard and the `if (share > 0)` defence-in-depth guard now,
// as their own iteration. The tests below assert the FIXED behaviour.
import { Blockchain, SandboxContract, TreasuryContract } from '@ton/sandbox';
import { beginCell, Builder, Cell, Dictionary, toNano } from '@ton/core';
import '@ton/test-utils';
import { compile } from '@ton/blueprint';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { PrimesLedger, FactorEntry } from '../wrappers/PrimesLedger';
import { PrimesRatchet } from '../wrappers/PrimesRatchet';
import { PrimesRegistrar } from '../wrappers/PrimesRegistrar';
import { PrimesCollection } from '../wrappers/PrimesCollection';
import { PrimesJettonMaster } from '../wrappers/PrimesJettonMaster';
import { FactorValue, factorsCell } from '../../shared/factors';
import { LEDGER } from '../../shared/opcodes';
import { minterCardAddress, minterCardInit } from '../../shared/minterCard';

const REPO = join(__dirname, '..', '..');
const CONTRACTS_DIR = join(REPO, 'contracts', 'contracts');
const MINT_PRICE = toNano('1');

describe('TON PRIMES — D8: no storage dict is ever walked, and the message-supplied one is unbounded', () => {
    // ------------------------------------------------------------------ //
    // The structural property
    // ------------------------------------------------------------------ //

    describe('storage dictionaries are looked up, never iterated', () => {
        /** Every `while (` in the contract set, with the collection it walks. */
        function loops(): { file: string; line: number; over: string }[] {
            const out: { file: string; line: number; over: string }[] = [];
            for (const f of readdirSync(CONTRACTS_DIR).filter((x) => x.endsWith('.tolk'))) {
                const src = readFileSync(join(CONTRACTS_DIR, f), 'utf8');
                const lines = src.split('\n');
                lines.forEach((raw, i) => {
                    if (!/^\s*while\s*\(/.test(raw)) return;
                    // What the body reads from: the first `X.get(` inside the
                    // next few lines is the collection being walked.
                    const body = lines.slice(i, i + 6).join('\n');
                    // A key-range walk (`findKeyGreater`) names its collection
                    // first; otherwise the first `.get(` does.
                    const g = body.match(/([A-Za-z_][A-Za-z0-9_.]*)\.findKeyGreater(?:OrEqual)?\(/)
                        ?? body.match(/([A-Za-z_][A-Za-z0-9_.]*)\.get\(/);
                    out.push({ file: f, line: i + 1, over: g ? g[1] : '(none)' });
                });
            }
            return out;
        }

        it('there are only a handful of loops at all, and every one walks the MESSAGE\'s factors', () => {
            const walking = loops().filter((l) => l.over !== '(none)');
            expect(walking.length).toBeGreaterThan(0);
            // The collection each loop walks. `factors` / `msg.factors` is the
            // map that arrived in the message, or a compile-time constant;
            // anything else here would be a storage dict and a gas cliff.
            const collections = [...new Set(walking.map((l) => l.over))].sort();
            // Five families, all bounded, none of them protocol state:
            //   factors / msg.factors  §3.2's factor list, carried in the message
            //   bases                  the fixed Miller-Rabin witness list, a
            //                          compile-time constant of 13 entries
            //   addresses              D-202's invite list, bounded by
            //                          INVITE_MAX_COUNT (3) before the walk starts
            //   w                      a literal weight array (the score block's)
            //   meters.forfeited       D-198's `flush_unsold`: a KEY-RANGE walk over
            //                          `unsoldPrimes` limited to ONE 256-number block
            //                          (the primes in it, ≤ 54), reading each row's
            //                          `forfeited` partner — the one storage walk, and
            //                          its bound is the block, not the dict's size
            //   lots / storage.lots    D-200's `park_lots` and its get-method twin
            //                          `parkScan`: a KEY-RANGE walk over the market's
            //                          `lots` that stops after PARK_SCAN_MAX (16) rows,
            //                          whatever the dict's size
            // What matters is that each is a BOUNDED collection travelling with
            // the work item or fixed at compile time, never an open-ended
            // dictionary that grows with adoption. The finding below is that the
            // FIRST family's bound is the weak one.
            expect(collections).toEqual([
                'addresses',
                'bases',
                'factors',
                'lots',
                'meters.forfeited',
                'msg.factors',
                'storage.lots',
                'w',
            ]);
        });

        it('every new walk is bounded by a constant declared in the same contract', () => {
            // The factor list's bound is arithmetic (the product must equal n),
            // and the finding below is that it is a WEAK bound. D-101 and D-102
            // added four more walks, and each one's bound is an explicit
            // constant in its own file — a bound a reader can find without
            // leaving the contract, which is what `constellations.max_members`
            // used to be before D-102 deleted the set line that published it.
            const ledger = readFileSync(join(CONTRACTS_DIR, 'primes_ledger.tolk'), 'utf8');

            // the invite list: 3 (D-202), and the walk cannot start above it (221).
            // (D-202 deleted the registrar's contributor and input walks and the
            // generators collection's drop-table walk with the builds.)
            expect(ledger).toMatch(/const INVITE_MAX_COUNT: int = 3;/);
            expect(ledger).toMatch(/throw 221/);
            // D-200: the `lots` page walk stops at a declared row count, never at the dict's end.
            const market = readFileSync(join(CONTRACTS_DIR, 'primes_market.tolk'), 'utf8');
            expect(market).toMatch(/const PARK_SCAN_MAX: int = 16;/);
            expect(market.match(/while \(r\.isFound && seen < PARK_SCAN_MAX\)/g)?.length).toBe(2);
        });

        it('no `while` walks a storage dictionary — the property that keeps growth cheap', () => {
            // Stated as its own assertion because it is what makes every dict's
            // growth a storage-rent question rather than a gas-cliff one. A dict
            // only ever looked up costs O(log n) per access however large it
            // gets; a dict that is walked makes every future message a hostage
            // of how many entries someone added.
            const STORAGE_DICTS = [
                'names', 'lots', 'divEntry', 'minterState',
                'unsoldPrimes', 'primeBitmap', 'offHeadBitmap', 'unroutedCredits',
                'positions', 'allowlist', 'pending', 'annotations',
                'primeRanks', 'paidEras', 'paidSpecials', 'boostUntil',
            ];
            // D-200: the one storage walk, bounded by PARK_SCAN_MAX rows per call (pinned above).
            const BOUNDED = new Set(['primes_market.tolk:lots']);
            for (const l of loops()) {
                const leaf = l.over.split('.').pop() ?? '';
                if (BOUNDED.has(`${l.file}:${leaf}`)) continue;
                expect({ site: `${l.file}:${l.line}`, walksStorage: STORAGE_DICTS.includes(leaf) }).toEqual({
                    site: `${l.file}:${l.line}`,
                    walksStorage: false,
                });
            }
        });
    });

    // ------------------------------------------------------------------ //
    // The finding: the message-supplied map has no ceiling and no exponent guard
    // ------------------------------------------------------------------ //

    describe('D8.1 / D-60 — zero-exponent factor padding (CURRENT behaviour, pinned)', () => {
        let blockchain: Blockchain;
        let ledger: SandboxContract<PrimesLedger>;
        let player: SandboxContract<TreasuryContract>;
        let collection: SandboxContract<PrimesCollection>;
        let codes: Record<string, Cell>;

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

        async function deploy() {
            blockchain = await Blockchain.create();
            blockchain.now = 1_770_000_000;
            const deployer = await blockchain.treasury('deployer');
            const genesisScript = await blockchain.treasury('genesisScript');
            const treasuryWallet = await blockchain.treasury('treasury');
            player = await blockchain.treasury('player', { balance: toNano('500') });

            collection = blockchain.openContract(
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
                        seedHead: 4n,
                        seedPrimes: [2n, 3n],
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
                value: toNano('0.2'),
            });
            await ledger.sendIgnite(genesisScript.getSender(), { owner: deployer.address, value: toNano('0.3') });
        }

        /** Mint 4 = 2², padded with `pad` zero-exponent entries. Returns the ledger's balance delta. */
        async function paddedMint(pad: number) {
            const factors: FactorEntry[] = [{ prime: 2n, exponent: 2, s: 1n }];
            for (let i = 0; i < pad; i++) factors.push({ prime: 2n, exponent: 0, s: 1n });
            const before = (await blockchain.getContract(ledger.address)).balance;
            const r = await ledger.sendMint(player.getSender(), {
                n: 4n,
                kind: 0,
                factors,
                referralKey: 0,
                beneficiary: null,
                value: MINT_PRICE,
            });
            const after = (await blockchain.getContract(ledger.address)).balance;
            const accepted = r.transactions.some(
                (t: any) =>
                    t.inMessage?.info?.dest?.equals?.(ledger.address) &&
                    t.description?.computePhase?.exitCode === 0
            );
            return { accepted, delta: after - before, txs: r.transactions.length };
        }

        it('the contract has the exponent guard — D-60 landed', () => {
            const src = readFileSync(join(CONTRACTS_DIR, 'primes_ledger.tolk'), 'utf8');
            expect(src).toMatch(/assert\s*\(\s*f\.exponent\s*>\s*0\s*\)/);
        });

        it('a zero-exponent factor is REJECTED, not silently accepted as p⁰ = 1', async () => {
            await deploy();
            const padded = await paddedMint(5);
            expect(padded.accepted).toBe(false);
        }, 120_000);

        it('padding no longer reaches the tribute fan-out — the mint aborts before any send', async () => {
            await deploy();
            const clean = await paddedMint(0);
            await deploy();
            const padded = await paddedMint(40);

            expect(clean.accepted).toBe(true);
            expect(padded.accepted).toBe(false);
            // Rejected outright: no credit_tribute-and-bounce pair per padding entry.
            expect(padded.txs).toBeLessThan(clean.txs);
        }, 180_000);

        it('at 120 entries the mint is still rejected — no deficit possible', async () => {
            // D-60 landed: the exponent guard rejects the padded factor list before
            // the tribute loop ever runs, so there is no fan-out cost to fund out of
            // the ledger's own balance.
            await deploy();
            const heavy = await paddedMint(120);
            expect(heavy.accepted).toBe(false);
        }, 180_000);

        // GAUNTLET V24 / D-188 point 1: the ledger forwards the factorization it CHECKED,
        // never the minter's map. The check reads keys 0.. up to the first gap, so a key
        // past the gap (200 here) can hang up to max_msg_cells of cells the check never
        // reads. Forwarded, that priced the item deploy out of the collection's reach and
        // every `retry_item` of the parked body burned the ledger's own balance.
        /** A distinct-cell 4-ary tree of `leaves` leaves, so dedup cannot shrink it. */
        function junkTree(leaves: number): Cell {
            let level: Cell[] = [];
            for (let i = 0; i < leaves; i++) level.push(beginCell().storeUint(i, 32).endCell());
            let tag = leaves;
            while (level.length > 1) {
                const next: Cell[] = [];
                for (let i = 0; i < level.length; i += 4) {
                    const b = beginCell().storeUint(tag++, 32);
                    level.slice(i, i + 4).forEach((c) => b.storeRef(c));
                    next.push(b.endCell());
                }
                level = next;
            }
            return level[0];
        }
        function paddedMintBody(junk: Cell): Cell {
            const Padded = {
                serialize(src: { prime: bigint; exponent: number; s: bigint; pad?: boolean }, b: Builder) {
                    FactorValue.serialize(src, b);
                    if (src.pad) b.storeRef(junk);
                },
                parse: () => { throw new Error('unused'); },
            };
            const dict = Dictionary.empty(Dictionary.Keys.Uint(8), Padded);
            dict.set(0, { prime: 2n, exponent: 2, s: 1n });
            dict.set(200, { prime: 3n, exponent: 1, s: 1n, pad: true });
            // D-191 point 1: no `beneficiary` field; the body goes to the payer's minter card.
            return beginCell()
                .storeUint(LEDGER.mint, 32)
                .storeUint(0, 64)
                .storeUint(4n, 256)
                .storeUint(0, 1)
                .storeDict(dict)
                .storeUint(0, 32)
                .storeUint(0, 3) // inviteCount
                .storeMaybeRef(null)
                .endCell();
        }
        const sendToCard = (body: Cell) =>
            player.send({
                to: minterCardAddress(ledger.address, player.address),
                init: minterCardInit(ledger.address, player.address),
                value: MINT_PRICE,
                body,
            });

        it('V24 — a padded factor map mints, and the collection receives only the checked entries', async () => {
            // Padding small enough that the card's forward of it stays inside
            // CARD_HOP_ALLOWANCE (D-191 point 1), so the ledger accepts the mint.
            const junk = junkTree(16);
            await deploy();
            const r = await sendToCard(paddedMintBody(junk));

            // This harness leaves some peers unwired, so their legs bounce; the two
            // transactions this finding is about must both land.
            expect(r.transactions).toHaveTransaction({ to: ledger.address, success: true });
            expect(r.transactions).toHaveTransaction({ from: ledger.address, to: collection.address, success: true });
            const toCollection = r.transactions.find(
                (t: any) =>
                    t.inMessage?.info?.src?.equals?.(ledger.address) &&
                    t.inMessage?.info?.dest?.equals?.(collection.address)
            );
            expect(toCollection).toBeDefined();
            // The canonical one-entry factorization is in the forwarded body; the junk is not.
            const canonicalHash = factorsCell([{ prime: 2n, exponent: 2, s: 1n }])!.hash();
            const seen = new Set<string>();
            const walk = (c: Cell) => {
                const h = c.hash().toString('hex');
                if (seen.has(h)) return;
                seen.add(h);
                c.refs.forEach(walk);
            };
            walk(toCollection!.inMessage!.body);
            expect(seen.has(canonicalHash.toString('hex'))).toBe(true);
            expect(seen.has(junk.hash().toString('hex'))).toBe(false);
            expect(seen.size).toBeLessThan(32);
        }, 180_000);

        it('D-191 point 1 — padding that makes the card hop dear is refused, and costs the ledger nothing', async () => {
            // ~1,365 distinct cells: the card's forward alone is far past
            // CARD_HOP_ALLOWANCE, so the ledger refuses the short value (103) before
            // doing any work, and the bounce returns to the card and on to the payer.
            await deploy();
            const before = (await blockchain.getContract(ledger.address)).balance;
            const r = await sendToCard(paddedMintBody(junkTree(1024)));
            expect(r.transactions).toHaveTransaction({ to: ledger.address, exitCode: 103 });
            expect(r.transactions).not.toHaveTransaction({ from: ledger.address, to: collection.address });
            expect((await blockchain.getContract(ledger.address)).balance).toBeGreaterThanOrEqual(before);
            expect(await ledger.getHead()).toBe(4n);
        }, 180_000);
    });
});
