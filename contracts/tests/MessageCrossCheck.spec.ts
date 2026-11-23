// TON PRIMES — the player-facing message bodies have exactly one definition.
//
// `AGENTS_PLAN.md` A1 / D-131.3. Until 2026-09-16 the webapp's `chain/messages.ts` and
// these wrappers each transcribed the same mint / lot / build bodies: every sandbox proof
// ran against the wrapper's bytes while every real 1 GRAM mint spent through the webapp's,
// and a headless client had to pick one or write a third. Both now call
// `shared/messages.ts`. Same shape as `FactorCrossCheck.spec.ts`: identity of the export,
// byte-identity of the wrapper's send body against the builder, and a scan that refuses
// a re-inlined opcode chain under `wrappers/` for the ops the builder owns.
import * as fs from 'fs';
import * as path from 'path';
import { Address, beginCell, Cell, ContractProvider, Sender, SendMode } from '@ton/core';
import * as shared from '../../shared/messages';
import * as dedust from '../scripts/dedust';
import { PrimesLedger } from '../wrappers/PrimesLedger';
import { PrimesMarket } from '../wrappers/PrimesMarket';

/** A provider that captures the body a `send*` method hands to `internal`. */
function capture(): { provider: ContractProvider; sent: () => Cell } {
    let body: Cell | undefined;
    const provider = {
        internal: async (_via: Sender, args: { body?: Cell }) => {
            body = args.body;
        },
    } as unknown as ContractProvider;
    return { provider, sent: () => body! };
}
const via = {} as Sender;
const addr = Address.parse('EQD__________________________________________0vo');
const factors = [{ prime: 2n, exponent: 2, s: 1n }, { prime: 3n, exponent: 1, s: 1n }];

describe('TON PRIMES — one message builder (A1)', () => {
    it('the webapp re-exports shared/messages.ts rather than keeping a copy', () => {
        // Read as source, the way FactorCrossCheck.spec.ts reads it: the webapp module is
        // Vite-aliased and not resolvable from this tsconfig, and what must be true is a
        // property of the FILE — that it forwards and inlines nothing.
        const src = fs.readFileSync(
            path.join(__dirname, '..', '..', 'webapp', 'src', 'chain', 'messages.ts'), 'utf-8');
        expect(src).toMatch(/export \* from "@ton-primes\/shared\/messages";/);
        expect(src).not.toMatch(/beginCell\(\)/);
    });

    it('D-146: the caller-gas figures in shared/messages.ts are the ratchet source, summed', () => {
        const src = fs.readFileSync(
            path.join(__dirname, '..', 'contracts', 'primes_ratchet.tolk'), 'utf-8');
        const c = (name: string): bigint => {
            const m = src.match(new RegExp(`const ${name}: (?:int|coins) = (\\d+);`));
            if (!m) throw new Error(`${name} not found in primes_ratchet.tolk`);
            return BigInt(m[1]);
        };
        const compute = c('CALLER_COMPUTE_GAS');
        expect(shared.RATCHET_CALLER_COMPUTE_NANOTON).toBe(compute);
        expect(shared.DEDUST_SWAP_GAS_NANOTON).toBe(c('DEDUST_SWAP_GAS'));
        expect(shared.FLUSH_CALLER_GAS_NANOTON).toBe(c('DEDUST_SWAP_GAS') + compute);
        expect(shared.STAKE_CALLER_GAS_NANOTON).toBe(c('TONSTAKERS_DEPOSIT_FEE') + c('STAKE_CREDIT_MARGIN') + compute);
        expect(shared.UNSTAKE_CALLER_GAS_NANOTON).toBe(
            2n * c('TSTON_EXIT_GAS') + c('DEDUST_JETTON_SWAP_GAS') + compute);
        expect(shared.HARVEST_CALLER_GAS_NANOTON).toBe(c('HARVEST_GAS') + compute);
    });

    it('PrimesLedger.sendMint sends buildMintMessage bytes, with both invite shapes', async () => {
        // D-191 point 1: the wrapper sends to the beneficiary's minter card through the
        // Sender (not the ledger's provider), with the card's StateInit attached.
        let sent: { to: Address; body?: Cell | null; init?: any } | null = null;
        const payer = Address.parse('EQCD39VS5jcptHL8vMjEXrzGaRcCVYto7HUn4bpAOg8xqB2N');
        const cardVia = { address: payer, send: async (args: any) => { sent = args; } } as unknown as Sender;
        const ledger = new PrimesLedger(addr);
        const addresses = new Map([[1, addr]]);
        await ledger.sendMint(capture().provider, cardVia, {
            n: 12n, kind: 0, factors, referralKey: 42, beneficiary: null,
            invites: { count: 2, addresses }, value: 0n, queryID: 9,
        });
        const fromKeeperShape = shared.buildMintMessage({
            ledger: addr, payer,
            n: 12n, kind: 0, factors, referralKey: 42, beneficiary: null, queryId: 9n,
            invites: { count: 2, addresses: [{ slot: 1, address: addr.toString() }] },
        });
        expect(sent!.body!.hash().equals(fromKeeperShape.body.hash())).toBe(true);
        expect(sent!.to.equals(fromKeeperShape.to)).toBe(true);
        expect(sent!.init.data.hash().equals(fromKeeperShape.init.data!.hash())).toBe(true);
    });

    it('PrimesMarket.sendOpenLot / sendBid / sendClose send the builder bytes', async () => {
        const market = new PrimesMarket(addr);
        let c = capture();
        await market.sendOpenLot(c.provider, via, { n: 12n, kind: 0, factors, beneficiary: addr, referralKey: 1, value: 0n });
        expect(c.sent().hash()).toEqual(shared.buildOpenLotMessage({ n: 12n, kind: 0, factors, beneficiary: addr, referralKey: 1, bidNanoton: 0n }).body.hash());
        c = capture();
        await market.sendBid(c.provider, via, { n: 13n, beneficiary: null, referralKey: 0, value: 0n, queryID: 3 });
        expect(c.sent().hash()).toEqual(shared.buildBidMessage({ n: 13n, bidNanoton: 0n, queryId: 3n }).body.hash());
        c = capture();
        await market.sendClose(c.provider, via, { n: 13n, value: 0n });
        expect(c.sent().hash()).toEqual(shared.buildCloseLotMessage({ n: 13n }).body.hash());
    });

    it('no wrapper re-inlines an opcode the shared builder owns', () => {
        const owned = ['LedgerOpcodes.Mint', 'MARKET.open_lot', 'MARKET.open_head_lot', 'MARKET.bid', 'MARKET.close'];
        const dir = path.join(__dirname, '..', 'wrappers');
        const offenders: string[] = [];
        for (const f of fs.readdirSync(dir)) {
            const src = fs.readFileSync(path.join(dir, f), 'utf-8');
            for (const op of owned) if (new RegExp(`storeUint\\(${op.replace('.', '\\.')},\\s*32\\)`).test(src)) offenders.push(`${f}: ${op}`);
        }
        expect(offenders).toEqual([]);
    });

    it('the wrapper bytes are unchanged by the move — golden mint body hash', () => {
        // D-215 widened `inviteCount` from 3 bits to 7.
        // Measured from the wrapper's own transcription at HEAD before A1 (same inputs).
        // D-191 point 1 dropped the `beneficiary` field (the 2-bit addr_none that stood here):
        // the card the body is sent to IS the beneficiary's.
        const { body } = shared.buildMintMessage({ ledger: addr, payer: addr, n: 12n, kind: 0, factors, referralKey: 42, beneficiary: null, queryId: 9n });
        const golden = beginCell()
            .storeUint(0xb0000002, 32).storeUint(9, 64).storeUint(12n, 256).storeUint(0, 1)
            .storeDict(shared.encodeFactors(factors)).storeUint(42, 32).storeUint(0, 7).storeMaybeRef(null)
            .endCell();
        expect(body.hash()).toEqual(golden.hash());
        void SendMode;
    });

    /**
     * THE DEDUST DEPOSIT WIRE FORMAT HAS TWO WRITERS, AND THIS IS WHY THAT IS ALLOWED.
     *
     * `contracts/scripts/dedust.ts` built the two liquidity-deposit bodies first, for the
     * genesis seeding scripts, and earned its layout against mainnet traces (2026-09-16) —
     * the docs' TL-B page and `@dedust/sdk` disagree about whether the native leg's three
     * coin fields are inline or in a ref, and only one of them is what mainnet accepts.
     * `shared/messages.ts` now builds the same two bodies for the WEBAPP's provide-liquidity
     * form. Rewriting the genesis script to import the shared one would put a deployment at
     * risk to remove a duplicate; asserting BYTE IDENTITY costs nothing and catches the only
     * thing the duplication can actually do wrong.
     *
     * If this fails, one of the two was edited and the other was not. The script's version
     * is the one with the trace behind it.
     */
    it('shared/messages.ts builds the same DeDust deposit bytes as contracts/scripts/dedust.ts', () => {
        const master = Address.parse('EQCcLAW537KnRg_aSPrnQJoyYjOZkzqYp6FVmRUvN1crSazV');
        const vault = Address.parse('EQDa4VOnTYlLvDJ0gZjNYm5PXfSmmtL6Vs6A_CZEtXCNICq_');
        const owner = Address.parse('EQD__________________________________________0vo');
        const assets: [dedust.DedustAsset, dedust.DedustAsset] = [{ kind: 'native' }, dedust.jettonAsset(master)];
        const tonIn = 1234567890n;
        const primesIn = 987654321000n;

        const scriptNative = dedust.depositNativeBody({
            amount: tonIn, assets, targetBalances: [tonIn, primesIn], minLpAmount: 0n, queryId: 0,
        });
        const sharedNative = shared.buildDedustDepositTonMessage({
            amountNanoton: tonIn, pairedPrimes: primesIn, primesJettonMaster: master.toString(),
        }).body;
        expect(sharedNative.hash()).toEqual(scriptNative.hash());

        // The jetton leg's shared builder wraps the payload in the TEP-74 transfer the app
        // sends, so the comparison unwraps it back to the payload the script returns.
        const scriptPayload = dedust.depositJettonForwardPayload({
            assets, targetBalances: [tonIn, primesIn], minLpAmount: 0n,
        });
        const sharedTransfer = shared.buildDedustDepositPrimesMessage({
            amountPrimes: primesIn, pairedTon: tonIn, primesJettonMaster: master.toString(),
            jettonVaultAddress: vault.toString(), ownerAddress: owner.toString(),
        }).body;
        const slice = sharedTransfer.beginParse();
        slice.loadUint(32); slice.loadUint(64); slice.loadCoins();
        slice.loadAddress(); slice.loadAddress(); slice.loadMaybeRef(); slice.loadCoins();
        expect(slice.loadBit()).toBe(true); // forward_payload as a ref
        expect(slice.loadRef().hash()).toEqual(scriptPayload.hash());
    });

    /** The mint rule a provide-liquidity form quotes with, pinned against hand arithmetic:
     *  `min(in × supply / reserve)` over the two sides, with the SMALLER side deciding. */
    it('quoteDedustLpMinted takes the smaller side and floors it', () => {
        const pool = { reserveTonNanoton: 1000n, reservePrimesNano: 4000n, lpTotalSupplyRaw: 2000n };
        // Balanced: both sides give 200.
        expect(shared.quoteDedustLpMinted({ amountNanoton: 100n, amountPrimes: 400n, ...pool })).toBe(200n);
        // PRIMES-heavy: the GRAM side is the binding one, and the excess is refunded.
        expect(shared.quoteDedustLpMinted({ amountNanoton: 100n, amountPrimes: 4000n, ...pool })).toBe(200n);
        // GRAM-heavy: the PRIMES side binds.
        expect(shared.quoteDedustLpMinted({ amountNanoton: 900n, amountPrimes: 400n, ...pool })).toBe(200n);
        // An empty pool has no ratio to join — a null, never a zero.
        expect(shared.quoteDedustLpMinted({ amountNanoton: 1n, amountPrimes: 1n, ...pool, lpTotalSupplyRaw: 0n })).toBeNull();
        // The partner field follows the reserves, either way round.
        expect(shared.dedustPartnerAmount({ amountRaw: 100n, side: 'ton', ...pool })).toBe(400n);
        expect(shared.dedustPartnerAmount({ amountRaw: 400n, side: 'primes', ...pool })).toBe(100n);
    });
});
