/**
 * The LOT BLOCK — one contract per (ledger, 256-number block) that holds the auction
 * marks for a block beyond the ledger's import frontier
 * (`contracts/contracts/primes_lot_block.tolk`, DECISIONS.md D-196).
 *
 * Only the ledger deploys or writes one, so no client needs this to send anything. It
 * lives here, like the minter card's code, so the contract wrappers and tests derive
 * the address from one cell; readers can instead ask the ledger's
 * `getLotBlockAddress(block)`. `contracts/tests/LotBlock.spec.ts` fails if this drifts
 * from what `primes_lot_block.tolk` compiles to (regenerate:
 * `node tools/sync-lot-block-code.mjs`).
 *
 * The init data is the block's `Storage` in its EMPTY state, field order load-bearing:
 * (ledgerAddr, block:64, claimed:256, soldPrime:256), where block = (n - 2) >> 8 and n's
 * bit is (n - 2) & 255 — the ledger's own bitmap chunk. The ledger derives the same
 * address (`lotBlockAddress` in primes_ledger.tolk).
 */
import { Address, beginCell, Cell, contractAddress, type StateInit } from "@ton/core";

export const LOT_BLOCK_CODE_HEX =
  "b5ee9c7241020f010002ad000114ff00f4a413f4bcf2c80b01020162020a02f6d0f8919130e020ed44d0fa48d33fd3ffd3fff40505d72c24e000000c8e5b36f89224c705f2e06405d33fd70bff20a6feab0724baf2e0c920a6fe8407b0ae5330b08e223035355bc8cf92c000020213cb3fcbffc9c8cf850812fa5271cf0b6eccc98040fb00e06c21b102c8fa52cb3fcbff12cbfff400c9ed54e089030400089c00000203fed7278e3336f89224c705f2e06405d33f31d70bff20a6feab0723baf2e0c9a6fe8407b0ae15b102c8fa52cb3f13cbff12cbfff400c9ed54e0d72c24e000001c8e313535f89223c705f2e06403d70b3fc8cf92c00001fecb3fcb3f12cbff12cbffc9c8cf850812fa5271cf0b6eccc98306fb00e0d72c24e0000024e30289d72705060700bc36f89224c705f2e06405d33f31f4052078f4866fa5908e1a5202fa00fa00d1c858fa0201fa02400778f443515178f47c6fa5e85f0322c8fa5212cb3fcbff13cbfff400c9ed54820898968072fb02c8cf8508fa5270cf0b6ec9810082fb0000089c0000050112e3025f06c700f2e0650801fe36f89224c705f2e06405d33fd70bff20a6feab0724baf2e0c920a6fe8407b0530678f40e6fa18e1c10685f08820898968072fb02c8cf8508fa5270cf0b6ec9810082fb00e1fa00fa00d1218477ba8e1c10795f09820898968072fb02c8cf8508fa5270cf0b6ec9810082fb00e08477c801fa0201fa02400878f44325c8fa5209007215cb3f13cbff16cbff12f400c9ed54820898968072fb02c8cf92c000020e14cb3f13cbff01fa02c9c8cf850812fa5271cf0b6eccc98306fb000201200b0e0201480c0d0021b4711da89a1f49063a67e63a7ffae17ff0006db520bda89a1f49063a67f0611ae43e80a454dfd560eb17b28b6e0a601c0034dfd080f6002f1e81cdf432860e0a601c3f401f401a2e2b300015bde3bf6a2687d246b859fc5153497a";

let codeCell: Cell | null = null;
export function lotBlockCode(): Cell {
  if (!codeCell) codeCell = Cell.fromBoc(Buffer.from(LOT_BLOCK_CODE_HEX, "hex"))[0];
  return codeCell;
}

/** The block's init data in its empty state — see the header for the layout. */
export function lotBlockData(ledger: Address, block: bigint | number): Cell {
  return beginCell()
    .storeAddress(ledger)
    .storeUint(BigInt(block), 64)
    .storeUint(0, 256) // claimed
    .storeUint(0, 256) // soldPrime
    .storeDict(undefined) // bookmarks — D-198, empty
    .endCell();
}

export function lotBlockInit(ledger: Address, block: bigint | number, code: Cell = lotBlockCode()): StateInit {
  return { code, data: lotBlockData(ledger, block) };
}

/** Where block `block`'s marks live while it is beyond the frontier. Same answer as the
 *  ledger's `getLotBlockAddress(block)`. */
export function lotBlockAddress(ledger: Address, block: bigint | number, code?: Cell): Address {
  return contractAddress(0, lotBlockInit(ledger, block, code));
}
