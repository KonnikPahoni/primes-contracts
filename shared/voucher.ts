/**
 * TON PRIMES — the §9.5 voucher payload, defined once.
 *
 * `contracts/contracts/primes_voucher.tolk` hashes a cell and checks an Ed25519
 * signature over that hash. Two separate pieces of software have to build that
 * cell byte for byte: the BACKEND signer (`backend/attribution`) and the test/
 * deploy harness (`contracts/wrappers/PrimesVoucher.ts`). If they ever disagree,
 * the failure mode is not a crash — it is a batch of vouchers that look perfectly
 * valid, are signed by the right key, and are rejected on-chain with
 * `voucher_bad_signature`. Players would see a claim button that never works.
 *
 * So the cell is built HERE, once, and both importers use it. This file is the
 * same kind of single-source-of-truth as `opcodes.ts` and for the same reason.
 *
 * The domain tags are the other half of that safety: a burn authorisation and a
 * payout authorisation differ in shape AND in their leading 32 bits, so neither
 * can ever be replayed as the other.
 */

import { Address, beginCell, Cell } from '@ton/core';
import params from './params.json';

/** "CLAM" — the payout payload's domain separator. */
export const VOUCHER_CLAIM_TAG = 0x434c414d;
/** "BURN" — the retire-the-program payload's domain separator. */
export const VOUCHER_BURN_TAG = 0x4255524e;

/**
 * §9.4's vault track this program draws on — "QSTS". The AMOUNT is not here: it
 * is the bounty vault's allow-list entry, fixed at genesis from params.json
 * `genesis.era_bounty_schedule.remaining_vault_split.tracks.quests.primes`. This
 * is only the tag that names the bucket, which the vault asserts against.
 */
export const PROGRAM_TAG_QUESTS = 0x51535453;

/**
 * D-170's security prize — "SECU". A second instance of the same voucher code on its
 * own owner-held key, allow-listed at genesis for
 * `remaining_vault_split.tracks.security_bounty.primes`.
 */
export const PROGRAM_TAG_SECURITY = 0x53454355;

/**
 * G78 / D-171 — "PQST": the third instance, on its own attribution key since audit
 * 2026-11-19 R2-M2 (D-171's 2026-11-20 amendment), that pays §9.4's contract-fact quests
 * (prime, recruit, game, referral) out of `remaining_vault_split.tracks.prime_quests.primes`.
 */
export const PROGRAM_TAG_PRIME_QUESTS = 0x50515354;

const NANO = 1_000_000_000n;

/**
 * Audit 2026-11-19 R2-M2 — the most each instance may ever pay ONE wallet, in nano-PRIMES.
 * Deploy data on the contract (`VoucherInit.maxPerWallet`, refused 716 above it) and the
 * backend signer's own refusal, so both read this one definition, from params.json:
 *
 *   QSTS — one wallet's whole §9.4 social board, `quest_rewards.reward_nanoprimes`;
 *   PQST — one wallet's whole contract-fact board, `quest_rewards.prime_quests.reward_primes`;
 *   SECU — the whole `security_bounty` track: D-170 pays ONE prize to ONE wallet.
 *
 * Every QSTS quest is a row inside `reward_nanoprimes` since D-118's 2026-11-20 amendment folded
 * `story-verified-reach` (a legacy GRAM figure, ~6,191 PRIMES at the genesis floor) into the
 * social board; backend/attribution's `quest-caps.test.ts` fails if a board outgrows its cap.
 */
export const VOUCHER_MAX_PER_WALLET: Readonly<Record<number, bigint>> = {
    [PROGRAM_TAG_QUESTS]: BigInt(params.genesis.quest_rewards.reward_nanoprimes),
    [PROGRAM_TAG_PRIME_QUESTS]: BigInt(params.genesis.quest_rewards.prime_quests.reward_primes) * NANO,
    [PROGRAM_TAG_SECURITY]:
        BigInt(params.genesis.era_bounty_schedule.remaining_vault_split.tracks.security_bounty.primes) * NANO,
};

/**
 * EARN_PLAN §3: the minimum notice retiring the program must give, in seconds
 * (90 days). Asserted on-chain, so "ends the program without stranding anyone's
 * earned balance" is checkable rather than editorial. A FLOOR — more notice is
 * allowed, less is refused.
 */
export const VOUCHER_BURN_MIN_GRACE = 7_776_000;

/**
 * Each network's global id (config param 19), which the contract reads with `blockchain.configParam(19)` and
 * hashes (audit 2026-11-19 M2). The instance address cannot tell testnet from mainnet: the
 * genesis wallet is v4r2, so one mnemonic deploys every voucher at the same address on both.
 */
export const NETWORK_GLOBAL_ID = { mainnet: -239, testnet: -3 } as const;

/**
 * The global id for a `TON_NETWORK` value, or `undefined` when it is unset or names no known
 * network. Strict on purpose: a signer that cannot name its network signs nothing, where
 * `loadNetwork()` would default an unset value to testnet.
 */
export function voucherGlobalId(network: string | undefined): number | undefined {
  const n = network?.trim().toLowerCase();
  return n === 'mainnet' || n === 'testnet' ? NETWORK_GLOBAL_ID[n] : undefined;
}

/**
 * The exact cell the contract hashes for a claim.
 *
 * `wallet` is in the HASH and not in the message body: that is the whole of
 * non-transferability. The contract checks the signature against its own
 * `senderAddress`, so a voucher can only ever pay whoever redeems it, and a
 * leaked voucher is useless to anybody but its subject.
 *
 * `validUntil` is in the hash so the backend can put a short life on a voucher
 * without the contract needing a revocation list — a short TTL *is* the
 * revocation mechanism.
 *
 * `globalId` and `voucher` are the network and the instance's own address (audit
 * 2026-11-19 M2), so one signing key reused across deployments cannot carry a voucher from
 * one to another. `globalId` comes FIRST so that a call written for an older payload is a
 * type error, not a silently different hash.
 */
export function voucherClaimPayload(
  /** The network's global id, `NETWORK_GLOBAL_ID` (M2): a voucher pays on one network only. */
  globalId: number,
  /** The voucher INSTANCE's own address (audit 2026-11-19 M2): a voucher pays on one deployment only. */
  voucher: Address,
  wallet: Address,
  cumulativeTotal: bigint,
  validUntil: number,
  /** The instance's track tag (G78 / D-171): a voucher pays on one instance only. */
  programTag: number = PROGRAM_TAG_QUESTS
): Cell {
  return beginCell()
    .storeUint(VOUCHER_CLAIM_TAG, 32)
    .storeUint(programTag, 32)
    .storeInt(globalId, 32)
    .storeAddress(voucher)
    .storeAddress(wallet)
    .storeCoins(cumulativeTotal)
    .storeUint(validUntil, 32)
    .endCell();
}

/** The exact cell the contract hashes for a burn authorisation, bound to one network and instance (M2). */
export function voucherBurnPayload(
  globalId: number,
  voucher: Address,
  claimDeadline: number,
  programTag: number = PROGRAM_TAG_QUESTS
): Cell {
  return beginCell()
    .storeUint(VOUCHER_BURN_TAG, 32)
    .storeUint(programTag, 32)
    .storeInt(globalId, 32)
    .storeAddress(voucher)
    .storeUint(claimDeadline, 32)
    .endCell();
}
