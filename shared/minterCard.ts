/**
 * The MINTER CARD — a wallet's rebate standing, one contract per (ledger, wallet)
 * (`contracts/contracts/primes_minter_card.tolk`, DECISIONS.md D-191 point 1).
 *
 * A mint is sent to the BENEFICIARY'S card, never to the ledger, and the first mint a
 * wallet is ever part of deploys the card — so every client that mints has to be able to
 * build the card's StateInit, and every reader has to find the card. Both need the code,
 * so the compiled code lives HERE, once: the webapp, the agent SDK, the backend readers
 * and the contract wrappers all derive the address from this one cell, and
 * `contracts/tests/MinterCard.spec.ts` fails if it drifts from what
 * `primes_minter_card.tolk` compiles to (regenerate: `node tools/sync-minter-card-code.mjs`).
 *
 * The init data is the card's `Storage` in its EMPTY state, field order load-bearing:
 * (ledgerAddr, owner, primesMinted:32, window:8, newcomerWindow:8, recruits:32,
 * newcomerOpened:1, seen:1, eraSeq:8, eraRecruits:32, inFlight:32, edgeSentAt:32). The ledger derives the same address
 * (`cardAddress` in primes_ledger.tolk) and trusts nothing that does not come from it.
 */
import { Address, beginCell, Cell, contractAddress, type StateInit } from "@ton/core";

export const MINTER_CARD_CODE_HEX =
  "b5ee9c724102230100063d000114ff00f4a413f4bcf2c80b0102016202160202cd030e020120040b020120050d04993e2464bc01f8083b51343e923e9234c7f4c1f4c1f4c7f480348034c1f4c7f4c7f4c7f44335cb096000000538c0b5cb093600000b38c08c4cc0b5cb093600000538c08d8175cb09360000090c600608090a01f830f89782103b9aca00bef2e067f892530ac705917f952cc000c300e2917f9af8232da181012cbec300e2f2e0682c9af8232da181012cb9c3009170e2547a98547a93927033de0ab32ec200930ea50ede2dc2009405b3c300923570e2930ca50cde2497535fc705b3c3009170e29c3a3b3f757ff823111140cc0ade240700e29236719926c2009306a406de06e25610c8fa52561001fa521fcb1f1dcb071bcb0719cb1f17ca00cf8314cb0712cb1f18cb1f1acb1fc9ed5409c8cec9c8cf926c00000617fa5218fa52cb1fcb07cb07cb1f14ca0012ca0012ccc9c8cf858812fa52cf841073fa0271cf0b65ccc98040fb0000e63df8922bc705f2e0640cd33f31fa48d31fd307d307d31fd200d70a001110111111100f11100f10ef10de10cd10bc10ab109a1089107807111207061112065612f0060bc8fa521afa5218cb1f16cb0714cb0712cb1fca00ca00cb07cb1fcb1fcb1fc9ed54c8cf8508fa5270cf0b6ec98042fb0000d83bf89229c705f2e0640ad33fd70b07530bbd933b70329130e203a401a428c8fa525280fa5217cb1f15cb0713cb0713cb1fca00cf8326cf0b0722cf0b1fcf900000000215cb1fc9ed54c8cf926c00000e14cb3ffa5213cb07cb1fc9c8cf850812fa5271cf0b6eccc98040fb0000788e3239f89227c705f2e06404a406c8fa5215fa5215cb1fcf841a14cb0712cb1fca00cf83cb0712cb1fcf9000000002cb1fc9ed54e05f09c700f2e0650201200c0d00733c0048300165cc208401312d0038083001258c2082bebc2038083000e58c20828583b038083000a58c20824c4b403830006560822625a0381c200045083098e48c1d78083087648c1d38083082648c1cf8083080a48c1cb83080245c781c200201200f12020120101100733c00c8300165cc208401312d0038083001258c2082bebc2038083000e58c20828583b038083000a58c20824c4b403830006560822625a0381c20004508248c1c78483000648c1cf8083000a48c1eb8083000e4cc2007b8300124a019381c20020120131400b31b088d00b080254af041b0c0245c38a4c2e902f78065d44731c16cf0c0248c5c38a596cd0d5c1c086386708024c970c0245c38a549f04170c0245c38a4c1e901f791d43889708027816948260d16dc1c1400dc0077c17791d42001f535cb09fffffffd3caff5d3340835c2c7e08426c000006f644c3835cb09360000033caffe920c7e9234c7f4c1f4c1f4c7f4803480350c747b51343e923e9234c7f4c1f4c1f4c7f480348034c1f4c7f4c7f4c7f442c44442c28444028427c423841f441b15555584bc0182f23e9486be948632c7c5b2c1c532c1c4a0150040cb1fca00ca00cb07cb1fcb1fcb1fc9ed54c8cf8508fa5270cf0b6ec98042fb000201201720020120181b02037960191a0063a79fda89a1f49063f49063a63e63a60e63a60e63a63fa40063a40063a60e63a63e63a63e63a63e63a241e00643e00843e00b00cba7a3da89a1f49063f49063a63fa60fa60fa63fa40063a40063a60e63a63e63a63e63a63e63a247e0044784010415f5e100e1c6084784010415f5e100e1c60847e0080fe0040d8401300b0415f5e101400bbc09840130090415f5e1014009bc05e008294026290201201c1d00dfb630dda89a1f49063f49063a63fa60fa60fa63fa401a40063a60fa63fa63e63a63e63a247e0064fe00251e0044de00847e00aeb0415f5e10059840042e1c60859840044e1c6085fe0045f8401244741bc5d8401244741bc5be00940211e20fc211abc7020d420b220f0208ebc46aa2500201661e1f005eaa2aed44d0fa4831fa4831d31f31d30731d307d31f31d200d20031d30731d31f31d31f31d31f31d175820afaf08058005eaadbed44d0fa4831fa4831d31fd307d30731d31f31d20031d20031d30731d31f31d31f31d31f31d121f00122f0025802012021220051b9093ed44d0fa4831fa4831d31f31d30731d30731d31f31d20031d20031d307d31fd31f31d31f31d18004fba6daed44d0fa48fa48d31f31d30731d30731d31f31d20031d200d30731d31f31d31f31d31f31d182bb8ff14";

let codeCell: Cell | null = null;
export function minterCardCode(): Cell {
  if (!codeCell) codeCell = Cell.fromBoc(Buffer.from(MINTER_CARD_CODE_HEX, "hex"))[0];
  return codeCell;
}

/** The card's init data in its empty state — see the header for the layout. */
export function minterCardData(ledger: Address, owner: Address): Cell {
  return beginCell()
    .storeAddress(ledger)
    .storeAddress(owner)
    .storeUint(0, 32) // primesMinted
    .storeUint(0, 8) // window
    .storeUint(0, 8) // newcomerWindow
    .storeUint(0, 32) // recruits
    .storeBit(false) // newcomerOpened
    .storeBit(false) // seen
    .storeUint(0, 8) // eraSeq
    .storeUint(0, 32) // eraRecruits
    .storeUint(0, 32) // inFlight
    .storeUint(0, 32) // edgeSentAt
    .endCell();
}

export function minterCardInit(ledger: Address, owner: Address, code: Cell = minterCardCode()): StateInit {
  return { code, data: minterCardData(ledger, owner) };
}

/** Where `owner`'s standing lives. Same answer as the ledger's `getMinterCardAddress(owner)`. */
export function minterCardAddress(ledger: Address, owner: Address, code?: Cell): Address {
  return contractAddress(0, minterCardInit(ledger, owner, code));
}
