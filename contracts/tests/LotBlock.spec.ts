// TON PRIMES — D-196: far-ahead lot marks live on per-block child contracts.
//
// THE BUG THIS PINS (external review item 5, GAUNTLET V30). A lot may open on any
// number ahead of the head (§4.4), and its mark is permanent (D-45). The mark was a
// bit in a 256-bit word per 256-number block on the LEDGER (`offHeadBitmap`, and
// `primeBitmap` for a prime sold ahead) and on the MARKET (`sold`). Behind the head
// those maps grow with the head; ahead of it the OPENER picked the block, so ~2
// cells per isolated far lot and ~30,000 lots reached config 43's 65,536-cell
// account cap — after which every storage-growing ledger transaction failed.
//
// THE FIX. The ledger keeps words only for blocks below its import frontier; a mark
// beyond it lives on that block's `primes_lot_block.tolk` until the permissionless
// `import_lot_block` pulls it in, and the head-advance walk stops at the frontier
// until it has. The market keeps a sold bit only behind its `headHint`; a second
// lot on a claimed number is refused by the ledger (or the lot block) instead.
import { Blockchain, SandboxContract, TreasuryContract, internal, createShardAccount, createEmptyShardAccount } from '@ton/sandbox';
import { Address, Cell, beginCell, contractAddress, toNano } from '@ton/core';
import '@ton/test-utils';
import { compile } from '@ton/blueprint';
import { PrimesRatchet } from '../wrappers/PrimesRatchet';
import { PrimesRegistrar } from '../wrappers/PrimesRegistrar';
import { PrimesLedger, FactorEntry } from '../wrappers/PrimesLedger';
import { PrimesCollection } from '../wrappers/PrimesCollection';
import { PrimesJettonMaster } from '../wrappers/PrimesJettonMaster';
import { PrimesMarket } from '../wrappers/PrimesMarket';
import { PrimesLotBlock } from '../wrappers/PrimesLotBlock';
import { PrimesItem } from '../wrappers/PrimesItem';
import { testMarketConfig, OPENING_HEAD, CLOSE_LOT_GAS, acquirePrimeAhead, acquirePrime } from './helpers/market';
import { lotBlockAddress, lotBlockCode, lotBlockData } from '../../shared/lotBlock';
import { ERRORS, LEDGER } from '../../shared/opcodes';

const MINT_PRICE = toNano('1');
const IMPORT_VALUE = toNano('0.05');
/** `LOT_BLOCK_WINDOW_BLOCKS` in primes_ledger.tolk (params.json off_head.import_window). */
const WINDOW_BLOCKS = 26n;
/** The ledger's bitmap chunk: n sits in block (n - 2) >> 8, at bit (n - 2) & 255. */
const blockOf = (n: bigint) => (n - 2n) >> 8n;
const bitOf = (n: bigint) => (n - 2n) & 255n;
const firstOf = (block: bigint) => block * 256n + 2n;

function isPrime(n: bigint): boolean {
    if (n < 2n) return false;
    for (let d = 2n; d * d <= n; d++) if (n % d === 0n) return false;
    return true;
}

const isqrt = (p: bigint): bigint => BigInt(Math.floor(Math.sqrt(Number(p))));

/** Trial division — test numbers stay below ~1e7. */
function factorize(n: bigint): FactorEntry[] {
    const out: FactorEntry[] = [];
    let m = n;
    for (let p = 2n; p * p <= m; p++) {
        let e = 0;
        while (m % p === 0n) { m /= p; e++; }
        if (e > 0) out.push({ prime: p, exponent: e, s: isqrt(p) });
    }
    if (m > 1n) out.push({ prime: m, exponent: 1, s: isqrt(m) });
    return out;
}

function nextPrime(from: bigint): bigint {
    let p = from;
    while (!isPrime(p)) p++;
    return p;
}

/** The first composite at or after `from` that is not a primorial. */
function compositeFrom(from: bigint): bigint {
    let n = from;
    while (isPrime(n)) n++;
    return n;
}

async function dataCells(bc: Blockchain, addr: Address): Promise<number> {
    const acc = (await bc.getContract(addr)).account.account!;
    const st = acc.storage.state;
    if (st.type !== 'active') throw new Error('not active');
    const seen = new Set<string>();
    const walk = (c: Cell) => {
        const h = c.hash().toString('hex');
        if (seen.has(h)) return;
        seen.add(h);
        c.refs.forEach(walk);
    };
    walk(st.state.data!);
    return seen.size;
}

async function isActive(bc: Blockchain, addr: Address): Promise<boolean> {
    return (await bc.getContract(addr)).accountState?.type === 'active';
}

describe('D-196: far-ahead lot marks live on lot blocks', () => {
    let codes: Record<string, Cell>;
    let blockchain: Blockchain;
    let deployer: SandboxContract<TreasuryContract>;
    let genesisScript: SandboxContract<TreasuryContract>;
    let opener: SandboxContract<TreasuryContract>;
    let keeper: SandboxContract<TreasuryContract>;
    let ledger: SandboxContract<PrimesLedger>;
    let market: SandboxContract<PrimesMarket>;
    let collection: SandboxContract<PrimesCollection>;

    beforeAll(async () => {
        codes = {
            item: await compile('PrimesItem'),
            collection: await compile('PrimesCollection'),
            jettonWallet: await compile('PrimesJettonWallet'),
            jettonMaster: await compile('PrimesJettonMaster'),
            ledger: await compile('PrimesLedger'),
            ratchet: await compile('PrimesRatchet'),
            registrar: await compile('PrimesRegistrar'),
            market: await compile('PrimesMarket'),
            lotBlock: await compile('PrimesLotBlock'),
        };
    });

    /**
     * A full stack with a real market. `seed` parks the head (test-only init data,
     * as HeadWalk.spec.ts does); by default the head opens at 4 as genesis does.
     */
    async function deploy(seed?: {
        head: bigint; primes: bigint[]; imported: bigint; flushed?: bigint;
        unsold?: { p: bigint; entry: bigint; forfeited: bigint }[];
    }) {
        blockchain = await Blockchain.create();
        blockchain.now = 1_770_000_000;
        deployer = await blockchain.treasury('deployer');
        genesisScript = await blockchain.treasury('genesisScript');
        opener = await blockchain.treasury('opener', { balance: toNano('100000') });
        keeper = await blockchain.treasury('keeper', { balance: toNano('100') });
        const treasuryWallet = await blockchain.treasury('treasury');
        const bountyVault = await blockchain.treasury('bountyVault');

        collection = blockchain.openContract(
            PrimesCollection.createFromConfig(
                { nextIndex: 2n, itemCode: codes.item, ledgerAddr: deployer.address, genesisScriptAddr: genesisScript.address },
                codes.collection
            )
        );
        await collection.sendDeploy(deployer.getSender(), toNano('5'));
        const master = blockchain.openContract(
            PrimesJettonMaster.createFromConfig(
                { ledgerAddr: deployer.address, genesisScriptAddr: genesisScript.address, walletCode: codes.jettonWallet },
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
                    seedHead: seed?.head,
                    seedPrimes: seed?.primes,
                    seedLotBlocksImported: seed?.imported,
                    seedUnsoldFlushed: seed?.flushed,
                    seedUnsold: seed?.unsold,
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
        const head = seed?.head ?? OPENING_HEAD;
        market = blockchain.openContract(
            PrimesMarket.createFromConfig(
                testMarketConfig({ headHint: head, ledgerAddr: ledger.address, ratchetAddr: ratchet.address }),
                codes.market
            )
        );
        await market.sendDeploy(deployer.getSender(), toNano('5'));
        await collection.sendSetLedger(genesisScript.getSender(), { ledgerAddr: ledger.address, value: toNano('0.05') });
        await master.sendSetLedger(genesisScript.getSender(), { ledgerAddr: ledger.address, value: toNano('0.05') });
        await master.sendSealAuthority(genesisScript.getSender(), { value: toNano('0.05') });
        await ledger.sendGenesisSeed(genesisScript.getSender(), {
            seedT: toNano('1000'),
            seedS: 1_200_000_000_000_000n,
            seedHead: head,
            value: toNano('0.2'),
        });
        await ledger.sendSetPeers(genesisScript.getSender(), {
            marketAddr: market.address,
            bountyVaultAddr: bountyVault.address,
            value: toNano('0.05'),
        });
        await ledger.sendIgnite(genesisScript.getSender(), { owner: deployer.address, value: toNano('0.3') });
    }

    async function openFar(n: bigint) {
        const factors = factorize(n);
        const quote = await market.getLotPriceFrom(n, factors);
        return market.sendOpenLot(opener.getSender(), {
            n,
            kind: 0,
            factors,
            beneficiary: null,
            referralKey: 0,
            value: quote.p0 + toNano('0.1'),
        });
    }

    async function closeLot(n: bigint) {
        const lot = await market.getLot(n);
        if (lot.closesAt > 0 && (blockchain.now ?? 0) <= lot.closesAt) blockchain.now = lot.closesAt + 1;
        return market.sendClose(keeper.getSender(), { n, value: CLOSE_LOT_GAS });
    }

    const lotBlockOf = (n: bigint) =>
        blockchain.openContract(PrimesLotBlock.createFromAddress(lotBlockAddress(ledger.address, blockOf(n))));

    it('the shared code is what primes_lot_block.tolk compiles to, and both derivations agree', async () => {
        expect(lotBlockCode().hash().toString('hex')).toBe(codes.lotBlock.hash().toString('hex'));
        await deploy();
        for (const b of [0n, 16n, 1_234_567n]) {
            expect((await ledger.getLotBlockAddress(b)).equals(lotBlockAddress(ledger.address, b))).toBe(true);
        }
        const st = await ledger.getLotBlockState();
        expect(st.windowBlocks).toBe(Number(WINDOW_BLOCKS));
        expect(st.frontierBlock).toBe(WINDOW_BLOCKS);
        expect(st.importingBlock).toBe(0n);
    });

    it('a far lot is claimed on its lot block, and the ledger does not grow', async () => {
        await deploy();
        const n = compositeFrom(1_000_000n);
        const ledgerCells = await dataCells(blockchain, ledger.address);
        const r = await openFar(n);
        expect(r.transactions).not.toHaveTransaction({ aborted: true });
        expect(r.transactions).toHaveTransaction({ from: ledger.address, to: lotBlockOf(n).address, deploy: true, success: true });
        expect(await dataCells(blockchain, ledger.address)).toBe(ledgerCells);
        expect(await ledger.isNumberOffHead(n)).toBe(-1);
        expect(await ledger.isNumberOffHeadResolved(n)).toBe(true);
        const words = await lotBlockOf(n).getWords();
        expect((words.claimed >> bitOf(n)) & 1n).toBe(1n);
        expect((await lotBlockOf(n).getLotBlockOwner()).block).toBe(blockOf(n));
        expect((await market.getLot(n)).found).toBe(true);
    });

    it('far lots in many blocks, opened and won, leave the ledger and the market as they were', async () => {
        await deploy();
        // Warm-up: the first far close creates the rows every later one reuses
        // (prime 2's forfeit row — 2 is unsold at genesis, and every lot below cites it).
        const warm = 2n * nextPrime(400_000n);
        await openFar(warm);
        await closeLot(warm);

        const ledgerBefore = await dataCells(blockchain, ledger.address);
        const marketBefore = await dataCells(blockchain, market.address);
        const LOTS = 60n;
        const opened: bigint[] = [];
        for (let i = 0n; i < LOTS; i++) {
            // One lot per block, blocks far apart: the worst case for a per-block word.
            // n = 2q, q a prime far beyond the frontier: 2 reuses its row, q is summed.
            const n = 2n * nextPrime(500_000n + i * 3_001n);
            const r = await openFar(n);
            expect(r.transactions).not.toHaveTransaction({ aborted: true });
            opened.push(n);
        }
        for (const n of opened) {
            const r = await closeLot(n);
            // q has no item, so its tribute credit bounces off the empty address —
            // that bounce IS the forfeit (D-196). The ledger and market stay green.
            expect(r.transactions).not.toHaveTransaction({ on: ledger.address, aborted: true });
            expect(r.transactions).not.toHaveTransaction({ on: market.address, aborted: true });
            expect((await market.getLot(n)).found).toBe(false); // settled: the row is gone
        }
        expect(await dataCells(blockchain, ledger.address)).toBe(ledgerBefore);
        expect(await dataCells(blockchain, market.address)).toBe(marketBefore);
        // The forfeit those far factors owed was paid and summed, not kept per prime.
        expect(await ledger.getForfeitedBeyondWindow()).toBeGreaterThan(0n);
    });

    it('a squatted empty item cannot catch a far factor forfeit', async () => {
        await deploy();
        const warm = 2n * nextPrime(400_000n);
        await openFar(warm);
        await closeLot(warm);

        // The attacker deploys item(q)'s canonical empty state — the collection's
        // `buildItemInitData`, byte for byte — with no Populate. Anyone can.
        const q = nextPrime(500_000n);
        const mutable = beginCell()
            .storeUint(0, 8) // populated
            .storeAddress(collection.address) // owner placeholder
            .storeUint(0, 8) // isPrime
            .storeRef(beginCell().endCell()) // factorization
            .storeUint(0, 16) // rarityFlags
            .storeCoins(0) // owed
            .storeUint(0, 24) // mintedDay
            .storeCoins(0) // tributeTotal
            .storeCoins(0) // referralPaidTotal
            .storeCoins(0) // divEntry
            .storeCoins(0) // forfeitedTotal
            .storeMaybeRef(null) // naming
            .endCell();
        const data = beginCell()
            .storeUint(q, 256)
            .storeAddress(collection.address)
            .storeAddress(ledger.address)
            .storeRef(mutable)
            .endCell();
        const init = { code: codes.item, data };
        const itemAddr = contractAddress(0, init);
        expect(itemAddr.equals(await ledger.getItemAddress(q))).toBe(true);
        const squat = await opener.send({ to: itemAddr, value: toNano('0.02'), init, body: beginCell().endCell() });
        expect(squat.transactions).toHaveTransaction({ to: itemAddr, success: true, deploy: true });

        const before = await ledger.getForfeitedBeyondWindow();
        const n = 2n * q;
        await openFar(n);
        const r = await closeLot(n);
        // The empty item refuses the credit (307); the bounce forfeits it (§6 point 2).
        expect(r.transactions).toHaveTransaction({
            from: ledger.address,
            to: itemAddr,
            success: false,
            exitCode: ERRORS.item_not_populated,
        });
        expect(r.transactions).not.toHaveTransaction({ on: ledger.address, aborted: true });
        expect(await blockchain.openContract(PrimesItem.createFromAddress(itemAddr)).getOwed()).toBe(0n);
        expect(await ledger.getForfeitedBeyondWindow()).toBeGreaterThan(before);
    });

    it('re-opening a sold far prime near AUCTIONABLE_MAX costs the opener, never the market float', async () => {
        // D-196 sets no sold bit ahead of headHint, so this refusal repeats on every
        // retry; at 0.04 the float lost ~0.02 a round on the heaviest prime open.
        await deploy();
        let p = 42_949_672_959_999n;
        while (!isPrime(p)) p--;
        await acquirePrimeAhead({ blockchain, market }, opener, p);
        const quote = await market.getLotPrice(p);
        const floatBefore = (await blockchain.getContract(market.address)).balance;
        const r = await market.sendOpenLot(opener.getSender(), {
            n: p, kind: 1, factors: [], beneficiary: null, referralKey: 0, value: quote.p0,
        });
        expect(r.transactions).not.toHaveTransaction({ aborted: true });
        expect((await market.getMarketStats()).forceCancels).toBe(1);
        // This prime's open burns ~400k gas; V34 measured ~680k near the cap, and config
        // 21 allows 1,000,000. The float must not lose even had this open burned the
        // ceiling: charge the delta the gas this open did NOT use.
        const open = r.transactions.find(
            (t) => t.inMessage?.info.type === 'internal' && t.inMessage.info.dest.equals(market.address)
                && t.inMessage.info.src.equals(opener.address)
        )!;
        const cp = (open.description as any).computePhase;
        const ceilingFees = (cp.gasFees * 1_000_000n) / cp.gasUsed;
        const delta = (await blockchain.getContract(market.address)).balance - floatBefore;
        expect(delta - (ceilingFees - cp.gasFees)).toBeGreaterThanOrEqual(0n);
    });

    it('a second lot on a claimed far number is refused by its lot block, and refunded', async () => {
        await deploy();
        const n = compositeFrom(2_000_000n);
        await openFar(n);
        await closeLot(n);
        expect((await market.getLot(n)).found).toBe(false); // no row and — ahead of headHint — no sold bit

        const before = await opener.getBalance();
        const r = await openFar(n);
        expect(r.transactions).not.toHaveTransaction({ aborted: true });
        expect(r.transactions).toHaveTransaction({ from: lotBlockOf(n).address, to: ledger.address, success: true });
        expect(r.transactions).toHaveTransaction({ from: ledger.address, to: market.address, success: true });
        // The refusal rides the opener's OPEN_RESERVE_GAS across four hops (market ->
        // ledger -> lot block -> ledger -> market). It must still pay the market's unwind
        // with room to spare, or a duplicate lot would survive to close.
        const relay = r.transactions.find(
            (t) => t.inMessage?.info.type === 'internal' && t.inMessage.info.src.equals(ledger.address)
                && t.inMessage.info.dest.equals(market.address)
        )!;
        const arrived = relay.inMessage!.info.type === 'internal' ? relay.inMessage!.info.value.coins : 0n;
        const used = (relay.description as any).computePhase?.gasFees ?? 0n;
        expect(arrived).toBeGreaterThan(2n * used);
        expect((await market.getLot(n)).found).toBe(false);
        expect((await market.getMarketStats()).forceCancels).toBe(1);
        expect(before - (await opener.getBalance())).toBeLessThan(toNano('0.2'));
    });

    it('import: an untouched block arrives empty; an early import is refused (225)', async () => {
        await deploy();
        expect((await ledger.getLotBlockState()).dueNow).toBe(true); // first(26) = 26·256 + 2 < 4 + 26·256
        const r = await ledger.sendImportLotBlock(keeper.getSender(), { value: IMPORT_VALUE });
        expect(r.transactions).not.toHaveTransaction({ aborted: true });
        const st = await ledger.getLotBlockState();
        expect(st.frontierBlock).toBe(WINDOW_BLOCKS + 1n);
        expect(st.importingBlock).toBe(0n);
        expect(await isActive(blockchain, lotBlockAddress(ledger.address, WINDOW_BLOCKS))).toBe(true); // deployed, words kept
        expect(st.dueNow).toBe(false);
        const early = await ledger.sendImportLotBlock(keeper.getSender(), { value: IMPORT_VALUE });
        expect(early.transactions).toHaveTransaction({
            to: ledger.address,
            success: false,
            exitCode: ERRORS.ledger_lot_block_not_due,
        });
        const short = await ledger.sendImportLotBlock(keeper.getSender(), { value: toNano('0.01') });
        expect(short.transactions).toHaveTransaction({ to: ledger.address, success: false, exitCode: 103 });
    });

    it('import carries a far claim and a far prime sale into the ledger, and the block keeps its words', async () => {
        await deploy();
        const block = WINDOW_BLOCKS; // the first block beyond the frontier
        const n = compositeFrom(firstOf(block) + 10n);
        let p = firstOf(block) + 100n;
        while (!isPrime(p)) p++;

        await openFar(n);
        await acquirePrimeAhead({ blockchain, market }, opener, p); // moves the clock past n's close too
        await closeLot(n);
        const words = await lotBlockOf(n).getWords();
        expect((words.claimed >> bitOf(n)) & 1n).toBe(1n);
        expect((words.claimed >> bitOf(p)) & 1n).toBe(1n); // a prime's lot claims too (D-196)
        expect((words.soldPrime >> bitOf(p)) & 1n).toBe(1n);
        expect(await ledger.isKnownPrime(p)).toBe(0);

        const r = await ledger.sendImportLotBlock(keeper.getSender(), { value: IMPORT_VALUE });
        expect(r.transactions).not.toHaveTransaction({ aborted: true });
        expect(((await lotBlockOf(n).getWords()).claimed >> bitOf(n)) & 1n).toBe(1n);
        expect(await ledger.isNumberOffHead(n)).toBe(1);
        expect(await ledger.isKnownPrime(p)).toBe(1);

        // Now local: a second lot on n is refused by the ledger itself.
        const again = await openFar(n);
        expect(again.transactions).not.toHaveTransaction({ from: ledger.address, to: lotBlockOf(n).address });
        expect(again.transactions).toHaveTransaction({ from: ledger.address, to: market.address, success: true });
        expect((await market.getMarketStats()).forceCancels).toBe(1);
    });

    it('a lost import answer is recovered by re-sending the import — the head never freezes', async () => {
        // The answer is fire-and-forget. A block that deleted itself on answering took
        // its marks with it whenever the ledger failed to process them, and left
        // `importingBlock` set for ever: the walk stops at the frontier, so the head froze.
        await deploy();
        const n = compositeFrom(firstOf(WINDOW_BLOCKS) + 10n);
        await openFar(n);
        const body = beginCell().storeUint(LEDGER.import_lot_block, 32).storeUint(0, 64).endCell();
        const it = await blockchain.sendMessageIter(
            internal({ from: keeper.address, to: ledger.address, value: IMPORT_VALUE, body }),
            { allowParallel: true }, // its own queue: abandoning the iterator drops what is left
        );
        await it.next(); // ledger -> lot block
        await it.next(); // lot block answers; the answer is dropped here, as if the ledger's arm had failed
        expect((await ledger.getLotBlockState()).importingBlock).toBe(WINDOW_BLOCKS);
        expect(await ledger.isNumberOffHead(n)).toBe(-1); // still beyond the frontier

        const retry = await ledger.sendImportLotBlock(keeper.getSender(), { value: IMPORT_VALUE });
        expect(retry.transactions).not.toHaveTransaction({ aborted: true });
        const st = await ledger.getLotBlockState();
        expect(st.importingBlock).toBe(0n);
        expect(st.frontierBlock).toBe(WINDOW_BLOCKS + 1n);
        expect(await ledger.isNumberOffHead(n)).toBe(1);
    });

    it('a prime sold ahead of the head cannot be listed again once the head passes it', async () => {
        await deploy();
        // A prime inside the window, sold ahead, then passed by the head.
        const p = 11n;
        await acquirePrimeAhead({ blockchain, market }, opener, p);
        // Walk the head past 11: mint 4, 6, 8, 9, 10, 12.
        for (const n of [4n, 6n, 8n, 9n, 10n, 12n]) {
            if ((await ledger.getHead()) !== n) continue;
            await ledger.sendMint(opener.getSender(), {
                n, kind: 0, factors: factorize(n), referralKey: 0, beneficiary: null, value: MINT_PRICE,
            });
        }
        expect(await ledger.getHead()).toBeGreaterThan(p);
        await ledger.sendSyncHead(keeper.getSender(), { value: toNano('0.1') });
        expect(await market.getHeadHint()).toBeGreaterThan(p);

        const r = await market.sendOpenHeadLot(keeper.getSender(), { n: p, value: toNano('0.2') });
        expect(r.transactions).not.toHaveTransaction({ aborted: true });
        expect(r.transactions).toHaveTransaction({ from: ledger.address, to: market.address, success: true });
        expect((await market.getLot(p)).found).toBe(true); // the tombstone: sold bit, reads closed
        expect((await market.getLot(p)).closed).toBe(true);
        // And it is tried once: the sold bit refuses a repeat at the market.
        const again = await market.sendOpenHeadLot(keeper.getSender(), { n: p, value: toNano('0.2') });
        expect(again.transactions).toHaveTransaction({ to: market.address, success: false, exitCode: 1002 });

        // LOW-3: the walk parked its stamp (no send on the mint path); `getNextSoldAhead`
        // indexes the row, and anyone's claim — the keeper's lane — hands it over and clears it.
        expect(await ledger.getNextSoldAhead(0n)).toBe(p);
        expect(await ledger.getNextSoldAhead(p + 1n)).toBe(-1n);
        const claim = await ledger.sendClaimDividend(keeper.getSender(), { p, value: toNano('0.02') });
        expect(claim.transactions).not.toHaveTransaction({ aborted: true });
        expect(await ledger.getNextSoldAhead(0n)).toBe(-1n);
        expect(await ledger.getDivEntryRaw(p)).toBe(-1n);
    });

    // ---- D-198: unsold primes' rows leave the ledger once the head has left their block ----

    const FLUSH_VALUE = toNano('0.15');
    const mintAt = (n: bigint) =>
        ledger.sendMint(opener.getSender(), {
            n, kind: 0, factors: factorize(n), referralKey: 0, beneficiary: null, value: MINT_PRICE,
        });

    it('D-198: the walk stops 26 blocks past the unsold-flush cursor, and walks on once a block is flushed', async () => {
        const limitN = firstOf(WINDOW_BLOCKS); // cursor 0 -> the walk stops at block 26
        const head = compositeFrom(limitN - 3n);
        const primes: bigint[] = [];
        for (let i = 2n; i < head; i++) if (isPrime(i)) primes.push(i);
        await deploy({ head, primes, imported: 100n, flushed: 0n }); // the import frontier is far away
        for (let n = await ledger.getHead(); n < limitN; n = await ledger.getHead()) {
            const r = await mintAt(n);
            expect(r.transactions).not.toHaveTransaction({ on: ledger.address, aborted: true });
        }
        expect(await ledger.getHead()).toBe(limitN);
        expect(await ledger.getWalkPending()).toBe(true);
        expect(await ledger.getUnsoldFlush()).toEqual({ unsoldFlushed: 0n, dueNow: true });

        const early = await ledger.sendFlushUnsold(keeper.getSender(), { value: toNano('0.1') });
        expect(early.transactions).toHaveTransaction({ to: ledger.address, exitCode: 103 });
        const f = await ledger.sendFlushUnsold(keeper.getSender(), { value: FLUSH_VALUE });
        expect(f.transactions).not.toHaveTransaction({ aborted: true });
        expect((await ledger.getUnsoldFlush()).unsoldFlushed).toBe(1n);
        await ledger.sendAdvanceHead(keeper.getSender(), { value: toNano('0.3') });
        // The limit position itself, if a plain composite, is the head now — walked.
        let expected = limitN;
        while (isPrime(expected)) expected++;
        expect(await ledger.getHead()).toBe(expected);
        expect(await ledger.getWalkPending()).toBe(false);
        const on = await mintAt(expected);
        expect(on.transactions).not.toHaveTransaction({ on: ledger.address, aborted: true });
        expect(await ledger.getHead()).toBeGreaterThan(expected);
    });

    it('D-198: a 16-row flush on a full window stays far inside the gas cap, and the caller pays for it', async () => {
        // The heaviest state a flush can meet: the walk has gone the whole 26 blocks
        // past the cursor, and every unsold prime in them has a forfeit row (seeded,
        // because walking it mint by mint is ~5,800 mints).
        const head = compositeFrom(firstOf(WINDOW_BLOCKS) - 3n);
        const primes: bigint[] = [];
        for (let i = 2n; i < head; i++) if (isPrime(i)) primes.push(i);
        const unsold = primes.map((p, i) => ({ p, entry: (1n << 110n) + BigInt(i), forfeited: 123_456_789n + BigInt(i) }));
        await deploy({ head, primes, imported: 100n, flushed: 0n, unsold });
        const before = (await blockchain.getContract(ledger.address)).balance;
        const f = await ledger.sendFlushUnsold(keeper.getSender(), { value: FLUSH_VALUE });
        expect(f.transactions).not.toHaveTransaction({ aborted: true });
        const tx = f.transactions.find(
            (t) => t.inMessage?.info.type === 'internal' && t.inMessage.info.src.equals(keeper.address)
        )!;
        // Measured 268,726 (primes_ledger.tolk FLUSH_MAX_ROWS): a 1M cap with room to spare.
        expect(Number((tx.description as any).computePhase.gasUsed)).toBeLessThan(400_000);
        // FLUSH_UNSOLD_VALUE covers the walk, the hop and its fee: the ledger is never poorer.
        expect((await blockchain.getContract(ledger.address)).balance).toBeGreaterThanOrEqual(before);
    });

    it('D-198 / LOW-5: a refused bookmarks batch comes home whole, on a full window, and re-flushes', async () => {
        // The never-expected refusal (a frozen block; the send carries its state init).
        // If the bounce could not afford the restore, up to 16 unsold primes would keep
        // their unsold bit with no bookmark anywhere, and each buyer would lose the
        // deferred dividend. Measured on the heaviest state the restore can meet: the
        // same full 26-block window, forfeit rows on every prime.
        const head = compositeFrom(firstOf(WINDOW_BLOCKS) - 3n);
        const primes: bigint[] = [];
        for (let i = 2n; i < head; i++) if (isPrime(i)) primes.push(i);
        const unsold = primes.map((p, i) => ({ p, entry: (1n << 110n) + BigInt(i), forfeited: 123_456_789n + BigInt(i) }));
        await deploy({ head, primes, imported: 100n, flushed: 0n, unsold });
        const lbAddr = lotBlockAddress(ledger.address, 0n);
        // A block that refuses: its data names another ledger, so the merge throws 100.
        await blockchain.setShardAccount(lbAddr, createShardAccount({
            address: lbAddr, code: lotBlockCode(), data: lotBlockData(keeper.address, 0n), balance: toNano('0.01'),
        }));
        const f = await ledger.sendFlushUnsold(keeper.getSender(), { value: FLUSH_VALUE });
        expect(f.transactions).not.toHaveTransaction({ on: ledger.address, aborted: true });
        const back = f.transactions.find(
            (t) => t.inMessage?.info.type === 'internal' && t.inMessage.info.bounced && t.inMessage.info.dest.equals(ledger.address)
        )!;
        expect(back).toBeDefined();
        const cp = (back.description as any).computePhase;
        expect(cp.success).toBe(true);
        // Half the bounce's value at most: room for a config 21 gas price rise.
        expect(cp.gasFees * 2n).toBeLessThan((back.inMessage!.info as any).value.coins);
        // Every row of the batch is back, exact, and the cursor still names the block.
        for (const r of unsold.slice(0, 16)) {
            expect(await ledger.getDivEntryRaw(r.p)).toBe(r.entry);
            expect(await ledger.getForfeitedRaw(r.p)).toBe(r.forfeited);
            expect(await ledger.isPrimeUnsold(r.p)).toBe(true);
        }
        expect((await ledger.getUnsoldFlush()).unsoldFlushed).toBe(0n);

        // Once the block can answer, the same batch flushes as if nothing had happened.
        await blockchain.setShardAccount(lbAddr, createEmptyShardAccount(lbAddr));
        const again = await ledger.sendFlushUnsold(keeper.getSender(), { value: FLUSH_VALUE });
        expect(again.transactions).not.toHaveTransaction({ aborted: true });
        const lb = blockchain.openContract(PrimesLotBlock.createFromAddress(lbAddr));
        for (const r of unsold.slice(0, 16)) {
            expect(await lb.getBookmark(r.p)).toMatchObject({ found: true, entry: r.entry, forfeited: r.forfeited });
        }
    });

    it('D-198: a flushed unsold prime keeps its exact bookmark on its lot block, and its buyer gets it', async () => {
        await deploy();
        // Walk the head out of block 0 (2..257): every prime there is crossed, unsold.
        for (let n = await ledger.getHead(); n <= firstOf(1n); n = await ledger.getHead()) {
            const r = await mintAt(n);
            expect(r.transactions).not.toHaveTransaction({ on: ledger.address, aborted: true });
        }
        const p = 13n;
        const entry = await ledger.getDivEntryRaw(p);
        expect(entry).toBeGreaterThanOrEqual(0n);
        expect(await ledger.isPrimeUnsold(p)).toBe(true);
        const notYet = await ledger.getUnsoldFlush();
        expect(notYet).toEqual({ unsoldFlushed: 0n, dueNow: true });
        const forfeitedBefore = await ledger.getForfeitedRaw(p); // 13 has been cited unsold
        expect(forfeitedBefore).toBeGreaterThan(0n);
        const cellsBefore = await dataCells(blockchain, ledger.address);

        const f = await ledger.sendFlushUnsold(keeper.getSender(), { value: FLUSH_VALUE });
        expect(f.transactions).not.toHaveTransaction({ aborted: true });
        // Block 0 is the densest block there is (54 primes): the lot block's merge must
        // stay well inside the hop's fixed 0.06 TON, with room for a bounce.
        const merge = f.transactions.find(
            (t) => t.inMessage?.info.type === 'internal' && t.inMessage.info.dest.equals(lotBlockAddress(ledger.address, 0n))
        )!;
        expect((merge.description as any).computePhase.gasFees).toBeLessThan(toNano('0.03'));
        // LOW-4: the hop's change goes back to the ledger; the block keeps only its rent floor.
        expect(f.transactions).toHaveTransaction({ from: lotBlockAddress(ledger.address, 0n), to: ledger.address, success: true });
        expect((await blockchain.getContract(lotBlockAddress(ledger.address, 0n))).balance).toBeLessThanOrEqual(toNano('0.01'));
        // 54 primes, at most 16 rows a call: the block stays the cursor until it is empty.
        expect((await ledger.getUnsoldFlush()).unsoldFlushed).toBe(0n);
        // Between batches: p (13, in the first 16 rows) has moved but the cursor still
        // names block 0. A mint citing it must forfeit into the aggregate, never re-grow
        // a per-prime row here that no later batch would collect.
        const aggMid = await ledger.getForfeitedBeyondWindow();
        for (let n = await ledger.getHead(); n % p !== 0n; n = await ledger.getHead()) await mintAt(n);
        await mintAt(await ledger.getHead());
        expect(await ledger.getForfeitedBeyondWindow()).toBeGreaterThan(aggMid);
        expect(await ledger.getForfeitedRaw(p)).toBe(0n);
        expect(await ledger.getForfeitedRaw(2n)).toBe(0n);
        let calls = 1;
        while ((await ledger.getUnsoldFlush()).unsoldFlushed === 0n) {
            const more = await ledger.sendFlushUnsold(keeper.getSender(), { value: FLUSH_VALUE });
            expect(more.transactions).not.toHaveTransaction({ aborted: true });
            expect((await blockchain.getContract(lotBlockAddress(ledger.address, 0n))).balance).toBeLessThanOrEqual(toNano('0.01'));
            calls++;
        }
        expect(calls).toBe(4); // ceil(54 / 16)
        // The rows left: fewer cells here, the same numbers there.
        expect(await dataCells(blockchain, ledger.address)).toBeLessThan(cellsBefore);
        expect(await ledger.getDivEntryRaw(p)).toBe(-2n);
        expect(await ledger.getDivEntry(p)).toBe(entry); // the wrapper follows -2 to the lot block
        expect(await ledger.isPrimeUnsold(p)).toBe(true);
        const lb = blockchain.openContract(PrimesLotBlock.createFromAddress(lotBlockAddress(ledger.address, 0n)));
        expect(await lb.getBookmark(p)).toMatchObject({ found: true, entry, forfeited: forfeitedBefore });
        expect(await ledger.getForfeitedRaw(p)).toBe(0n);
        // A second flush of the same block is not due: the head is in block 1.
        expect((await ledger.getUnsoldFlush()).dueNow).toBe(false);
        // A forfeit on it NOW has no per-prime row: it joins the aggregate (§6 point 2's
        // money is unchanged; only its attribution is).
        const aggBefore = await ledger.getForfeitedBeyondWindow();
        for (let n = await ledger.getHead(); n % p !== 0n; n = await ledger.getHead()) await mintAt(n);
        await mintAt(await ledger.getHead());
        expect(await ledger.getForfeitedBeyondWindow()).toBeGreaterThan(aggBefore);
        expect(await ledger.getForfeitedRaw(p)).toBe(0n);

        // LOW-4: five idle years. The block's 54 rows owe more rent than its 0.01 floor
        // holds; the release's own value pays the debt and the answer still goes.
        blockchain.now = (blockchain.now ?? 0) + 5 * 365 * 86_400;
        // The sale: the item starts unstamped, the lot block hands the stamp back, and the
        // ledger sends it straight on to the item (LOW-3) — no row waits here on a claim
        // the owner may never send.
        const sale = await acquirePrime({ blockchain, market, ledger }, opener, p);
        expect(sale.result.transactions).not.toHaveTransaction({ on: lb.address, aborted: true });
        expect(sale.result.transactions).toHaveTransaction({ from: lb.address, to: ledger.address, success: true });
        expect((await blockchain.getContract(lb.address)).balance).toBe(toNano('0.01')); // floor refilled, rest returned
        expect(await ledger.isPrimeUnsold(p)).toBe(false);
        expect((await lb.getBookmark(p)).entry).toBe(2n ** 120n - 1n); // released
        const item = await ledger.getItemAddress(p);
        expect(sale.result.transactions).toHaveTransaction({ from: ledger.address, to: item, op: 0xb0000036, success: true });
        expect(sale.result.transactions).toHaveTransaction({ from: item, to: ledger.address, op: 0xb000000e, success: true });
        expect(await ledger.getDivEntryRaw(p)).toBe(-1n); // the item holds it
        expect(await ledger.getNextSoldAhead(0n)).toBe(-1n);
        // The item was credited everything since the stamp and re-stamped at today's divAcc.
        expect(await ledger.getDivEntry(p)).toBe(await ledger.getDivAcc());
        expect(await ledger.getClaimableDividend(p)).toBe(0n);
    }, 300_000);

    it('the head stops at the frontier, and walks on — past an imported claim — once the block is in', async () => {
        // With nothing imported the frontier is block 26, whose first number is 6658.
        const frontierN = firstOf(WINDOW_BLOCKS);
        const head = compositeFrom(frontierN - 3n);
        const primes: bigint[] = [];
        for (let i = 2n; i < head; i++) if (isPrime(i)) primes.push(i);
        await deploy({ head, primes, imported: 0n });
        expect((await ledger.getLotBlockState()).frontierBlock).toBe(WINDOW_BLOCKS);

        // A lot beyond the frontier: claimed on block 26's lot block.
        const claimed = compositeFrom(frontierN + 2n);
        await openFar(claimed);
        expect(await ledger.isNumberOffHead(claimed)).toBe(-1);

        const mint = (n: bigint) =>
            ledger.sendMint(opener.getSender(), {
                n, kind: 0, factors: factorize(n), referralKey: 0, beneficiary: null, value: MINT_PRICE,
            });
        // Mint up to the frontier: the walk parks the head ON it, unwalked.
        for (let n = await ledger.getHead(); n < frontierN; n = await ledger.getHead()) {
            const r = await mint(n);
            // (The seeded primes have no items, so their tribute credits bounce and
            // park — a fixture artefact; the ledger itself must stay green.)
            expect(r.transactions).not.toHaveTransaction({ on: ledger.address, aborted: true });
        }
        expect(await ledger.getHead()).toBe(frontierN);
        expect(await ledger.getWalkPending()).toBe(true);
        const refused = await mint(frontierN);
        expect(refused.transactions).not.toHaveTransaction({ on: ledger.address, aborted: true });
        expect(await ledger.getHead()).toBe(frontierN); // a lost race: refunded, head unmoved

        await ledger.sendImportLotBlock(keeper.getSender(), { value: IMPORT_VALUE });
        expect(await ledger.isNumberOffHead(claimed)).toBe(1);
        await ledger.sendAdvanceHead(keeper.getSender(), { value: toNano('0.3') });
        // The frontier position itself, if it is a plain composite, is now the head.
        let expected = frontierN;
        while (isPrime(expected) || expected === claimed) expected++;
        expect(await ledger.getHead()).toBe(expected);
        expect(await ledger.getWalkPending()).toBe(false);

        // Mint on through the claimed number: the walk skips it.
        for (let n = await ledger.getHead(); n <= claimed; n = await ledger.getHead()) {
            expect(n).not.toBe(claimed);
            await mint(n);
        }
        expect(await ledger.getHead()).toBeGreaterThan(claimed);
    });
});
