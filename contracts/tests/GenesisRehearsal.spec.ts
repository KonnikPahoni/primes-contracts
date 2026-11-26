// TON PRIMES — genesis pipeline rehearsal, executed for real in @ton/sandbox
// (docs/phase3-report.md exit gate: "genesis script rehearsed on sandbox").
//
// This drives contracts/scripts/genesisPipeline.ts — the SAME module
// contracts/scripts/deployGenesis.ts runs against a network — through the full
// sequence: deploy -> bootstrap wiring -> operator allocation mint (D-46, no
// LP deposit or burn) -> bounty vault funding -> seal jetton authority -> open
// minting -> queue the venue timelock -> IGNITE, then buys a prime off the
// market and mints a composite at the head to prove the line actually opened.
//
// D-20 REMOVED A WHOLE STEP FROM THIS FILE. There is no genesis auction, no lot
// set K, and no "mint past the auction set": `bootstrap_genesis` is gone and the
// pipeline's job shrank to mint Unity, flip `launched`, and open the market. The
// market then decides which primes are open — every prime with no unbuilt
// composite ahead of it — which at genesis is 2 and 3, with 4 the first number
// anybody can build.
//
// NOTE ON SCALE: the LP and bounty PRIMES amounts run at 1/1000 scale so the
// rehearsal fits inside @ton/sandbox's default treasury balances. Nothing in the
// pipeline or the contracts is scale-dependent.
import { Blockchain, SandboxContract, TreasuryContract } from '@ton/sandbox';
import { Address, beginCell, Cell, toNano } from '@ton/core';
import '@ton/test-utils';
import { compile } from '@ton/blueprint';
import {
    GenesisCode,
    GenesisEnv,
    GenesisParams,
    OPENING_HEAD,
    TIMELOCK_DELAY,
    deployAndWire,
    completeGenesis,
    donateGenesisFloor,
    genesisDonationTon,
    genesisPairingPrimes,
    genesisPairingTon,
    igniteGame,
    pairingInstructions,
    treasuryVestPrimes,
    verifyPresentation,
    decodeComposedNftContent,
    dryRunGenesisMasterAddress,
} from '../scripts/genesisPipeline';
import { decodeOffchainContent } from '../wrappers/PrimesJettonMaster';
import { PrimesItem } from '../wrappers/PrimesItem';
import { PrimesJettonWallet } from '../wrappers/PrimesJettonWallet';
import { acquirePrime, RESERVABLE_20014, winLot } from './helpers/market';
import sharedParams from '../../shared/params.json';
import { PROGRAM_TAG_PRIME_QUESTS, PROGRAM_TAG_QUESTS, PROGRAM_TAG_SECURITY, REBATE_KIND } from '../../shared/opcodes';
import { VOUCHER_MAX_PER_WALLET } from '../../shared/voucher';
import { keyPairFromSeed } from '@ton/crypto';
import { PrimesVoucher, signVoucherClaim } from '../wrappers/PrimesVoucher';
import { sandboxGlobalId } from './helpers/globalId';

const VOUCHER_KEY = keyPairFromSeed(Buffer.alloc(32, 76));
// R2-M2 — the prime-quests instance's own key (D-171 amended 2026-11-20): one key per track.
const PRIME_QUESTS_KEY = keyPairFromSeed(Buffer.alloc(32, 171));
// D-170 — the security prize's own key; the real one is held offline by the owner.
const SECURITY_KEY = keyPairFromSeed(Buffer.alloc(32, 170));

const SCALE = 1000; // see the scale note above

/** D-212: a stand-in for the genesis-day GRAM figure of 50 EUR, and the owner's rename fee. */
const REHEARSAL_NAME_FEE = toNano('10');
const REHEARSAL_RENAME_FEE = toNano(String((sharedParams as any).naming.rename_fee_ton));

describe('TON PRIMES — genesis pipeline rehearsal (sandbox)', () => {
    let blockchain: Blockchain;
    let genesis: SandboxContract<TreasuryContract>;
    let proposer: SandboxContract<TreasuryContract>;
    let treasuryWallet: SandboxContract<TreasuryContract>;
    let dedustVault: SandboxContract<TreasuryContract>;
    let dedustPool: SandboxContract<TreasuryContract>;
    let dedustJettonVault: SandboxContract<TreasuryContract>;
    // §4.3.2 / D-151 — the staked reserve's venue and its two tsTON wallets.
    let tonstakersPool: SandboxContract<TreasuryContract>;
    let dedustTstonVault: SandboxContract<TreasuryContract>;
    let dedustTstonPool: SandboxContract<TreasuryContract>;
    let ratchetTstonWallet: SandboxContract<TreasuryContract>;
    let treasuryTstonWallet: SandboxContract<TreasuryContract>;
    let bidders: SandboxContract<TreasuryContract>[];
    let minter: SandboxContract<TreasuryContract>;

    let code: GenesisCode;
    let env: GenesisEnv;
    let params: GenesisParams;

    beforeAll(async () => {
        code = {
            item: await compile('PrimesItem'),
            collection: await compile('PrimesCollection'),
            jettonWallet: await compile('PrimesJettonWallet'),
            jettonMaster: await compile('PrimesJettonMaster'),
            ledger: await compile('PrimesLedger'),
            ratchet: await compile('PrimesRatchet'),
            registrar: await compile('PrimesRegistrar'),
            venueTimelock: await compile('PrimesVenueTimelock'),
            // P2.A7/D-20: ONE market. `PrimesAuction` and `PrimesTrophyAuction`
            // retired with the three-contract format, and with them the
            // half-wired-genesis failure mode their circular bootstrap created.
            market: await compile('PrimesMarket'),
            bountyVault: await compile('PrimesBountyVault'),
            // W5 (D-17/D-34, staking, INERT). Deployed by a real genesis and its
            // link is one-shot, so the rehearsal deploys it too. (D-212 deleted
            // the W6 burn sink that sat beside it.)
            stake: await compile('PrimesStake'),
            stakePosition: await compile('PrimesStakePosition'),
            vesting: await compile('PrimesVesting'),
            // D-100 points 4/7 — the governed treasury, its per-wallet child
            // template and the LP sink. `PrimesLpPosition` is compiled and never
            // deployed by the pipeline: it is the treasury's child code, which
            // makes it ADDRESS-DETERMINING for the treasury.
            treasury: await compile('PrimesTreasury'),
            lpPosition: await compile('PrimesLpPosition'),
            lpSink: await compile('PrimesLpSink'),
            // G76 — §9.5's voucher program, the vault's second allow-listed payer.
            voucher: await compile('PrimesVoucher'),
            claimReceipt: await compile('PrimesClaimReceipt'),
            minterCard: await compile('PrimesMinterCard'), // D-191 point 1
            lotBlock: await compile('PrimesLotBlock'), // D-196
        };
    });

    beforeEach(async () => {
        blockchain = await Blockchain.create();
        blockchain.now = 1_770_000_000;
        genesis = await blockchain.treasury('genesisScript', { balance: toNano('2000') });
        proposer = await blockchain.treasury('proposer');
        treasuryWallet = await blockchain.treasury('treasury');
        dedustVault = await blockchain.treasury('dedustNativeVault');
        dedustPool = await blockchain.treasury('dedustPool');
        dedustJettonVault = await blockchain.treasury('dedustJettonVault');
        // §4.3.2 / D-151 — five stand-ins for what is Tonstakers' and DeDust's on
        // mainnet and the mock pool on testnet. FIVE DISTINCT ADDRESSES, not one:
        // the mock collapses them and that is right for the mock, but this
        // rehearsal is the thing that would catch two fields being swapped in the
        // pipeline, and it cannot catch that if they are the same address.
        tonstakersPool = await blockchain.treasury('tonstakersPool');
        dedustTstonVault = await blockchain.treasury('dedustTstonVault');
        dedustTstonPool = await blockchain.treasury('dedustTstonPool');
        ratchetTstonWallet = await blockchain.treasury('ratchetTstonWallet');
        treasuryTstonWallet = await blockchain.treasury('treasuryTstonWallet');
        minter = await blockchain.treasury('minter');
        bidders = [];
        for (const name of ['bidder0', 'bidder1', 'bidder2', 'bidder3', 'bidder4', 'bidder5']) {
            // D-20 prices a prime at 1.5 x its tribute NPV, and the rehearsal
            // ships the REAL, unscaled NPV table (see the trophyNpv note below),
            // so prime 2 opens above 1,300 GRAM. Buyers are funded for the real
            // number rather than the table being scaled down to the buyers —
            // scaling it would clamp every prime to PRIME_P0_MIN and the ladder
            // would go untested.
            bidders.push(await blockchain.treasury(name, { balance: toNano('4000') }));
        }

        env = {
            open: (c) => blockchain.openContract(c as any) as any,
            genesisSender: genesis.getSender(),
            genesisAddress: genesis.address,
            proposerSender: proposer.getSender(),
            now: () => blockchain.now as number,
            genesisBalance: async () => await genesis.getBalance(),
            // D-100 point 4. On a live deploy this is a `get_wallet_address`
            // call against the DeDust pool; here the pool is a sandbox stand-in
            // with no such method, so the rehearsal supplies a deterministic
            // stand-in of its own — exactly as it does for the pool address.
            // What is being rehearsed is the BOOTSTRAP (one-shot, self-closing,
            // and the thing that makes `getLocked()` comparable to a balance),
            // not DeDust's address derivation.
            lpWalletFor: async (owner) =>
                (await blockchain.treasury('lpwallet:' + owner.toRawString())).address,
            log: () => {},
        };

        params = {
            eraSchedule: sharedParams.genesis.era_bounty_schedule.era_bounty_schedule.map((e) => ({
                eraBoundary: BigInt(e.era_boundary_n),
                // DENOMINATION_PLAN P4: GRAM-denominated value + nominal cap. BOTH
                // scale, and they have to scale together — the vault pays
                // `bountyTon * S / T` and `S`/`T` are both at 1/SCALE here, so a
                // cap left at full size would simply never bind and the scaled
                // rehearsal would stop exercising it.
                bountyTon: BigInt(Math.round((e.bounty_ton / SCALE) * 1e9)),
                maxPrimes: BigInt(Math.round((e.max_primes / SCALE) * 1e9)),
            })),
            // D-99 §1.5 — the two-entry rebate schedule, scaled with everything else
            // for the same reason the era schedule is: the vault pays
            // `bountyTon * S / T` against a `maxPrimes` cap, and a cap left at full
            // size in a 1/SCALE rehearsal would simply never bind.
            rebateSchedule: [
                {
                    tier: REBATE_KIND.COMPOSITE_PER_POINT,
                    bountyTon: BigInt(
                        Math.round(sharedParams.genesis.score_rebate.rates.composite_per_point.reward_ton * 1e9),
                    ),
                    maxPrimes: BigInt(
                        Math.round(
                            (sharedParams.genesis.score_rebate.rates.composite_per_point
                                .max_primes_per_point_genesis_floor /
                                SCALE) *
                                1e9,
                        ),
                    ),
                },
                {
                    tier: REBATE_KIND.PRIME_FAMILY,
                    bountyTon: BigInt(Math.round(sharedParams.genesis.score_rebate.rates.prime_family.reward_ton * 1e9)),
                    maxPrimes: BigInt(
                        Math.round(
                            (sharedParams.genesis.score_rebate.rates.prime_family.max_primes_genesis_floor / SCALE) *
                                1e9,
                        ),
                    ),
                },
            ],
            bountyVaultPrimes: BigInt(Math.round((sharedParams.genesis.bounty_vault_size_primes / SCALE) * 1e9)),
            // G76 — a rehearsal voucher key; the real one is QUESTS_VOUCHER_SIGNER_SECRET_KEY.
            questsSignerPubkey: VOUCHER_KEY.publicKey,
            // R2-M2 — the real one is PRIME_QUESTS_VOUCHER_SIGNER_SECRET_KEY.
            primeQuestsSignerPubkey: PRIME_QUESTS_KEY.publicKey,
            // Scaled like every other PRIMES figure in this rehearsal.
            questsPrimes: BigInt(
                Math.round(
                    (sharedParams.genesis.era_bounty_schedule.remaining_vault_split.tracks.quests.primes / SCALE) * 1e9
                )
            ),
            securitySignerPubkey: SECURITY_KEY.publicKey,
            securityBountyPrimes: BigInt(
                Math.round(
                    (sharedParams.genesis.era_bounty_schedule.remaining_vault_split.tracks.security_bounty.primes /
                        SCALE) *
                        1e9
                )
            ),
            primeQuestsPrimes: BigInt(
                Math.round(
                    (sharedParams.genesis.era_bounty_schedule.remaining_vault_split.tracks.prime_quests.primes / SCALE) *
                        1e9
                )
            ),
            lpPrimesPerTon: sharedParams.genesis.genesis_lp_ratio_primes_per_ton,
            // D-46: nominal supply-sizing input only, never deposited. Scaled
            // like every other PRIMES/GRAM figure in this rehearsal (see the
            // SCALE note above).
            seedTon: toNano((sharedParams.genesis.genesis_seed_ton / SCALE).toFixed(9)),
            // D-100 point 6: this is the OPERATOR'S WALLET, renamed from
            // `treasuryAddr` because the treasury is now a contract the pipeline
            // deploys. `treasuryWallet` keeps its sandbox name so the §3.1
            // royalty assertions below still read against the same address they
            // always did — the royalty destination is the one thing D-100 does
            // NOT move.
            operatorAddr: treasuryWallet.address,
            proposerAddr: proposer.address,
            distributionRateBpsPerDay: sharedParams.staking.distribution_rate_bps_per_day,
            // D-212: the naming fees. The first naming's GRAM figure is a genesis-day
            // input (no params value exists); the rename fee is params.json's owner figure.
            nameFee: REHEARSAL_NAME_FEE,
            renameFee: REHEARSAL_RENAME_FEE,
            // D-100 point 2, owner-set. Scaled like every other GRAM figure here.
            donationTon: sharedParams.genesis.genesis_donation_ton / SCALE,
            // D-140. `p_f` is a RATIO, and the rehearsal scales `T` and `S`
            // together, so it is scale-free and goes in unscaled -- the same
            // reasoning the supply-ratio assertion below already relies on.
            genesisFloorPriceTonPerPrimes: sharedParams.genesis.genesis_floor_price_ton_per_primes,
            donationPrimes: sharedParams.genesis.genesis_donation_primes,
            dedustNativeVault: dedustVault.address,
            dedustPool: dedustPool.address,
            primesJettonVault: dedustJettonVault.address,
            // §4.3.2 / D-151 — the staked reserve's venue and its two tsTON
            // wallets. Required, like `presentation`: see `validateStakingVenue`.
            tonstakersPool: tonstakersPool.address,
            dedustTstonVault: dedustTstonVault.address,
            dedustTstonPool: dedustTstonPool.address,
            ratchetTstonWallet: ratchetTstonWallet.address,
            treasuryTstonWallet: treasuryTstonWallet.address,
            // D-20: every prime's opening price comes from this table (or the
            // declared ladder fallback). There is no per-lot start price to
            // supply any more, so this is the only price input genesis carries.
            trophyNpv: sharedParams.trophy_auction.npv_ladder.npv_ton_by_prime as Record<string, number>,
            trophyRest: sharedParams.trophy_auction.resting_ladder.resting_nanoton_by_prime as Record<string, number>,
            // The real URIs deployGenesis.ts ships, not placeholders: the rehearsal's job
            // is to run the same code path a live genesis runs, and presentation is now
            // part of it (init data, unchangeable after deploy).
            presentation: {
                collectionMetadataUri: 'https://primes.live/collection.json',
                nftContentPrefix: 'https://primes.live/nft/',
                jettonMetadataUri: 'https://primes.live/jetton.json',
                royaltyNum: sharedParams.fees.royalty_numerator,
                royaltyDen: sharedParams.fees.royalty_denominator,
            },
        };
    });

    it('runs the full genesis pipeline end to end and opens the line at the first composite', async () => {
        // ---- 1-2. deploy + one-shot bootstrap wiring ----
        const d = await deployAndWire(env, code, params);

        expect((await d.collection.getCollectionData()).ledgerAddr.toString()).toBe(d.ledger.address.toString());
        expect((await d.master.getJettonData()).ledgerAddr.toString()).toBe(d.ledger.address.toString());
        expect((await d.ledger.getPeers()).peersSet).toBe(1);
        expect((await d.market.getMarketConfig()).ledgerAddr.toString()).toBe(d.ledger.address.toString());
        // D-212: the two naming fees landed in deploy data, and the registrar's rename
        // fee equals the collection's. Asserted HERE, in the wiring block, because
        // after this the only fix is a fresh genesis.
        const naming = await d.collection.getNaming();
        expect(naming.nameFee).toBe(REHEARSAL_NAME_FEE);
        expect(naming.renameFee).toBe(REHEARSAL_RENAME_FEE);
        expect(await d.registrar.getTrophyRenameFee()).toBe(naming.renameFee);
        // D-168: the treasury names the stake master in its init data
        // (`distribute()`'s recipient); the master learns the treasury by its
        // one-shot `set_wallet`, asserted with its wallet below.
        expect((await d.treasury.getDistribution()).stakeAddr.toString()).toBe(d.stake.address.toString());
        // D-212: a trophy re-engraving's fee reaches the floor through the collection.
        expect((await d.registrar.getPeers()).collectionSet).toBe(1);

        // ---- D-100: THE TWO FEE DESTINATIONS ARE TWO DIFFERENT ADDRESSES ----
        //
        // `ConfigA.feeDests` is init data with no setter, so this is the last
        // moment it can be checked while the set is still abandonable. The
        // failure it catches is silent by construction: the wrapper DEFAULTS
        // `operatorAddr` to `treasuryAddr` (so the many pre-D-100 fixtures keep
        // compiling), which means a pipeline that forgot to pass one would ship
        // the forfeit's 58% and its 42% remainder into the SAME address and no
        // get-method would look wrong — it would just quietly be the pre-D-100
        // behaviour again. Since D-152 the two addresses still have to differ
        // for exactly one reason, and it is a smaller one: §4.1's 5% line and
        // the forfeit's 58% both pay the governed pot deliberately now, so what
        // this check protects is the operator's 42% remainder being a SEPARATE
        // destination rather than a collapse of the forfeit split.
        const feeDests = await d.ledger.getFeeDests();
        expect(feeDests.treasuryAddr.toString()).toBe(d.treasury.address.toString());
        expect(feeDests.operatorAddr.toString()).toBe(treasuryWallet.address.toString());
        expect(feeDests.treasuryAddr.toString()).not.toBe(feeDests.operatorAddr.toString());

        // The treasury reports the config it was deployed with, and the two
        // ADDRESS-DETERMINING fields that have no setter at all are the ones
        // worth reading back: the sink it can forward LP to, and the operator it
        // records (which confers no authority — there is no message the treasury
        // accepts from that address).
        const treasuryCfg = await d.treasury.getTreasuryConfig();
        expect(treasuryCfg.sinkAddr.toString()).toBe(d.lpSink.address.toString());
        expect(treasuryCfg.operatorAddr.toString()).toBe(treasuryWallet.address.toString());
        expect(treasuryCfg.walletsSet).toBe(0); // `set_wallets` is a completeGenesis step

        // The LP sink exists, is empty, and has locked nothing — which is the
        // only state it can be in before anyone pairs on DeDust. TR-6 says its
        // balance is monotone non-decreasing, so zero here is the floor of every
        // later reading.
        expect(await d.lpSink.getLocked()).toBe(0n);
        expect(await d.lpSink.getEvents()).toBe(0);

        // D-166: ONE lock, the treasury's, and its beneficiary is a CONTRACT.
        // Checked before `completeGenesis` mints into it, because beneficiary and
        // total are init data and this is where a mis-size is still an abandoned
        // deploy rather than a stranded allocation. The deployment has no
        // operator lock at all.
        const vestTotal = treasuryVestPrimes(params, params.seedTon);
        const trVest = await d.treasuryVesting.getVesting();
        expect(trVest.totalAmount).toBe(vestTotal);
        expect(trVest.beneficiary.toString()).toBe(d.treasury.address.toString());
        expect('operatorVesting' in d).toBe(false);

        // minting is NOT open yet: head is still at the pre-genesis value
        expect(await d.ledger.getHead()).toBe(2n);

        // ---- 4-8 FIRST: operator allocation, bounty vault, seal, open minting,
        // queue the venue. §6 point 3 / D-46: the head opens BEFORE any bid
        // exists, so the game does not wait on the auction, and none of this
        // depends on any real DeDust deposit existing. Under the pre-D-19-era
        // ordering this block sat after the auction closed and nothing could
        // mint until every lot cleared its reserve. ----
        const tonNominal = params.seedTon;
        const dedustTonBefore = await dedustVault.getBalance();
        // the venue timelock's eta is stamped when step 8 runs, which is now
        // BEFORE any lot clears — so it must be compared against the clock at
        // queue time, not against a `blockchain.now` that later jumps forward
        // along the decay curve.
        const queuedAt = blockchain.now as number;
        const result = await completeGenesis(env, params, d, tonNominal);

        // CONCEPT §6 point 0: genesis lands COMPLETE BUT CLOSED. Nothing is
        // biddable, reservable or mintable yet, and that is checked here rather
        // than assumed — "the deploy script does not ignite" is a claim about
        // the pipeline, so the pipeline rehearsal is where it belongs.
        expect((await d.ledger.getLaunch()).launched).toBe(false);
        expect(await d.market.getLaunched()).toBe(false);

        // D-93: the floor donation, between the seed and the launch. Without it
        // `ignite` throws 218 (`ledger_floor_unbacked`) — the pipeline leaves
        // `T = 0` and this is the step that creates the floor at all. Scaled
        // like every other figure in this rehearsal; the mainnet amount is
        // D-92's derived 240 GRAM.
        const donation = toNano((genesisDonationTon(sharedParams.genesis) / SCALE).toFixed(9));
        // D-156: the taper scales this emission by `(S_MAX − S)/S_MAX`, evaluated at the
        // `S` the handler sees. `donateGenesisFloor` does nothing but the donation, so the
        // `S` DELTA across it is exactly that emission — measured off the ledger rather
        // than recomputed, because the point of the assertion far below is to tie the
        // operator's wallet balance to what the ledger actually emitted.
        const sBeforeDonation = await d.ledger.getFloorDen();
        await donateGenesisFloor(env, d, donation);
        const donationPrimes = (await d.ledger.getFloorDen()) - sBeforeDonation;
        expect(await d.ledger.getFloorNum()).toBe(donation);

        // THE LAUNCH. Mints Unity to the founder and opens the one market.
        const launch = await igniteGame(env, d, genesis.address);
        expect(launch.launched).toBe(true);
        // D-20: the head is defined over composites and Unity only, so it opens
        // at the FIRST COMPOSITE. Unity itself does not move it, and 2 and 3 are
        // never on the sequential line at all — the genesis seed's walk to 4
        // marked them prime on the way past.
        expect(await d.ledger.getHead()).toBe(OPENING_HEAD);
        expect(launch.itemsMinted).toBe(1n); // Unity, and nothing else
        expect(await d.ledger.isKnownPrime(2n)).toBe(1);
        expect(await d.ledger.isKnownPrime(3n)).toBe(1);

        // ---- 3. THE PRIME MARKET, running against an already-live game.
        //
        // D-20: this is not a genesis step. There is no lot set to seed and no
        // bootstrap message to send — 2 and 3 are already behind the head, so
        // their MODE_DUTCH_BUYNOW lots are openable by anybody from the first
        // block, and buying one is what a player does, not what genesis does.
        // Each buy settles in the same transaction it is made in (D-20/D-88). ----
        const lane = { blockchain, market: d.market as any, ledger: d.ledger as any };
        const buys: bigint[] = [];
        for (const [i, p] of [2n, 3n].entries()) {
            const buy = await acquirePrime(lane, bidders[i], p);
            buys.push(buy.premium);
            const lot = await d.market.getLot(p);
            expect(lot.closed).toBe(true);
        }
        const marketState = await d.market.getMarketStats();
        expect(marketState.closedLots).toBe(2);
        expect(marketState.unforwardedPremium).toBe(0n);
        // 100% of every premium reached the ledger and none of it bounced (D-7).
        expect(marketState.lotPremiumTotal).toBe(buys[0] + buys[1]);

        // each bought prime is a real NFT owned by its buyer
        for (const [i, p] of [2n, 3n].entries()) {
            const itemAddr = await d.collection.getItemAddress(p);
            const item = blockchain.openContract(PrimesItem.createFromAddress(itemAddr));
            const data = await item.getNumberData();
            expect(data.owner.toString()).toBe(bidders[i].address.toString());
            expect(data.isPrime).toBe(1);
        }

        // D-46: no DeDust deposit at genesis. The DeDust stand-in vault never
        // receives anything — no PRIMES ever move there, so its jetton wallet is
        // never even deployed (TEP-74 wallets deploy lazily on first transfer),
        // which is itself the honest proof nothing was sent.
        expect(await dedustVault.getBalance()).toBe(dedustTonBefore);

        // D-166: the whole vested allocation is the treasury's, in ONE lock, and
        // genesis releases its tranche 0. The operator holds only what its own
        // donation minted — no genesis allocation at all. Everything below is the
        // arithmetic an auditor does in three get-calls, and it has to close
        // exactly: nothing minted has leaked and nothing is stranded.
        const minted = result.allocationResult.primesMinted;
        expect(minted).toBe(treasuryVestPrimes(params, params.seedTon));
        const genesisWalletAddr = await d.master.getWalletAddress(genesis.address);
        const genesisWallet = blockchain.openContract(PrimesJettonWallet.createFromAddress(genesisWalletAddr));
        const trLockWallet = blockchain.openContract(
            PrimesJettonWallet.createFromAddress(await d.master.getWalletAddress(d.treasuryVesting.address))
        );
        const operatorHolds = (await genesisWallet.getWalletData()).balance;
        const trLockHolds = (await trLockWallet.getWalletData()).balance;
        // D-92/D-100 point 2: the donation above minted `X·L` PRIMES to whoever
        // sent it — here the operator, as on mainnet — and those are the pool's
        // PRIMES side, not part of the vested allocation. They land in the same
        // wallet, so the vesting arithmetic is stated net of them rather than
        // against a raw balance that silently mixes the two.
        // D-156: the logistic cap tapers this emission like every other, so what the
        // operator actually holds is `X·L·(S_MAX − S)/S_MAX`. Same integer order as the
        // contract — multiply before dividing, one truncation — and `sAtDonation` is the
        // `S` the handler saw, which at genesis is the seeded supply.
        // D-156, pinned explicitly: the emission is the flat `X·L` rate MINUS the taper,
        // so it must be strictly below the flat figure and within a hair of it at genesis
        // (S is a rounding error against a 1.2e9 PRIMES cap). Without these two bounds the
        // delta above would pass even if the taper were removed or ran away.
        const flatRate = donation * BigInt(sharedParams.genesis.genesis_lp_ratio_primes_per_ton);
        expect(donationPrimes).toBeLessThan(flatRate);
        expect(donationPrimes).toBeGreaterThan((flatRate * 9_999n) / 10_000n);
        expect(operatorHolds).toBe(donationPrimes);
        // The whole mint, accounted for: one released quarter on the treasury's
        // wallet, the rest in its lock.
        const trWallet = blockchain.openContract(
            PrimesJettonWallet.createFromAddress(await d.master.getWalletAddress(d.treasury.address))
        );
        const treasuryHolds = (await trWallet.getWalletData()).balance;
        expect(trLockHolds + treasuryHolds).toBe(minted);
        expect(treasuryHolds).toBe(minted / 4n);
        expect(trLockHolds).toBe(minted - minted / 4n);
        // D-100 point 6: the tranche is COUNTED, not merely held — the
        // `NOTIFY_GAS` riding the vesting transfer is what makes this line true.
        expect((await d.treasury.getTreasuryBalances()).primesBalance).toBe(minted / 4n);

        // The lock's own report agrees with its wallet, and the schedule is the
        // declared one. `startTime` is stamped by `set_wallet`, so a nonzero
        // value is also the proof that the bootstrap landed. Nothing further is
        // claimable until the clock reaches day 90.
        const trVestAfter = await d.treasuryVesting.getVesting();
        expect(trVestAfter.totalAmount).toBe(minted);
        expect(trVestAfter.releasedAmount).toBe(minted / 4n);
        expect(trVestAfter.unlocked).toBe(1);
        expect(trVestAfter.tranches).toBe(4);
        expect(trVestAfter.startTime).toBeGreaterThan(0);
        expect(trVestAfter.beneficiary.toString()).toBe(d.treasury.address.toString());
        expect((await d.treasuryVesting.getVestingSchedule()).releasableNow).toBe(0n);

        // D-100 points 4/5: the treasury and the sink know their own jetton
        // wallets, which is what makes every later figure checkable — the sink's
        // `getLocked()` against its LP wallet balance, the treasury's
        // `primesBalance` against its PRIMES wallet.
        const lpSinkCfg = await d.lpSink.getLpSinkConfig();
        expect(lpSinkCfg.walletSet).toBe(1);
        expect(lpSinkCfg.lpJettonWalletAddr.toString()).toBe(
            (await env.lpWalletFor(d.lpSink.address)).toString()
        );
        expect(await d.lpSink.getLocked()).toBe(0n);
        const trCfgAfter = await d.treasury.getTreasuryConfig();
        expect(trCfgAfter.walletsSet).toBe(1);
        expect(trCfgAfter.lpJettonWallet.toString()).toBe(
            (await env.lpWalletFor(d.treasury.address)).toString()
        );
        expect(trCfgAfter.primesJettonWallet.toString()).toBe(
            (await d.master.getWalletAddress(d.treasury.address)).toString()
        );
        // The vest tranche is the only PRIMES in, all of it held and none of it
        // distributed yet (D-168: `distribute()` is the only non-proposal exit).
        expect((await d.treasury.getTreasuryBalances()).primesBalance).toBe(minted / 4n);
        const dist = await d.treasury.getDistribution();
        expect(dist.rateBps).toBe(sharedParams.staking.distribution_rate_bps_per_day);
        expect(dist.lastDistributeTime).toBe(0);
        expect(dist.distributedTotal).toBe(0n);

        // bounty vault holds real PRIMES, pre-counted into S
        const vaultCfg = await d.vault.getVaultConfig();
        expect(vaultCfg.walletSet).toBe(1);
        const vaultWallet = blockchain.openContract(PrimesJettonWallet.createFromAddress(vaultCfg.jettonWalletAddr));
        expect((await vaultWallet.getWalletData()).balance).toBe(params.bountyVaultPrimes);

        // D-168: THE STAKE MASTER KNOWS ITS OWN WALLET AND HOLDS NOTHING. It is
        // custody and starts empty; a genesis that funded it would be a genesis that
        // pre-counted PRIMES into a sink, which is not what `S` means.
        const stakeCfg = await d.stake.getStakeConfig();
        expect(stakeCfg.walletSet).toBe(1);
        expect(stakeCfg.treasuryAddr.toString()).toBe(d.treasury.address.toString());
        expect(stakeCfg.jettonWalletAddr.toString()).toBe(
            (await d.master.getWalletAddress(d.stake.address)).toString()
        );
        expect(await d.stake.getStakeSolvency()).toEqual({
            lockedTotal: 0n, streamRemaining: 0n, unclaimedTotal: 0n,
        });

        // jetton authority sealed: mint_genesis is dead forever
        expect((await d.master.getJettonData()).genesisSealed).toBe(1);
        const postSeal: any = await (d.master as any).sendMintGenesis(genesis.getSender(), {
            to: genesis.address,
            amount: toNano('1'),
            value: toNano('0.2'),
        });
        expect(postSeal.transactions).toHaveTransaction({ to: d.master.address, success: false, exitCode: 400 });

        // Minting open: T/S seeded, head at the first composite, the primes the
        // genesis walk crossed recorded in the bitmap. `S` is EXACTLY the seed —
        // §5.1's k = 0 means a prime sale emits nothing, ever — while `T` has
        // grown past it, because D-7 credits the nominal MINT_PRICE's pool leg
        // AND, since `DECISIONS.md` D-114 amended D-7, HALF of the premium to
        // the ratchet (the other half goes to the governed treasury and never
        // reaches `T`). That asymmetry is the whole claim: a prime sale is
        // backing without emission, so it can only raise p_f = T/S. Asserting
        // `T === seedT` here would be asserting that clearings do nothing.
        // The baseline is the seed PLUS D-92's donation emission — the one other
        // thing that has moved `S` at this point, and the only emission in the
        // whole game that is not a rebate (D-91 point 4).
        const sBaseline = result.seedS + donationPrimes;
        expect(await d.ledger.getFloorDen()).toBe(sBaseline);
        const tAfterSales = await d.ledger.getFloorNum();
        expect(tAfterSales).toBeGreaterThan(result.seedT + donation);
        // Only the ratchet's half of every premium reached `T`, plus the two
        // nominal mints' own pool legs — so the growth is at least half the
        // premium and strictly more (D-114; the pool legs and truncation
        // rounding up on an odd premium both push it above the exact half).
        expect(tAfterSales - result.seedT - donation).toBeGreaterThan(marketState.lotPremiumTotal / 2n);

        // D-20: the head has not moved. Buying a prime is not a mint at the head.
        expect(await d.ledger.getHead()).toBe(OPENING_HEAD);
        for (const p of [2n, 3n]) {
            expect(await d.ledger.isKnownPrime(p)).toBe(1);
        }
        // ...and the primes ABOVE the head are not marked yet: the bitmap records
        // what the head has walked past, and it has walked past nothing but 2, 3.
        expect(await d.ledger.isKnownPrime(5n)).toBe(0);
        expect(await d.ledger.isKnownPrime(9n)).toBe(0);

        // ---- the genesis SIZING is EXACTLY what params.json says it is ----
        //
        // DENOMINATION_PLAN P7: this is the assertion that catches a
        // half-propagated redenomination. `L` reaches the deploy through three
        // separate call sites and the era schedule through a fourth; a params file
        // at one `L` with a deploy path at another produces a game that opens at
        // the wrong sizing and nothing else complains. So the identity is checked
        // against the file rather than against a remembered number:
        //
        //   S₀ = seed·L/2 + V   and   V = vault_pct · seed·L        (D-166)
        //   ⟹  S₀/seed = L · (1/2 + vault_pct) = genesis_supply_primes / seed
        //
        // D-100 point 2 BROKE THE OLD FORM OF THIS ASSERTION, and it is worth
        // being exact about which half broke. The identity above is a statement
        // about SUPPLY SIZING and it is untouched by D-100 — `S₀` is `seed·L·(1/2 +
        // vault_pct)` = 11,000,000 at the 200 GRAM nominal since D-166 deleted the
        // operator's half of the vest. What used to be true
        // as well is that this same ratio WAS the opening floor's reciprocal,
        // because D-92 chose the donation to make `T/S₀` come out at `seed/S₀`.
        // The owner unpinned the donation from the seed (132.50 GRAM against a 200
        // GRAM nominal), so `deploy_floor_primes_per_ton` is now
        // `1 / genesis_floor_price_ton_per_primes` = 2,857,142.86 — a floor
        // figure, ~48× the supply ratio, and no longer the same number.
        // Asserting them equal is asserting the coincidence D-100 removed.
        //
        // D-46: `result.seedT` is always `0` (no real deposit), so the sizing is
        // checked against `tonNominal` — the sizing input — not against real `T`.
        // Everything here is at 1/SCALE, and the ratio is scale-free, which is why
        // the rehearsal can check the real figure at a fraction of the size.
        expect(result.seedS).toBeGreaterThan(result.allocationResult.primesMinted);
        expect(result.seedT).toBe(0n);
        const supplyPrimesPerSeedTon =
            sharedParams.genesis.genesis_lp_ratio_primes_per_ton *
            (0.5 + sharedParams.genesis.bounty_vault_pct_of_genesis_lp);
        // `seedS` is nano-PRIMES and `tonNominal` nanoGRAM: same 1e9, so the ratio
        // is PRIMES per GRAM directly.
        expect(Number(result.seedS) / Number(tonNominal)).toBeCloseTo(supplyPrimesPerSeedTon, 3);
        expect(sharedParams.genesis.genesis_supply_primes).toBeCloseTo(
            sharedParams.genesis.genesis_seed_ton * supplyPrimesPerSeedTon,
            3
        );
        // …and the DEPLOY FLOOR is the donation's floor, which is the other half
        // of the same pair of numbers and is checked as such rather than assumed.
        expect(sharedParams.genesis.deploy_floor_primes_per_ton).toBeCloseTo(
            1 / sharedParams.genesis.genesis_floor_price_ton_per_primes,
            3
        );
        // `S` at deploy is `S₀` PLUS what `donate_floor` mints the donor — the
        // 2026-09-24 testnet genesis measured that; dividing by `S₀` alone is 12% high.
        expect(sharedParams.genesis.genesis_floor_price_ton_per_primes).toBeCloseTo(
            sharedParams.genesis.genesis_donation_ton /
                (sharedParams.genesis.genesis_supply_primes + sharedParams.genesis.genesis_donation_primes),
            12
        );

        // venue timelock queued (step 8), not executed: 30 days out, permissionless
        const queued = await d.timelock.getQueued();
        expect(queued.hasQueued).toBe(1);
        expect(queued.fired).toBe(0);
        expect(queued.dedustNativeVault.toString()).toBe(dedustVault.address.toString());
        expect(queued.eta).toBeGreaterThanOrEqual(queuedAt + TIMELOCK_DELAY);
        // D-194: queued is not confirmed — the LP vote is the second key, and its
        // electorate is the treasury the pipeline just deployed.
        expect(queued.confirmed).toBe(0);
        expect((await d.timelock.getKeys()).governanceAddr.toString()).toBe(d.treasury.address.toString());

        // §4.3.2 / D-151 — THE STAKED RESERVE IS WIRED, in all three places it
        // has to be, and each is read back off a get-method rather than assumed.
        // D-194: deploy data only — no queued venue change can move it.
        const stakingVenue = await d.ratchet.getStakingVenue();
        expect(stakingVenue.tonstakersPool.toString()).toBe(tonstakersPool.address.toString());
        expect(stakingVenue.dedustTstonVault.toString()).toBe(dedustTstonVault.address.toString());
        expect(stakingVenue.dedustTstonPool.toString()).toBe(dedustTstonPool.address.toString());
        expect((await d.ratchet.getHarvestDest()).toString()).toBe(d.treasury.address.toString());
        const tstonWallet = await d.ratchet.getTstonWallet();
        expect(tstonWallet.walletSet).toBe(1);
        expect(tstonWallet.tstonWalletAddr.toString()).toBe(ratchetTstonWallet.address.toString());
        expect((await d.treasury.getTreasuryConfig()).tstonJettonWallet.toString()).toBe(
            treasuryTstonWallet.address.toString()
        );

        // ---- post-genesis smoke: the line really is open at 4 = 2^2 ----
        //
        // D-20 makes 4 the first buildable number, and it is buildable out of a
        // prime somebody bought a moment ago — which is the whole shape of the
        // new opening: the market supplies the factors the head consumes.
        const mint: any = await (d.ledger as any).sendMint(minter.getSender(), {
            n: 4n,
            kind: 0,
            factors: [{ prime: 2n, exponent: 2 }],
            referralKey: 2,
            beneficiary: null,
            value: toNano('1'),
        });
        expect(mint.transactions).toHaveTransaction({ to: d.ledger.address, success: true });
        // and the head walks past 5, which is prime, opening it in the market
        expect(await d.ledger.getHead()).toBe(6n);
        expect(await d.ledger.isKnownPrime(5n)).toBe(1);

        // tribute reached the prime's buyer (CONCEPT §4.2's "early on,
        // essentially all tribute flows to the people who bought the primes")
        const item2 = blockchain.openContract(PrimesItem.createFromAddress(await d.ledger.getItemAddress(2n)));
        // §3.2: 4 = 2^2 — 2 is the sole tribute recipient, so it takes the whole
        // 80% divisor line (the 20% flat line accrues to div_acc, not `owed`).
        expect(await item2.getOwed()).toBe(toNano('0.08'));

        // the floor ratchets from its genesis value
        expect(await d.ledger.getFloorNum()).toBeGreaterThan(result.seedT);

        // and the market's ACQUISITION lane is live at the same moment
        // (CONCEPT §6 point 3).
        //
        // D-30 leaves one route to a composite ahead of the head: open an
        // ascending lot at `P0(n)` — opening is a paid first bid — let the clock
        // run, and close it. D-90: THE CLOSE MINTS. 20014 = 2 · 10007, and 10007
        // is far above this head, so the settlement also exercises D-90.1 — the
        // cited factor is proved by Miller-Rabin rather than looked up in the
        // prime bitmap it is not in yet.
        const { n: resN } = RESERVABLE_20014;
        const win = await winLot({ blockchain, market: d.market }, minter, RESERVABLE_20014);
        expect(await d.ledger.isNumberOffHeadResolved(resN)).toBe(true); // D-196: on its lot block that far ahead
        const wonItem = blockchain.openContract(
            PrimesItem.createFromAddress(await d.ledger.getItemAddress(resN))
        );
        const wonData = await wonItem.getNftData();
        expect(wonData.init).toBe(-1); // TEP-62 init? is TVM true
        expect(wonData.ownerAddress.equals(minter.address)).toBe(true);
        expect(win.premium).toBeGreaterThan(0n); // it went somewhere: half to T, half to the treasury (D-114)

        // §7 stays a public event: an era boundary is on NEITHER lane, because
        // a price of any kind would leave it purchasable years ahead by one
        // wallet, which privatises a public ceremony. The rehearsal proves the
        // acquisition lane is open at genesis, not that the ceremony numbers are
        // for sale.
        expect(await d.market.getIsOpenable(30n)).toBe(false);
    }, 180_000);

    // GAUNTLET.md R17 — the mainnet DeDust-pool ordering problem. `dryRunGenesisMasterAddress`
    // must print the SAME address `deployAndWire` actually deploys the jetton master to,
    // computed with no send and no live network, or a mainnet pool created against it would
    // be created against the wrong contract.
    it('R17: dryRunGenesisMasterAddress predicts the real deployed master address', async () => {
        const predicted = dryRunGenesisMasterAddress(
            env.genesisAddress,
            code.jettonMaster,
            code.jettonWallet,
            params.presentation.jettonMetadataUri
        );

        const d = await deployAndWire(env, code, params);

        expect(predicted.toString()).toBe(d.master.address.toString());
    });

    // G76 / CONCEPT §9.5 — the quests track pays through the voucher END TO END on the set
    // the pipeline actually deploys: the vault's allow-list names the voucher, `SetVault`
    // closed the loop, and a signed claim moves PRIMES from the vault to the claimant.
    it('G76: a signed voucher pays PRIMES out of the genesis vault', async () => {
        const d = await deployAndWire(env, code, params);
        await completeGenesis(env, params, d, params.seedTon);
        const v = await d.voucher.getVault();
        expect(v.vaultSet).toBe(true);
        expect(v.vaultAddr.equals(d.vault.address)).toBe(true);

        const total = toNano('3'); // 3 PRIMES, well inside the scaled quests cap
        const validUntil = (blockchain.now as number) + 3600;
        const voucher = blockchain.openContract(PrimesVoucher.createFromAddress(d.voucher.address));
        const r = await voucher.sendClaim(minter.getSender(), {
            cumulativeTotal: total,
            validUntil,
            signature: signVoucherClaim(VOUCHER_KEY.secretKey, sandboxGlobalId(blockchain), d.voucher.address, minter.address, total, validUntil),
            value: toNano('0.2'),
        });
        expect(r.transactions).not.toHaveTransaction({ aborted: true });
        const wallet = blockchain.openContract(
            PrimesJettonWallet.createFromAddress(await d.master.getWalletAddress(minter.address))
        );
        expect((await wallet.getWalletData()).balance).toBe(total);
    });

    // D-170 — the one security prize. A second voucher instance on its own key, tagged SECU,
    // allow-listed for exactly the prize: the whole prize pays, and not one nanoPRIMES more.
    it('D-170: the security voucher pays the reserved prize and nothing past it', async () => {
        const d = await deployAndWire(env, code, params);
        await completeGenesis(env, params, d, params.seedTon);
        const sec = blockchain.openContract(PrimesVoucher.createFromAddress(d.securityVoucher.address));
        expect((await sec.getSignerState()).programTag).toBe(PROGRAM_TAG_SECURITY);
        expect(d.securityVoucher.address.equals(d.voucher.address)).toBe(false);

        const prize = params.securityBountyPrimes;
        const validUntil = (blockchain.now as number) + 3600;
        const claim = (total: bigint, key: Buffer) =>
            sec.sendClaim(minter.getSender(), {
                cumulativeTotal: total,
                validUntil,
                signature: signVoucherClaim(key, sandboxGlobalId(blockchain), sec.address, minter.address, total, validUntil, PROGRAM_TAG_SECURITY),
                value: toNano('0.2'),
            });
        const wallet = blockchain.openContract(
            PrimesJettonWallet.createFromAddress(await d.master.getWalletAddress(minter.address))
        );
        const balance = async () =>
            (await blockchain.getContract(wallet.address)).accountState?.type === 'active'
                ? (await wallet.getWalletData()).balance
                : 0n;

        // The quests signer cannot spend the prize.
        await claim(prize, VOUCHER_KEY.secretKey);
        expect(await balance()).toBe(0n);

        const r = await claim(prize, SECURITY_KEY.secretKey);
        expect(r.transactions).not.toHaveTransaction({ aborted: true });
        expect(await balance()).toBe(prize);

        // One past the reserve: the vault refuses, the bounce rolls the high-water mark back.
        await claim(prize + 1n, SECURITY_KEY.secretKey);
        expect(await balance()).toBe(prize);
        expect(await sec.getPaid(minter.address)).toBe(prize);
    });

    // G78 / D-171 — the third instance, tagged PQST, capped at `prime_quests`, on its own key
    // since R2-M2. A PQST voucher on its key pays; the quests key cannot spend this track,
    // and neither can its own key under the QSTS tag.
    it('G78 / R2-M2: the prime-quests voucher pays on its own key under its own tag only', async () => {
        const d = await deployAndWire(env, code, params);
        await completeGenesis(env, params, d, params.seedTon);
        const pq = blockchain.openContract(PrimesVoucher.createFromAddress(d.primeQuestsVoucher.address));
        expect((await pq.getSignerState()).programTag).toBe(PROGRAM_TAG_PRIME_QUESTS);
        const total = toNano('2');
        const validUntil = (blockchain.now as number) + 3600;
        const send = (key: Buffer, tag?: number) =>
            pq.sendClaim(minter.getSender(), {
                cumulativeTotal: total,
                validUntil,
                signature: signVoucherClaim(key, sandboxGlobalId(blockchain), pq.address, minter.address, total, validUntil, tag),
                value: toNano('0.2'),
            });
        await send(PRIME_QUESTS_KEY.secretKey); // signed for QSTS — refused here
        expect(await pq.getPaid(minter.address)).toBe(0n);
        await send(VOUCHER_KEY.secretKey, PROGRAM_TAG_PRIME_QUESTS); // the quests key — refused here
        expect(await pq.getPaid(minter.address)).toBe(0n);
        const r = await send(PRIME_QUESTS_KEY.secretKey, PROGRAM_TAG_PRIME_QUESTS);
        expect(r.transactions).not.toHaveTransaction({ aborted: true });
        const wallet = blockchain.openContract(
            PrimesJettonWallet.createFromAddress(await d.master.getWalletAddress(minter.address))
        );
        expect((await wallet.getWalletData()).balance).toBe(total);
    });

    // Audit 2026-11-19 R2-M2 — each instance's per-wallet cap is the shared/voucher.ts figure
    // the backend signer refuses above, read back off the deployed contract (unscaled: it is
    // a bound, not a figure this rehearsal spends).
    it('R2-M2: every voucher instance carries its params.json per-wallet cap', async () => {
        const d = await deployAndWire(env, code, params);
        for (const [inst, tag] of [
            [d.voucher, PROGRAM_TAG_QUESTS],
            [d.primeQuestsVoucher, PROGRAM_TAG_PRIME_QUESTS],
            [d.securityVoucher, PROGRAM_TAG_SECURITY],
        ] as const) {
            expect(await inst.getMaxPerWallet()).toBe(VOUCHER_MAX_PER_WALLET[tag]);
        }
        expect(VOUCHER_MAX_PER_WALLET[PROGRAM_TAG_QUESTS]).toBe(BigInt(sharedParams.genesis.quest_rewards.reward_nanoprimes));
        expect(VOUCHER_MAX_PER_WALLET[PROGRAM_TAG_PRIME_QUESTS]).toBe(
            BigInt(sharedParams.genesis.quest_rewards.prime_quests.reward_primes) * 1_000_000_000n
        );
        expect(VOUCHER_MAX_PER_WALLET[PROGRAM_TAG_SECURITY]).toBe(
            BigInt(sharedParams.genesis.era_bounty_schedule.remaining_vault_split.tracks.security_bounty.primes) * 1_000_000_000n
        );
    });

    it('R2-M2: genesis refuses to deploy two voucher instances on one key', async () => {
        for (const dup of [
            { primeQuestsSignerPubkey: VOUCHER_KEY.publicKey },
            { securitySignerPubkey: VOUCHER_KEY.publicKey },
            { securitySignerPubkey: PRIME_QUESTS_KEY.publicKey },
        ]) {
            await expect(deployAndWire(env, code, { ...params, ...dup })).rejects.toThrow(/one key per track/);
        }
    });

    it('opens minting with every prime still unsold — the cold start (CONCEPT §6 point 3)', async () => {
        // This test replaces the old "refuses to open minting if any auction lot
        // went unsold (D19 guard)". The assertion is inverted DELIBERATELY and
        // the spec moved first: §6 point 3 opens minting at deploy regardless of
        // whether any real DeDust liquidity exists (D-46), so the line is open
        // before a single prime is bought, and an unbought prime is §6 point 2's
        // forfeited case rather than an error.
        //
        // D-20 makes it structural rather than merely tolerated. A prime is never
        // a position on the sequential line, so an unsold prime cannot orphan the
        // head no matter how long it sits — "it just sits there, at MINT_PRICE,
        // forever, until bought."
        const d = await deployAndWire(env, code, params);

        // Open the game. NOTHING has been bought and no real liquidity exists.
        await completeGenesis(env, params, d, params.seedTon);
        // D-93: the floor donation comes first — `ignite` refuses to launch a
        // ledger whose `T` is still 0.
        await donateGenesisFloor(env, d, toNano((genesisDonationTon(sharedParams.genesis) / SCALE).toFixed(9)));
        // CONCEPT §6 point 0: and then somebody starts it.
        await igniteGame(env, d, genesis.address);

        expect(await d.ledger.getHead()).toBe(OPENING_HEAD);
        expect((await d.master.getJettonData()).genesisSealed).toBe(1);
        expect((await d.market.getMarketStats()).closedLots).toBe(0);

        // Run the clock far past a full decay window with nobody buying. D-20
        // point 2: the price rests on the universal MINT_PRICE floor and the lot
        // stays open — no expiry, no void, no reserve left unmet.
        const lane = { blockchain, market: d.market as any, ledger: d.ledger as any };
        // 3, not a fresh "ahead of head" prime: D-88 point 3 puts an
        // ahead-of-head prime on the ASCENDING lane, so `open_head_lot` refuses
        // it — 3 is the one already-past-turn prime this cold-start genesis has
        // to work with besides 2. D-88 point 1 makes the resting price
        // `getPrimeFloor(3)`, which D-218 sets to the tribute 3 earns over the
        // 5,000 composite mints after its turn — the genesis rest table's entry.
        const priceMin = await d.market.getPrimeFloor(3n);
        expect(priceMin).toBe(BigInt(sharedParams.trophy_auction.resting_ladder.resting_nanoton_by_prime['3']));
        const { decaySeconds: specialDecaySeconds } = await d.market.getPrimeDutchTerms();
        await d.market.sendOpenHeadLot(bidders[0].getSender(), { n: 3n, value: toNano('0.2') });
        blockchain.now = (blockchain.now as number) + specialDecaySeconds * 10;
        const resting = await d.market.getLot(3n);
        expect(resting.closed).toBe(false);
        expect(resting.standingPrice).toBe(priceMin); // D-88 pt 1: rests above MINT_PRICE, and PARKS

        // …and the head never noticed. The line is open at 4 and composites mint
        // straight through, which is the whole point.
        expect(await d.ledger.getHead()).toBe(OPENING_HEAD);
        // 4 = 2^2 cites 2, and 2 is unsold, so 2's tribute line is the one that
        // forfeits. Forfeiture is per CITED factor, not per open lot.
        const forfeitedBefore = await d.ledger.getForfeited(2n);

        // The unbought prime's tribute forfeits to the TREASURY while it sits
        // (D-20 point 4) — not to the pool and not to any item's owner.
        const mint: any = await (d.ledger as any).sendMint(minter.getSender(), {
            n: 4n,
            kind: 0,
            factors: [{ prime: 2n, exponent: 2 }],
            referralKey: 0,
            beneficiary: null,
            value: toNano('1'),
        });
        expect(mint.transactions).toHaveTransaction({ to: d.ledger.address, success: true });
        expect(await d.ledger.getForfeited(2n)).toBeGreaterThan(forfeitedBefore);

        // …and that prime can still be bought, at the floor, whenever anyone wants
        // — at its own tier floor, which is above MINT_PRICE for a special prime.
        const late = await acquirePrime(lane, bidders[0], 3n);
        expect(late.standingPrice).toBe(priceMin);
        expect(late.premium).toBe(priceMin - toNano('1'));
        expect((await d.market.getLot(3n)).closed).toBe(true);
    }, 120_000);

    // ------------------------------------------------------------------
    // W8.3 — EVERY DEPLOY-TIME CONFIG VALUE, READ BACK OFF THE DEPLOYED
    // CONTRACT AND CHECKED AGAINST ITS SOURCE.
    //
    // These land in ADDRESS-DETERMINING init data with no setter, so a wrong one
    // is not a bug to fix but a genesis to abandon. The suites that already pin
    // these numbers do it against markets and ledgers built by test helpers;
    // this block does it against the set `deployAndWire` actually produces,
    // which is the only artefact the operator ships.
    // ------------------------------------------------------------------
    describe('W8.3 deploy config traces to shared/params.json', () => {
        // `MIN_AUCTION_DISTANCE` is DELETED (D-45) — there is no deploy-time
        // liveness-gate figure left to trace to params.json. The test that used
        // to stand here pinned exactly that figure; see `PrimesMarket.spec.ts`'s
        // "D-45 — the auction-distance gate is deleted" block for its replacement.

        it('ships W8.1 RES_GAS 0.060 and the derived LOT_FLOOR 1.060', async () => {
            const d = await deployAndWire(env, code, params);
            const resGas = await d.market.getResGas();
            expect(resGas).toBe(BigInt(sharedParams.off_head.res_gas_nanoton));
            const mp = await d.market.getMarketParams();
            // LOT_FLOOR is an IDENTITY, not a second number: MINT_PRICE + RES_GAS.
            expect(mp.lotFloor).toBe(toNano('1') + resGas);
            expect(mp.lotFloor).toBe(BigInt(sharedParams.off_head.lane_floor_nanoton));
            // D-88 point 1 DELETED §12's "no lane may terminate above 1 GRAM"
            // and MKT-1 with it: a prime's lane rests at min(P0(p),
            // max(MINT_PRICE, restTable[p])) (D-218).
            // `floorMin` below is therefore the LOWER BOUND the contract
            // publishes, not any lot's terminus — which is why the field is
            // named `floorMin`. GAUNTLET C6.1: this used to add "and it is
            // derived, not stored", which stopped being true at SS3/D-47 —
            // `Lot.priceFloor` is a stored field, write-once from `n` (no
            // message carries it, no update path mutates it), and that is the
            // half of MKT-1 that survived. D-61 (GAUNTLET C6.2) retargets the
            // outside-checkable witness onto `PrimesMarket.spec.ts`'s C6 block,
            // which drives real lots to their terminus and reads `getLotFloor`.
            // See CONCEPT.md §4.4.
            const dutch = await d.market.getPrimeDutchTerms();
            expect(dutch.floorMin).toBe(toNano('1'));
        });

        // D-100 — THE PAIRING RUNBOOK IS PART OF THE DEPLOY, not a wiki page.
        //
        // The pair is manual (R1-2: no verified DeDust deposit wire format), so
        // the last thing a genesis run does is tell a human what is left. This
        // asserts the four addresses an auditor needs are actually in it: a
        // runbook that names the treasury but not the sink's own LP jetton
        // wallet leaves `getLocked()` uncheckable, which is the one number the
        // sink exists to publish.
        it('prints a pairing runbook naming the treasury, the sink and the sink LP wallet', async () => {
            const d = await deployAndWire(env, code, params);
            const lpWallet = await env.lpWalletFor(d.lpSink.address);
            const text = pairingInstructions(sharedParams.genesis, d, lpWallet);

            expect(text).toContain(d.treasury.address.toString());
            expect(text).toContain(d.lpSink.address.toString());
            expect(text).toContain(lpWallet.toString());
            expect(text).toContain(d.ledger.address.toString());
            // D-140 added a fifth (the operator's vesting lock); D-166 deleted
            // that lock, so the runbook names no `release` step at all.
            expect(text).not.toMatch(/release/);
            // The figures, from params.json and not from prose: the donation and the
            // PRIMES it mints (`X·L` at T = 0, less D-156's taper).
            // `donate_floor` is named, because it is what moves them.
            expect(text).toContain(String(sharedParams.genesis.genesis_donation_ton));
            expect(text).toContain(String(Math.floor(sharedParams.genesis.genesis_donation_primes)));
            expect(text).toMatch(/donateFloor/);
            // NOT the nominal seed. Printing the seed here is the exact confusion
            // D-100 point 2 created and this line is what would catch it — whenever
            // the two differ. D-204 set the donation to the seed's own 200, and a
            // string cannot tell two equal figures apart.
            if (sharedParams.genesis.genesis_seed_ton !== sharedParams.genesis.genesis_donation_ton) {
                expect(text).not.toContain(`${sharedParams.genesis.genesis_seed_ton} GRAM`);
            }
        });

        // D-140. The runbook is the only place the opening PRICE of the market is
        // ever stated, because the price is not protocol state — it is the ratio
        // of the one deposit a human makes by hand. So the number it prints is
        // asserted here, against `p_f` and not against a literal: a runbook that
        // quotes the GRAM side at `PRIMES / L` reopens the 286x book, and nothing
        // on chain would complain.
        it('quotes the pair at the floor, not at L (D-140)', async () => {
            const d = await deployAndWire(env, code, params);
            const lpWallet = await env.lpWalletFor(d.lpSink.address);
            const text = pairingInstructions(sharedParams.genesis, d, lpWallet);

            const g = sharedParams.genesis;
            // The PRIMES side is the donation's mint and nothing else (D-166
            // deleted the operator's vest tranche). NOT the treasury's tranche —
            // that one is behind a keyless contract whose electorate does not
            // exist yet (D-100 points 7/9).
            const primes = genesisPairingPrimes(g);
            // D-156's taper applies to the donation's mint too, so it is below `X·L`.
            expect(primes).toBe(Math.floor(g.genesis_donation_primes));
            expect(primes).toBeLessThan(g.genesis_donation_ton * g.genesis_lp_ratio_primes_per_ton);

            // …and the GRAM side is that times the floor, which is the whole
            // decision. `market_over_floor_at_open` is the same statement from
            // the sim's side, and the two are asserted against each other so a
            // regen that moved one without the other fails here.
            // The quote is in WHOLE nanoGRAM, so "at the floor" can only mean "at
            // the floor rounded down to the chain's granularity" — exact equality
            // held only while `p_f` happened to land on a nanoGRAM boundary (350
            // exactly, under D-100 point 2's 4.20 GRAM donation). D-154's 132.50 GRAM
            // puts it at 11,041.666… nanoGRAM, so the two assertions below are the
            // real invariant `genesisPairingTon` promises: never ABOVE the floor —
            // a book a nanoGRAM over is one `flush()` refuses — and never more than
            // one nanoGRAM per PRIMES below it.
            const ton = genesisPairingTon(g);
            expect(ton / primes).toBeLessThanOrEqual(g.genesis_floor_price_ton_per_primes);
            expect(g.genesis_floor_price_ton_per_primes - ton / primes).toBeLessThan(1e-9);
            expect(g.market_over_floor_at_open).toBeCloseTo(1, 9);
            expect(text).toContain(`${primes} PRIMES against ${ton} GRAM`);

            // The old shape, named so it can never come back by accident: the
            // pair must NOT be the donation's own GRAM figure, and must NOT be
            // priced at L.
            expect(text).not.toContain(`PRIMES against ${g.genesis_donation_ton} GRAM`);
            expect(ton).toBeLessThan(g.genesis_donation_ton);
        });

        it('opens the ledger at D-29 L = 10,000, and closes D-26 three-term identity', async () => {
            const d = await deployAndWire(env, code, params);
            const result = await completeGenesis(env, params, d, params.seedTon);

            // DENOMINATION_PLAN D-29. `L` reaches the deploy through
            // `mintTreasuryVest`; a params file at 10,000 with a
            // pipeline at 1,000 sizes the game at the wrong supply and nothing
            // else complains.
            expect(sharedParams.genesis.genesis_lp_ratio_primes_per_ton).toBe(10_000);
            expect(result.allocationResult.primesMinted).toBe(
                (params.seedTon *
                    BigInt(Math.round(sharedParams.genesis.genesis_lp_ratio_primes_per_ton * 1000))) /
                    1000n /
                    2n
            );

            // W3 / D-26, D-46: `T = seedT + swapped + pending`. `seedT` is
            // always `0` in this deployment (no real deposit) — the identity
            // still holds, it just closes at `0`, not at a nonzero founder
            // seed.
            expect(await d.ledger.getSeedT()).toBe(0n);
            expect(result.seedT).toBe(0n);
            expect(await d.ledger.getFloorNum()).toBe(0n);
            expect(await d.ratchet.getPending()).toBe(0n);
            expect(await d.ratchet.getSwapped()).toBe(0n);
        }, 120_000);
    });

    // ------------------------------------------------------------------
    // TEP-62/64/66 presentation (CONCEPT §3.1)
    //
    // The pipeline used to pass NO content cell and NO royalty destination to either the
    // collection or the jetton master, and the wrappers' `?? beginCell().endCell()` /
    // `?? genesisScriptAddr` defaults answered for them. Nothing failed: every contract
    // field, encoder and standard-named get-method was already correct and in place, so a
    // genesis produced a fully standards-compliant deploy that renders NAMELESS everywhere,
    // with per-item URIs that are bare relative paths and the §3.1 royalty pointed at the
    // throwaway deploy wallet.
    //
    // All of it is init data, so none of it is fixable without redeploying the whole set at
    // fresh addresses. These assertions go through `provider.get(<exact standard name>)` —
    // the same call a wallet, explorer or marketplace makes — because that is the surface
    // that was broken, and the camelCase getters pass either way.
    // ------------------------------------------------------------------
    describe('§3.1 presentation lands in the deployed contracts', () => {
        it('names the collection, the items and the jetton', async () => {
            const d = await deployAndWire(env, code, params);

            const cd = await d.collection.getStandardCollectionData();
            expect(decodeOffchainContent(cd.collectionContent)).toBe(params.presentation.collectionMetadataUri);

            const jetton = await d.master.getJettonDataStandard();
            expect(decodeOffchainContent(jetton.jettonContent)).toBe(params.presentation.jettonMetadataUri);

            // The composed item URI is absolute and correctly separated — the two failure
            // modes the empty prefix and a missing trailing slash produce respectively.
            const composed = await d.collection.getNftContent(1234n, beginCell().endCell());
            expect(decodeComposedNftContent(composed)).toBe('https://primes.live/nft/1234.json');

            expect(decodeComposedNftContent(composed).startsWith('https://')).toBe(true);
        });

        it('points the royalty at the COLLECTION (D-128) and the declared owner at the operator', async () => {
            const d = await deployAndWire(env, code, params);

            const royalty = await d.collection.getRoyaltyParams();
            expect(royalty.numerator).toBe(sharedParams.fees.royalty_numerator);
            expect(royalty.denominator).toBe(sharedParams.fees.royalty_denominator);
            expect(royalty.numerator / royalty.denominator).toBeCloseTo(0.05, 12); // §3.1

            // D-128 — THE TWO FIELDS SEPARATED, and this test is where that reads.
            //
            // They used to be the same address because the royalty went one place.
            // Now TEP-66's destination is the COLLECTION, because that is where the
            // split happens and the standard carries only one destination...
            expect(royalty.destination.toString()).toBe(d.collection.address.toString());
            // ...while `owner_address` from get_collection_data is still the operator:
            // it is what marketplaces display as the collection owner, and it confers no
            // authority — there is no message the collection accepts from it (§8). It is
            // also still where the OPERATOR'S HALF of every royalty lands.
            const cd = await d.collection.getStandardCollectionData();
            expect(cd.ownerAddress.toString()).toBe(treasuryWallet.address.toString());
            expect(cd.ownerAddress.toString()).not.toBe(genesis.address.toString());
            expect(cd.ownerAddress.toString()).not.toBe(royalty.destination.toString());
        });

        it('verifyPresentation catches a deploy that came out nameless', async () => {
            // The regression guard proper. deployAndWire runs verifyPresentation against
            // the live get-methods, so a wrapper that silently drops a field — the exact
            // shape of the original bug — fails the genesis instead of shipping it.
            const d = await deployAndWire(env, code, params);
            await expect(verifyPresentation(params, d)).resolves.toBeUndefined();

            // Same deployment, read against a presentation it does not match.
            await expect(
                verifyPresentation(
                    { ...params, presentation: { ...params.presentation, jettonMetadataUri: 'https://primes.live/other.json' } },
                    d
                )
            ).rejects.toThrow(/jetton content URI did not land/i);

            await expect(
                verifyPresentation({ ...params, operatorAddr: genesis.address }, d)
            ).rejects.toThrow(/owner\/royalty destination did not land/i);

            await expect(
                verifyPresentation(
                    { ...params, presentation: { ...params.presentation, nftContentPrefix: 'https://example.test/x/' } },
                    d
                )
            ).rejects.toThrow(/item 1234 content URI did not land/i);
        }, 120_000);

        it('refuses to deploy anything at all on a bad presentation', async () => {
            // Ordering matters more than the throw does: validatePresentation runs before
            // the first sendDeploy, so a caught mistake costs an error message rather than
            // a half-built set of one-shot-wired contracts at addresses that can never be
            // reused.
            const balanceBefore = await genesis.getBalance();
            await expect(
                deployAndWire(env, code, {
                    ...params,
                    presentation: { ...params.presentation, nftContentPrefix: 'https://primes.live/nft' },
                })
            ).rejects.toThrow(/must end in "\/"/i);
            expect(await genesis.getBalance()).toBe(balanceBefore); // not one nanoGRAM spent
        });

        // §4.3.2 / D-151 — THE SILENTLY INERT RESERVE, refused.
        //
        // This is the one bootstrap in the pipeline whose omission does not fail
        // at the contract: the treasury wrapper writes the TREASURY'S OWN ADDRESS
        // when `tstonJettonWallet` is left out, so `SetWallets` succeeds,
        // `walletsSet` flips to 1, the one-shot closes, and the tsTON arm is
        // unreachable forever. Nothing on chain says so; it surfaces months later
        // as a `harvest()` that does nothing. So the pipeline refuses the value
        // itself, before any message — which is what this asserts.
        it('refuses a staking venue address that is a placeholder or the receiver itself', async () => {
            const balanceBefore = await genesis.getBalance();
            // The treasury address is not knowable to a caller before the run, so
            // the check must be inside the pipeline; drive it with the OTHER
            // wrapper default, the genesis script address, which is.
            await expect(
                deployAndWire(env, code, { ...params, treasuryTstonWallet: genesis.address })
            ).rejects.toThrow(/genesis script placeholder/i);
            await expect(
                deployAndWire(env, code, { ...params, tonstakersPool: genesis.address })
            ).rejects.toThrow(/tonstakersPool/);
            expect(await genesis.getBalance()).toBe(balanceBefore); // not one nanoGRAM spent
        });
    });
});
