/**
 * TON PRIMES — the §9.5 voucher signer. EARN_PLAN E3.3.
 *
 * Signs `(tag, program_tag, global_id, voucher, wallet, cumulative_total, valid_until)` —
 * `shared/voucher.ts`'s `voucherClaimPayload` — with Ed25519 so a player can
 * redeem an off-chain-scored quest reward themselves. The contract that honours
 * these is `contracts/contracts/primes_voucher.tolk`; the signed cell is built by
 * `shared/voucher.ts`, which the contract's own test/deploy harness imports too,
 * rather than being reimplemented here — a signer that agrees with the contract
 * informally is a signer that eventually issues perfectly-signed vouchers the
 * chain rejects.
 *
 * ---- What this module refuses to do, and why each refusal is here ----
 *
 * 1. IT WILL NOT SIGN A REWARD WITH NO ATTRIBUTED ON-CHAIN MINT BEHIND IT.
 *    Owner decision 0.2.1, and §9.4's own reasoning: counted Telegram starts are
 *    Telegram accounts, and those cost cents — "the one place the growth stack was
 *    cheaper to farm than to use". The gate is enforced HERE as well as being
 *    stated in the bot's and the webapp's copy, because a gate that lives only in
 *    copy is not a gate. `mintGate` is a required argument; there is no default.
 *
 *    BUT — and this is the whole of B-5 — a required argument is only as strong as
 *    the caller that fills it. `buildAttributionServer`'s `/voucher` route once
 *    filled it from `req.body.offChain`, which made the gate a field the claimant
 *    ticked, and `earnedPrimes` a figure the claimant chose. The signer refused
 *    nothing, correctly, all the way to a signature. So the refusal below is one
 *    half of a mechanism whose other half lives in `server.ts`: the route now takes
 *    NO quest facts from its request and derives them through `VoucherFactSource`,
 *    and a signer wired without a derivation is refused rather than fallen back on.
 *    If you are reading this because you are about to add a second caller: it owes
 *    the same derivation, from a source the requester cannot write to. There is no
 *    check in this file that can save you from getting that wrong.
 *
 * 2. IT WILL NOT SIGN A TOTAL THAT WENT DOWN. The contract pays
 *    `cumulative_total - already_paid` and stores the total, so a total that ever
 *    decreases pays zero forever after — the difference is not clawed back, it is
 *    STRANDED. So the signer keeps its own high-water mark per wallet and refuses
 *    to go backwards, which turns a scoring bug into a refusal instead of into a
 *    player's balance quietly disappearing.
 *
 * 3. IT WILL NOT SIGN AFTER THE PROGRAM IS BURNED. Once the key is retired the
 *    honest thing is to stop issuing, not to keep writing paper against a contract
 *    whose deadline is running down. The contract keeps honouring vouchers already
 *    out (that is what the 90-day grace is for); the signer stops making new ones.
 *
 * 4. IT NEVER MIXES THE TWO PROGRAMS. `DECISIONS.md` D-171: no contract ever verified a
 *    quest in its own claim transaction, so the contract-fact tracks (referral, recruit,
 *    prime, game) are paid by a SECOND instance, `PQST`. Since audit 2026-11-19 R2-M2 (D-171
 *    amended 2026-11-20) each program has its OWN KEY and its own `VoucherSigner` instance
 *    (`index.ts`), so one leaked key reaches one track. Each program also has its own tag in
 *    the signed hash, its own high-water mark and its own total from
 *    `voucherEarnedPrimes(…, program)` — so a `QSTS` voucher never redeems on `PQST`, and
 *    one program's regression can never be hidden by the other's growth. The PQST total
 *    is built from chain facts the event index and the read-proxy observed, never from
 *    the request.
 *
 * 5. IT NEVER SIGNS FOR AN INSTANCE IT CANNOT NAME. Audit 2026-11-19 M2: the signed hash
 *    carries the NETWORK's global id and the voucher instance's own ADDRESS, so a key
 *    reused on another deployment (testnet then mainnet, or a redeploy) cannot carry a
 *    voucher across. The address alone is not enough: a v4r2 genesis wallet deploys every
 *    instance at the same address on both networks. The network is `TON_NETWORK` and each
 *    program's address is the deployment's (`PRIMES_VOUCHER_ADDRESS`,
 *    `PRIMES_PRIME_QUESTS_VOUCHER_ADDRESS`); with either missing it refuses.
 *
 * 6. IT WILL NOT SIGN A TOTAL ABOVE THE PROGRAM'S PER-WALLET CAP. Audit 2026-11-19 R2-M2: the
 *    contract refuses such a claim (716), so a voucher above it is worthless — and signing it
 *    would first raise the high-water mark above every payable total, so rule 2 would then
 *    refuse every honest voucher for that wallet for ever. Checked BEFORE the mark is written.
 *    The cap is `VOUCHER_MAX_PER_WALLET` in `shared/voucher.ts`, the figure genesis deploys.
 *
 * ---- Key handling ----
 *
 * The secret key never leaves this process and is never logged, not even at
 * length. The PUBLIC key is exposed on purpose: it is baked into the voucher
 * contract at deploy, so a holder can verify a voucher off-chain before spending
 * gas on it, and "the key that signs is the key the contract trusts" is checkable
 * by anyone against `getSignerState()`.
 */

import { Address } from "@ton/core";
import { keyPairFromSecretKey, sign, type KeyPair } from "@ton/crypto";
import {
  PROGRAM_TAG_PRIME_QUESTS,
  PROGRAM_TAG_QUESTS,
  VOUCHER_MAX_PER_WALLET,
  voucherClaimPayload,
} from "@ton-primes/shared/voucher";
import type { VoucherProgram } from "./quests.js";

/** The on-chain tag each program's instance carries (D-171). */
export const PROGRAM_TAG: Record<VoucherProgram, number> = {
  quests: PROGRAM_TAG_QUESTS,
  prime_quests: PROGRAM_TAG_PRIME_QUESTS,
};

/** Nano-PRIMES per whole PRIMES (TEP-74, 9 decimals). */
export const PRIMES_DECIMALS = 1_000_000_000n;

/** How long a signed voucher stays redeemable. Short on purpose: the contract has
 *  no revocation list, so a short life IS the revocation mechanism — a scoring
 *  correction takes effect within one voucher lifetime rather than never. */
export const VOUCHER_TTL_SECONDS = 3600;

export interface SignedVoucher {
  /** The wallet this voucher pays, and the only wallet that can redeem it. */
  wallet: string;
  /** Cumulative nano-PRIMES earned to date, as a decimal string (JSON-safe). */
  cumulativeTotal: string;
  /** Unix seconds. */
  validUntil: number;
  /** Ed25519 signature, hex. */
  signature: string;
  /**
   * What the contract will actually pay if this is redeemed right now: the total
   * minus what the contract has already paid this wallet. Advisory — the contract
   * recomputes it — but the UI must not show "claim 80 PRIMES" for a voucher that
   * will pay zero.
   */
  payableNow: string;
}

export interface VoucherSignerStore {
  /**
   * The highest cumulative total ever signed for this wallet ON THIS PROGRAM'S INSTANCE, in
   * nano-PRIMES. `instance` is the voucher contract's raw address (review of R2-M2): a mark
   * from an earlier genesis must never apply to a fresh deployment, whose receipts start at
   * zero — keyed by tag alone, an old mark refused the new program's honest totals for ever.
   * Old rows (migration 019) carry `""`, which no live signer reads.
   */
  getSignedHighWater(wallet: string, programTag: number, instance: string): Promise<bigint>;
  setSignedHighWater(wallet: string, total: bigint, programTag: number, instance: string): Promise<void>;
}

export class VoucherSignerError extends Error {
  constructor(
    message: string,
    readonly code:
      | "mint_gate_unmet"
      | "total_regressed"
      | "program_burned"
      | "nothing_earned"
      | "bad_wallet"
      | "program_unconfigured"
      | "total_above_cap"
  ) {
    super(message);
    this.name = "VoucherSignerError";
  }
}

export interface MintGate {
  /**
   * Whether at least one on-chain mint is attributed to this wallet's earning
   * activity. For the bot-connect reward and the story quest this is "an
   * attributed mint arrived on your label"; the caller decides which chain fact
   * satisfies it, but it must be a CHAIN fact.
   */
  attributedMintExists: boolean;
  /** The get-method or event the caller checked, for the audit line. */
  evidence: string;
}

export class VoucherSigner {
  private readonly keyPair: KeyPair;
  private readonly instances: Partial<Record<VoucherProgram, Address>>;

  /**
   * @param secretKey 64-byte Ed25519 secret key. Never logged.
   * @param globalId  The network's global id, `NETWORK_GLOBAL_ID` (M2): the hash binds it, because
   *                  the instance address is the same on testnet and mainnet.
   * @param instances Each program's voucher contract address, as configured (M2): the hash binds it.
   * @param burned    Set once the program has been retired on-chain (read from
   *                  `getSignerState().burnedAt`). A burned signer issues nothing.
   */
  constructor(
    secretKey: Buffer,
    private readonly store: VoucherSignerStore,
    private readonly globalId: number,
    instances: Partial<Record<VoucherProgram, string | undefined>>,
    private burned = false
  ) {
    this.keyPair = keyPairFromSecretKey(secretKey);
    this.instances = {};
    for (const [program, a] of Object.entries(instances) as [VoucherProgram, string | undefined][]) {
      if (a) this.instances[program] = Address.parse(a);
    }
  }

  /** The raw address of `program`'s instance, or undefined when it is not configured. The
   *  quest locks and the high-water mark are keyed by it (one namespace per deployment). */
  instanceRaw(program: VoucherProgram): string | undefined {
    return this.instances[program]?.toRawString();
  }

  /** The public key the voucher contract is deployed with. Safe to publish. */
  get publicKeyHex(): string {
    return this.keyPair.publicKey.toString("hex");
  }

  /** Mark the program burned. Irreversible here, as it is on-chain. */
  markBurned(): void {
    this.burned = true;
  }

  get isBurned(): boolean {
    return this.burned;
  }

  /**
   * Issue a voucher for `earnedPrimes` whole PRIMES.
   *
   * `alreadyPaidOnChain` is what the contract says it has paid this wallet
   * (`getPaid`), used only to fill `payableNow` so the UI can tell the difference
   * between "80 PRIMES to claim" and "80 PRIMES, already claimed".
   */
  async issue(args: {
    wallet: string;
    earnedPrimes: number;
    mintGate: MintGate;
    alreadyPaidOnChain?: bigint;
    now?: Date;
    /** D-171 — which instance this voucher is for. Defaults to the quests program. */
    program?: VoucherProgram;
  }): Promise<SignedVoucher> {
    const { wallet, earnedPrimes, mintGate } = args;
    const program = args.program ?? "quests";
    const tag = PROGRAM_TAG[program];
    const instance = this.instances[program];
    const now = args.now ?? new Date();

    if (this.burned) {
      throw new VoucherSignerError(
        "the voucher program has been retired; vouchers already issued remain redeemable until the on-chain deadline",
        "program_burned"
      );
    }

    if (!instance) {
      throw new VoucherSignerError(`no voucher contract address configured for the ${program} program`, "program_unconfigured");
    }

    let parsed: Address;
    try {
      parsed = Address.parse(wallet);
    } catch {
      throw new VoucherSignerError(`not a TON address: ${wallet}`, "bad_wallet");
    }

    // THE GATE (decision 0.2.1). Checked before anything is computed, so a
    // farmed-reach account never even learns what it would have been worth.
    if (!mintGate.attributedMintExists) {
      throw new VoucherSignerError(
        "this reward pays after your first attributed on-chain mint — reach alone does not settle it (§9.4)",
        "mint_gate_unmet"
      );
    }

    const total = BigInt(Math.max(0, Math.floor(earnedPrimes))) * PRIMES_DECIMALS;
    if (total === 0n) {
      throw new VoucherSignerError("nothing earned on a voucher-settled track yet", "nothing_earned");
    }

    // R2-M2: never sign past what the contract will ever pay one wallet — and never let such a
    // total reach the high-water mark below, where it would strand every honest total after it.
    const cap = tag === undefined ? undefined : VOUCHER_MAX_PER_WALLET[tag];
    if (cap === undefined) {
      // `total > undefined` is false: an unmapped program would sign uncapped. Refuse instead.
      throw new VoucherSignerError(`no per-wallet cap is defined for the ${program} program`, "program_unconfigured");
    }
    if (total > cap) {
      throw new VoucherSignerError(
        `refusing to sign a total (${total}) above the ${program} program's per-wallet cap (${cap}); ` +
          `the contract would refuse it (716)`,
        "total_above_cap"
      );
    }

    // Never sign a total lower than one already signed. The contract treats the
    // total as a high-water mark, so a regression does not refund — it strands.
    // Keyed by the RAW form (B9): `EQ…`, `UQ…` and `0:…` are one wallet, and a mark per
    // spelling let a caller sign under a second spelling below the first one's mark.
    const key = parsed.toRawString();
    const instanceKey = instance.toRawString();
    const highWater = await this.store.getSignedHighWater(key, tag, instanceKey);
    if (total < highWater) {
      throw new VoucherSignerError(
        `refusing to sign a total (${total}) below the high-water mark already signed (${highWater}); ` +
          `the contract would pay zero and the difference would be stranded, not refunded`,
        "total_regressed"
      );
    }
    if (total > highWater) await this.store.setSignedHighWater(key, total, tag, instanceKey);

    const validUntil = Math.floor(now.getTime() / 1000) + VOUCHER_TTL_SECONDS;
    const signature = sign(
      voucherClaimPayload(this.globalId, instance, parsed, total, validUntil, tag).hash(),
      this.keyPair.secretKey
    );

    const paid = args.alreadyPaidOnChain ?? 0n;
    const payableNow = total > paid ? total - paid : 0n;

    return {
      wallet,
      cumulativeTotal: total.toString(),
      validUntil,
      signature: signature.toString("hex"),
      payableNow: payableNow.toString(),
    };
  }
}

export class InMemoryVoucherSignerStore implements VoucherSignerStore {
  private marks = new Map<string, bigint>();
  async getSignedHighWater(wallet: string, programTag: number, instance: string): Promise<bigint> {
    return this.marks.get(`${instance}|${programTag}:${wallet}`) ?? 0n;
  }
  async setSignedHighWater(wallet: string, total: bigint, programTag: number, instance: string): Promise<void> {
    this.marks.set(`${instance}|${programTag}:${wallet}`, total);
  }
}
