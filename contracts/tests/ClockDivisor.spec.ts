// TON PRIMES — D-139, THE TEST CLOCK.
//
// One deploy-time `clockDivisor` divides every wall-clock constant a set
// enforces: the market's `AUCTION_WINDOW` / `BID_EXTENSION` /
// `PRIME_DUTCH_SECONDS`, the ratchet's `FLUSH_COOLDOWN` and the treasury's
// `VOTE_DURATION`. It exists so a full-protocol testnet run can watch a 7-day
// auction close in an hour instead of waiting out nine real days.
//
// TWO PROPERTIES, AND BOTH MATTER:
//
//   1. **1 is the identity.** Every other suite in this repo deploys without
//      the field and expects the declared figures; this asserts that directly,
//      so "mainnet is unchanged" is a test rather than a claim.
//   2. **A divided deploy enforces AND PUBLISHES the divided clock.** The lot's
//      own `closesAt` is the enforcement; `getMarketParams` /
//      `getPrimeDutchTerms` / `getGov` are the publication CONCEPT.md §9.1
//      requires — the UI must be able to draw the clock the contract actually
//      runs, not the one the source declares.
//
// The ratchet's `FLUSH_COOLDOWN` is exercised at divisor 1 by
// `DecompositionSolvency.spec.ts`; here it is covered by deploying a divided
// ratchet at all, since the divisor sits in the same config cell as
// `ledgerAddr` and a layout slip would break every message the contract takes.
import { Blockchain, SandboxContract, TreasuryContract } from '@ton/sandbox';
import { toNano } from '@ton/core';
import '@ton/test-utils';
import { compile } from '@ton/blueprint';
import { PrimesMarket } from '../wrappers/PrimesMarket';
import { PrimesTreasury } from '../wrappers/PrimesTreasury';
import { PrimesVenueTimelock } from '../wrappers/PrimesVenueTimelock';
import { RESERVABLE_14 } from './helpers/market';
import sharedParams from '../../shared/params.json';

const AUCTION_WINDOW = 604_800; // primes_market.tolk
const BID_EXTENSION = 4_020; //   primes_market.tolk
const PRIME_DUTCH_SECONDS = 604_800; // primes_market.tolk
const VOTE_DURATION = 86_400; //  primes_treasury.tolk
const NOTICE_DURATION = sharedParams.treasury.notice_duration_seconds; // primes_treasury.tolk, D-173 amendment
const TIMELOCK_DELAY = 2_592_000; // primes_venue_timelock.tolk — 30 days

/** 604800 / 168 = 3600 — the one-hour auction a testnet run deploys. */
const TEST_DIVISOR = 168;

describe('D-139 — the deploy-time clock divisor', () => {
    let blockchain: Blockchain;
    let deployer: SandboxContract<TreasuryContract>;
    let ledger: SandboxContract<TreasuryContract>;
    let marketCode: Awaited<ReturnType<typeof compile>>;
    let treasuryCode: Awaited<ReturnType<typeof compile>>;
    let positionCode: Awaited<ReturnType<typeof compile>>;
    let timelockCode: Awaited<ReturnType<typeof compile>>;

    beforeAll(async () => {
        marketCode = await compile('PrimesMarket');
        treasuryCode = await compile('PrimesTreasury');
        positionCode = await compile('PrimesLpPosition');
        timelockCode = await compile('PrimesVenueTimelock');
    }, 180_000);

    beforeEach(async () => {
        blockchain = await Blockchain.create();
        blockchain.now = 1_770_000_000;
        deployer = await blockchain.treasury('deployer');
        // The market's only privileged sender: it is what `launch_open` must
        // come from, and the market never calls back into it here.
        ledger = await blockchain.treasury('ledger');
    });

    async function openMarket(clockDivisor?: number) {
        const market = blockchain.openContract(
            PrimesMarket.createFromConfig(
                {
                    headHint: 4n,
                    ledgerAddr: ledger.address,
                    ratchetAddr: deployer.address,
                    clockDivisor,
                },
                marketCode
            )
        );
        await market.sendDeploy(deployer.getSender(), toNano('5'));
        await market.sendLaunchOpen(ledger.getSender(), { value: toNano('0.1') });
        expect(await market.getLaunched()).toBe(true);
        return market;
    }

    async function openTreasury(clockDivisor?: number) {
        const treasury = blockchain.openContract(
            PrimesTreasury.createFromConfig(
                {
                    operatorAddr: deployer.address,
                    sinkAddr: deployer.address,
                    stakeAddr: deployer.address,
                    distributionRateBpsPerDay: 19,
                    positionCode,
                    genesisScriptAddr: deployer.address,
                    clockDivisor,
                },
                treasuryCode
            )
        );
        await treasury.sendDeploy(deployer.getSender(), toNano('1'));
        return treasury;
    }

    async function openTimelock(clockDivisor?: number) {
        const timelock = blockchain.openContract(
            PrimesVenueTimelock.createFromConfig(
                {
                    proposerAddr: deployer.address,
                    governanceAddr: deployer.address,
                    ratchetAddr: deployer.address,
                    genesisScriptAddr: deployer.address,
                    clockDivisor,
                },
                timelockCode
            )
        );
        await timelock.sendDeploy(deployer.getSender(), toNano('1'));
        return timelock;
    }

    /**
     * The venue timelock is the fifth consumer, and the one that made the
     * difference between "queued live on every set" and "executed on none of
     * them": at divisor 1 no run can wait out 30 days, so `execute` — the
     * PERMISSIONLESS half of the protocol's only admin surface — had never run
     * at a real node. `queue` refuses an `eta` sooner than the delay (801), so
     * the delay is measured by finding the earliest eta the contract accepts.
     */
    it('the venue timelock divides its 30-day delay, and 1 leaves it at 30 days', async () => {
        const now = blockchain.now as number;

        const mainnet = await openTimelock();
        const tooSoonOnMainnet = await mainnet.sendQueue(deployer.getSender(), {
            dedustNativeVault: deployer.address,
            dedustPool: deployer.address,
            primesJettonVault: deployer.address,
            eta: now + Math.floor(TIMELOCK_DELAY / TEST_DIVISOR),
            value: toNano('0.2'),
        });
        expect(tooSoonOnMainnet.transactions).toHaveTransaction({
            to: mainnet.address,
            exitCode: 801, // timelock_not_matured — the 30 days are untouched
        });
        expect((await mainnet.getQueued()).hasQueued).toBe(0);

        const divided = await openTimelock(TEST_DIVISOR);
        const eta = now + Math.floor(TIMELOCK_DELAY / TEST_DIVISOR);
        const accepted = await divided.sendQueue(deployer.getSender(), {
            dedustNativeVault: deployer.address,
            dedustPool: deployer.address,
            primesJettonVault: deployer.address,
            eta,
            value: toNano('0.2'),
        });
        expect(accepted.transactions).not.toHaveTransaction({ to: divided.address, aborted: true });
        const q = await divided.getQueued();
        expect(q.hasQueued).toBe(1);
        expect(q.eta).toEqual(eta);
        // ~4.3 hours out, so a run that queues in its first phase executes in its last.
        expect(eta - now).toEqual(15_428);
    }, 60_000);

    it('deployed without the field, every clock is the declared one', async () => {
        const market = await openMarket();
        const params = await market.getMarketParams();
        expect(params.auctionWindow).toEqual(AUCTION_WINDOW);
        expect(params.bidExtension).toEqual(BID_EXTENSION);
        expect((await market.getPrimeDutchTerms()).decaySeconds).toEqual(PRIME_DUTCH_SECONDS);
        const gov = await (await openTreasury()).getGov();
        expect(gov.voteDuration).toEqual(VOTE_DURATION);
        expect(gov.noticeDuration).toEqual(NOTICE_DURATION);
    }, 60_000);

    it('a divided deploy publishes the divided clock', async () => {
        const market = await openMarket(TEST_DIVISOR);
        const params = await market.getMarketParams();
        expect(params.auctionWindow).toEqual(3_600); // one hour
        expect(params.bidExtension).toEqual(Math.floor(BID_EXTENSION / TEST_DIVISOR));
        expect((await market.getPrimeDutchTerms()).decaySeconds).toEqual(3_600);

        const gov = await (await openTreasury(TEST_DIVISOR)).getGov();
        expect(gov.voteDuration).toEqual(Math.floor(VOTE_DURATION / TEST_DIVISOR));
        // The notice (audit R2-H1) rides the same divisor, as its own parameter.
        expect(gov.noticeDuration).toEqual(Math.floor(NOTICE_DURATION / TEST_DIVISOR));
        // D-168: `distribute()`'s 30-day interval rides the same divisor.
        const dist = await (await openTreasury(TEST_DIVISOR)).getDistribution();
        expect(dist.interval).toEqual(Math.floor(2592000 / TEST_DIVISOR));
    }, 60_000);

    it('and ENFORCES it — an opened lot closes one hour out, not seven days', async () => {
        const market = await openMarket(TEST_DIVISOR);
        const bidder = await blockchain.treasury('bidder');
        const quote = await market.getLotPriceFrom(RESERVABLE_14.n, RESERVABLE_14.factors);

        await market.sendOpenLot(bidder.getSender(), {
            n: RESERVABLE_14.n,
            kind: 0,
            factors: RESERVABLE_14.factors,
            beneficiary: null,
            referralKey: 0,
            value: quote.p0 + quote.resGas + toNano("0.2"),
        });

        const lot = await market.getLot(RESERVABLE_14.n);
        expect(lot.found).toBe(true);
        expect(lot.closesAt - lot.openedAt).toEqual(3_600);
    }, 60_000);
});
