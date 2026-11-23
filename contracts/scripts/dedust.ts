/**
 * TON PRIMES — DeDust v2 wire format, in one place.
 *
 * This is the ONLY module in the repo that builds a real DeDust message. The
 * ratchet builds its own `swap#ea06185d` on chain (`primes_ratchet.tolk`) and
 * the two test mocks PARSE what DeDust sends; everything an off-chain script
 * needs to SEND is here.
 *
 * PROVENANCE. Every layout below is taken from `@dedust/sdk`'s own builders,
 * not from the docs' TL-B page, because the two disagree in one place that
 * matters: the docs print `deposit_liquidity`'s `min_lp_amount` and both target
 * balances INLINE, while the SDK writes them in a REF, and the SDK is what
 * mainnet accepts. Cross-checked against mainnet traces on 2026-09-16.
 *
 * THE FACTORY HAS THE SAME ADDRESS ON MAINNET AND TESTNET. That is not a typo,
 * and it is why this repo spent months believing DeDust did not exist on
 * testnet: an address is `hash(StateInit(code, data))`, and mainnet's factory
 * was UPGRADED IN PLACE, so the two chains run different code at one address.
 * Comparing code hashes says "different contract"; comparing addresses says
 * "same deployment". Both vault and pool creation are permissionless on
 * testnet, for 0.1 and 0.25 GRAM.
 */
import { Address, Cell, TupleItem, TupleReader, beginCell, toNano } from '@ton/core';
import type { TonClient } from '@ton/ton';

/** Same on mainnet and testnet — see the header. */
export const DEDUST_FACTORY = Address.parse('EQBfBWT7X2BHg9tXAxzhz2aKiNTU1tpt5NsiK0uSDW_YAJ67');

/**
 * The native GRAM vault. Unlike the factory this is a per-network deployment
 * with its own address, and the testnet one is live with real traffic.
 */
export const DEDUST_NATIVE_VAULT_TESTNET = Address.parse('kQDa4VOnTYlLvDJ0gZjNYm5PXfSmmtL6Vs6A_CZEtXCNIJE1');
export const DEDUST_NATIVE_VAULT_MAINNET = Address.parse('EQDa4VOnTYlLvDJ0gZjNYm5PXfSmmtL6Vs6A_CZEtXCNICq_');

export const DedustOps = {
    createVault: 0x21cfe02b,
    createVolatilePool: 0x97d51f2f,
    /** native vault half of a two-sided deposit */
    depositNative: 0xd55e4686,
    /** jetton vault half, carried as a TEP-74 transfer's forward payload */
    depositJetton: 0x40e108d6,
    /** native vault swap (what primes_ratchet.tolk sends) */
    swapNative: 0xea06185d,
    /** jetton vault swap, in a TEP-74 forward payload — NOT the same opcode */
    swapJetton: 0xe3a0d482,
    /** a refused swap's GRAM handed back. NOT a bounce — see primes_ratchet.tolk */
    payout: 0x474f86cf,
    jettonTransfer: 0x0f8a7ea5,
} as const;

/** `volatile$0` — the only pool type this repo uses. */
const POOL_TYPE_VOLATILE = 0;

export type DedustAsset =
    | { kind: 'native' }
    | { kind: 'jetton'; workchainId: number; address: bigint }
    | { kind: 'extraCurrency'; currencyId: number };

/**
 * `native$0000 = Asset; jetton$0001 workchain_id:int8 address:uint256 = Asset;`
 *
 * A variable-width union, which is why it is written by hand rather than
 * declared: 4 bits for native, 44 for a jetton. Note what a jetton Asset IS —
 * a tag plus the master's hash, an IDENTIFIER and not a pointer. The factory
 * never dereferences it, which is what makes creating a pool for a jetton
 * master that does not exist yet legal (verified on a mainnet trace).
 */
export function storeAsset(builder: ReturnType<typeof beginCell>, asset: DedustAsset) {
    if (asset.kind === 'native') {
        builder.storeUint(0, 4); // native$0000
    } else if (asset.kind === 'jetton') {
        builder.storeUint(1, 4).storeInt(asset.workchainId, 8).storeUint(asset.address, 256); // jetton$0001
    } else {
        builder.storeUint(2, 4).storeInt(asset.currencyId, 32); // extra_currency$0010
    }
}

/** An `Asset` on its own, for passing to the factory's get-methods as a slice. */
function assetCell(asset: DedustAsset): Cell {
    const b = beginCell();
    storeAsset(b, asset);
    return b.endCell();
}

export function jettonAsset(master: Address): DedustAsset {
    return {
        kind: 'jetton',
        workchainId: master.workChain,
        address: BigInt('0x' + master.hash.toString('hex')),
    };
}

/**
 * Both addresses are PURE DERIVATIONS of the factory address and the asset
 * pair, so these answer for pools and vaults that do not exist yet. Asset order
 * does not matter — DeDust normalises it so a pair has one address either way.
 */
export async function getPoolAddress(client: TonClient, a0: DedustAsset, a1: DedustAsset): Promise<Address> {
    const res = await client.runMethod(DEDUST_FACTORY, 'get_pool_address', [
        { type: 'int', value: BigInt(POOL_TYPE_VOLATILE) },
        { type: 'slice', cell: assetCell(a0) },
        { type: 'slice', cell: assetCell(a1) },
    ]);
    return res.stack.readAddress();
}

export async function getVaultAddress(client: TonClient, asset: DedustAsset): Promise<Address> {
    const res = await client.runMethod(DEDUST_FACTORY, 'get_vault_address', [
        { type: 'slice', cell: assetCell(asset) },
    ]);
    return res.stack.readAddress();
}

/** `create_vault#21cfe02b query_id:uint64 asset:Asset` — 0.1 GRAM is DeDust's own figure. */
export function createVaultBody(asset: DedustAsset, queryId = 0): Cell {
    const b = beginCell().storeUint(DedustOps.createVault, 32).storeUint(queryId, 64);
    storeAsset(b, asset);
    return b.endCell();
}
export const CREATE_VAULT_VALUE = toNano('0.15'); // 0.1 nominal + the standing fee margin

/** `create_volatile_pool#97d51f2f query_id:uint64 asset0:Asset asset1:Asset` */
export function createVolatilePoolBody(a0: DedustAsset, a1: DedustAsset, queryId = 0): Cell {
    const b = beginCell().storeUint(DedustOps.createVolatilePool, 32).storeUint(queryId, 64);
    storeAsset(b, a0);
    storeAsset(b, a1);
    return b.endCell();
}
export const CREATE_POOL_VALUE = toNano('0.35'); // 0.25 nominal + the standing fee margin

/**
 * The native half of a two-sided deposit, per `VaultNative.sendDepositLiquidity`.
 * Send to the NATIVE VAULT with `value = amount + DEPOSIT_NATIVE_GAS`.
 *
 * NOTE THE REF around the three coin fields — see the header. And note what is
 * NOT here: there is no recipient field anywhere in this schema, so the LP
 * jetton can only ever go to the account that sends this message.
 */
export function depositNativeBody(opts: {
    amount: bigint;
    assets: [DedustAsset, DedustAsset];
    targetBalances: [bigint, bigint];
    minLpAmount?: bigint;
    queryId?: number;
}): Cell {
    const b = beginCell()
        .storeUint(DedustOps.depositNative, 32)
        .storeUint(opts.queryId ?? 0, 64)
        .storeCoins(opts.amount)
        .storeUint(POOL_TYPE_VOLATILE, 1);
    storeAsset(b, opts.assets[0]);
    storeAsset(b, opts.assets[1]);
    b.storeRef(
        beginCell()
            .storeCoins(opts.minLpAmount ?? 0n)
            .storeCoins(opts.targetBalances[0])
            .storeCoins(opts.targetBalances[1])
            .endCell()
    );
    b.storeUint(0, 1); // fulfill_payload = none
    b.storeUint(0, 1); // reject_payload = none
    return b.endCell();
}
export const DEPOSIT_NATIVE_GAS = toNano('0.3');

/**
 * The jetton half, per `VaultJetton.createDepositLiquidityPayload`. Rides as the
 * `forward_payload` of a TEP-74 transfer to the JETTON VAULT (not the pool).
 *
 * The three coin fields are INLINE here, unlike the native half above. That
 * asymmetry is DeDust's, not a mistake in this file.
 */
export function depositJettonForwardPayload(opts: {
    assets: [DedustAsset, DedustAsset];
    targetBalances: [bigint, bigint];
    minLpAmount?: bigint;
}): Cell {
    const b = beginCell().storeUint(DedustOps.depositJetton, 32).storeUint(POOL_TYPE_VOLATILE, 1);
    storeAsset(b, opts.assets[0]);
    storeAsset(b, opts.assets[1]);
    b.storeCoins(opts.minLpAmount ?? 0n)
        .storeCoins(opts.targetBalances[0])
        .storeCoins(opts.targetBalances[1]);
    b.storeUint(0, 1); // fulfill_payload = none
    b.storeUint(0, 1); // reject_payload = none
    return b.endCell();
}
export const DEPOSIT_JETTON_VALUE = toNano('0.5');
export const DEPOSIT_JETTON_FORWARD = toNano('0.4');

/**
 * TEP-74 `transfer`. Used twice by the seeding script: once to hand PRIMES to
 * the jetton vault (with the deposit payload), once to hand the LP receipt to
 * the LP sink (with no payload — the sink has exactly one thing it can do with
 * a deposit).
 *
 * `forwardTon` MUST be > 0 for either destination: it is what makes the
 * receiving contract get a `transfer_notification` at all, and both DeDust's
 * vault and `primes_lp_sink.tolk` act only on that notification.
 */
export function jettonTransferBody(opts: {
    amount: bigint;
    destination: Address;
    responseAddress: Address;
    forwardTon: bigint;
    forwardPayload?: Cell;
    queryId?: number;
}): Cell {
    const b = beginCell()
        .storeUint(DedustOps.jettonTransfer, 32)
        .storeUint(opts.queryId ?? 0, 64)
        .storeCoins(opts.amount)
        .storeAddress(opts.destination)
        .storeAddress(opts.responseAddress)
        .storeUint(0, 1) // custom_payload = none
        .storeCoins(opts.forwardTon);
    if (opts.forwardPayload) b.storeUint(1, 1).storeRef(opts.forwardPayload);
    else b.storeUint(0, 1);
    return b.endCell();
}

/**
 * A jetton vault only becomes usable once TEP-89 has answered the master, which
 * is why `create_vault` must run AFTER the master is deployed. The native vault
 * has no such method — deployed means ready there.
 */
export async function jettonVaultIsReady(client: TonClient, vault: Address): Promise<boolean> {
    const res = await client.runMethod(vault, 'is_ready', []);
    return res.stack.readBoolean();
}

/**
 * GAUNTLET G67 — THE OPENING PRICE OF AN EMPTY POOL, FROM THE LEDGER.
 *
 * `seedDedustLiquidity.ts` posts `PRIMES × p_f` GRAM, and on an empty pool that ratio IS
 * the price. It used to take `p_f` from `params.json`'s `genesis_floor_price_ton_per_primes`,
 * the floor D-154's 132.50 GRAM donation WOULD make. The `20260927`/`20260928` sets donated
 * 75 GRAM, so the live floor was 6.3867e-6 against the 1.2045e-5 posted: the book opened at
 * 1.886x `p_f` and every flush took the floor guard's REFUSE branch (§4.3.1).
 *
 * So the live pair `T/S` (`getFloorNum`/`getFloorDen`, what `ignite` checks) is the figure.
 * When it and the params figure disagree by more than a nanoGRAM of rounding, nothing is
 * chosen silently: `choice` (`PRIMES_LP_FLOOR=live|params`) must name the one to use.
 *
 * Returns nanoGRAM per WHOLE PRIMES, rounded DOWN — a book a nanoGRAM under `p_f` is one
 * `flush()` fills, a nanoGRAM over is one it refuses.
 */
export function openingFloorNanotonPerPrimes(
    live: { t: bigint; s: bigint },
    paramsNanotonPerPrimes: bigint,
    choice?: string
): { nanotonPerPrimes: bigint; source: 'live' | 'params' } {
    if (live.s <= 0n || live.t <= 0n) {
        throw new Error(`ledger floor is T=${live.t} S=${live.s} — donateFloor.ts has not landed; nothing to price at.`);
    }
    const liveNano = (live.t * 1_000_000_000n) / live.s;
    if (choice === 'live') return { nanotonPerPrimes: liveNano, source: 'live' };
    if (choice === 'params') return { nanotonPerPrimes: paramsNanotonPerPrimes, source: 'params' };
    if (choice !== undefined && choice !== '') throw new Error(`PRIMES_LP_FLOOR=${choice}: expected "live" or "params".`);
    const gap = liveNano - paramsNanotonPerPrimes;
    if (gap >= -1n && gap <= 1n) return { nanotonPerPrimes: liveNano, source: 'live' };
    throw new Error(
        `the ledger's live floor is ${liveNano} nanoGRAM/PRIMES but params.json says ${paramsNanotonPerPrimes} ` +
            `(${(Number(paramsNanotonPerPrimes) / Number(liveNano)).toFixed(3)}x). An empty pool's first deposit sets ` +
            'its price for good. Set PRIMES_LP_FLOOR=live to open at p_f, or PRIMES_LP_FLOOR=params to open at the ' +
            "sim's figure on purpose."
    );
}

/**
 * Refuse a genesis whose DeDust pool or PRIMES jetton vault is keyed on a different jetton
 * master than the one it is about to deploy (`MISTAKES.md` 2026-11-12). Both are pure
 * derivations of the master's address, which is a hash of its CODE: a pool created from a
 * stale `contracts/build/` is a healthy pool for a token that will never exist, and genesis
 * would bake it into the ratchet's venue and the LP sink's and treasury's one-shot
 * bootstraps. `master` must come from the same code cells the run deploys, so no build
 * order can make this pass wrongly. `runGet` is the caller's get-method transport.
 */
export async function assertDedustKeyedOnMaster(
    runGet: (addr: Address, method: string, args: TupleItem[]) => Promise<TupleReader>,
    master: Address,
    pool: Address,
    jettonVault: Address
): Promise<void> {
    const asset = jettonAsset(master);
    const wantPool = (
        await runGet(DEDUST_FACTORY, 'get_pool_address', [
            { type: 'int', value: BigInt(POOL_TYPE_VOLATILE) },
            { type: 'slice', cell: assetCell({ kind: 'native' }) },
            { type: 'slice', cell: assetCell(asset) },
        ])
    ).readAddress();
    const wantVault = (await runGet(DEDUST_FACTORY, 'get_vault_address', [{ type: 'slice', cell: assetCell(asset) }])).readAddress();
    const bad: string[] = [];
    if (!wantPool.equals(pool)) bad.push(`PRIMES_DEDUST_POOL_ADDR is ${pool}, but this run's pool is ${wantPool}`);
    if (!wantVault.equals(jettonVault)) bad.push(`PRIMES_DEDUST_JETTON_VAULT_ADDR is ${jettonVault}, but this run's vault is ${wantVault}`);
    if (bad.length) {
        throw new Error(
            `Refusing to run: the DeDust addresses are not keyed on the jetton master this run deploys (${master}).\n  ` +
                bad.join('\n  ') +
                '\nRe-run createDedustPool.ts (after `npx blueprint build --all`) and paste the lines it prints.'
        );
    }
}
