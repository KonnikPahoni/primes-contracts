/**
 * TON PRIMES — deployed contract address registry.
 *
 * Single source of truth for "which address is the ledger / collection / etc" that every
 * backend service reads from. All addresses come from environment variables — nothing is
 * hardcoded, because the same code has to serve a live testnet deployment, a fresh redeploy,
 * and an unconfigured local stack. Testnet genesis is redeployed rather than patched whenever
 * storage layout or wire format moves (D-89/D-90/D-91 each forced one), so this comment names
 * no date: the current live addresses are recorded in docs/testnet-deployment.md and pasted
 * into the stack's .env (see .env.example).
 * This file only defines the *names* and *shape* of that configuration, so every address is
 * still `undefined` until the environment supplies it.
 *
 * Every backend service that reads chain state must go through this module (or its own
 * env parsing built the same way) so that "which contract did this number come from" is
 * always answerable — the CONCEPT.md §9.1 honesty constraint starts here.
 */

export type NetworkName = "mainnet" | "testnet";

export interface ContractAddresses {
  /**
   * UPGRADE_PLAN_V5.md §4 B1 / CONCEPT v5 §3.4: the monolith formerly called the
   * "bank" is decomposed into ledger + ratchet + registrar. (There was a fourth, the
   * escrow on the reservation shard; D-90 deleted it and there is no `escrow` field.) Each of the four satisfies
   * `balance ~= its own declared liability` in one `getSolvency` call, which is
   * what Phase D's §6 D7 reconciliation block renders.
   */
  ledger: string | undefined;
  ratchet: string | undefined;
  registrar: string | undefined;
  /*
   * `bank` is DELETED, and `PRIMES_BANK_ADDRESS` with it. It was the deprecated
   * alias for `ledger`, kept for "the one release the alias lives" while a
   * deployment configured before the §3.4 rename caught up. That release is long
   * past: the only .env in this repo that sets an address sets
   * `PRIMES_LEDGER_ADDRESS`, and the word "bank" is retired vocabulary. Do not
   * re-add it — a second env var for one contract is how a stale address survives
   * a genesis redeploy.
   */
  collection: string | undefined;
  jettonMaster: string | undefined;
  /**
   * DECISIONS.md D-3 / docs/audit/unified-market-layout.md — THE MARKET. One
   * router covering what used to be three addresses (`reservationBook`,
   * `auction`, `trophyAuction`), all three now deleted. Its escrow shards
   * (history: D-90 deleted them) were DERIVED from this address, never configured.
   */
  market: string | undefined;
  bountyVault: string | undefined;
  venueTimelock: string | undefined;
  /**
   * The stake master (`primes_stake.tolk`, CONCEPT.md §5.3, D-168): PRIMES locked for a
   * term, paid from the treasury's `distribute()` budget. Each wallet's positions live on
   * a child found with the master's `getStakePositionAddress(owner)`.
   */
  stake: string | undefined;
  /**
   * D-100 point 6 — `primes_vesting.tolk`, beneficiary = the treasury contract: the only
   * genesis PRIMES allocation since D-166 deleted the operator's lock. Not economic state:
   * the vest moves custody of an already-counted allocation, never `S` or `T`.
   */
  treasuryVesting: string | undefined;
  /** D-100 — `primes_treasury.tolk`, the governed treasury and LP-miner custody. */
  treasury: string | undefined;
  /** D-100 point 4 — `primes_lp_sink.tolk`. LP in, nothing out. */
  lpSink: string | undefined;
  /** G76 / CONCEPT §9.5 — `primes_voucher.tolk`, the signed-voucher program the vault's `quests` track pays through. */
  voucher: string | undefined;
  /** D-170 — the same voucher code on the owner's own key, allow-listed for the one security prize. */
  securityVoucher: string | undefined;
  /** G78 / D-171 — the voucher instance, on its own key since R2-M2, that pays §9.4's contract-fact quests. */
  primeQuestsVoucher: string | undefined;
}

export const CONTRACT_ENV_VARS: Record<keyof ContractAddresses, string> = {
  ledger: "PRIMES_LEDGER_ADDRESS",
  ratchet: "PRIMES_RATCHET_ADDRESS",
  registrar: "PRIMES_REGISTRAR_ADDRESS",
  collection: "PRIMES_COLLECTION_ADDRESS",
  jettonMaster: "PRIMES_JETTON_MASTER_ADDRESS",
  market: "PRIMES_MARKET_ADDRESS",
  bountyVault: "PRIMES_BOUNTY_VAULT_ADDRESS",
  venueTimelock: "PRIMES_VENUE_TIMELOCK_ADDRESS",
  stake: "PRIMES_STAKE_ADDRESS",
  treasuryVesting: "PRIMES_TREASURY_VESTING_ADDRESS",
  treasury: "PRIMES_TREASURY_ADDRESS",
  lpSink: "PRIMES_LP_SINK_ADDRESS",
  voucher: "PRIMES_VOUCHER_ADDRESS",
  securityVoucher: "PRIMES_SECURITY_VOUCHER_ADDRESS",
  primeQuestsVoucher: "PRIMES_PRIME_QUESTS_VOUCHER_ADDRESS",
};

/** Reads every PRIMES_*_ADDRESS env var. All are optional/undefined pre-deployment (Phase 4);
 *  Phase 5 sets them once the genesis script has run against testnet. Callers must handle
 *  `undefined` explicitly rather than assuming a live deployment exists. */
export function loadContractAddresses(env: NodeJS.ProcessEnv = process.env): ContractAddresses {
  const out = {} as ContractAddresses;
  for (const key of Object.keys(CONTRACT_ENV_VARS) as (keyof ContractAddresses)[]) {
    // Trimmed: a pasted address with a stray space or CR is the same address, not a bad one.
    out[key] = env[CONTRACT_ENV_VARS[key]]?.trim() || undefined;
  }
  return out;
}

/** Which TON network every backend service should target. Defaults to testnet — the plan
 *  is explicit that Phase 4/5 point at testnet, never mainnet, until Phase 7. */
export function loadNetwork(env: NodeJS.ProcessEnv = process.env): NetworkName {
  const n = (env.TON_NETWORK || "testnet").toLowerCase();
  if (n !== "mainnet" && n !== "testnet") {
    throw new Error(`TON_NETWORK must be "mainnet" or "testnet", got "${n}"`);
  }
  if (n === "mainnet" && env.ALLOW_MAINNET !== "true") {
    // Hard guard: Phase 4/5 backend code must never accidentally point at mainnet.
    // Set ALLOW_MAINNET=true explicitly (Phase 7 concern) to override.
    throw new Error(
      'TON_NETWORK=mainnet requires ALLOW_MAINNET=true to be set explicitly. ' +
        "This stack targets testnet by default (IMPLEMENTATION_PLAN.md Phase 4)."
    );
  }
  return n;
}

/**
 * GAUNTLET X4 — one env read, so the three endpoint helpers below cannot drift in how they
 * look one up. Empty string reads as unset: `docker-compose.yml`'s `${VAR:-}` expansion
 * makes an unconfigured variable an EMPTY one rather than an absent one, which has already
 * caused live 503s in this repo by defeating a `??` fallback.
 */
function readEnv(name: string): string | undefined {
  const v = typeof process !== "undefined" ? process.env?.[name] : undefined;
  return v && v.trim() ? v.trim() : undefined;
}

export function tonApiEndpoint(network: NetworkName): string {
  // X4, same rule: the NFT holder index and the video cache read through TonAPI, so it is a
  // third provider dependency and gets a third override rather than being the one that was
  // forgotten.
  return readEnv("TON_API_ENDPOINT") ?? (network === "mainnet" ? "https://tonapi.io" : "https://testnet.tonapi.io");
}

/** Base URL for TonCenter's v2 JSON-RPC surface (`POST {this}/jsonRPC`), which is what
 *  `@ton/ton`'s `TonClient` (used by read-proxy and keeper for live get-method / send-boc
 *  calls) actually speaks. This is the v2 JSON-RPC base — v3's REST base (used by
 *  event-poller) does NOT have a `/jsonRPC` route — appending `/jsonRPC` to it 500s. Found
 *  live during Phase 5 testnet testing: both read-proxy's and keeper's `src/index.ts` were
 *  doing exactly that mismatch (v3 base plus `/jsonRPC`), so every `TonClient` call 500'd
 *  against a real deployment even though `/health` was fine — see docs/phase5-report.md. */
export function toncenterRpcEndpoint(network: NetworkName): string {
  // GAUNTLET X4 — the PROVIDER IS CONFIGURATION, in one place, for every consumer.
  //
  // Every chain read in the system went through one company's endpoint with no override
  // anywhere but `read-index`'s own config, so switching provider meant editing five files
  // and three scripts under whatever pressure had made it necessary. The override lives on
  // the helper instead, so read-proxy, keeper, read-index, the agent SDK and the genesis
  // scripts all inherit it without knowing it exists.
  //
  // `TON_RPC_ENDPOINT` is the name to use — provider-neutral on purpose, because the point
  // of the item is that this is not permanently Toncenter.
  //
  // MUST speak Toncenter's v2 JSON-RPC: `@ton/ton`'s `TonClient` talks that dialect and
  // nothing else. Orbs TON Access is a proven, keyless drop-in — see
  // `docs/rpc-failover.md` for the measurement and the switch-over procedure.
  const override = readEnv("TON_RPC_ENDPOINT");
  if (override) return override;
  return network === "mainnet"
    ? "https://toncenter.com/api/v2/jsonRPC"
    : "https://testnet.toncenter.com/api/v2/jsonRPC";
}

/**
 * Base URL for Toncenter's v3 REST surface — the event-poller's PRIMARY indexer since
 * 2026-09-02 (`ToncenterEventSource`).
 *
 * A THIRD Toncenter base, and the three are not interchangeable: `toncenterRpcEndpoint`
 * above ends in `/api/v2/jsonRPC` and is JSON-RPC for `@ton/ton`'s `TonClient`; this one is
 * `/api/v3` and is plain REST (`GET {this}/transactions?account=…`). Appending `/jsonRPC`
 * to a v3 base 500s, and asking a v2 base for `/transactions` 404s.
 */
export function toncenterV3Endpoint(network: NetworkName): string {
  // X4. A SEPARATE override from the v2 one above, deliberately: the two bases are not
  // interchangeable (see this function's own comment), so one variable covering both would
  // guarantee that switching provider broke whichever consumer was not being thought about.
  const override = readEnv("TON_INDEX_ENDPOINT");
  if (override) return override;
  return network === "mainnet" ? "https://toncenter.com/api/v3" : "https://testnet.toncenter.com/api/v3";
}
