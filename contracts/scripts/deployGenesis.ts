/**
 * TON PRIMES — THE genesis deploy script. One script, two senders (GAUNTLET.md G55).
 *
 *   npx blueprint run deployGenesis --testnet --mnemonic
 *   npx blueprint run deployGenesis --mainnet --tonconnect
 *   npx tsx scripts/deployGenesis.ts --skew-safe        # testnet, clock-lagging machine
 *
 * Under blueprint, network selection and key custody are entirely blueprint's
 * (`--testnet` / `--mainnet`, `--mnemonic` / `--tonconnect` / `--tonhub`), so no
 * key material or endpoint lives in this repo. `--skew-safe` swaps in the
 * hand-rolled +600s sender from `scriptHost.ts` (why: see that file's header) —
 * testnet only, keyed from `/.env`'s DEPLOYER_MNEMONIC and
 * `PRIMES_DEPLOY_SUBWALLET_ID`. It replaces `deployGenesisSkewSafe.ts`, a 610-line
 * fork of this file that G55 deleted after the two had drifted apart. The genesis LOGIC is in genesisPipeline.ts
 * and is shared verbatim with the sandbox rehearsal
 * (contracts/tests/GenesisRehearsal.spec.ts), so what Phase 5 runs on testnet
 * is the same code path Phase 3 rehearsed.
 *
 * THE NETWORK'S DEPLOY FACTS come from `shared/networks/<network>.yaml`, chosen by the
 * network this run targets (`readNetworkConfig`): the operator wallet, DeDust's native
 * vault, the D-212 first-naming fee, the TEP-64 metadata URIs, and on mainnet the five
 * §4.3.2 / D-151 staked-reserve addresses. `mainnet.yaml` cannot carry a test knob;
 * `testnet.yaml`'s `test_overrides` may lower the rename fee, seed, auction clock and stake
 * minimum for a rehearsal. A run refuses while any env var those files replaced is set.
 *
 * Per-genesis values stay env vars, because they change with every run:
 *
 *   PRIMES_PROPOSER_ADDR      — the venue-timelock proposer key (the one
 *                               standing credential in the system); must be this
 *                               run's deploy wallet (`assertProposerMatchesSender`)
 *   PRIMES_DEDUST_POOL_ADDR   — DeDust PRIMES/GRAM pool (createDedustPool.ts)
 *   PRIMES_DEDUST_JETTON_VAULT_ADDR — DeDust PRIMES jetton vault (createDedustPool.ts)
 *   PRIMES_DEDUST_LP_STANDIN  — optional, "1", TESTNET ONLY (GAUNTLET.md R17):
 *                               when the pool above is a stand-in wallet with
 *                               no `get_wallet_address`, derive the LP sink's
 *                               and treasury's LP wallet from
 *                               `standInLpWalletFor` instead of aborting at
 *                               step 25b. Refused off testnet.
 *
 * The staked-reserve wallets are inputs and not derivations because the tsTON master is
 * TONSTAKERS', not ours — `getWalletAddress` on anything this repo deploys cannot answer
 * for them.
 *
 * D-46 (supersedes D-19 and CONCEPT §6 point 3's old founder-seed reading):
 * there is no LP leg in this pipeline any more. The three DeDust addresses
 * above are still required — they're baked into the ratchet's deploy-time
 * storage and queued on the venue timelock, deterministic and known before
 * anyone has added liquidity — but no GRAM or PRIMES is deposited into them by
 * this script, and there is nothing to burn here. The operator pairs the
 * PRIMES its genesis floor donation mints with its own GRAM into the DeDust
 * pool directly (DeDust's own permissionless deposit flow — anyone can add
 * liquidity). D-166: the operator has no genesis PRIMES allocation at all.
 *
 * `testnet.yaml`'s `test_overrides.seed_ton` overrides the nominal supply-sizing input
 * (`params.genesis.genesis_seed_ton` = 200, used only to size the treasury's vested
 * allocation and the bounty vault — never deposited) with a smaller figure. It is NOT a
 * free knob: see `resolveSeedTon` below for exactly which economic figures it distorts and
 * which it leaves intact. Nothing measured from an overridden deploy is evidence about
 * v5's genesis economics; it is evidence about the wire formats, the message flow, and the
 * deploy pipeline.
 */
import { execFileSync } from 'child_process';
import path from 'path';
import { Address, beginCell, toNano } from '@ton/core';
import { NetworkProvider } from '@ton/blueprint';
import {
    GenesisCode,
    GenesisEnv,
    GenesisParams,
    GenesisPresentation,
    genesisDonationTon,
    requireTrophyNpv,
    requireTrophyRest,
    runGenesis,
    validatePresentation,
    standInLpWalletFor,
    dryRunGenesisMasterAddress,
} from './genesisPipeline';
import { assertDedustKeyedOnMaster } from './dedust';
import { MockTonstakersPool } from '../wrappers/MockTonstakersPool';
import params from '../../shared/params.json';
import { REBATE_KIND } from '../../shared/opcodes';

import { hydrateProcessEnv, clockDivisorOf, resolveStakeMin, readNetworkConfig, type NetworkConfig } from './envFile';
import { requireGenesisReady, requireValue } from '../../shared/networkConfig';
import { ScriptHost, hostFromProvider, runSkewSafe } from './scriptHost';

// W10: `tsx` loads no `.env`, and every `process.env.PRIMES_*_ADDRESS` read below
// otherwise falls through to a hardcoded address from a genesis that is months dead
// — silently, because a dead-but-still-answering contract returns plausible numbers
// rather than an error. `hydrateProcessEnv()` is the one reader that ends that; it
// never overwrites a var the shell already set.
hydrateProcessEnv();

/**
 * G76 / CONCEPT §9.5 — a voucher instance's PUBLIC key, taken from the secret the
 * attribution service signs that program with (a 64-byte ed25519 secret in hex whose last
 * 32 bytes ARE the public key). One source, so the deployed key and the signing key cannot
 * disagree. Unset refuses: a genesis without it ships a track nobody can ever pay.
 *
 * Audit 2026-11-19 R2-M2 (D-171 amended 2026-11-20): one key per track —
 * `QUESTS_VOUCHER_SIGNER_SECRET_KEY` for QSTS, `PRIME_QUESTS_VOUCHER_SIGNER_SECRET_KEY`
 * for PQST. The pipeline refuses two instances on one key.
 */
function requireVoucherSignerPubkey(name: 'QUESTS_VOUCHER_SIGNER_SECRET_KEY' | 'PRIME_QUESTS_VOUCHER_SIGNER_SECRET_KEY'): Buffer {
    const raw = process.env[name];
    if (!raw && process.env.VOUCHER_SIGNER_SECRET_KEY) {
        // R2-M2 renamed the one key into two. Say so, rather than "must be set".
        throw new Error(
            `${name} is unset but VOUCHER_SIGNER_SECRET_KEY is set: audit R2-M2 split that key into ` +
                'QUESTS_VOUCHER_SIGNER_SECRET_KEY and PRIME_QUESTS_VOUCHER_SIGNER_SECRET_KEY — one key per track, ' +
                'generated separately. The old variable is no longer read.'
        );
    }
    if (!raw || !/^[0-9a-fA-F]{128}$/.test(raw)) {
        throw new Error(
            `${name} must be set to a 64-byte ed25519 secret key in hex ` +
                '(its voucher instance is deployed with its public half; G76, R2-M2)'
        );
    }
    return Buffer.from(raw, 'hex').subarray(32);
}

/**
 * D-170 — the security prize's PUBLIC key, 32 bytes in hex. Only the public half: the owner
 * keeps the secret offline and signs the one award by hand, so no service ever holds it.
 */
function requireSecuritySignerPubkey(): Buffer {
    const raw = process.env.SECURITY_BOUNTY_SIGNER_PUBKEY;
    if (!raw || !/^[0-9a-fA-F]{64}$/.test(raw)) {
        throw new Error(
            'SECURITY_BOUNTY_SIGNER_PUBKEY must be set to a 32-byte ed25519 public key in hex ' +
                '(the D-170 security prize voucher is deployed with it)'
        );
    }
    return Buffer.from(raw, 'hex');
}

function requireAddr(name: string): Address {
    const raw = process.env[name];
    if (!raw) throw new Error(`${name} is required (see this script's header)`);
    return Address.parse(raw);
}

/**
 * G17 (filed from E14a, 2026-08-29): the venue timelock's `Queue` arm checks its stored
 * `proposerAddr` (baked in at deploy time from `PRIMES_PROPOSER_ADDR`) against the SENDER of
 * `Queue` — which this script always sends as `env.proposerSender`, the SAME wallet as
 * `genesisSender`. If `PRIMES_PROPOSER_ADDR` names another wallet — e.g.
 * `PRIMES_DEPLOY_SUBWALLET_ID` was bumped for a fresh-subwallet redeploy without bumping the
 * proposer — the mismatch bakes silently into the timelock and surfaces 38 steps later when
 * `timelock:queue` bounces with `throw 800` (wrong_sender). That is what happened on the
 * 2026-08-29 genesis. Refuse before spending any gas. Applies under either sender.
 */
export function assertProposerMatchesSender(
    proposerAddr: Address,
    genesisAddress: Address,
    walletId: number | undefined
): void {
    if (!proposerAddr.equals(genesisAddress)) {
        throw new Error(
            `Refusing to run: PRIMES_PROPOSER_ADDR (${proposerAddr.toString({ testOnly: true })}) ` +
                `does not match the deploy wallet that will send Queue (${genesisAddress.toString({ testOnly: true })}, ` +
                `derived from PRIMES_DEPLOY_SUBWALLET_ID=${walletId ?? '<default>'}). The venue timelock bakes in ` +
                'proposerAddr at deploy time and checks it against the actual sender at Queue time — a mismatch ' +
                "bounces the queue step after every other genesis step has already landed (see G17, E14a's " +
                '2026-08-29 recovery). Update PRIMES_PROPOSER_ADDR to match this wallet before retrying.'
        );
    }
}

/** The five §4.3.2 addresses, exactly as `GenesisParams` names them. */
export type StakingVenueAddresses = Pick<
    GenesisParams,
    'tonstakersPool' | 'dedustTstonVault' | 'dedustTstonPool' | 'ratchetTstonWallet' | 'treasuryTstonWallet'
>;

/**
 * §4.3.2 / D-151 — THE STAKED RESERVE'S FIVE ADDRESSES, and the one place the
 * network decides where they come from.
 *
 * MAINNET: all five come from `mainnet.yaml`'s `staking_venue`. The tsTON master is Tonstakers' and the
 * tsTON/GRAM pool is DeDust's, so nothing this repo deploys can derive any of
 * them, and `validateStakingVenue` (genesisPipeline.ts) refuses the placeholders
 * an omission would otherwise leave behind.
 *
 * TESTNET: there is NO Tonstakers pool on testnet and there cannot be a useful
 * one — D-151 P0 point 1: the tsTON rate only moves when a Controller lends to
 * an Approver-approved validator that wins a testnet election, so without a
 * validator node the rate is pinned at ~1.0 and neither `harvest()` nor an
 * above-cost exit can be exercised. So the run deploys the sandbox double,
 * `contracts/test-mocks/mock_tonstakers_pool.tolk`, and points all five at it:
 * that mock deliberately collapses the pool, the tsTON minter, the ratchet's own
 * tsTON wallet and DeDust's tsTON/native vaults into ONE account, so one address
 * is the correct answer for all five rather than a shortcut. What a testnet run
 * then proves is the WIRING — the two one-shot bootstraps, the venue in init
 * data, the timelock queue — and nothing about the economics, which are proved in
 * `@ton/sandbox` by `RatchetStaking.spec.ts` against the same mock.
 *
 * THE NETWORK DECIDES, NOT A CONFIG VALUE. The mock branch is reachable only when
 * the host's network is `testnet` (blueprint's `--testnet`, or `--skew-safe`,
 * whose endpoint is hardwired to testnet); there is no env var, flag or file anyone
 * can set that points a mainnet genesis at a stand-in. That is deliberately
 * stricter than `PRIMES_DEDUST_LP_STANDIN`, which is an opt-in flag guarded by a
 * network check — here there is nothing to opt into.
 */
export async function resolveStakingVenue(host: ScriptHost, cfg: NetworkConfig): Promise<StakingVenueAddresses> {
    if (host.network !== 'testnet') {
        const v = requireValue(cfg, 'staking_venue', cfg.stakingVenue);
        const a = (k: keyof typeof v) => Address.parse(requireValue(cfg, `staking_venue.${k}`, v[k]));
        return {
            tonstakersPool: a('tonstakersPool'),
            dedustTstonVault: a('dedustTstonVault'),
            dedustTstonPool: a('dedustTstonPool'),
            ratchetTstonWallet: a('ratchetTstonWallet'),
            treasuryTstonWallet: a('treasuryTstonWallet'),
        };
    }
    // Rate 1:1 in INIT DATA rather than via `SetRate`, so no second message is
    // needed and the deposit leg cannot hit the wrapper's 0/1 default (which
    // fails hard rather than minting zero tsTON — see MockTonstakersPool).
    const pool = host.open(
        MockTonstakersPool.createFromConfig(
            { rateNum: toNano('1'), rateDen: toNano('1') },
            await host.code('MockTonstakersPool')
        )
    );
    await pool.sendDeploy(host.sender, toNano('0.5'));
    await new Promise((r) => setTimeout(r, 15_000));
    host.write(
        `[testnet] mock Tonstakers pool ${pool.address.toString()} — stands in for the pool, the ` +
            'tsTON minter, both tsTON wallets and DeDust\'s tsTON/native vaults. Record it in ' +
            'docs/testnet-deployment.md; it is NOT a mainnet address and cannot become one.'
    );
    return {
        tonstakersPool: pool.address,
        dedustTstonVault: pool.address,
        dedustTstonPool: pool.address,
        ratchetTstonWallet: pool.address,
        treasuryTstonWallet: pool.address,
    };
}

/**
 * The nominal supply-sizing input behind the genesis vested allocation
 * (`T0`, `params.genesis.genesis_seed_ton`), or a testnet-only override of it.
 * D-46: this value is NEVER deposited anywhere — it only sizes how much
 * PRIMES the treasury's vesting lock holds (D-166: `seed·L/2`).
 *
 * WHAT THE OVERRIDE ACTUALLY CHANGES
 *
 * Genesis opens the ledger with `T0 = 0` always (there is no real backing at
 * deploy any more) and `S0 = seed·L/2 + V` (D-166), where L =
 * `genesis_lp_ratio_primes_per_ton` (10 000, DECISIONS D-29) and V =
 * `bounty_vault_size_primes` (10 000 000, a fixed sim constant independent of
 * this override) — see genesisPipeline.ts's `completeGenesis`. So:
 *
 *   - THE OPENING FLOOR MOVES WITH IT, and D-100 point 2 is why this bullet
 *     changed. `completeGenesis` still seeds `T = 0`, but `donate_floor` follows
 *     immediately (D-93's seed → donate → ignite), and the donation is now an
 *     OWNER-SET 132.50 GRAM (D-154) that no longer tracks the seed. The floor an overridden
 *     run opens at is `donation / (S0 + donation·L)` with a SMALLER `S0` — i.e.
 *     HIGHER than spec, not equal to it. Before D-100 the two moved together
 *     (D-92 chose the donation to reproduce `seed/S0`) and this bullet could say
 *     "unaffected"; it cannot any more.
 *
 *   - The TREASURY'S VESTED ALLOCATION scales linearly with the seed
 *     (`seed · L / 2` nanoPRIMES, D-166), so a smaller override means a smaller
 *     lock, not a smaller pool (there is no pool yet).
 *
 *   - The VAULT'S SHARE OF S0 moves inversely, since V is fixed: at the
 *     specified 200 GRAM nominal seed, S0 = 200·10 000/2 + 10 000 000 =
 *     11 000 000, so the vault is ~91% of S0; at a 10 GRAM override,
 *     S0 = 10 050 000 and the vault is ~99.5% of S0. (The ratio is structural:
 *     DENOMINATION_PLAN §1.1 measured `L` to be a pure denomination knob, so
 *     D-29's L = 1 000 -> 10 000 moved every PRIMES figure here together and
 *     none of the reasoning changed. The ARITHMETIC did, and these lines
 *     carry the post-D-29 numbers.)
 *
 * What an overridden run cannot tell you is anything quantitative about the
 * real genesis sizing: the treasury lock's real size or the vault's real
 * supply share. Those must be read from the sim, not from the deployment.
 *
 * V is deliberately NOT scaled along with the seed: the era bounty schedule
 * pays out of it against a GRAM-denominated value (`era_bounty_schedule`, and
 * DENOMINATION_PLAN P4), so shrinking the vault would silently underfund eras
 * rather than merely distorting a ratio.
 */
/**
 * D-212 (§4.7.1) — the two naming fees, in nanoGRAM.
 *
 * `name_fee_ton` is REQUIRED and has no default: the owner set the first naming at about
 * 50 EUR, and a contract cannot read EUR, so the GRAM figure is chosen from the GRAM/EUR rate
 * on the genesis day and written into `mainnet.yaml` then (launch gate M5). A genesis that
 * forgot it must fail here, not ship a guessed price into deploy data nobody can change.
 *
 * The rename fee is the owner's 200 GRAM (`shared/params.json` `naming.rename_fee_ton`).
 * `testnet.yaml`'s `test_overrides.rename_fee_ton` may lower it, so a rehearsal can afford a
 * rename; the loader refuses `test_overrides` in `mainnet.yaml`.
 */
export function resolveNamingFees(cfg: NetworkConfig): { nameFee: bigint; renameFee: bigint } {
    if (cfg.nameFeeTon === null) {
        throw new Error(
            `shared/networks/${cfg.network}.yaml: name_fee_ton is not set. D-212: the first naming costs ` +
                "~50 EUR in GRAM at the genesis-day rate — set it to that day's figure (launch gate M5)."
        );
    }
    const nameFee = toNano(String(cfg.nameFeeTon));
    const renameTon = cfg.testOverrides.renameFeeTon ?? params.naming.rename_fee_ton;
    const renameFee = toNano(String(renameTon));
    if (nameFee <= 0n || renameFee <= 0n) throw new Error('D-212: both naming fees must be positive');
    return { nameFee, renameFee };
}

export function resolveSeedTon(cfg: NetworkConfig, ui: { write: (m: string) => void }): bigint {
    const spec = toNano(String(params.genesis.genesis_seed_ton));
    const override = cfg.testOverrides.seedTon;
    if (override === undefined) return spec;
    // Unreachable through `parseNetworkConfig` (it refuses `test_overrides` in mainnet.yaml);
    // kept because the founder seed is a CONCEPT §6 protocol figure and this is where it lands.
    if (cfg.network !== 'testnet') {
        throw new Error('test_overrides.seed_ton may only be set for a testnet rehearsal');
    }
    const raw = String(override);

    const seed = toNano(raw);
    if (seed > spec) {
        throw new Error(
            `test_overrides.seed_ton (${raw} GRAM) exceeds the specified seed ` +
                `(${params.genesis.genesis_seed_ton} GRAM). The override exists to make genesis ` +
                'affordable on testnet, not to change the economics upward.'
        );
    }

    const L = params.genesis.genesis_lp_ratio_primes_per_ton;
    const V = BigInt(Math.round(params.genesis.bounty_vault_size_primes * 1e9));
    // p_f = T0/S0 reported as its reciprocal (PRIMES per GRAM), which is the
    // direction the UI quotes and the easier one to eyeball against L.
    // D-166: the vested allocation is the treasury's half of `seed·L`, so S0 = seed·L/2 + V.
    const s0At = (t: bigint) => (t * BigInt(Math.round(L * 1000))) / 1000n / 2n + V;
    const primesPerTonAt = (t: bigint) => Number(s0At(t)) / Number(t);
    ui.write('');
    ui.write('!!! ==================================================================');
    ui.write('!!!  NOMINAL SEED OVERRIDDEN — THIS IS NOT A v5 GENESIS SIZING');
    ui.write('!!! ==================================================================');
    ui.write(`!!!  CONCEPT §6 nominal seed : ${params.genesis.genesis_seed_ton} GRAM`);
    ui.write(`!!!  this run                : ${raw} GRAM  (${(Number(seed) / Number(spec)) * 100}% of spec)`);
    ui.write('!!!');
    ui.write(`!!!  PRESERVED  seeded T     : 0 (D-46: no real deposit at genesis, seed or not)`);
    ui.write(`!!!  DISTORTED  opening floor: the D-100 donation is ${params.genesis.genesis_donation_ton} GRAM`);
    ui.write(`!!!                          : either way, so a smaller S0 opens a HIGHER floor`);
    ui.write('!!!');
    ui.write(`!!!  DISTORTED  S0 per seed GRAM: 1 GRAM = ${primesPerTonAt(seed).toFixed(1)} PRIMES`);
    ui.write(`!!!                       spec: 1 GRAM = ${primesPerTonAt(spec).toFixed(1)} PRIMES`);
    ui.write(
        `!!!  DISTORTED  vault share  : ${((Number(V) / Number(s0At(seed))) * 100).toFixed(1)}% of S0` +
            ` (spec: ${((Number(V) / Number(s0At(spec))) * 100).toFixed(1)}%)`
    );
    ui.write('!!!');
    ui.write('!!!  The bounty vault is NOT scaled with the seed (era bounties are');
    ui.write('!!!  absolute PRIMES). Read genesis economics from the sim, not from');
    ui.write('!!!  this deployment. Record the override in docs/testnet-deployment.md.');
    ui.write('!!! ==================================================================');
    ui.write('');

    return seed;
}

/**
 * CONCEPT §3.1's TEP-64/TEP-66 presentation: what the collection, its items and the PRIMES
 * jetton are CALLED, and where the 5% secondary royalty is declared to go.
 *
 * The documents are served from webapp/public (collection.json, jetton.json,
 * jetton-logo.png) and by the read-proxy at `/nft/<n>.json`, all published by deploy.ps1.
 *
 * What is NOT optional is that they be passed at all: see `GenesisParams.presentation`.
 * These land in init data, no message can change them, and a genesis that omits them ships
 * a permanently nameless collection and jetton.
 */
export function resolvePresentation(cfg: NetworkConfig): GenesisPresentation {
    return {
        // From `shared/networks/<network>.yaml`. The nft prefix's trailing slash is
        // load-bearing (the collection appends `<n>.json`); the loader refuses one without it.
        collectionMetadataUri: cfg.presentation.collectionMetadataUri,
        nftContentPrefix: cfg.presentation.nftContentPrefix,
        jettonMetadataUri: cfg.presentation.jettonMetadataUri,
        // CONCEPT §3.1's 5%, read from params.json rather than written as a literal
        // (CLAUDE.md rule 3: no economic parameter that isn't traceable to the sim or spec).
        royaltyNum: params.fees.royalty_numerator,
        royaltyDen: params.fees.royalty_denominator,
    };
}

/** Blueprint's entry point: `npx blueprint run deployGenesis --testnet --mnemonic`. */
/**
 * D-139 / D-153 — the two test divisors are TESTNET-ONLY, refused anywhere else.
 * Owner, D-153: "later increase back for production". This is that: a mainnet
 * genesis cannot inherit testnet's `auction_seconds` / `stake_min_ton`, both of which land
 * in address-determining init data no message can change afterwards
 * (`docs/mainnet-launch-gates.md` M2). `mainnet.yaml` has nowhere to put either; this is
 * the second lock, on the divisors themselves.
 */
export function requireMainnetDivisors(network: string, clockDivisor: number, stakeDivisor: number): void {
    if (network === 'testnet' || (clockDivisor === 1 && stakeDivisor === 1)) return;
    throw new Error(
        `Target network is "${network}" but clockDivisor=${clockDivisor}, stakeDivisor=${stakeDivisor}. ` +
            'Both must be 1 off testnet (D-139, D-153): only testnet.yaml may set ' +
            'test_overrides.auction_seconds / stake_min_ton.'
    );
}

export async function run(provider: NetworkProvider) {
    await deployGenesis(hostFromProvider(provider));
}

export async function deployGenesis(host: ScriptHost) {
    // Resolved before the compile step so a rejected override fails in a second
    // rather than after twelve contracts have been built.
    // The network THIS RUN targets picks the file — never TON_NETWORK (see readNetworkConfig).
    const cfg = readNetworkConfig(host.network);
    requireGenesisReady(cfg);
    host.write(`network config: shared/networks/${cfg.network}.yaml`);
    const seedTon = resolveSeedTon(cfg, { write: host.write });
    const clockDivisor = clockDivisorOf(cfg);
    const stakeDivisor = resolveStakeMin(cfg).divisor;
    requireMainnetDivisors(host.network, clockDivisor, stakeDivisor);
    const presentation = resolvePresentation(cfg);
    validatePresentation(presentation);

    const code: GenesisCode = {
        item: await host.code('PrimesItem'),
        collection: await host.code('PrimesCollection'),
        jettonWallet: await host.code('PrimesJettonWallet'),
        jettonMaster: await host.code('PrimesJettonMaster'),
        ledger: await host.code('PrimesLedger'),
        ratchet: await host.code('PrimesRatchet'),
        registrar: await host.code('PrimesRegistrar'),
        venueTimelock: await host.code('PrimesVenueTimelock'),
        market: await host.code('PrimesMarket'),
        bountyVault: await host.code('PrimesBountyVault'),
        voucher: await host.code('PrimesVoucher'),
        claimReceipt: await host.code('PrimesClaimReceipt'),
        minterCard: await host.code('PrimesMinterCard'), // D-191 point 1
        lotBlock: await host.code('PrimesLotBlock'), // D-196
        // D-100 points 4/7. `PrimesLpPosition` is compiled but never deployed
        // here — it is the treasury's child template and is ADDRESS-DETERMINING
        // for the treasury, so a recompile of the child moves the parent.
        treasury: await host.code('PrimesTreasury'),
        lpPosition: await host.code('PrimesLpPosition'),
        lpSink: await host.code('PrimesLpSink'),
        // D-168 (the stake master and its per-wallet child, which is
        // ADDRESS-DETERMINING for the master). D-212 deleted the burn sink.
        stake: await host.code('PrimesStake'),
        stakePosition: await host.code('PrimesStakePosition'),
        vesting: await host.code('PrimesVesting'),
    };

    const genesisAddress = host.address;
    const dedustPool = requireAddr('PRIMES_DEDUST_POOL_ADDR');
    const env: GenesisEnv = {
        open: (c) => host.open(c),
        genesisSender: host.sender,
        genesisAddress,
        proposerSender: host.sender,
        now: () => host.now(),
        genesisBalance: () => host.balance(),
        // D-100 point 4. The DeDust POOL is the LP jetton's master, so its own
        // `get_wallet_address` is the only authority on where a given owner's LP
        // lives. This is a real network call and it is the reason a genesis run
        // now REQUIRES THE POOL TO ALREADY EXIST: an undeployed pool answers no
        // get-method, and there is no fallback worth inventing — the address
        // lands in the LP sink's one-shot bootstrap and the treasury's, and a
        // wrong one means every LP deposit bounces (1170) or is refused (1151).
        lpWalletFor: async (owner) => {
            // GAUNTLET.md R17: testnet-only stand-in, refused on any other network.
            if (process.env.PRIMES_DEDUST_LP_STANDIN === '1') {
                if (host.network !== 'testnet') {
                    throw new Error(
                        'PRIMES_DEDUST_LP_STANDIN=1 is testnet-only: a stand-in LP wallet on mainnet ' +
                            'would refuse every real LP deposit forever'
                    );
                }
                const a = standInLpWalletFor(owner);
                host.write(`[lp stand-in] ${owner.toString()} -> ${a.toString()}`);
                return a;
            }
            try {
                const stack = await host.runGet(dedustPool, 'get_wallet_address', [
                    { type: 'slice', cell: beginCell().storeAddress(owner).endCell() },
                ]);
                return stack.readAddress();
            } catch (e) {
                throw new Error(
                    `genesis: could not read get_wallet_address(${owner}) from the DeDust pool ` +
                        `${dedustPool}. The PRIMES/GRAM pool must exist before genesis runs — the LP ` +
                        'sink and the treasury both bake an LP jetton wallet address into a one-shot ' +
                        `bootstrap and neither can be repaired afterwards. Underlying: ${String(e)}`
                );
            }
        },
        settle: async (step) => {
            host.write(`… ${step}`);
            await new Promise((r) => setTimeout(r, 15_000)); // let the network confirm
        },
        log: (m) => host.write(m),
    };

    // §4.3.2 / D-151. On MAINNET this only reads mainnet.yaml. On TESTNET it is the
    // first thing in the run that sends a message (the mock pool's deploy), and
    // it has to be, because its address is a `GenesisParams` field and the params
    // object is built below. It therefore runs BEFORE the gas-floor preflight, so
    // a run that the preflight then refuses has spent 0.5 GRAM on a mock — a
    // testnet nuisance and nothing more: the mock strands no one-shot bootstrap
    // and the next attempt simply deploys another one.
    // G17: before the first send (the testnet mock just below), refuse if
    // PRIMES_PROPOSER_ADDR won't match the sender that queues the timelock proposal.
    assertProposerMatchesSender(requireAddr('PRIMES_PROPOSER_ADDR'), genesisAddress, host.walletId);
    // MISTAKES.md 2026-11-12: the pool must be keyed on the master derived from the code
    // THIS run deploys — not from whatever build createDedustPool.ts happened to read.
    if (process.env.PRIMES_DEDUST_LP_STANDIN !== '1') {
        await assertDedustKeyedOnMaster(
            (a, m, args) => host.runGet(a, m, args),
            dryRunGenesisMasterAddress(genesisAddress, code.jettonMaster, code.jettonWallet, presentation.jettonMetadataUri),
            dedustPool,
            requireAddr('PRIMES_DEDUST_JETTON_VAULT_ADDR')
        );
        host.write('preflight ok: DeDust pool and jetton vault are keyed on this run\'s jetton master');
    }
    const stakingVenue = await resolveStakingVenue(host, cfg);

    const genesisParams: GenesisParams = {
        // D-20 DELETES `lots`. There is no fixed genesis set: every prime, from
        // 2 onward, opens permissionlessly at `P0(n)` and decays to D-88's
        // resting price `max(NPV(n)/2, P0(n)/3, MINT_PRICE)`.
        eraSchedule: params.genesis.era_bounty_schedule.era_bounty_schedule.map((e) => ({
            eraBoundary: BigInt(e.era_boundary_n),
            // DENOMINATION_PLAN P4: the schedule is GRAM-denominated. `bountyTon`
            // is the ceremony's fixed value; `maxPrimes` is what it buys at the
            // genesis floor and is the cap the vault can never exceed.
            bountyTon: BigInt(Math.round(e.bounty_ton * 1e9)),
            maxPrimes: BigInt(Math.round(e.max_primes * 1e9)),
        })),
        // D-99 §1.5 — the two-entry rebate schedule, GRAM-denominated exactly like
        // the era schedule above. Kind 0's figures are PER POINT of D(n): the
        // vault multiplies by the points the ledger reports, so what is stored
        // here is one point's worth and never a whole number's rebate.
        rebateSchedule: [
            {
                tier: REBATE_KIND.COMPOSITE_PER_POINT,
                bountyTon: BigInt(Math.round(params.genesis.score_rebate.rates.composite_per_point.reward_ton * 1e9)),
                maxPrimes: BigInt(
                    Math.round(
                        params.genesis.score_rebate.rates.composite_per_point.max_primes_per_point_genesis_floor * 1e9,
                    ),
                ),
            },
            {
                tier: REBATE_KIND.PRIME_FAMILY,
                bountyTon: BigInt(Math.round(params.genesis.score_rebate.rates.prime_family.reward_ton * 1e9)),
                maxPrimes: BigInt(
                    Math.round(params.genesis.score_rebate.rates.prime_family.max_primes_genesis_floor * 1e9),
                ),
            },
        ],
        bountyVaultPrimes: BigInt(Math.round(params.genesis.bounty_vault_size_primes * 1e9)),

        lpPrimesPerTon: params.genesis.genesis_lp_ratio_primes_per_ton,
        // D-140: the two figures the printed pairing runbook needs to quote the
        // pair at the FLOOR rather than at `L`. Read from the file, never derived
        // here — `genesis_floor_price_ton_per_primes` is a sim output.
        genesisFloorPriceTonPerPrimes: params.genesis.genesis_floor_price_ton_per_primes,
        donationPrimes: params.genesis.genesis_donation_primes,
        // D-46: nominal only — sizes the treasury's vested allocation (D-166) and S0,
        // never deposited anywhere. `resolveSeedTon` allows a smaller figure on
        // testnet only, and documents exactly what that distorts.
        seedTon,
        // CONCEPT.md §4.4 / DECISIONS.md D-3 (was TROPHY_AUCTION_PLAN.md D3;
        // see README.md's retired-documents table). Absent until the sim publishes it, and the
        // absence is honest: every prime then opens at max(ladder, PRIME_P0_MIN),
        // which is D3's declared ladder fallback, not a silent zero.
        trophyNpv: requireTrophyNpv(params),
        trophyRest: requireTrophyRest(params), // D-218
        // `minAuctionDistance` is DELETED (D-45) — the ascending lane's
        // liveness gate no longer exists; see `primes_market.tolk`'s D-45 note.
        questsSignerPubkey: requireVoucherSignerPubkey('QUESTS_VOUCHER_SIGNER_SECRET_KEY'),
        primeQuestsSignerPubkey: requireVoucherSignerPubkey('PRIME_QUESTS_VOUCHER_SIGNER_SECRET_KEY'),
        questsPrimes: BigInt(
            Math.round(params.genesis.era_bounty_schedule.remaining_vault_split.tracks.quests.primes * 1e9)
        ),
        securitySignerPubkey: requireSecuritySignerPubkey(),
        securityBountyPrimes: BigInt(
            Math.round(params.genesis.era_bounty_schedule.remaining_vault_split.tracks.security_bounty.primes * 1e9)
        ),
        primeQuestsPrimes: BigInt(
            Math.round(params.genesis.era_bounty_schedule.remaining_vault_split.tracks.prime_quests.primes * 1e9)
        ),
        operatorAddr: Address.parse(requireValue(cfg, 'operator_addr', cfg.operatorAddr)),
        proposerAddr: requireAddr('PRIMES_PROPOSER_ADDR'),
        // D-168's sim-selected `distribute()` rate. Deploy data on the treasury
        // with no setter, so it is read from the file at exactly one call site
        // rather than defaulted anywhere (CLAUDE.md rule 3).
        distributionRateBpsPerDay: params.staking.distribution_rate_bps_per_day,
        // D-212 (§4.7.1): the naming fees, deploy data with no setter.
        ...resolveNamingFees(cfg),
        // D-139 — THE TEST CLOCK. `testnet.yaml`'s `test_overrides.auction_seconds`
        // (absent = 604800 = mainnet = divisor 1) sets the auction window, and the same divisor
        // scales the ratchet's flush cooldown and the treasury's vote window so
        // every clock in a set moves together. Address-determining on three
        // contracts, so it is chosen here, in the diff, like every other figure
        // in this object.
        clockDivisor,
        // D-153 — 1 on mainnet, which is the identity and the default.
        stakeDivisor,
        // D-100 point 2, OWNER-SET. NOT sent by this script — `donateFloor.ts`
        // sends it, after this run and before ignite (D-93). It is here so the
        // pairing runbook printed at the end quotes the real figure.
        donationTon: genesisDonationTon(params.genesis),
        dedustNativeVault: Address.parse(requireValue(cfg, 'dedust_native_vault', cfg.dedustNativeVault)),
        dedustPool,
        primesJettonVault: requireAddr('PRIMES_DEDUST_JETTON_VAULT_ADDR'),
        // §4.3.2 / D-151 — the staked reserve's venue and the two tsTON wallets.
        // The network picks the source; see
        // `resolveStakingVenue`.
        ...stakingVenue,
        presentation,
    };

    // Preflight. `GenesisEnv.genesisBalance` has existed since the pipeline was
    // written and nothing ever called it, so a genesis that ran out of GRAM
    // partway through would strand the set: every bootstrap link (collection
    // `ledgerSet`, the jetton authority seal, the ledger's `genesisSeeded`) is
    // one-shot, and the item addresses derive from the ledger address, so a
    // half-wired deploy cannot be repaired — only abandoned and redone at fresh
    // addresses. Refuse up front instead.
    //
    // Static sum of attached values in genesisPipeline.ts as of W8.3 (which
    // added the staking sink and the burn sink):
    //   6.5  eleven deploys @0.5 (collection, master, timelock, ledger@1,
    //        ratchet@1, registrar, market, vault, STAKE, SINK — the ledger and
    //        the ratchet take 1 each, the other nine 0.5)
    //   0.40 eight bootstrap wires @0.05 (SetLedger ×2, SetRatchet,
    //        SetPeers, SetLedger ×2, SetCollection, SetSinks, SetSink)
    //   0.30 treasury vested-allocation genesis mint (D-46/D-166: no LP deposit, no burn)
    //   0.35 vault genesis mint + SetWallet
    //   0.05 ratchet SetJettonWallet
    //   0.05 ratchet SetTstonWallet (D-151), and on TESTNET ONLY a further 0.5
    //        for the mock Tonstakers pool, already sent by resolveStakingVenue
    //        above — so this floor is read against a balance that has paid it
    //   0.10 the two sinks' SetWallet @0.05
    //   0.05 jetton seal
    //   0.20 GenesisSeed
    //   0.10 timelock queue
    //   D-100 adds: 0.5 LP sink deploy, 0.6 treasury deploy, 0.6 the SECOND
    //        vesting lock, 0.05 the LP sink's SetWallet, 0.05 the treasury's
    //        SetWallets, 0.05 the second lock's SetWallet  = +1.85
    //   ≈ 10.00 GRAM, plus forward fees. 13 GRAM leaves >2 GRAM of headroom; the
    // deploy values largely remain as balance on the deployed contracts rather
    // than being burned. D-46: unlike the old founder seed, none of this is
    // spent as pool backing — the genesis wallet never sends GRAM anywhere but
    // gas for its own messages.
    const PIPELINE_GAS_FLOOR = toNano('13');
    const balance = await env.genesisBalance();
    if (balance < PIPELINE_GAS_FLOOR) {
        throw new Error(
            `Refusing to run: genesis wallet ${genesisAddress} holds ${Number(balance) / 1e9} GRAM, ` +
                `but this run needs ${Number(PIPELINE_GAS_FLOOR) / 1e9} GRAM of pipeline gas. ` +
                'Every bootstrap link in the genesis is one-shot, so a run that stops halfway ' +
                'cannot be resumed — the whole set would have to be redeployed at fresh addresses.'
        );
    }
    host.write(
        `preflight ok: ${Number(balance) / 1e9} GRAM available, ` +
            `${Number(PIPELINE_GAS_FLOOR) / 1e9} GRAM pipeline gas required (no seed deposit — D-46)`
    );

    const genesis = await runGenesis(env, code, genesisParams, {
        onAuctionOpen: async (d) => {
            // CONCEPT §6 point 1: no close to wait for. D-20: each lot decays from
            // ITS OWN open, and D-88 point 1: it comes to rest at
            // `max(NPV(n)/2, P0(n)/3, MINT_PRICE)` and PARKS there until bought, with no
            // expiry — so the deploy does not block on the market at all. Opening
            // lots, and buying them, are external and permissionless.
            host.write(
                `market open (per-lot decay to max(NPV(n)/2, P0(n)/3, MINT_PRICE), parks there, no expiry). ` +
                    `Address: ${d.market.address}`
            );
        },
        // CONCEPT §6 point 0: `unityOwner` is deliberately NOT passed. This
        // script builds the game; it does not start it. Ignition mints Unity to
        // the founder and opens minting and both market lot modes in one
        // irreversible transaction, and that is a decision rather than a step —
        // so it gets its own script, run when the founder chooses.
    });

    host.write('genesis complete — DEPLOYED BUT CLOSED');
    printGenesisTable(host, genesis.deployment);
    host.write(
        'Nothing is live yet: mint and both auction modes (ascending ahead of the head, descending prime lots) ' +
            'refuse until Unity (#1) is minted. Start the game with the same sender:\n' +
            '    npx blueprint run ignite --testnet --mnemonic\n' +
            '    npx tsx scripts/ignite.ts --skew-safe\n' +
            '(set PRIMES_UNITY_OWNER to the address that should own #1; it defaults to this wallet)'
    );
}

/**
 * GAUNTLET G49, half two: print the address table in `docs/testnet-deployment.md`'s own row
 * format, so writing the run up is a PASTE rather than a transcription. The doc is the INPUT to
 * `check-env-genesis.mjs`, so a skipped write-up disarms the check that catches the next stale
 * paste. THE ADDRESSES COME FROM THE RUN, NOT FROM `.env` (2026-09-17, MISTAKES.md): `.env`
 * still names the PREVIOUS set at this instant. Failing to print is not a reason to fail a
 * completed genesis, so this is best-effort and says so.
 */
function printGenesisTable(host: ScriptHost, d: Awaited<ReturnType<typeof runGenesis>>['deployment']) {
    const repo = path.resolve(__dirname, '..', '..');
    try {
        host.write('');
        host.write('--- paste into docs/testnet-deployment.md (GAUNTLET G49) ---');
        const deployed = {
            PRIMES_LEDGER_ADDRESS: d.ledger.address.toString(),
            PRIMES_RATCHET_ADDRESS: d.ratchet.address.toString(),
            PRIMES_REGISTRAR_ADDRESS: d.registrar.address.toString(),
            PRIMES_COLLECTION_ADDRESS: d.collection.address.toString(),
            PRIMES_JETTON_MASTER_ADDRESS: d.master.address.toString(),
            PRIMES_MARKET_ADDRESS: d.market.address.toString(),
            PRIMES_BOUNTY_VAULT_ADDRESS: d.vault.address.toString(),
            PRIMES_VOUCHER_ADDRESS: d.voucher.address.toString(),
            PRIMES_SECURITY_VOUCHER_ADDRESS: d.securityVoucher.address.toString(),
            PRIMES_PRIME_QUESTS_VOUCHER_ADDRESS: d.primeQuestsVoucher.address.toString(),
            PRIMES_VENUE_TIMELOCK_ADDRESS: d.timelock.address.toString(),
            PRIMES_STAKE_ADDRESS: d.stake.address.toString(),
            PRIMES_TREASURY_ADDRESS: d.treasury.address.toString(),
            PRIMES_LP_SINK_ADDRESS: d.lpSink.address.toString(),
            PRIMES_TREASURY_VESTING_ADDRESS: d.treasuryVesting.address.toString(),
        };
        host.write(
            execFileSync(
                process.execPath,
                [path.join(repo, 'tools', 'genesis-table.mjs'), '--heading', '--addresses', JSON.stringify(deployed)],
                { cwd: repo, encoding: 'utf8' }
            )
        );
    } catch (e) {
        host.write(`[genesis-table] could not print the paste-ready table: ${(e as Error).message}`);
        host.write('[genesis-table] run `node tools/genesis-table.mjs --heading` by hand.');
    }
}

// `npx tsx scripts/deployGenesis.ts --skew-safe`. Guarded so the tests and the scripts that
// import `resolvePresentation` / `resolveSeedTon` / `assertProposerMatchesSender` from this
// module do not also run a genesis, and so blueprint's own `require` of it runs `run()` only.
if (require.main === module) runSkewSafe('deployGenesis', deployGenesis);
