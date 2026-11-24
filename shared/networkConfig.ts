/**
 * Per-network deploy facts — `shared/networks/{testnet,mainnet}.yaml`, parsed and checked.
 *
 * WHY THIS EXISTS. Every value here used to be an env var in `/.env`, and the laptop's
 * `.env` is a TESTNET file: on 2026-11-24 it still carried a 0.5 GRAM naming fee, a 2 GRAM
 * rename fee, a 50 GRAM donation and a 1-hour auction clock, all of which a mainnet
 * genesis would have read and baked into deploy data no message can change. One file per
 * network, selected by the network the run actually targets, ends that: a mainnet run can
 * only ever read `mainnet.yaml`, and `mainnet.yaml` has no place to put a test knob.
 *
 * WHAT GOES HERE: non-secret values that are fixed per NETWORK. What does not: secrets
 * (mnemonics, signer keys, API keys stay in `/.env`), per-RUN values (the deploy subwallet
 * id, the proposer, the DeDust pool and jetton vault — they move with every genesis and each
 * has its own preflight assert), and the deployed contract addresses services read.
 *
 * WHAT DOES NOT GO HERE EITHER: any economic parameter. Mainnet's rename fee, donation,
 * seed, auction clock and stake minimum are `shared/params.json`'s (CLAUDE.md rule 3), so
 * `mainnet.yaml` does not restate them. `testnet.yaml` may LOWER them in its
 * `test_overrides` block, and only there.
 *
 * Pure: takes the file's text, reads nothing. Callers read the file (the contracts scripts
 * are CommonJS, the keeper is ESM) through `readNetworkConfig` in their own package.
 */
import { Address } from "@ton/core";
import { parse } from "yaml";

export type Network = "testnet" | "mainnet";

/** The five §4.3.2 / D-151 staked-reserve venue addresses. Mainnet only: testnet deploys a mock. */
export interface StakingVenueConfig {
  tonstakersPool: string | null;
  dedustTstonVault: string | null;
  dedustTstonPool: string | null;
  ratchetTstonWallet: string | null;
  treasuryTstonWallet: string | null;
}

/** Testnet-only reductions of `params.json` figures. Every field absent = the spec figure. */
export interface TestOverrides {
  renameFeeTon?: number;
  donateTon?: number;
  seedTon?: number;
  auctionSeconds?: number;
  stakeMinTon?: number;
}

export interface NetworkConfig {
  network: Network;
  /** Forfeit remainder + TEP-66 royalty destination. Deploy data, no setter. */
  operatorAddr: string | null;
  /** DeDust's native (GRAM) vault — the same for every genesis on a network. */
  dedustNativeVault: string | null;
  /** D-212 first-naming fee in GRAM. Mainnet: 50 EUR at the genesis-day rate (launch gate M5). */
  nameFeeTon: number | null;
  presentation: {
    collectionMetadataUri: string;
    nftContentPrefix: string;
    jettonMetadataUri: string;
  };
  stakingVenue: StakingVenueConfig | null;
  testOverrides: TestOverrides;
}

/**
 * Every env var this file replaced. A run that still finds one set refuses: the old
 * variable would otherwise sit in `.env` looking authoritative while nothing read it — or,
 * worse, while some script nobody migrated still did.
 */
export const RETIRED_ENV_VARS: readonly string[] = [
  "PRIMES_OPERATOR_ADDR",
  "PRIMES_DEDUST_VAULT_ADDR",
  "PRIMES_NAME_FEE_TON",
  "PRIMES_RENAME_FEE_TON",
  "PRIMES_DONATE_TON",
  "PRIMES_TESTNET_SEED_TON",
  "PRIMES_AUCTION_SECONDS",
  "PRIMES_STAKE_MIN_TON",
  "PRIMES_COLLECTION_METADATA_URI",
  "PRIMES_NFT_CONTENT_PREFIX",
  "PRIMES_JETTON_METADATA_URI",
  "PRIMES_TONSTAKERS_POOL_ADDR",
  "PRIMES_DEDUST_TSTON_VAULT_ADDR",
  "PRIMES_DEDUST_TSTON_POOL_ADDR",
  "PRIMES_RATCHET_TSTON_WALLET_ADDR",
  "PRIMES_TREASURY_TSTON_WALLET_ADDR",
  "KEEPER_FLUSH_COOLDOWN_SECONDS",
];

/** Names of retired vars that are set (non-empty — compose passes `${VAR:-}` as ""). */
export function retiredEnvVarsSet(get: (name: string) => string | undefined): string[] {
  return RETIRED_ENV_VARS.filter((k) => {
    const v = get(k);
    return v !== undefined && v.trim() !== "";
  });
}

/** Blueprint says "mainnet" / "testnet" / "custom"; anything not testnet gets mainnet's file and rules. */
export function configNetworkFor(network: string): Network {
  return network === "testnet" ? "testnet" : "mainnet";
}

const TOP_KEYS = [
  "network",
  "operator_addr",
  "dedust_native_vault",
  "name_fee_ton",
  "presentation",
  "staking_venue",
  "test_overrides",
] as const;
const PRESENTATION_KEYS = ["collection_metadata_uri", "nft_content_prefix", "jetton_metadata_uri"] as const;
const VENUE_KEYS = [
  "tonstakers_pool",
  "dedust_tston_vault",
  "dedust_tston_pool",
  "ratchet_tston_wallet",
  "treasury_tston_wallet",
] as const;
const OVERRIDE_KEYS = ["rename_fee_ton", "donate_ton", "seed_ton", "auction_seconds", "stake_min_ton"] as const;

function onlyKeys(where: string, obj: Record<string, unknown>, allowed: readonly string[]): void {
  const extra = Object.keys(obj).filter((k) => !allowed.includes(k));
  if (extra.length) throw new Error(`${where}: unknown key(s) ${extra.join(", ")} (allowed: ${allowed.join(", ")})`);
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * An address in user-friendly form whose testnet flag matches the file. A `kQ…` testnet
 * address parses on mainnet too, so the flag is the only thing that stops a testnet
 * operator wallet being pasted into `mainnet.yaml`.
 */
function address(where: string, v: unknown, network: Network): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v !== "string" || !Address.isFriendly(v)) {
    throw new Error(`${where}: must be a user-friendly address (EQ…/UQ… or kQ…/0Q…), got ${JSON.stringify(v)}`);
  }
  const { isTestOnly } = Address.parseFriendly(v);
  if (isTestOnly !== (network === "testnet")) {
    throw new Error(
      `${where}: ${v} is a ${isTestOnly ? "testnet" : "mainnet"}-flagged address in ${network}.yaml`
    );
  }
  return v;
}

function positive(where: string, v: unknown): number | undefined {
  if (v === null || v === undefined) return undefined;
  if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) {
    throw new Error(`${where}: must be a positive number, got ${JSON.stringify(v)}`);
  }
  return v;
}

function uri(where: string, v: unknown): string {
  if (typeof v !== "string" || !/^https:\/\/\S+$/.test(v)) {
    throw new Error(`${where}: must be an https:// URI, got ${JSON.stringify(v)}`);
  }
  return v;
}

/**
 * Parse and SHAPE-check one network file. A value the next genesis still needs may be
 * `null` here (mainnet's name fee is chosen on the day); `requireGenesisReady` is the
 * check a deploy runs.
 */
export function parseNetworkConfig(text: string, network: Network): NetworkConfig {
  const file = `${network}.yaml`;
  const raw: unknown = parse(text);
  if (!isObject(raw)) throw new Error(`${file}: must be a YAML mapping`);
  onlyKeys(file, raw, TOP_KEYS);
  if (raw.network !== network) {
    throw new Error(`${file}: says network: ${JSON.stringify(raw.network)}, expected ${network}`);
  }

  const pres = raw.presentation;
  if (!isObject(pres)) throw new Error(`${file}: presentation must be a mapping`);
  onlyKeys(`${file} presentation`, pres, PRESENTATION_KEYS);
  const nftContentPrefix = uri(`${file} presentation.nft_content_prefix`, pres.nft_content_prefix);
  // The collection concatenates `<n>.json` onto it with no separator (primes_collection.tolk).
  if (!nftContentPrefix.endsWith("/")) {
    throw new Error(`${file} presentation.nft_content_prefix must end with "/" (got ${nftContentPrefix})`);
  }

  let stakingVenue: StakingVenueConfig | null = null;
  if (raw.staking_venue !== undefined && raw.staking_venue !== null) {
    if (network === "testnet") {
      throw new Error(
        `${file}: staking_venue is mainnet-only — testnet genesis deploys the mock Tonstakers pool (D-151)`
      );
    }
    const v = raw.staking_venue;
    if (!isObject(v)) throw new Error(`${file}: staking_venue must be a mapping`);
    onlyKeys(`${file} staking_venue`, v, VENUE_KEYS);
    stakingVenue = {
      tonstakersPool: address(`${file} staking_venue.tonstakers_pool`, v.tonstakers_pool, network),
      dedustTstonVault: address(`${file} staking_venue.dedust_tston_vault`, v.dedust_tston_vault, network),
      dedustTstonPool: address(`${file} staking_venue.dedust_tston_pool`, v.dedust_tston_pool, network),
      ratchetTstonWallet: address(`${file} staking_venue.ratchet_tston_wallet`, v.ratchet_tston_wallet, network),
      treasuryTstonWallet: address(`${file} staking_venue.treasury_tston_wallet`, v.treasury_tston_wallet, network),
    };
  }

  const testOverrides: TestOverrides = {};
  if (raw.test_overrides !== undefined && raw.test_overrides !== null) {
    if (network !== "testnet") {
      throw new Error(
        `${file}: test_overrides is testnet-only. Mainnet's fees, donation, clock and stake minimum ` +
          "are shared/params.json's, and they land in deploy data no message can change (M2, M5)."
      );
    }
    const o = raw.test_overrides;
    if (!isObject(o)) throw new Error(`${file}: test_overrides must be a mapping`);
    onlyKeys(`${file} test_overrides`, o, OVERRIDE_KEYS);
    testOverrides.renameFeeTon = positive(`${file} test_overrides.rename_fee_ton`, o.rename_fee_ton);
    testOverrides.donateTon = positive(`${file} test_overrides.donate_ton`, o.donate_ton);
    testOverrides.seedTon = positive(`${file} test_overrides.seed_ton`, o.seed_ton);
    testOverrides.auctionSeconds = positive(`${file} test_overrides.auction_seconds`, o.auction_seconds);
    testOverrides.stakeMinTon = positive(`${file} test_overrides.stake_min_ton`, o.stake_min_ton);
  }

  return {
    network,
    operatorAddr: address(`${file} operator_addr`, raw.operator_addr, network),
    dedustNativeVault: address(`${file} dedust_native_vault`, raw.dedust_native_vault, network),
    nameFeeTon: positive(`${file} name_fee_ton`, raw.name_fee_ton) ?? null,
    presentation: {
      collectionMetadataUri: uri(`${file} presentation.collection_metadata_uri`, pres.collection_metadata_uri),
      nftContentPrefix,
      jettonMetadataUri: uri(`${file} presentation.jetton_metadata_uri`, pres.jetton_metadata_uri),
    },
    stakingVenue,
    testOverrides,
  };
}

/**
 * D-139 — THE TEST CLOCK, written as a DURATION in `testnet.yaml` and deployed as a DIVISOR.
 *
 * `test_overrides.auction_seconds` is how long an ascending auction runs on the set; mainnet
 * is 604800 (7 days), divisor 1. ONE divisor drives every clock in a set, so a testnet 3600
 * also gives a ~8.5-minute flush cooldown and governance vote. It must divide 604800 exactly
 * (nobody should have to reason about a rounded window), and the divisor may not pass
 * `BID_EXTENSION` = 4020, where the anti-snipe extension would floor to zero.
 */
export const MAINNET_AUCTION_SECONDS = 604800;

export function clockDivisorOf(cfg: NetworkConfig): number {
  const seconds = cfg.testOverrides.auctionSeconds;
  if (seconds === undefined) return 1;
  if (!Number.isInteger(seconds) || seconds > MAINNET_AUCTION_SECONDS) {
    throw new Error(`test_overrides.auction_seconds must be an integer in 1..${MAINNET_AUCTION_SECONDS} (got ${seconds})`);
  }
  if (MAINNET_AUCTION_SECONDS % seconds !== 0) {
    throw new Error(
      `test_overrides.auction_seconds must divide ${MAINNET_AUCTION_SECONDS} exactly ` +
        `(got ${seconds}; try 604800, 86400, 7200, 3600, 1800 or 600)`
    );
  }
  const divisor = MAINNET_AUCTION_SECONDS / seconds;
  if (divisor > 4020) {
    throw new Error(
      `test_overrides.auction_seconds=${seconds} implies a clock divisor of ${divisor}, ` +
        "past the 4020 ceiling (the bid extension would floor to 0 seconds)"
    );
  }
  return divisor;
}

/**
 * D-153 — THE TEST STAKE FLOOR, written as a MINIMUM in `testnet.yaml` and deployed as a
 * DIVISOR of `specStakeMinTon` (`params.json` `staked_reserve.stake_min_ton`). Unlike the
 * clock it need not divide evenly — the ratchet's `STAKE_MIN / divisor` is integer nanotons —
 * so the divisor is rounded and the EFFECTIVE minimum is returned for the caller to print.
 */
export function stakeMinOf(cfg: NetworkConfig, specStakeMinTon: number): { divisor: number; effectiveTon: number } {
  const want = cfg.testOverrides.stakeMinTon;
  if (want === undefined) return { divisor: 1, effectiveTon: specStakeMinTon };
  if (want > specStakeMinTon) {
    throw new Error(
      `test_overrides.stake_min_ton must be in (0, ${specStakeMinTon}] (got ${want}): it can only ` +
        "lower the declared figure, never raise it."
    );
  }
  const divisor = Math.max(1, Math.round(specStakeMinTon / want));
  if (divisor > 65535) {
    throw new Error(
      `test_overrides.stake_min_ton=${want} implies a stake divisor of ${divisor}, past the uint16 ceiling of 65535`
    );
  }
  return { divisor, effectiveTon: specStakeMinTon / divisor };
}

/** Narrow a nullable field for a genesis run, naming the file and key that must be filled in. */
export function requireValue<T>(cfg: NetworkConfig, key: string, v: T | null | undefined): T {
  if (v === null || v === undefined) {
    throw new Error(`shared/networks/${cfg.network}.yaml: ${key} is not set, and this run needs it`);
  }
  return v;
}

/** The fields every genesis reads, all present. Mainnet also needs the full staking venue. */
export function requireGenesisReady(cfg: NetworkConfig): void {
  requireValue(cfg, "operator_addr", cfg.operatorAddr);
  requireValue(cfg, "dedust_native_vault", cfg.dedustNativeVault);
  requireValue(cfg, "name_fee_ton (D-212: 50 EUR at the genesis-day rate — launch gate M5)", cfg.nameFeeTon);
  if (cfg.network === "mainnet") {
    const v = requireValue(cfg, "staking_venue", cfg.stakingVenue);
    for (const [k, val] of Object.entries(v)) requireValue(cfg, `staking_venue.${k}`, val);
  }
}
