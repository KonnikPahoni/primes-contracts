// TON PRIMES — D-189: the head-advance walk is gas-bounded and resumable.
//
// THE BUG THIS PINS. `executeMint` used to walk past every prime and every
// auctioned composite after `n` in ONE transaction, with no bound. Opening a lot
// costs ~1.07 TON and nothing limits how many consecutive numbers can be
// auctioned, so ~55 lots in a row (~60 TON) pushed the one head mint that
// crossed them past the 1,000,000-gas basechain cap. It aborted, every retry
// walked the same run, the off-head bits are permanent and the ledger has no
// upgrade path: the core loop was frozen for good.
//
// THE FIX. The walk stops once the transaction has consumed WALK_GAS_STOP, parks
// `head` on the first unwalked position with `walkPending = 1`, head mints refund
// while it is set, and the permissionless `advance_head` walks on. This file
// auctions a 200-number run — four times the old breaking point — and asserts
// that no transaction aborts and the head lands exactly where an unbounded walk
// would have put it, at small n and at the worst case the lanes can reach (an
// ω = 12 head mint, the heaviest post-walk tail, next to 13-digit primes).
import { Blockchain, SandboxContract, TreasuryContract } from '@ton/sandbox';
import { beginCell, Cell, toNano, Transaction } from '@ton/core';
import '@ton/test-utils';
import { compile } from '@ton/blueprint';
import { PrimesLedger, FactorEntry } from '../wrappers/PrimesLedger';
import { PrimesRatchet } from '../wrappers/PrimesRatchet';
import { PrimesRegistrar } from '../wrappers/PrimesRegistrar';
import { PrimesCollection } from '../wrappers/PrimesCollection';
import { PrimesJettonMaster } from '../wrappers/PrimesJettonMaster';
import { MARKET } from '../../shared/opcodes';

const MINT_PRICE = toNano('1');
const ADVANCE_HEAD_VALUE = toNano('0.3');
const RUN = 200;
/** `primes_market.tolk`'s AUCTIONABLE_MAX, 2^32 · 10^4 − 1. */
const AUCTIONABLE_MAX = 42_949_672_959_999n;
/** The basechain per-transaction cap (config 20); the walk must stay clear of it. */
const GAS_CAP = 1_000_000n;

function isPrime(n: bigint): boolean {
    if (n < 2n) return false;
    for (const p of [2n, 3n, 5n, 7n, 11n, 13n, 17n, 19n, 23n, 29n, 31n, 37n]) {
        if (n % p === 0n) return n === p;
    }
    let d = n - 1n;
    let r = 0;
    while (d % 2n === 0n) { d /= 2n; r++; }
    const pow = (b: bigint, e: bigint) => {
        let x = 1n; b %= n;
        while (e > 0n) { if (e & 1n) x = (x * b) % n; b = (b * b) % n; e >>= 1n; }
        return x;
    };
    outer: for (const a of [2n, 3n, 5n, 7n, 11n, 13n, 17n, 19n, 23n, 29n, 31n, 37n]) {
        let x = pow(a, d);
        if (x === 1n || x === n - 1n) continue;
        for (let i = 1; i < r; i++) { x = (x * x) % n; if (x === n - 1n) continue outer; }
        return false;
    }
    return true;
}

const isqrt = (p: bigint): bigint => BigInt(Math.floor(Math.sqrt(Number(p))));

const gasOf = (t: Transaction): bigint => {
    const d = t.description as any;
    return d.computePhase?.type === 'vm' ? BigInt(d.computePhase.gasUsed) : 0n;
};

describe('TON PRIMES — D-189: a long auctioned run cannot freeze the head', () => {
    let codes: Record<string, Cell>;
    let blockchain: Blockchain;
    let genesisScript: SandboxContract<TreasuryContract>;
    let market: SandboxContract<TreasuryContract>;
    let minter: SandboxContract<TreasuryContract>;
    let keeper: SandboxContract<TreasuryContract>;
    let ledger: SandboxContract<PrimesLedger>;

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

    /** FanOutGas.spec.ts's seam: head parked on `head`, only its own factors marked. */
    async function deployAtHead(head: bigint, seedPrimes: bigint[]) {
        blockchain = await Blockchain.create();
        blockchain.now = 1_770_000_000;
        const deployer = await blockchain.treasury('deployer');
        genesisScript = await blockchain.treasury('genesisScript');
        market = await blockchain.treasury('market');
        minter = await blockchain.treasury('minter', { balance: toNano('500') });
        keeper = await blockchain.treasury('keeper', { balance: toNano('500') });
        const treasuryWallet = await blockchain.treasury('treasury');

        const collection = blockchain.openContract(
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
                    seedHead: head,
                    seedPrimes,
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
        // A treasury stands in for the market: all the walk cares about is `mark_off_head`.
        await ledger.sendSetPeers(genesisScript.getSender(), {
            marketAddr: market.address,
            bountyVaultAddr: deployer.address,
            value: toNano('0.05'),
        });
        await collection.sendSetLedger(genesisScript.getSender(), { ledgerAddr: ledger.address, value: toNano('0.05') });
        await master.sendSetLedger(genesisScript.getSender(), { ledgerAddr: ledger.address, value: toNano('0.05') });
        await master.sendSealAuthority(genesisScript.getSender(), { value: toNano('0.05') });
        await ledger.sendGenesisSeed(genesisScript.getSender(), {
            seedT: toNano('1000'),
            seedS: 1_200_000_000_000_000n,
            seedHead: head,
            value: toNano('0.2'),
        });
        await ledger.sendIgnite(genesisScript.getSender(), { owner: deployer.address, value: toNano('0.3') });
    }

    /** `open_lot`'s ledger half, for the first RUN composites after `head`. Returns the last. */
    async function auctionRun(head: bigint): Promise<bigint> {
        let marked = 0;
        let n = head;
        while (marked < RUN) {
            n += 1n;
            if (isPrime(n)) continue;
            const r = await market.send({
                to: ledger.address,
                value: toNano('0.05'),
                body: beginCell().storeUint(MARKET.mark_off_head, 32).storeUint(0, 64).storeUint(n, 256).endCell(),
            });
            expect(r.transactions).toHaveTransaction({ to: ledger.address, success: true });
            marked++;
        }
        return n;
    }

    /**
     * Mint `head`, then drive `advance_head` until the walk is done. Asserts no
     * ledger transaction aborts or comes near the cap, and returns what landed.
     */
    async function crossRun(head: bigint, factors: FactorEntry[]) {
        const runEnd = await auctionRun(head);
        // Where an unbounded walk would have stopped: the first plain composite past the run.
        let expectedHead = runEnd + 1n;
        while (isPrime(expectedHead)) expectedHead++;
        let primesCrossed = 0;
        for (let i = head + 1n; i < expectedHead; i++) if (isPrime(i)) primesCrossed++;
        const primesBefore = await ledger.getPrimesCount();

        let maxGas = 0n;
        // Only the LEDGER's transactions: the harness seeds primes with no items, so
        // their `credit_tribute` legs land on empty accounts (FanOutGas.spec.ts counts
        // those as `unroutedHeld`, which is correct and not what this file is about).
        const check = (r: { transactions: Transaction[] }) => {
            expect(r.transactions).not.toHaveTransaction({ on: ledger.address, aborted: true });
            for (const t of r.transactions) {
                if (t.inMessage?.info.dest?.toString() === ledger.address.toString()) {
                    maxGas = gasOf(t) > maxGas ? gasOf(t) : maxGas;
                }
            }
        };

        const mint = await ledger.sendMint(minter.getSender(), {
            n: head, kind: 0, factors, referralKey: 0, beneficiary: null, value: MINT_PRICE,
        });
        check(mint);
        expect(mint.transactions).toHaveTransaction({ to: ledger.address, success: true });
        // The run is 4x the old breaking point: one mint cannot have finished it.
        expect(await ledger.getWalkPending()).toBe(true);
        expect(await ledger.getHead()).toBeLessThan(expectedHead);

        let calls = 0;
        while (await ledger.getWalkPending()) {
            const before = await ledger.getHead();
            const r = await ledger.sendAdvanceHead(keeper.getSender(), { value: ADVANCE_HEAD_VALUE });
            check(r);
            expect(await ledger.getHead()).toBeGreaterThan(before); // every call makes progress
            expect(++calls).toBeLessThan(50);
        }

        expect(await ledger.getHead()).toBe(expectedHead);
        expect(await ledger.getPrimesCount()).toBe(primesBefore + primesCrossed);
        for (let i = head + 1n; i < expectedHead; i++) {
            if (isPrime(i)) expect(await ledger.isPrimeUnsold(i)).toBe(true);
        }
        expect(maxGas).toBeLessThan((GAS_CAP * 9n) / 10n);
        return { calls, maxGas };
    }

    it('small n: a 200-number run is crossed over several calls, head lands where it always would', async () => {
        const head = 1000n; // 2^3 · 5^3
        await deployAtHead(head, [2n, 5n]);
        const r = await crossRun(head, [
            { prime: 2n, exponent: 3, s: 1n },
            { prime: 5n, exponent: 3, s: 2n },
        ]);
        expect(r.calls).toBeGreaterThan(0);
    });

    it('worst case: an ω = 12 head mint next to 13-digit primes still stays under the cap', async () => {
        // The heaviest post-walk tail the auction lane can reach. FanOutGas.spec.ts's
        // omegaNumber(12): the first eleven primes and 43, not a primorial (~8.6e12).
        const primes = [2n, 3n, 5n, 7n, 11n, 13n, 17n, 19n, 23n, 29n, 31n, 43n];
        const head = primes.reduce((a, b) => a * b, 1n);
        await deployAtHead(head, primes);
        await crossRun(
            head,
            primes.map((p) => ({ prime: p, exponent: 1, s: isqrt(p) }))
        );
    });

    it('both bitmaps take writes up to AUCTIONABLE_MAX (the chunk key used to overflow at 2^40)', async () => {
        await deployAtHead(1000n, [2n, 5n]);
        // A composite lot opened at the very top of the auction range.
        const composite = AUCTIONABLE_MAX - 1n; // even
        const mark = await market.send({
            to: ledger.address,
            value: toNano('0.05'),
            body: beginCell().storeUint(MARKET.mark_off_head, 32).storeUint(0, 64).storeUint(composite, 256).endCell(),
        });
        expect(mark.transactions).toHaveTransaction({ to: ledger.address, success: true });
        expect(mark.transactions).not.toHaveTransaction({ aborted: true });
        // D-196: that far ahead the mark lives on the block's lot block, not here.
        expect(await ledger.isNumberOffHead(composite)).toBe(-1);
        expect(await ledger.isNumberOffHeadResolved(composite)).toBe(true);
        expect(await ledger.isNumberOffHeadResolved(composite - 256n)).toBe(false);

        // A prime sold ahead of the head at the top of the range is marked in the prime bitmap.
        let prime = AUCTIONABLE_MAX;
        while (!isPrime(prime)) prime--;
        const sale = await ledger.sendSettlePrimeClearing(market.getSender(), {
            n: prime, beneficiary: minter.address, referralKey: 0, value: MINT_PRICE + toNano('0.5'),
        });
        expect(sale.transactions).not.toHaveTransaction({ on: ledger.address, aborted: true });
        expect(sale.transactions).toHaveTransaction({ to: ledger.address, success: true });
    });

    it('a head mint while the walk is pending refunds, and advance_head with nothing pending is a no-op', async () => {
        const head = 1000n;
        await deployAtHead(head, [2n, 5n]);
        await auctionRun(head);
        await ledger.sendMint(minter.getSender(), {
            n: head, kind: 0, factors: [{ prime: 2n, exponent: 3, s: 1n }, { prime: 5n, exponent: 3, s: 2n }],
            referralKey: 0, beneficiary: null, value: MINT_PRICE,
        });
        expect(await ledger.getWalkPending()).toBe(true);
        const parked = await ledger.getHead();
        const primesBefore = await ledger.getPrimesCount();

        // Whatever `head` reads mid-walk is not mintable: the mint is a lost race.
        const lost = await ledger.sendMint(minter.getSender(), {
            n: parked, kind: 0, factors: [], referralKey: 0, beneficiary: null, value: MINT_PRICE,
        });
        expect(lost.transactions).not.toHaveTransaction({ on: ledger.address, aborted: true });
        // D-191 point 1: the refund rides back through the minter's card.
        const card = await ledger.getMinterCardAddress(minter.address);
        expect(lost.transactions).toHaveTransaction({ from: ledger.address, to: card });
        expect(lost.transactions).toHaveTransaction({ from: card, to: minter.address });
        expect(await ledger.getHead()).toBe(parked);
        expect(await ledger.getPrimesCount()).toBe(primesBefore);

        while (await ledger.getWalkPending()) {
            await ledger.sendAdvanceHead(keeper.getSender(), { value: ADVANCE_HEAD_VALUE });
        }
        const settled = await ledger.getHead();
        const idle = await ledger.sendAdvanceHead(keeper.getSender(), { value: ADVANCE_HEAD_VALUE });
        expect(idle.transactions).not.toHaveTransaction({ on: ledger.address, aborted: true });
        expect(idle.transactions).toHaveTransaction({ from: ledger.address, to: keeper.address });
        expect(await ledger.getHead()).toBe(settled);

        // Under ADVANCE_HEAD_VALUE is refused outright (103), before any walk.
        const cheap = await ledger.sendAdvanceHead(keeper.getSender(), { value: toNano('0.1') });
        expect(cheap.transactions).toHaveTransaction({ to: ledger.address, success: false, exitCode: 103 });
    });
});
