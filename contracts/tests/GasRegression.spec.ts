// TON PRIMES — gas regression suite (docs/phase3-report.md §9.6 item 7).
//
// Snapshots the compute gas of every entrypoint across all nine contracts and
// diffs it against a committed baseline (contracts/gas-baseline.json), failing
// on a regression beyond TOLERANCE. Regenerate the baseline deliberately with:
//
//     GAS_BASELINE_UPDATE=1 npx jest GasRegression
//
// It also reconciles the REAL per-mint protocol-side cost against CONCEPT.md
// §4.1's gas & ops line — since D-117 measured as the fall in the LEDGER's own
// surplus over declared liability across the mint's whole trace (`spendAcross`),
// which counts every hop the line pays by construction — and writes each row to
// the baseline as `gas_ops_spend.<row>`, the input `sim/primes_sim/gas.py`
// derives the line itself from (the largest row, rounded up to a whole percent).
import { Blockchain, SandboxContract, TreasuryContract, internal } from '@ton/sandbox';
import { Address, beginCell, Cell, toNano, Transaction } from '@ton/core';
import '@ton/test-utils';
import { compile } from '@ton/blueprint';
import * as fs from 'fs';
import * as path from 'path';
import { PrimesRatchet, FLUSH_VALUE, HARVEST_VALUE, STAKE_VALUE, UNSTAKE_VALUE } from '../wrappers/PrimesRatchet';
import { MockTonstakersPool } from '../wrappers/MockTonstakersPool';
import { PrimesRegistrar } from '../wrappers/PrimesRegistrar';
import { PrimesLedger, FactorEntry } from '../wrappers/PrimesLedger';
import { PrimesCollection } from '../wrappers/PrimesCollection';
import { PrimesJettonMaster } from '../wrappers/PrimesJettonMaster';
import { PrimesJettonWallet } from '../wrappers/PrimesJettonWallet';
import { PrimesItem } from '../wrappers/PrimesItem';
import { PrimesVenueTimelock } from '../wrappers/PrimesVenueTimelock';
import { PrimesMarket } from '../wrappers/PrimesMarket';
import { testMarketConfig, acquirePrime, OPENING_HEAD } from './helpers/market';
import { PrimesBountyVault } from '../wrappers/PrimesBountyVault';
import { COLLECTION as COLLECTION_OPS, ITEM as ITEM_OPS } from '../../shared/opcodes';
import { NAME_RELAY_GAS_NANOTON } from '../../shared/messages';
// D-100's three contracts. Measured standalone at the bottom of the walk; see
// the block comment there for why they are not wired into the mint path.
import {
    PrimesTreasury,
    TreasuryAsset,
    TREASURY_TIERS,
    depositPayload,
} from '../wrappers/PrimesTreasury';
import { PrimesLpPosition } from '../wrappers/PrimesLpPosition';
import { PrimesLpSink } from '../wrappers/PrimesLpSink';
import { PrimesStake, budgetPayload, stakePayload } from '../wrappers/PrimesStake';
import { PrimesStakePosition } from '../wrappers/PrimesStakePosition';
// GAUNTLET C13: the invite line has its own pair of fresh stacks below, built
// with the shared full-stack helper, so the two rows differ ONLY in the list.
import { TEP74 } from '../../shared/opcodes';
import { deployStack, factorize as factorizeBig } from './helpers/stack';

// COMPARABILITY BREAK (P2.A8, 2026-08-17) — recorded here because JSON carries
// no comments. The unified-market consolidation (D-20/D-22) retired the
// `auction.bid` / `auction.take` / `auction.finalize` rows with the contracts
// that received them, and the surviving reserve/cancel/settle rows were RENAMED
// from `reservation_book.*` / `reservation_shard.*` to `market.*` /
// `market_shard.*` — the receiving contract is `primes_market(_shard).tolk` now,
// and a baseline row named after a deleted contract reads as a stale row.
// The renamed rows carry their prior measured values forward unchanged (same
// code path, same numbers); rows against baselines older than this commit are
// not comparable by key.
// FOURTH COMPARABILITY BREAK, 2026-09-07 (D-101 / D-102). Five rows are
// REBASELINED, and the two effects behind them pull in OPPOSITE directions, so
// they are attributed separately rather than netted:
//
//   registrar.record_mint                  4790 -> 8990  (+87.7%)
//   ledger.mint.composite_w1             102669 -> 101991 (-0.7%)
//   ledger.mint.composite_w2             124387 -> 123367 (-0.8%)
//   ledger.mint.composite_w3_primorial   164229 -> 163109 (-0.7%)
//   ledger.mint.composite_referred       116954 -> 116456 (-0.4%)
//
// THE REGISTRAR GOT DEARER because D-102 rebuilt it: `record_mint` now carries
// and stores the head (the build line's expiry clock is a HEAD, not a wall
// clock), and the D-99 score block is pasted into the contract, so the arm's
// storage cell and its code both grew. 8,990 units is ~0.0036 TON at config 21
// — it rides `REGISTRAR_HOP_GAS` on a PRIME mint, which is the cheapest leg of
// the mint profile and has the room.
//
// THE LEDGER GOT CHEAPER, and by deletion: D-102 removed the constellation
// boost — the `omega` dictionary read plus the whole rescale pass — from the
// hot path of every composite mint. The four rows above are UNINVITED mints, so
// they measure that saving alone.
//
// GAUNTLET C13 (2026-09-12) CLOSES THE GAP THIS COMMENT USED TO NAME. D-101's
// invite fan-out now has two rows of its own — `ledger.mint.invite_count_0`
// (99,740) and `ledger.mint.invite_count_5` (117,809), same n (the head, 4 —
// the same omega=1 composite as `ledger.mint.composite_w1`), same 1 TON, same
// genesis shape, on two FRESH stacks that differ only in the invite list. The
// **delta is 18,069 gas for five real `deploy_generator` sends** (~3,614/deploy,
// well under this comment's own pre-measurement guess of "5 x 6,690 plus
// forwarding" — that number was `GENERATOR_ITEM_DEPLOY_VALUE`'s nanoton figure
// misread as a gas figure, not a measurement). `invite_count_0` (99,740) sits
// within 2.9% of `composite_w1` (102,639) — the two numbers come from
// different stacks (bootstrapping `SetInviteConfig` needs its own genesis, see
// below) so an exact match was never the bar; what matters is that opting out
// of the invite line costs the same order of magnitude as not having it at
// all, not that it costs zero more. `InviteGenerators.spec.ts` still owns the
// functional proof (fan-out correctness, the short-list arithmetic, the
// signature check); this file owns only the gas number.
//
// FIFTH COMPARABILITY BREAK, 2026-11-07 (DECISIONS.md D-202). The invite line is
// up to THREE plain 0.1 TON text transfers to minter-named addresses: no signature
// check, no `deploy_generator`. `ledger.mint.invite_count_5` is RETIRED and
// `ledger.mint.invite_count_3` replaces it; `registrar.record_mint` is RETIRED with
// the hop (its one reader was the build clock). Every mint row moved because the
// ledger's code and storage (ConfigS deleted) changed; see the commit for the
// measured figures.
//
// NOT REBASELINED, and not this change's to bless: `market.open_lot` (+9.2%)
// and `market.open_lot.max_digits` (+11.9%) moved in the same working tree
// under a concurrent pricing-model change to `primes_market.tolk` (D-99's
// factor categories, which price an `open_lot` from the factors it already
// carries). Both are inside the 20% tolerance and both belong to that change's
// own gate, so they are left reading against the pre-change baseline.
//
// THIRD COMPARABILITY BREAK, 2026-09-05 (D-100). Six rows are NEW —
// `treasury.{deposit,claim,relock,expire_vote,withdraw,execute}`, `lp_position.claim`,
// `lp_sink.deposit` and `ledger.mint_won_lot.forfeit_split` — and two
// existing MARKET rows moved by a fixed +625 units each:
//
//   market.bid_head_prime   19934 -> 20559
//   market.open_head_lot   170871 -> 171496
//
// THE CONTRACTS DID NOT CHANGE; THE FIXTURE DID. The new forfeit-split row opens
// a lot on 186 before the lot-lane block runs, so the market's lot dictionary
// carries one more entry by the time those two rows are measured, and both pay
// the same one-node-deeper lookup. `+625 on exactly two rows, identical` is the
// signature of a dictionary that grew, not of code that got dearer; every other
// market row is byte-identical. Rows against baselines older than this commit
// are comparable by key but those two are one dictionary node apart.
//
// WHAT DID NOT MOVE, AND WHY IT IS WORTH SAYING: D-100 adds one
// `configA.feeDests.load()` per mint and, on a mint that cites an unsold prime,
// one extra outbound. `ledger.mint.composite_w1` did not move a unit for it.
// The +45% that row carries came in the SAME COMMIT from a different decision —
// D-99's `scoreOf(n)` on the settlement path — and was re-baselined by that work
// (011dae64). Measured by stubbing `scoreOf` out and re-running this file:
// composite_w1 is 102669 with the score and 66120 without, so the score costs
// ~36,500 units, and the rest of that commit (D-100's `FeeDests` indirection
// included) is ~4,800 units CHEAPER than the 70918 that stood before both.
// D-100 made the mint path faster, not slower. Do not re-attribute it.
// FOURTH COMPARABILITY BREAK, 2026-09-21 (D-151, §4.3.2's staked reserve). Four
// rows are NEW — `ratchet.{set_tston_wallet,stake,harvest,unstake}` — and TWO
// EXISTING RATCHET ROWS MOVE:
//
//   ratchet.flush         7610 -> 10026  (+31.7%)   7610 last measured 2026-09-12
//   ratchet.update_venue  3406 ->  5050  (+48.3%)   3406 last measured 2026-08-16
//
// THESE DELTAS ARE CUMULATIVE OVER THOSE WINDOWS, NOT D-151's BILL. The dates are
// the whole point: `update_venue`'s 3406 is five weeks old and `flush`'s 7610 nine
// days, and the ratchet and the venue timelock were rewritten repeatedly in between
// (be2c47d1, a9cead25, 1b246ca1, d8299ad0, fbc95121, 3f896319, e2c11741, 06708a87).
// Every one of those commits could move these rows under the one-sided 20% tolerance
// below without failing anything, so what the two numbers measure is "everything
// since the date on the right", D-151 included.
//
// D-151's OWN IDENTIFIABLE SHARE is two additions and nothing else claimed here:
// `flush` gained the `inFlightExit` guard — it now refuses while an EXIT is open
// (`storage.staking.load().inFlightExit == 0`, throw 230), which it must, because
// leg 2's fill arrives as the same `payout#474f86cf` from the same native vault a
// refused flush does and two open round trips could not be told apart; `update_venue`
// gained the `^VenueStaking` ref parse, storing the venue checked instead of blind, so
// a malformed venue is refused at the timelock hop rather than 30 days later at the
// first `stake()` — a path that runs at most once per timelock cycle.
//
// Both rows are ABOVE the tolerance and are rebaselined here. What is NOT asserted is
// how the delta splits between D-151 and the eight commits before it: the baseline
// carries no per-commit history, so nobody can attribute it from this file, and a
// future movement in `ratchet.flush` is a question to re-measure, not a bug on sight.
// (MISTAKES.md 2026-09-21: a `.tolk` change re-measures the whole baseline, or names
// in its commit message the rows it knowingly left stale. That rule is what would have
// made these two deltas attributable.)
// D-194 (2026-09-28): the venue timelock gained a second key and lost §4.3.2's
// staking ref. One row is NEW — `venue_timelock.confirm_venue` (3569) — and the
// timelock/ratchet/treasury rows below are rebaselined, every other row untouched:
//
//   venue_timelock.set_ratchet         1852 -> 2682  (+44.8%)  bootstrap fields moved to a ref cell
//   venue_timelock.queue               3571 -> 3677  (+3.0%)   seq bump
//   venue_timelock.execute             5542 -> 6186  (+11.6%)  confirmed check + boot-ref load
//   venue_timelock.retry_update_venue  4018 -> 4472  (+11.3%)  boot-ref load
//   venue_timelock.cancel              3214 -> 3160  (-1.7%)
//   ratchet.update_venue               4981 -> 4249  (-14.7%)  no staking ref parse; copied forward
//   treasury.execute                  11446 -> 11498 (+0.5%)   the asset-3 branch test
const BASELINE_PATH = path.join(__dirname, '..', 'gas-baseline.json');
const TOLERANCE = 0.2; // 20% regression budget over the committed baseline
// CONCEPT.md §4.1's gas & ops line, READ from the bytecode's own source: the spend
// measurement below is `line − Δsurplus`, so it must use the line the ledger under test
// actually keeps. Reading params.json instead made every row wrong by the difference
// whenever the contract moved first (D-117: 0.19 -> 0.20 read 10M nanoton low).
// SimCrossCheck pins GAS_OPS_AMOUNT to params.json's sim-derived `mint.gas_ops_pct`.
const GAS_OPS_LINE = BigInt(
    /const GAS_OPS_AMOUNT: coins = (\d+);/.exec(
        fs.readFileSync(path.join(__dirname, '..', 'contracts', 'primes_ledger.tolk'), 'utf8')
    )![1]
);
// What the ledger attaches on a reservation settlement (`handleSettle`: 0.015
// `SettleConfirmed` + 0.010 `HeadUpdate`), and exactly what the shard forwards
// as `SETTLE_GAS` out of §4.4's `RES_GAS`. These two MUST be equal: if the
// ledger ever attaches more than the shard forwards, the difference silently
// becomes a §4.1 gas & ops cost, which is precisely the bug this constant's
// two uses below were hiding.
const SETTLE_HOP = toNano('0.025');
const MINT_PRICE = toNano('1');
// D-191 point 1: the most of a mint's 1 TON the payer -> card -> ledger hop may consume,
// read from the ledger's own source for the reason GAS_OPS_LINE is.
const CARD_HOP_ALLOWANCE = BigInt(
    /const CARD_HOP_ALLOWANCE: coins = (\d+);/.exec(
        fs.readFileSync(path.join(__dirname, '..', 'contracts', 'primes_ledger.tolk'), 'utf8')
    )![1]
);
const TIMELOCK_DELAY = 2592000;

type Snapshot = Record<string, number>;

function gasAt(result: any, addr: Address): number {
    const tx: Transaction | undefined = result.transactions.find(
        (t: Transaction) => t.inMessage?.info.type === 'internal' && t.inMessage.info.dest?.toString() === addr.toString()
    );
    if (!tx) return 0;
    const cp: any = (tx.description as any).computePhase;
    return cp && cp.type === 'vm' ? Number(cp.gasUsed) : 0;
}


describe('TON PRIMES — gas regression', () => {
    const snapshot: Snapshot = {};
    const mintCostReport: {
        label: string;
        spend: string;
        withinLine: boolean;
    }[] = [];

    let blockchain: Blockchain;
    let deployer: SandboxContract<TreasuryContract>;
    let genesisScript: SandboxContract<TreasuryContract>;
    let treasuryWallet: SandboxContract<TreasuryContract>;
    let proposer: SandboxContract<TreasuryContract>;
    let dedust: SandboxContract<TreasuryContract>;
    let minter: SandboxContract<TreasuryContract>;
    let keeper: SandboxContract<TreasuryContract>;

    let codes: Record<string, Cell>;
    let collection: SandboxContract<PrimesCollection>;
    let master: SandboxContract<PrimesJettonMaster>;
    let ledger: SandboxContract<PrimesLedger>;
    let ratchet: SandboxContract<PrimesRatchet>;
    let registrar: SandboxContract<PrimesRegistrar>;
    let timelock: SandboxContract<PrimesVenueTimelock>;
    let book: SandboxContract<PrimesMarket>;
    let vault: SandboxContract<PrimesBountyVault>;

    beforeAll(async () => {
        codes = {
            item: await compile('PrimesItem'),
            collection: await compile('PrimesCollection'),
            jettonWallet: await compile('PrimesJettonWallet'),
            jettonMaster: await compile('PrimesJettonMaster'),
            ledger: await compile('PrimesLedger'),
            ratchet: await compile('PrimesRatchet'),
            registrar: await compile('PrimesRegistrar'),
            venueTimelock: await compile('PrimesVenueTimelock'),
            market: await compile('PrimesMarket'),
            bountyVault: await compile('PrimesBountyVault'),
        };

        blockchain = await Blockchain.create();
        blockchain.now = 1_770_000_000;
        deployer = await blockchain.treasury('deployer');
        genesisScript = await blockchain.treasury('genesisScript');
        treasuryWallet = await blockchain.treasury('treasury');
        proposer = await blockchain.treasury('proposer');
        dedust = await blockchain.treasury('dedust');
        // D-20: the walk below BUYS ten primes off the Dutch lane on top of its
        // nineteen 1-TON composite mints, and a prime opens at 1.5x its tribute
        // NPV — tens of TON each, not one. The old 500 TON ran dry at n = 16 and
        // the mint after it came back as a refund, which reads exactly like a
        // head mismatch and is not one.
        minter = await blockchain.treasury('minter', { balance: toNano('100000') });
        keeper = await blockchain.treasury('keeper');

        collection = blockchain.openContract(
            PrimesCollection.createFromConfig(
                { nextIndex: 2n, itemCode: codes.item, ledgerAddr: deployer.address, genesisScriptAddr: genesisScript.address },
                codes.collection
            )
        );
        await collection.sendDeploy(deployer.getSender(), toNano('5'));

        master = blockchain.openContract(
            PrimesJettonMaster.createFromConfig(
                { ledgerAddr: deployer.address, genesisScriptAddr: genesisScript.address, walletCode: codes.jettonWallet },
                codes.jettonMaster
            )
        );
        await master.sendDeploy(deployer.getSender(), toNano('5'));

        timelock = blockchain.openContract(
            PrimesVenueTimelock.createFromConfig(
                {
                    proposerAddr: proposer.address,
                    // D-194's second key. A wallet stands in for the treasury here: this
                    // walk measures the timelock's `confirm_venue` arm, not the vote.
                    governanceAddr: proposer.address,
                    ratchetAddr: deployer.address,
                    genesisScriptAddr: genesisScript.address,
                },
                codes.venueTimelock
            )
        );
        await timelock.sendDeploy(deployer.getSender(), toNano('5'));

        ledger = blockchain.openContract(
            PrimesLedger.createFromConfig(
                {
                    a: {
                        collectionAddr: collection.address,
                        jettonMasterAddr: master.address,
                        treasuryAddr: treasuryWallet.address,
                        itemCode: codes.item,
                    },
                    b: {
                        genesisScriptAddr: genesisScript.address,
                    },
                },
                codes.ledger
            )
        );
        await ledger.sendDeploy(deployer.getSender(), toNano('20'));

        // ---- §3.4 B1 decomposition -------------------------------------------
        // `pending` / flush() / the DeDust leg live on the RATCHET now, and the
        // ranks + naming on the REGISTRAR. Both have a circular address
        // dependency with the ledger, so both are deployed without it and linked
        // one-shot (SetLedger x2, then SetSinks). Until SetSinks lands the ledger
        // throws 233 on every mint rather than stranding pool backing.
        ratchet = blockchain.openContract(
            PrimesRatchet.createFromConfig(
                {
                    venueTimelockAddr: timelock.address,
                    genesisScriptAddr: genesisScript.address,
                    dedustNativeVault: dedust.address,
                    dedustPool: dedust.address,
                    primesJettonVault: dedust.address,
                },
                codes.ratchet
            )
        );
        await ratchet.sendDeploy(deployer.getSender(), toNano('10'));
        registrar = blockchain.openContract(
            PrimesRegistrar.createFromConfig({ genesisScriptAddr: genesisScript.address }, codes.registrar)
        );
        await registrar.sendDeploy(deployer.getSender(), toNano('5'));
        await ratchet.sendSetLedger(genesisScript.getSender(), {
            ledgerAddr: ledger.address,
            value: toNano('0.05'),
        });
        await registrar.sendSetLedger(genesisScript.getSender(), {
            ledgerAddr: ledger.address,
            value: toNano('0.05'),
        });
        await ledger.sendSetSinks(genesisScript.getSender(), {
            ratchetAddr: ratchet.address,
            registrarAddr: registrar.address,
            value: toNano('0.05'),
        });
        // ----------------------------------------------------------------------

        book = blockchain.openContract(
            PrimesMarket.createFromConfig(
                testMarketConfig({
                    headHint: OPENING_HEAD,
                    ledgerAddr: ledger.address,
                    ratchetAddr: ratchet.address,
                }),
                codes.market
            )
        );
        await book.sendDeploy(deployer.getSender(), toNano('5'));

        vault = blockchain.openContract(
            PrimesBountyVault.createFromConfig(
                {
                    // DENOMINATION_PLAN P4: TON-denominated value + its nominal cap
                    // at the genesis floor (20,000 PRIMES per TON, D-42).
                    schedule: [
                        {
                            eraBoundary: 30n,
                            bountyTon: 5_309_499_989n,
                            maxPrimes: 5_309_499_989n * 20_000n,
                        },
                    ],
                    ledgerAddr: ledger.address,
                    jettonMasterAddr: master.address,
                    genesisScriptAddr: genesisScript.address,
                    allowlist: [],
                    // V26.7: covers era 30's cap, so the primorial mint measures a
                    // real payout (it bounced off a 1,000-PRIMES wallet before).
                    fundedPrimes: 5_309_499_989n * 20_000n,
                },
                codes.bountyVault
            )
        );
        await vault.sendDeploy(deployer.getSender(), toNano('5'));

        // D-20: the separate genesis-lot bootstrap is GONE, with `BootstrapGenesis`
        // itself. There is no admin surface left on the market to measure here —
        // every prime opens through the same permissionless `open_head_lot`,
        // measured below in the lot-lane block once the head has passed it.

        // ---- bootstrap wiring (measured) ----
        snapshot['collection.set_ledger'] = gasAt(
            await collection.sendSetLedger(genesisScript.getSender(), { ledgerAddr: ledger.address, value: toNano('0.05') }),
            collection.address
        );
        snapshot['jetton_master.set_ledger'] = gasAt(
            await master.sendSetLedger(genesisScript.getSender(), { ledgerAddr: ledger.address, value: toNano('0.05') }),
            master.address
        );
        // §3.4: the timelock's one admin action is `update_venue`, and the venue
        // lives with flush() on the ratchet now. Its target is the RATCHET.
        snapshot['venue_timelock.set_ratchet'] = gasAt(
            await timelock.sendSetRatchet(genesisScript.getSender(), { ratchetAddr: ratchet.address, value: toNano('0.05') }),
            timelock.address
        );
        snapshot['jetton_master.mint_genesis'] = gasAt(
            await master.sendMintGenesis(genesisScript.getSender(), {
                to: vault.address,
                amount: 5_309_499_989n * 20_000n, // = the vault's fundedPrimes
                value: toNano('0.3'),
            }),
            master.address
        );
        snapshot['bounty_vault.set_wallet'] = gasAt(
            await vault.sendSetWallet(genesisScript.getSender(), {
                jettonWalletAddr: await master.getWalletAddress(vault.address),
                value: toNano('0.05'),
            }),
            vault.address
        );
        snapshot['jetton_master.seal_authority'] = gasAt(
            await master.sendSealAuthority(genesisScript.getSender(), { value: toNano('0.05') }),
            master.address
        );
        snapshot['ledger.genesis_seed'] = gasAt(
            await ledger.sendGenesisSeed(genesisScript.getSender(), {
                seedT: toNano('1000'),
                seedS: 1_200_000_000_000_000n,
                seedHead: OPENING_HEAD,
                value: toNano('0.05'),
            }),
            ledger.address
        );
        snapshot['ledger.set_peers'] = gasAt(
            await ledger.sendSetPeers(genesisScript.getSender(), {
                marketAddr: book.address,
                bountyVaultAddr: vault.address,
                value: toNano('0.05'),
            }),
            ledger.address
        );
        // CONCEPT §6 point 0: nothing mints until Unity does. Measured like every
        // other genesis message — it runs exactly once per deployment, so it is a
        // one-off cost rather than a per-mint one, but "one-off" is a claim the
        // baseline should be able to check rather than take on trust.
        snapshot['ledger.ignite'] = gasAt(
            await ledger.sendIgnite(genesisScript.getSender(), {
                owner: deployer.address,
                value: toNano('0.3'),
            }),
            ledger.address
        );
        // The fan-out must actually have reached the book, or every reservation
        // row below measures a refusal instead of a reservation.
        expect(await book.getLaunched()).toBe(true);
    });

    async function mint(n: bigint, kind: number, factors: FactorEntry[], referralKey = 0) {
        return await ledger.sendMint(minter.getSender(), {
            n,
            kind,
            factors,
            referralKey,
            beneficiary: null,
            value: MINT_PRICE,
        });
    }

    /**
     * D-30 — the ONLY way an escrowed claim comes into existence: open an
     * ascending lot (opening is a paid first bid at `P0(n)`), run the 7-day
     * clock out, close it permissionlessly. The close is the message that writes
     * the shard record and notifies the ledger, so the escrow-lane gas rows are
     * measured off the CLOSE now rather than off a `reserve` that no longer
     * exists.
     *
     * MOVES `blockchain.now` past the lot's `closesAt`. This block already ran
     * after the timelock block, which is the only other clock-sensitive one.
     */
    async function winClaim(n: bigint, factors: FactorEntry[]) {
        // PHASE 3 (PRICING_MODEL_PLAN.md §4): `open_lot` prices a composite off
        // the factorization it is sent, so the quote is asked the same way.
        // `getLotPrice(n)` is the lower bound for a caller without them.
        const p0 = (await book.getLotPriceFrom(n, factors)).p0;
        const open = await book.sendOpenLot(minter.getSender(), {
            n,
            kind: 0,
            factors,
            beneficiary: null,
            referralKey: 0,
            value: p0 + toNano('0.15'), // nominal PLUS the standing fee margin
        });
        expect(open.transactions).toHaveTransaction({ to: book.address, success: true });
        const lot = await book.getLot(n);
        blockchain.now = lot.closesAt + 1;
        const { r: close, spend } = await spendAcross(blockchain, ledger, () =>
            book.sendClose(keeper.getSender(), { n, value: toNano('0.3') })
        );
        expect(close.transactions).toHaveTransaction({ to: book.address, success: true });
        return { open, close, spend };
    }

    // D-117 (a) — WHAT THE LINE ACTUALLY PAYS, measured on the ledger itself.
    //
    // This reconciliation used to be `totalFees(trace) + attached − resGasFunded`,
    // with `attached` a hand-kept list of the hops this file knew about. It was
    // wrong in both directions: it charged every DOWNSTREAM contract's fees on top
    // of the value that already paid them (double count), and it silently omitted
    // every hop nobody had added to the list — the special-number rebate hop, the
    // era trophy, the ratchet hop's RATCHET_HOP_GAS, the fee legs' forward fees
    // under PAY_FEES_SEPARATELY, the D-117 confirmation round trip. The ω=3
    // primorial row read 99.0M against the line while the ledger really spent 110M.
    //
    // The ledger's own books close that gap by construction. Every other §4.1 line
    // either leaves the ledger (pool, treasury, referral, forfeits) or is declared
    // as a liability the moment it is booked (tribute owed, the flat dividend, a
    // parked held split), so across one mint the ledger's surplus over declared
    // liability rises by EXACTLY the unspent part of the gas & ops line. Whatever
    // it paid for — its own compute, the value on every protocol hop, the forward
    // fees it pays separately, a later receipt's compute — is `line − Δsurplus`.
    // Value that arrived earmarked (a lot close's SETTLE_GAS, a buyer's RES_GAS)
    // nets itself out the same way, so there is no credit to hand-apply either.
    // Storage rent is excluded: it accrues with wall-clock time, which this file
    // moves, and it is OPS_RESERVE's `owed`-rent leg, not this mint's cost.
    async function surplusOf(bc: Blockchain, l: SandboxContract<PrimesLedger>): Promise<bigint> {
        const b = await l.getLiabilityBreakdown();
        return (await bc.getContract(l.address)).balance - b.tributeOwed - b.unroutedHeld - b.divOutstanding;
    }
    function rentOf(result: any, l: SandboxContract<PrimesLedger>): bigint {
        const h = l.address.hash.toString('hex');
        return result.transactions
            .filter((t: Transaction) => t.address.toString(16).padStart(64, '0') === h)
            .reduce((a: bigint, t: Transaction) => a + ((t.description as any).storagePhase?.storageFeesCollected ?? 0n), 0n);
    }
    async function spendAcross<R extends { transactions: any[] }>(
        bc: Blockchain,
        l: SandboxContract<PrimesLedger>,
        act: () => Promise<R>
    ): Promise<{ r: R; spend: bigint }> {
        const before = await surplusOf(bc, l);
        const r = await act();
        const after = await surplusOf(bc, l);
        return { r, spend: GAS_OPS_LINE - (after - before) - rentOf(r, l) };
    }

    // Every row is also written to the baseline as `gas_ops_spend.<key>` (nanoton,
    // not gas): `sim/primes_sim/gas.py` derives GAS_OPS_AMOUNT from the largest one,
    // and the baseline's 20% tolerance flags a row that grows.
    function recordMintCost(label: string, key: string, spend: bigint) {
        snapshot[`gas_ops_spend.${key}`] = Number(spend);
        console.log(`[gas-ops] ${key} ${spend}`);
        mintCostReport.push({ label, spend: spend.toString(), withinLine: spend <= GAS_OPS_LINE });
        return spend;
    }

    // D-117 (a) — THE TRUE WORST CASE, measured, not argued.
    //
    // The main walk below measures the rows a genesis stack can reach in a few
    // dozen mints, which tops out at the ω=3 primorial 30. The line has to cover
    // the heaviest mint `executeMint` will actually perform, so this block builds
    // it on seeded stacks (`seedHead`/`seedPrimes`, the harness seam that exists
    // for exactly this) with EVERY leg the mint path can fire at once:
    //
    //   - every cited factor SOLD, so each one costs a `credit_tribute` hop
    //     (forfeits are cheaper: no hop value, FanOutGas.spec.ts measures them);
    //   - a gift to a never-seen wallet, so the recruit edge writes two
    //     `minterState` rows, becomes the era's leader and the TROPHY hop fires;
    //   - a valid referral key (the relay rides in the D-117 held split);
    //   - all three invite slots (D-202: three 0.1 TON transfers, the loop's compute);
    //   - a primorial, for the ERA BOUNTY hop, and the D-99 special-number
    //     rebate hop, which every scored head mint fires;
    //   - the rebate mint, the ratchet hop, the item deploy and the D-117
    //     `mint_confirmed` round trip that pays the held split.
    //
    // Four shapes, because the fan-out cost depends on the numbers and not on ω
    // alone (FanOutGas.spec.ts): the three primorials ≥ 510510 (ω = 7, 8, 9) and
    // the ω = 12 ceiling (2·3·…·37, not on the primorial list, so no era legs;
    // the auction lane reaches it, and a head mint is its upper bound — the lane
    // settles the same factor loop without the special-number rebate hop).
    it('D-117: the heaviest mint executeMint can perform, every hop, measured on the ledger', async () => {
        const shapes: { key: string; n: bigint; primorial: boolean }[] = [
            { key: 'worst_primorial_w7', n: 510_510n, primorial: true },
            { key: 'worst_primorial_w8', n: 9_699_690n, primorial: true },
            { key: 'worst_primorial_w9', n: 223_092_870n, primorial: true },
            { key: 'worst_plain_w12', n: 7_420_738_134_810n, primorial: false },
        ];
        for (const shape of shapes) {
            const factors = factorizeBig(shape.n);
            const s = await deployStack({
                seedHead: shape.n,
                seedPrimes: factors.map((f) => f.prime),
            });
            expect(await s.ledger.getHead()).toBe(shape.n);
            // A seeded prime is marked but has no ITEM — nothing ever minted it — so a
            // `credit_tribute` to it would bounce and hand its hop value back, and the
            // row would measure a cheaper mint than any real one (it did: 54M nanoton
            // cheaper at ω = 7). In a real game every sold factor has its item. Deploy
            // them the only way an item is deployed, a `mint_item` from the ledger's
            // address, and the referral key's item with them.
            for (const k of [...factors.map((f) => f.prime), 4n]) {
                await s.blockchain.sendMessage(
                    internal({
                        from: s.ledger.address,
                        to: s.collection.address,
                        value: toNano('0.05'),
                        body: beginCell()
                            .storeUint(0xc0000001, 32) // COLLECTION.mint_item
                            .storeUint(0, 64)
                            .storeUint(k, 256)
                            .storeAddress(s.bob.address)
                            .storeUint(k === 4n ? 0 : 1, 8)
                            .storeRef(beginCell().endCell())
                            .storeUint(0, 16)
                            .storeCoins(toNano('0.025'))
                            .storeUint(shape.n, 64)
                            .storeMaybeRef(null)
                            .storeMaybeRef(null) // prime_init (D-188): a seeded prime carries no row
                            .endCell(),
                    })
                );
            }
            // D-191 point 1: the recruit credit reaches the era's running max a hop
            // AFTER the mint, so a primorial's trophy hop fires only if an earlier
            // recruit already leads the era. Seat one (a reply from `bob`'s card, the
            // only sender the ledger accepts it from) so the ceremony pays for the
            // trophy exactly as it would in a real era. On w12 nobody leads, so
            // alice's own reply takes the lead — the reply's dearer path.
            if (shape.primorial) {
                await s.blockchain.sendMessage(
                    internal({
                        from: await s.ledger.getMinterCardAddress(s.bob.address),
                        to: s.ledger.address,
                        value: toNano('0.05'),
                        body: beginCell()
                            .storeUint(0x9b000003, 32) // MINTER_CARD.card_recruit_counted
                            .storeUint(0, 64)
                            .storeAddress(s.bob.address)
                            .storeUint(0, 8)
                            .storeUint(1, 32)
                            .endCell(),
                    })
                );
                expect((await s.ledger.getEraLeader()).leader?.equals(s.bob.address)).toBe(true);
            }
            const gift = await s.blockchain.treasury(`${shape.key}_gift`);
            const invitees = await Promise.all([1, 2, 3].map((i) => s.blockchain.treasury(`${shape.key}_inv${i}`)));
            const addresses = new Map(invitees.map((t, i) => [i + 1, t.address]));
            const { r, spend } = await spendAcross(s.blockchain, s.ledger, () =>
                s.ledger.sendMint(s.alice.getSender(), {
                    n: shape.n,
                    kind: 0,
                    factors,
                    referralKey: 4,
                    beneficiary: gift.address,
                    invites: { count: 3, addresses },
                    value: MINT_PRICE,
                })
            );
            expect(r.transactions).toHaveTransaction({ to: s.ledger.address, success: true });
            // THE SHAPE OF THE TRACE: nothing aborted and nothing came back bounced, so
            // no hop value returned to the ledger to flatter the row.
            expect(r.transactions).not.toHaveTransaction({ aborted: true });
            expect(r.transactions.filter((t: any) => t.inMessage?.info?.bounced === true).length).toBe(0);
            // Every leg really fired, or the row is the cheap path under a heavy name.
            const fromLedger = (to: Address) =>
                r.transactions.filter(
                    (t: any) => t.inMessage?.info?.src?.equals?.(s.ledger.address) && t.inMessage?.info?.dest?.equals?.(to)
                ).length;
            // V28: the held split's receipt comes from item(n) itself, once populated.
            expect(r.transactions).toHaveTransaction({ from: await s.ledger.getItemAddress(shape.n), to: s.ledger.address, success: true });
            let credits = 0;
            for (const f of factors) credits += fromLedger(await s.ledger.getItemAddress(f.prime));
            expect(credits).toBe(factors.length);
            expect(fromLedger(await s.ledger.getItemAddress(4n))).toBe(1); // the referral relay
            for (const t of invitees) expect(fromLedger(t.address)).toBe(1); // D-202: one transfer each
            expect(fromLedger(s.vault.address)).toBe(shape.primorial ? 2 : 1); // era bounty + special rebate
            expect(fromLedger(s.registrar.address)).toBe(shape.primorial ? 1 : 0); // the era trophy
            // D-191 point 1: the recruit edge — one credit to the payer's card, one reply.
            const aliceCard = await s.ledger.getMinterCardAddress(s.alice.address);
            expect(fromLedger(aliceCard)).toBe(1);
            expect(r.transactions).toHaveTransaction({ from: aliceCard, to: s.ledger.address, success: true });
            // THE PADDED BOUND. The payer -> card -> ledger hop is paid out of the 1 TON, and
            // the ledger accepts a mint up to CARD_HOP_ALLOWANCE short of the price — so a
            // body padded to make the card's forward dearer can move up to that much of the
            // hop onto the line. The worst such mint is this one with its honest hop swapped
            // for the whole allowance, and it must still fit.
            const giftCard = await s.ledger.getMinterCardAddress(gift.address);
            const arrived = r.transactions.find(
                (t: any) => t.inMessage?.info?.src?.equals?.(giftCard) && t.inMessage.info.dest.equals(s.ledger.address)
            )!.inMessage!.info as any;
            const hop = MINT_PRICE - (arrived.value.coins as bigint);
            expect(hop).toBeGreaterThan(0n);
            expect(hop).toBeLessThan(CARD_HOP_ALLOWANCE);
            console.log(`[gas-ops] ${shape.key} card hop ${hop}, padded bound ${spend - hop + CARD_HOP_ALLOWANCE}`);
            expect(spend - hop + CARD_HOP_ALLOWANCE).toBeLessThanOrEqual(GAS_OPS_LINE);
            recordMintCost(`worst case: ${shape.key} (n = ${shape.n})`, shape.key, spend);
        }
    }, 600_000);

    it('snapshots every entrypoint and reconciles per-mint cost against the gas & ops line', async () => {
        // ---- mint path: primes, then composites of growing omega ----
        const primesToMint: bigint[] = [];
        for (let i = 2; i <= 31; i++) {
            let isPrime = i > 1;
            for (let j = 2; j * j <= i; j++) if (i % j === 0) isPrime = false;
            if (isPrime) primesToMint.push(BigInt(i));
        }
        const factorize = (n: number): FactorEntry[] => {
            const out: FactorEntry[] = [];
            let m = n;
            for (let p = 2; p <= m; p++) {
                let e = 0;
                while (m % p === 0) {
                    m /= p;
                    e++;
                }
                if (e > 0) out.push({ prime: BigInt(p), exponent: e });
            }
            return out;
        };

        for (let n = 2; n <= 30; n++) {
            const isPrime = primesToMint.includes(BigInt(n));

            if (isPrime) {
                // D-20: THERE IS NO PRIME MINT. `mint(p, kind = 1)` is a
                // head-mismatch refund now, and measuring it here was measuring
                // `ledger.mint.lost_race` under two other names. The real cost of
                // acquiring a prime is `market.bid_head_prime` +
                // `ledger.settle_prime_clearing`, both snapshotted on the market
                // block below against a lot opened for the purpose.
                //
                // The buys still have to HAPPEN here, in order, because the
                // composite measurements below depend on them: §3.2's tribute
                // leg only sends a `credit_tribute` to a factor that has been
                // SOLD (an unsold prime's share forfeits to the treasury instead,
                // D-20 point 4), so a walk that skipped the buys would measure
                // composite mints on their cheap path and call it the budget.
                const buy = await acquirePrime({ blockchain, market: book, ledger }, minter, BigInt(n));
                if (n === 2) {
                    snapshot['market.bid_head_prime.small'] = gasAt(buy.result, book.address);
                    snapshot['ledger.settle_prime_clearing.small'] = gasAt(buy.result, ledger.address);
                    snapshot['collection.mint_item'] = gasAt(buy.result, collection.address);
                    snapshot['ratchet.pool_inject'] = gasAt(buy.result, ratchet.address);
                }
                continue;
            }

            const factors = factorize(n);
            const ratchetBuffer = async () =>
                (await blockchain.getContract(ratchet.address)).balance - (await ratchet.getPending());
            const bufferBefore = await ratchetBuffer();
            const { r: mintResult, spend } = await spendAcross(blockchain, ledger, () => mint(BigInt(n), 0, factors));
            expect(mintResult.transactions).toHaveTransaction({ to: ledger.address, success: true });
            // D-146: RATCHET_HOP_GAS (0.001) carries the hop itself — the ratchet's
            // gas buffer must not fall across a mint, or `pending` would be paying
            // for its own injection.
            expect(await ratchetBuffer()).toBeGreaterThanOrEqual(bufferBefore);

            if (n === 4) {
                snapshot['jetton_master.mint'] = gasAt(mintResult, master.address);
                // THE REBATE MUST BE VISIBLE, not merely credited. With
                // `forwardTonAmount = 0` the recipient's jetton wallet sends no
                // TEP-74 `transfer_notification`, the recipient's address then
                // appears NOWHERE in the mint's message tree (the excess returns
                // to the master, not to them), and TonAPI — which is what
                // Tonkeeper renders — attaches no action to their account at
                // all. Reported 2026-09-19 against testnet mint n=26: 102,921.54
                // PRIMES credited and provably in `get_wallet_data`, while the
                // wallet showed only the bounty vault's 524.31 PRIMES, because
                // THAT leg is a `JettonTransfer` and TonAPI attributes those to
                // the recipient regardless. See `MINT_NOTIFY_TON`.
                expect(mintResult.transactions).toHaveTransaction({
                    from: await master.getWalletAddress(minter.address),
                    to: minter.address,
                    op: TEP74.transfer_notification,
                    success: true,
                });
                // UPGRADE_PLAN_V5.md §4 B5: the §3.4 decomposition adds message
                // hops charged against §4.1's 10% gas & ops line. Measure them
                // as their own entrypoints rather than letting them hide inside
                // the mint total — B5 is explicit that if the ratchet hop lands
                // badly, the escrow split is kept and the ratchet split is
                // re-argued, and that decision needs a number.
                snapshot['ledger.mint.composite_w1'] = gasAt(mintResult, ledger.address);
                // D-191 point 1: the minter card's own hop (first mint: it deploys here).
                snapshot['minter_card.mint'] = gasAt(mintResult, await ledger.getMinterCardAddress(minter.address));
                recordMintCost('composite omega=1', 'composite_w1', spend);
                const item2 = await ledger.getItemAddress(2n);
                snapshot['item.credit_tribute'] = gasAt(mintResult, item2);
            }
            if (n === 6) {
                snapshot['ledger.mint.composite_w2'] = gasAt(mintResult, ledger.address);
                recordMintCost('composite omega=2', 'composite_w2', spend);
            }
            if (n === 30) {
                snapshot['ledger.mint.composite_w3_primorial'] = gasAt(mintResult, ledger.address);
                recordMintCost('composite omega=3 (primorial, era bounty, special rebate)', 'composite_w3_primorial', spend);
                // the primorial era bounty fired from the same mint
                expect(mintResult.transactions).toHaveTransaction({ from: ledger.address, to: vault.address, success: true });
                snapshot['bounty_vault.pay_era_bounty'] = gasAt(mintResult, vault.address);
            }
        }
        // D-20: `head` no longer advances by exactly 1 per mint — minting the
        // composite 30 auto-walks the forward primes-only gap past 31 (marking
        // it unsold, never minting it) and lands on the next COMPOSITE, 32.
        // See Meters.compositesMinted/primesSoldCount doc: `head` is defined
        // over composites (and Unity) only now.
        expect(await ledger.getHead()).toBe(32n);
        expect(await ledger.isPrimeUnsold(31n)).toBe(true);

        // referred mint (adds the referral relay hop). D-20: a PRIME can no
        // longer be minted directly via `Mint` at all — primes never occupy
        // the head — so this is now a referred COMPOSITE mint instead. The
        // referral relay hop itself is identical on both kinds; a prime's own
        // referred-mint entry point is `ledger.settle_prime_clearing`,
        // measured separately in the lot-lane block below.
        const { r: referred, spend: referredSpend } = await spendAcross(blockchain, ledger, () =>
            mint(32n, 0, [{ prime: 2n, exponent: 5 }], 2)
        );
        snapshot['ledger.mint.composite_referred'] = gasAt(referred, ledger.address);
        snapshot['item.forward_to_owner'] = gasAt(referred, await ledger.getItemAddress(2n));
        // NOTE: the 0.1 TON referral relay is a SPLIT line (CONCEPT §4.1's 10%
        // referral), not a gas & ops cost, so it is deliberately excluded from
        // the 0.10 TON reconciliation below — only protocol-side gas/deploy
        // value counts against that line.
        recordMintCost('composite, referred', 'composite_referred', referredSpend);

        // lost race (cheap-fail refund path). GAUNTLET V6: the LOSER's own attached
        // value pays the handler's gas, never the ledger's balance ("losing costs gas
        // and never principal"). D-191 point 1: the refund rides ledger -> the
        // minter's card (which gives the mint's window units back) -> the minter,
        // carry-all, so the real gas of both hops comes out of the refund and the
        // fixed LOST_RACE_GAS floor that used to approximate it is deleted.
        {
            const ledgerBalanceBefore = (await blockchain.getContract(ledger.address)).balance;
            const lost = await ledger.sendMint(minter.getSender(), {
                n: 2n,
                kind: 1,
                factors: [],
                referralKey: 0,
                beneficiary: null,
                value: MINT_PRICE,
            });
            expect(lost.transactions).not.toHaveTransaction({ aborted: true });
            snapshot['ledger.mint.lost_race'] = gasAt(lost, ledger.address);
            const refundTx = lost.transactions.find(
                (t) =>
                    t.inMessage?.info?.type === 'internal' &&
                    (t.inMessage.info as any).dest?.toString?.() === minter.address.toString()
            );
            expect(refundTx).toBeDefined();
            const refunded = (refundTx!.inMessage as any).info.value.coins as bigint;
            // three hops of real gas and forward fees, and nothing kept
            expect(refunded).toBeLessThan(MINT_PRICE);
            expect(refunded).toBeGreaterThan(MINT_PRICE - toNano('0.02'));
            const ledgerBalanceAfter = (await blockchain.getContract(ledger.address)).balance;
            expect(ledgerBalanceAfter).toBeGreaterThanOrEqual(ledgerBalanceBefore);
        }

        // ---- item paths ----
        {
            const item2Addr = await ledger.getItemAddress(2n);
            const item2 = blockchain.openContract(PrimesItem.createFromAddress(item2Addr));
            const claim = await item2.sendClaimTribute(minter.getSender(), { value: toNano('0.05') });
            snapshot['item.claim_tribute'] = gasAt(claim, item2Addr);
            snapshot['ledger.claim_tribute'] = gasAt(claim, ledger.address);
            const transfer = await item2.sendTransfer(minter.getSender(), {
                newOwner: keeper.address,
                value: toNano('0.05'),
            });
            snapshot['item.transfer'] = gasAt(transfer, item2Addr);
        }

        // ---- jetton wallet paths ----
        {
            const walletAddr = await master.getWalletAddress(minter.address);
            const wallet = blockchain.openContract(PrimesJettonWallet.createFromAddress(walletAddr));
            // Regression guard: rebate PRIMES must actually LAND in the
            // minter's wallet. A too-small attached value here made every
            // rebate mint bounce silently in the first pass.
            const walletData = await wallet.getWalletData();
            expect(walletData.balance).toBeGreaterThan(2000n);
            const transfer = await wallet.sendTransfer(minter.getSender(), {
                destination: keeper.address,
                responseAddr: minter.address,
                amount: 1000n,
                value: toNano('0.2'),
            });
            expect(transfer.transactions).toHaveTransaction({ to: walletAddr, success: true });
            snapshot['jetton_wallet.transfer'] = gasAt(transfer, walletAddr);
            snapshot['jetton_wallet.internal_transfer'] = gasAt(transfer, await master.getWalletAddress(keeper.address));
            const burn = await wallet.sendBurn(minter.getSender(), {
                amount: 1000n,
                responseAddr: minter.address,
                value: toNano('0.1'),
            });
            snapshot['jetton_wallet.burn'] = gasAt(burn, walletAddr);
            snapshot['jetton_master.burn_notification'] = gasAt(burn, master.address);
        }

        // ---- flush ----
        snapshot['ratchet.flush'] = gasAt(await ratchet.sendFlush(keeper.getSender(), { value: FLUSH_VALUE }), ratchet.address);

        // ---- venue timelock ----
        {
            const eta = blockchain.now! + TIMELOCK_DELAY + 10;
            snapshot['venue_timelock.queue'] = gasAt(
                await timelock.sendQueue(proposer.getSender(), {
                    dedustNativeVault: dedust.address,
                    dedustPool: dedust.address,
                    primesJettonVault: dedust.address,
                    eta,
                    value: toNano('0.05'),
                }),
                timelock.address
            );
            const queued = await timelock.getQueued();
            snapshot['venue_timelock.confirm_venue'] = gasAt(
                await timelock.sendConfirmVenue(proposer.getSender(), {
                    seq: queued.seq,
                    voteOpens: queued.queuedAt,
                    voteCloses: queued.eta,
                    value: toNano('0.05'),
                }),
                timelock.address
            );
            blockchain.now = eta;
            const exec = await timelock.sendExecute(keeper.getSender(), { value: toNano('0.1') });
            snapshot['venue_timelock.execute'] = gasAt(exec, timelock.address);
            snapshot['ratchet.update_venue'] = gasAt(exec, ratchet.address);
            snapshot['venue_timelock.retry_update_venue'] = gasAt(
                await timelock.sendRetryUpdateVenue(keeper.getSender(), { value: toNano('0.1') }),
                timelock.address
            );
            snapshot['venue_timelock.cancel'] = gasAt(
                await timelock.sendCancel(proposer.getSender(), { value: toNano('0.05') }),
                timelock.address
            );
        }

        // ---- the ahead-of-the-head path (D-30, D-90) ----
        //
        // COMPARABILITY BREAK, 2026-08-19. `market.reserve` and
        // `market.reserve.max_digits` are DELETED with the flat-fee `reserve`
        // entry point (D-30). `market.open_lot.max_digits` replaces the latter as
        // the 14-digit worst case for the D(n) scoring loop.
        //
        // SECOND COMPARABILITY BREAK, D-90. Four rows are REBASELINED because their measurement
// point moved, not because they got dearer by drift:
//   ledger.mint_won_lot        65425 -> 68029   measured on the CLOSE now
//   ledger.mint_won_lot.omega3 68714 -> 72753   same, and this is the ω=3 worst
//   market.close                          17144 -> 14044   no longer sends to a shard
//   ledger.mark_off_head                   7272 ->  7290   unchanged code, noise
// The close got CHEAPER and the ledger's settle arm dearer, which is the shape to expect:
// one transaction now does what a shard hop plus a later `settle(n)` used to. The mint hot
// path (`ledger.mint.composite_w1/w2/w3`, `collection.mint_item`, `item.credit_tribute`,
// `ratchet.pool_inject`) is BYTE-IDENTICAL — D-90.1's Miller-Rabin fallback is behind a
// bitmap hit that a head mint always takes, so it never runs there. Treat any movement in
// those rows as a bug in this change, not a baseline to update.
//
// The deleted rows: `market_shard.reserve`,
        // `market.settle`, `market_shard.settle`, `market.release` and
        // `market_shard.release` are DELETED ROWS — the escrow shard and the
        // whole claim lifecycle are gone. A won lot MINTS IN ITS OWN CLOSE, so
        // `ledger.mint_won_lot` and its ω=3 sibling are measured on
        // the close transaction now. `ledger.mark_off_head` is unmoved: it fires
        // from `open_lot`.
        {
            snapshot['ledger.sync_head'] = gasAt(
                await ledger.sendSyncHead(keeper.getSender(), { value: toNano('0.05') }),
                ledger.address
            );
            // D-30: any composite may be opened, so the fixture is no longer
            // constrained by a lane threshold — 39 = 3 · 13 is kept because it
            // has the omega = 2 shape the settlement rows below are named for
            // and sits BELOW the omega = 3 row's 42. The head is strictly
            // sequential, so the two claims must settle in ascending order or
            // the walk between them would have to mint a number already claimed.
            const n = 39n;
            const claim = await winClaim(n, [
                { prime: 3n, exponent: 1 },
                { prime: 13n, exponent: 1 },
            ]);
            // D-90: THE SETTLEMENT IS IN THE CLOSE. `market_shard.reserve`,
            // `market.settle`, `market_shard.settle`, `market.release` and
            // `market_shard.release` are deleted rows — the shard and the whole
            // claim lifecycle are gone — and `ledger.mint_won_lot` is
            // now measured on the close transaction instead of on a later
            // permissionless `settle(n)`. `ledger.mark_off_head` is unmoved: it
            // fires from `open_lot`, in the same transaction as the opening bid.
            snapshot['ledger.mark_off_head'] = gasAt(claim.open, ledger.address);
            snapshot['ledger.mint_won_lot'] = gasAt(claim.close, ledger.address);

            // D-30/D-37: there is no `RES_FEE` at all any more — it, its
            // `RES_PRIORITY_BASE` and `RES_PREMIUM` parts, and the flat
            // reservation fee they priced are all deleted (`shared/params.json`
            // `reservations`: "there is no RES_FEE and no RES_PRIORITY under
            // D-30"). `RES_GAS` survives alone, carved from the winning bid.
            // What survives with it is the property that
            // was never about pricing: the slice of RES_GAS that rides to the
            // ledger with the settlement must cover the hops the ledger attaches
            // on the way back EXACTLY. Any shortfall is a silent charge against
            // §4.1's 10% line — the failure mode the ω=3 row below exists to
            // catch, pinned here at its source. D-90 moves the pair from the
            // deleted shard's `getResFeeSplit` onto the market itself.
            const split = await book.getResFeeSplit();
            expect(split.resGas).toBe(await book.getResGas());
            expect(split.settleGas).toBe(SETTLE_HOP);
            expect(split.settleGas).toBeLessThanOrEqual(split.resGas);
            // and the number really is minted, off-head, in that close
            expect(await ledger.isNumberOffHead(n)).toBe(1);
            recordMintCost('lot close settlement omega=2', 'settle_w2', claim.spend);

            // CONCEPT §4.4 point 1a: the D(n) scoring loop is compute a plain
            // mint never pays, so `res_fee_split` prices the book's row at its
            // WORST CASE rather than at the sample composite above. The worst
            // case is the maximum digit count a reservation can actually have:
            // the shard's `shardId` is a uint32 over n/10_000, which caps a
            // reservable n at ~4.29e13, i.e. 14 digits. n = 10^13 is that bound
            // with a two-factor decomposition, so this row measures the scoring
            // loop at full length without inflating the SHARD's row (which
            // res_fee_split reads separately) with a 78-factor product.
            // 2^43 · 3 is 14 digits with a two-factor shape and no pattern
            // weight at all (D = 0), and it is under AUCTIONABLE_MAX. D-30 moves
            // the row from `reserve` to `open_lot`, which is where the scoring
            // loop is walked now — and `open_lot` ALSO verifies the
            // factorization, so this row is not comparable by value with the
            // retired `market.reserve.max_digits`. The measurement it exists for
            // is the same: the worst-case cost of the D(n) walk.
            const wide = 26_388_279_066_624n; // 2^43 · 3, 14 digits
            const wideFactors = [
                { prime: 2n, exponent: 43 },
                { prime: 3n, exponent: 1 },
            ];
            const wideOpen = await book.sendOpenLot(minter.getSender(), {
                n: wide,
                kind: 0,
                factors: wideFactors,
                beneficiary: null,
                referralKey: 0,
                // Phase 3 (§4): quoted WITH the factors, because that is what
                // `open_lot` prices this open at.
                value: (await book.getLotPriceFrom(wide, wideFactors)).p0 + toNano('0.2'),
            });
            expect(wideOpen.transactions).toHaveTransaction({ to: book.address, success: true });
            snapshot['market.open_lot.max_digits'] = gasAt(wideOpen, book.address);

            // A lot settlement (the settle hop on top of a full mint) on a
            // three-factor number. It was once the heaviest mint this file
            // measured; D-117's seeded worst-case block above now holds that
            // title, and this row stays as the auction lane's own measurement.
            // A failure here is a design question for CONCEPT §4.1, not a number
            // to update.
            //
            // RESOLVED 2026-08-15 (owner decision, §12's third fallback): this row
            // measured 0.1034 and was failing. Two things were wrong. The settle
            // hop was charged to the 10% line although §4.4 funds it from
            // `RES_GAS` — that is the `SETTLE_HOP` credit below. And `SETTLE_GAS`
            // was 0.020 against 0.025 of hops the ledger actually attaches, so
            // 0.005 per settlement really was leaking onto the line. If this row
            // goes red again it is still a design question, not a number to
            // update.
            //
            // D-90: the settlement is now IN THE CLOSE, so this measures one
            // transaction instead of two hops chained through a shard — the row
            // should get cheaper, never dearer.
            const n3 = 42n; // 2 · 3 · 7, omega = 3
            const claim3 = await winClaim(n3, [
                { prime: 2n, exponent: 1 },
                { prime: 3n, exponent: 1 },
                { prime: 7n, exponent: 1 },
            ]);
            snapshot['ledger.mint_won_lot.omega3'] = gasAt(claim3.close, ledger.address);
            // D-45/D-90: `advanceHead` is false on this path, so a settlement
            // never moves the head. 42 is far ahead of it and stays skipped
            // forever — pinned here so a regression that makes a close advance
            // the head fails exactly where it used to.
            expect(await ledger.getHead()).toBeLessThan(n3);
            expect(await ledger.isNumberOffHead(n3)).toBe(1);
            recordMintCost('lot close settlement omega=3', 'settle_w3', claim3.spend);

            // D-100 POINT 6 — THE FORFEIT SPLIT, WHICH IS THE ONE THING D-100
            // ADDS TO THE MINT'S OUTBOUND FAN-OUT, AND THEREFORE THE ONLY WAY
            // IT CAN MOVE THE §4.1 GAS & OPS RECONCILIATION.
            //
            // Until D-100 an unsold prime's forfeited tribute share (§6 point 2)
            // was ONE send, to `treasuryAddr`. It is now TWO: 80% to the
            // governed treasury contract and the remainder to the operator. The
            // forfeited TON itself is split money, not gas — it comes out of the
            // tribute line and never touches the 10% line — but the SECOND
            // MESSAGE'S OWN FEES do, and nothing in this file measured a mint
            // that forfeits at all. Every composite above cites factors the walk
            // already bought, which is deliberate (see the note in the mint
            // loop) and is exactly why this case fell through.
            //
            // 186 = 2 · 3 · 31 is the cheapest way to construct it here: 2 and 3
            // were bought off the Dutch lane, 31 was marked unsold when minting
            // 30 walked the head past it, and this block runs BEFORE the lot
            // lane below buys 31. So the split is two `credit_tribute` sends
            // plus the two-way forfeit: four value-bearing sends against the
            // three the ω=3 row above makes.
            //
            // THE TWO GAS ROWS ARE NOT SUBTRACTABLE — 186 and 42 also differ in
            // their D-99 score and in their factor loop, so the difference is
            // not "the price of D-100's second send" and must not be quoted as
            // one. What IS comparable is the line this file exists to defend:
            // the ω=3 all-sold row reconciles at 0.0924 TON and this one at
            // 0.0808, so the forfeit split comes out CHEAPER against §4.1's
            // 0.10 TON. It trades one `credit_tribute` hop (0.008 of attached
            // gas) for two bare sends whose value is the forfeited tribute
            // itself — split money, never the 10% line. D-100's second send does
            // not threaten the gas & ops line, and this row is the measurement
            // that says so rather than the argument that it shouldn't.
            //
            // `attached` therefore counts TWO credit_tribute hops, not three: a
            // forfeited factor has no item to credit, so no hop is attached for
            // it.
            const nForfeit = 186n; // 2 · 3 · 31, with 31 unsold
            expect(await ledger.isPrimeUnsold(31n)).toBe(true);
            const claimForfeit = await winClaim(nForfeit, [
                { prime: 2n, exponent: 1 },
                { prime: 3n, exponent: 1 },
                { prime: 31n, exponent: 1 },
            ]);
            snapshot['ledger.mint_won_lot.forfeit_split'] = gasAt(
                claimForfeit.close,
                ledger.address
            );
            recordMintCost('lot close settlement omega=3, one factor unsold (D-100 forfeit split)', 'settle_w3_forfeit', claimForfeit.spend);
            // Both halves of the forfeit really left, or the row above is
            // measuring the cheap path under an expensive name.
            const opTotals = await ledger.getOperatorTotals();
            expect(opTotals.treasuryPaidTotal).toBeGreaterThan(0n);
            expect(opTotals.operatorPaidTotal).toBeGreaterThan(0n);
        }

        // ---- lot lane (D-3, on the MARKET) ----
        //
        // P2.A7 REPLACES THE THREE `auction.*` ROWS with the market's own
        // `open_lot` / `bid` / `close`. D-20 THEN DELETES the genesis-specific
        // `MODE_DUTCH_CLOCK` sub-lane (bootstrap_genesis's pre-bid clock) —
        // every prime now opens on the SAME `MODE_DUTCH_BUYNOW` lane a real head
        // lot uses, so `market.bid_genesis` becomes `market.open_head_lot` +
        // `market.bid_head_prime`: two rows instead of one, because opening the
        // clock and buying are now separate permissionless messages rather than
        // one pre-seeded lot's pre-bid.
        //
        // Every row below MUST be a successful transaction. The pre-§6 baseline
        // was not: this block runs late, after the reservation and era steps have
        // pushed `blockchain.now` well past the old `auctionEnd`, so the old
        // `auction.bid` (1239 gas) was measuring a REJECTED bid and the old
        // `auction.finalize` (10177) the no-bid branch that minted nothing. These
        // assertions are what stop that from recurring silently.
        {
            const expectOk = (r: any) =>
                expect(r.transactions).toHaveTransaction({ to: book.address, success: true });

            // 31 was marked (and left unsold) when minting 30 walked the head
            // past it; the loop above buys 2..29 but stops before it, so this is
            // the one prime in range with no lot yet. `book`'s `headHint` was
            // synced to the real ledger head at `ledger.sync_head` above, so
            // `31 < headHint` holds and the lot is eligible.
            const openHead = await book.sendOpenHeadLot(keeper.getSender(), { n: 31n, value: toNano('0.1') });
            expectOk(openHead);
            snapshot['market.open_head_lot'] = gasAt(openHead, book.address);

            // D-20 / D-88: the purchase SETTLES IN THIS TRANSACTION —
            // there is no pre-bid clock to start first, unlike the retired
            // MODE_DUTCH_CLOCK lane. This is also the message that reaches the
            // ledger via `SettlePrimeClearing` and clears 29's `unsoldPrimes`
            // entry, so it is the heaviest message on the head lane.
            const minPayment = (await book.getLot(31n)).minPayment;
            const { r: bid, spend: bidSpend } = await spendAcross(blockchain, ledger, () =>
                book.sendBid(keeper.getSender(), {
                    n: 31n,
                    beneficiary: null,
                    referralKey: 0,
                    value: minPayment + toNano('0.5'),
                })
            );
            expectOk(bid);
            snapshot['market.bid_head_prime'] = gasAt(bid, book.address);
            snapshot['ledger.settle_prime_clearing'] = gasAt(bid, ledger.address);

            // D-20 PUT A WHOLE MINT PATH OUTSIDE THIS RECONCILIATION, and it had
            // to come back in. A prime's nominal MINT_PRICE runs the SAME §4.1
            // five-way split a composite runs — including the same 10% gas & ops
            // leg — so the purchase has to fit inside the same 0.10 TON, and
            // nothing measured whether it did. It is charged like any other mint:
            // the item deploy, the ratchet hop and the registrar hop are drawn
            // from the line; `RES_GAS` is not, because the buyer paid it on top of
            // the number's price exactly as a reserver does (see the note on
            // `recordMintCost`).
            recordMintCost('prime purchase (Dutch buy-now, D-20)', 'prime_purchase', bidSpend);

            // Opening an ASCENDING lot: carries the payload AND the opener's own
            // bid, so it is the heaviest message on the reservation-adjacent lane.
            //
            // D-22: the ascending lane is the COMPOSITE lane. A prime is
            // purchasable by exactly one mechanism — the MODE_DUTCH_BUYNOW lot
            // above — and this snapshot used to open 999,983, which is prime. An
            // ascending prime lot is won into a reservation that settles when the
            // head reaches `n`, and under D-20 the head never reaches a prime, so
            // the escrow was cancellable but never settleable. 10^6 is the
            // clearest auction-lane composite in the system: POW10_W = 60
            // (GAUNTLET N3's D-12/D-21 retune) puts it well above zero on the
            // power-of-ten pattern alone.
            const openN = 1_000_000n;
            const openFactors = [
                { prime: 2n, exponent: 6 },
                { prime: 5n, exponent: 6 },
            ];
            const open = await book.sendOpenLot(keeper.getSender(), {
                n: openN,
                kind: 0,
                factors: openFactors,
                beneficiary: null,
                referralKey: 0,
                // Phase 3 (§4): the factored quote, which is what `open_lot` charges.
                value: (await book.getLotPriceFrom(openN, openFactors)).p0 + toNano('0.5'),
            });
            snapshot['market.open_lot'] = gasAt(open, book.address);

            // Close: permissionless, and the path that forwards the premium to the
            // ledger — the most expensive lot path there is. D-20: this can only
            // ever be an ASCENDING close now — a MODE_DUTCH_BUYNOW lot (like the
            // head lot above) has NO permissionless termination at all; it always
            // throws `mkt_close_too_early` (1005) here, and its only termination
            // is the purchase already measured above.
            blockchain.now = blockchain.now! + 8 * 86400;
            const close = await book.sendClose(keeper.getSender(), { n: openN, value: toNano('0.3') });
            expectOk(close);
            snapshot['market.close'] = gasAt(close, book.address);
        }

        // ---- D-212: naming a number for TON (§4.7.1) ----
        //
        // Off the mint path, measured against the walk's own stack: the minter names a
        // composite it owns. Four hops, each its own row — the collection's door, the
        // item's check-and-pay, the collection's relay of the fee, the ledger's floor step.
        {
            let owned = 0n;
            for (const n of [4n, 6n, 8n, 9n, 10n, 12n]) {
                const it_ = blockchain.openContract(PrimesItem.createFromAddress(await collection.getItemAddress(n)));
                try {
                    if ((await it_.getNumberData()).owner.equals(minter.address)) { owned = n; break; }
                } catch { /* not minted in this walk */ }
            }
            expect(owned).toBeGreaterThan(0n);
            const { nameFee } = await collection.getNaming();
            const named = await collection.sendNameNumber(minter.getSender(), {
                n: owned,
                text: beginCell().storeStringTail('a name').endCell(),
                value: nameFee + NAME_RELAY_GAS_NANOTON,
            });
            expect(named.transactions).not.toHaveTransaction({ aborted: true });
            const gasOf = (op: number) => {
                const tx = named.transactions.find(
                    (t: Transaction) =>
                        t.inMessage?.info.type === 'internal' &&
                        t.inMessage.body.beginParse().remainingBits >= 32 &&
                        t.inMessage.body.beginParse().preloadUint(32) === op
                );
                const cp: any = tx && (tx.description as any).computePhase;
                return cp && cp.type === 'vm' ? Number(cp.gasUsed) : 0;
            };
            snapshot['collection.name_number'] = gasOf(COLLECTION_OPS.name_number);
            snapshot['item.item_name'] = gasOf(ITEM_OPS.item_name);
            snapshot['collection.naming_paid'] = gasOf(COLLECTION_OPS.naming_paid);
            snapshot['ledger.royalty_to_ratchet.naming'] = gasOf(0xb0000079); // LEDGER.royalty_to_ratchet
        }


        // ---- D-100 / D-168: the governed treasury, LP custody and the LP sink ----
        //
        // Measured STANDALONE, like the venue timelock, the jetton wallet and
        // the burn sink blocks above, and for a stronger reason than any of
        // them: these three contracts touch nothing in the mint walk. They hold
        // no protocol TON, they send the ledger nothing, and TR-4 is that
        // nothing here mints — so there is no path by which a row below can
        // change a row above, and wiring them into the walk would have implied
        // one exists.
        //
        // The two jetton wallets are sandbox stand-ins. Every row here is the
        // gas the TREASURY (or the sink, or a position child) burns on its own
        // account; a real DeDust LP wallet sits on the far side of both the
        // inbound notification and the outbound transfer and would change
        // neither figure. `LpMiner.spec.ts` and `Treasury.spec.ts` use the same
        // stand-ins for the same reason.
        //
        {
            const lpWallet = await blockchain.treasury('trLpWallet');
            const primesWallet = await blockchain.treasury('trPrimesWallet');
            const sinkLpWallet = await blockchain.treasury('trSinkLpWallet');
            const holder = await blockchain.treasury('trHolder', { balance: toNano('1000') });
            const operatorWallet = await blockchain.treasury('trOperator');

            const lpSinkCode = await compile('PrimesLpSink');
            const treasuryCode = await compile('PrimesTreasury');
            const positionCode = await compile('PrimesLpPosition');

            const lpSink = blockchain.openContract(
                PrimesLpSink.createFromConfig(
                    { genesisScriptAddr: genesisScript.address },
                    lpSinkCode
                )
            );
            await lpSink.sendDeploy(deployer.getSender(), toNano('1'));
            await lpSink.sendSetWallet(genesisScript.getSender(), {
                lpJettonWalletAddr: sinkLpWallet.address,
                value: toNano('0.05'),
            });

            const treasury = blockchain.openContract(
                PrimesTreasury.createFromConfig(
                    {
                        operatorAddr: operatorWallet.address,
                        sinkAddr: lpSink.address,
                        // A fixture rate, deliberately not a claim about the
                        // figure the sim selects: the rate is DEPLOY DATA
                        // (`staking.distribution_rate_bps_per_day`), and gas does
                        // not depend on its value. The stake address is a
                        // stand-in: `distribute()`'s transfer goes to the sandbox
                        // PRIMES wallet, which is all this row measures.
                        stakeAddr: operatorWallet.address,
                        distributionRateBpsPerDay: 100,
                        positionCode,
                        genesisScriptAddr: genesisScript.address,
                    },
                    treasuryCode
                )
            );
            await treasury.sendDeploy(deployer.getSender(), toNano('200'));
            // Audit M1: the tsTON wallet is named so `treasury.tston_in` below reaches the
            // tsTON branch (omitted, the wrapper writes the treasury's own address).
            const tstonWallet = await blockchain.treasury('treasuryTstonWallet');
            await treasury.sendSetWallets(genesisScript.getSender(), {
                lpJettonWallet: lpWallet.address,
                primesJettonWallet: primesWallet.address,
                tstonJettonWallet: tstonWallet.address,
                value: toNano('0.1'),
            });
            // The vest arriving, so `distribute()` below has a balance to budget.
            await treasury.sendTransferNotification(primesWallet.getSender(), {
                amount: toNano('1000000'),
                from: deployer.address,
                value: toNano('0.15'),
            });

            // 1. DEPOSIT — credits the child (deploying it on the first deposit)
            //    and moves the vote denominator.
            const ELECTORATE_TIER = 2; // 6 months
            const deposit = await treasury.sendTransferNotification(lpWallet.getSender(), {
                amount: toNano('1000'),
                from: holder.address,
                value: toNano('0.6'),
                forwardPayload: depositPayload(ELECTORATE_TIER),
            });
            expect(deposit.transactions).toHaveTransaction({ to: treasury.address, success: true });
            snapshot['treasury.deposit'] = gasAt(deposit, treasury.address);

            // Audit M1 — harvest's tsTON arrives carrying exactly `HARVEST_FORWARD_TON`
            // (0.05 TON). The tsTON branch returns before the 0.15 TON
            // `TREASURY_MIN_FORWARD` check, so the forward pays this compute and nothing else.
            const tstonIn = await treasury.sendTransferNotification(tstonWallet.getSender(), {
                amount: toNano('1'),
                from: deployer.address,
                value: toNano('0.05'),
            });
            expect(tstonIn.transactions).not.toHaveTransaction({ aborted: true });
            expect((await treasury.getTreasuryBalances()).tstonBalance).toBe(toNano('1'));
            snapshot['treasury.tston_in'] = gasAt(tstonIn, treasury.address);

            const child = blockchain.openContract(
                PrimesLpPosition.createFromConfig(
                    { owner: holder.address, treasuryAddr: treasury.address },
                    positionCode
                )
            );

            // 2. RELOCK (D-147) — applied on the child, reported to the treasury as
            //    `relock_vote`, which moves the vote weight between tiers. Since
            //    D-168 nothing is paid, so nothing is awaited.
            const relock = await child.sendRelock(holder.getSender(), {
                positionId: 0,
                tier: 3,
                value: toNano('0.6'),
            });
            expect(relock.transactions).toHaveTransaction({
                to: treasury.address,
                success: true,
            });
            snapshot['lp_position.relock'] = gasAt(relock, child.address);
            snapshot['treasury.relock'] = gasAt(relock, treasury.address);

            // 3b. EXPIRE (D-147) — the permissionless poke. It edits ONE gov field
            //     and sends nothing, so it is the cheapest arm on this contract and
            //     is measured precisely because it is meant to stay that way: a
            //     keeper may fire it often.
            blockchain.now = (await child.getPosition(0)).maturesAt + 10;
            const expire = await child.sendExpire(keeper.getSender(), {
                positionId: 0,
                value: toNano('0.6'),
            });
            expect(expire.transactions).toHaveTransaction({
                to: treasury.address,
                success: true,
            });
            snapshot['treasury.expire_vote'] = gasAt(expire, treasury.address);

            // 4. WITHDRAW — once the term has matured. The LP transfer out plus
            //    the child's confirmation.
            const withdraw = await child.sendWithdraw(holder.getSender(), {
                positionId: 0,
                value: toNano('0.6'),
            });
            expect(withdraw.transactions).toHaveTransaction({
                to: treasury.address,
                success: true,
            });
            snapshot['treasury.withdraw'] = gasAt(withdraw, treasury.address);

            // 5. EXECUTE — the whole governance path has to run first, because
            //    an execute with no passed proposal behind it is a throw and
            //    would measure the refusal. Deposit again (the position above is
            //    gone), propose, vote, wait out the day, execute.
            //
            //    Asset 0 (TON) on purpose: it is the arm with the `TonPayout`
            //    send and `getOriginalBalance()` cap arithmetic, i.e. the one
            //    that does not reduce to a TEP-74 transfer already measured by
            //    the withdraw row above.
            await treasury.sendTransferNotification(lpWallet.getSender(), {
                amount: toNano('1000'),
                from: holder.address,
                value: toNano('0.6'),
                forwardPayload: depositPayload(ELECTORATE_TIER),
            });
            // §5.5.5: only LP locked strictly before the proposal opened votes on it.
            blockchain.now = blockchain.now! + 1;
            await child.sendPropose(holder.getSender(), {
                asset: TreasuryAsset.TON,
                amount: toNano('1'),
                dest: keeper.address,
                positionId: 1,
                value: toNano('0.6'),
            });
            // D-173 amendment 2026-11-19: the vote opens after the notice.
            const window = await treasury.getProposal(0);
            blockchain.now = window.opens;
            await child.sendVote(holder.getSender(), {
                seq: 0,
                support: true,
                positionId: 1,
                value: toNano('0.6'),
            });
            blockchain.now = window.closes + 60;
            const exec = await treasury.sendExecute(keeper.getSender(), {
                seq: 0,
                value: toNano('2'),
            });
            expect(exec.transactions).toHaveTransaction({ to: treasury.address, success: true });
            snapshot['treasury.execute'] = gasAt(exec, treasury.address);

            // 5b. DISTRIBUTE (D-168) — the permissionless monthly budget: the
            //     formula over `primesBalance` and one TEP-74 transfer with a
            //     forward payload. The first one is allowed at once.
            const distribute = await treasury.sendDistribute(keeper.getSender());
            expect(distribute.transactions).toHaveTransaction({ to: treasury.address, success: true });
            snapshot['treasury.distribute'] = gasAt(distribute, treasury.address);

            // 6. THE LP SINK — one deposit, and there is only ever one thing to
            //    measure: the contract has exactly one inbound handler and no
            //    outbound message type at all (D-100 point 4). A row that ever
            //    grows materially here means something was added to a contract
            //    whose whole guarantee is that nothing can be.
            const lock = await lpSink.sendTransferNotification(sinkLpWallet.getSender(), {
                amount: toNano('500'),
                from: holder.address,
                value: toNano('0.1'),
            });
            expect(lock.transactions).toHaveTransaction({ to: lpSink.address, success: true });
            snapshot['lp_sink.deposit'] = gasAt(lock, lpSink.address);
            expect(await lpSink.getLocked()).toBe(toNano('500'));
        }

        // ---- D-168: the stake master and its position child ----
        //
        // Standalone for the same reason as the treasury block: nothing here
        // touches the mint walk. The master's PRIMES wallet is a sandbox stand-in
        // impersonated for the notifications; every row is gas on the master's
        // (or the child's) own account. Four rows: a budget arriving, a stake
        // (deploying the child), and a claim measured on both hops — the owner
        // pays the child's and the master's arithmetic.
        {
            const stakeWallet = await blockchain.treasury('stkPrimesWallet');
            const stakeTreasury = await blockchain.treasury('stkTreasury');
            const staker = await blockchain.treasury('stkHolder', { balance: toNano('100') });
            const stakePositionCode = await compile('PrimesStakePosition');
            const stake = blockchain.openContract(
                PrimesStake.createFromConfig(
                    {
                        jettonMasterAddr: deployer.address,
                        positionCode: stakePositionCode,
                        genesisScriptAddr: genesisScript.address,
                    },
                    await compile('PrimesStake')
                )
            );
            await stake.sendDeploy(deployer.getSender(), toNano('1'));
            await stake.sendSetWallet(genesisScript.getSender(), {
                jettonWalletAddr: stakeWallet.address,
                treasuryAddr: stakeTreasury.address,
                value: toNano('0.05'),
            });

            const stakeIn = await stake.sendTransferNotification(stakeWallet.getSender(), {
                amount: toNano('1000'),
                from: staker.address,
                value: toNano('0.2'),
                forwardPayload: stakePayload(3),
            });
            expect(stakeIn.transactions).not.toHaveTransaction({ aborted: true });
            snapshot['stake.stake'] = gasAt(stakeIn, stake.address);

            const budget = await stake.sendTransferNotification(stakeWallet.getSender(), {
                amount: toNano('10000'),
                from: stakeTreasury.address,
                value: toNano('0.05'),
                forwardPayload: budgetPayload(),
            });
            expect(budget.transactions).not.toHaveTransaction({ aborted: true });
            snapshot['stake.budget'] = gasAt(budget, stake.address);

            const position = blockchain.openContract(
                PrimesStakePosition.createFromConfig(
                    { owner: staker.address, stakeAddr: stake.address },
                    stakePositionCode
                )
            );
            blockchain.now = blockchain.now! + 86400;
            const claim = await position.sendClaim(staker.getSender(), { positionId: 0 });
            expect(claim.transactions).not.toHaveTransaction({ aborted: true });
            snapshot['stake_position.claim'] = gasAt(claim, position.address);
            snapshot['stake.settle'] = gasAt(claim, stake.address);
        }

        // ---------------- GAUNTLET C13: the invite line (D-202) ----------------
        // Two FRESH, otherwise-identical stacks (own `deployStack`, own genesis),
        // each minting the exact same head (4, the same omega=1 composite as
        // `ledger.mint.composite_w1` above) for the same 1 TON — one with no
        // invite list, one with all three slots filled. Same n, same value, same
        // everything except the invite line, so the difference between the two
        // rows below IS the line's cost, not noise from a different fixture.
        {
            const stackZero = await deployStack();
            const headZero = await stackZero.ledger.getHead();
            const zero = await stackZero.ledger.sendMint(stackZero.alice.getSender(), {
                n: headZero,
                kind: 0,
                factors: factorizeBig(headZero),
                referralKey: 0,
                beneficiary: null,
                invites: null,
                value: MINT_PRICE,
            });
            expect(zero.transactions).toHaveTransaction({ to: stackZero.ledger.address, success: true });
            snapshot['ledger.mint.invite_count_0'] = gasAt(zero, stackZero.ledger.address);

            const stackThree = await deployStack();
            const headThree = await stackThree.ledger.getHead();
            expect(headThree).toBe(headZero); // same genesis, must land on the same n
            const invitees = await Promise.all(
                [1, 2, 3].map((i) => stackThree.blockchain.treasury(`c13_invitee${i}`))
            );
            const addresses = new Map(invitees.map((t, i) => [i + 1, t.address]));
            const three = await stackThree.ledger.sendMint(stackThree.alice.getSender(), {
                n: headThree,
                kind: 0,
                factors: factorizeBig(headThree),
                referralKey: 0,
                beneficiary: null,
                invites: { count: 3, addresses },
                value: MINT_PRICE,
            });
            expect(three.transactions).toHaveTransaction({ to: stackThree.ledger.address, success: true });
            expect(three.transactions).not.toHaveTransaction({ aborted: true });
            const sends = three.transactions.filter(
                (t: any) =>
                    t.inMessage?.info?.src?.toString() === stackThree.ledger.address.toString() &&
                    invitees.some((v) => t.inMessage?.info?.dest?.toString() === v.address.toString())
            );
            expect(sends.length).toBe(3); // all three slots actually sent
            snapshot['ledger.mint.invite_count_3'] = gasAt(three, stackThree.ledger.address);

            console.log(
                `[gas] C13 invite line: invite_count=0 -> ${snapshot['ledger.mint.invite_count_0']}` +
                    `, invite_count=3 -> ${snapshot['ledger.mint.invite_count_3']}` +
                    `, delta ${snapshot['ledger.mint.invite_count_3'] - snapshot['ledger.mint.invite_count_0']}` +
                    ` (uninvited composite_w1 baseline: ${snapshot['ledger.mint.composite_w1']})`
            );
        }

        // ---- §4.3.2, the staked reserve (D-151) ----
        //
        // ON ITS OWN FIXTURE, deliberately. Every arm below needs state the main
        // stack cannot reach: `stake` needs `pending` above 625 TON (STAKE_MIN is
        // 500 and the reserve is 20% of the obligation), `unstake` needs the
        // reserve already BREACHED — which only `flush()` can do — and `harvest`
        // needs the pool rate to have moved between two deposits. Reaching all
        // three from the genesis stack would mean donating ~1,800 TON into `T`
        // and firing a second venue timelock cycle in the middle of a file whose
        // other rows are measured against that same `T`. A fresh ratchet against
        // `mock_tonstakers_pool.tolk` measures the same compute with none of that
        // coupling; `RatchetStaking.spec.ts` is where the behaviour is proved.
        {
            const poolMock = blockchain.openContract(
                MockTonstakersPool.createFromConfig(
                    { rateNum: toNano('1'), rateDen: toNano('1'), freeTon: toNano('2000') },
                    await compile('MockTonstakersPool')
                )
            );
            await poolMock.sendDeploy(deployer.getSender(), toNano('3000'));

            const stakingRatchet = blockchain.openContract(
                PrimesRatchet.createFromConfig(
                    {
                        ledgerAddr: minter.address, // stands in as the only legal PoolInject sender
                        venueTimelockAddr: proposer.address,
                        genesisScriptAddr: genesisScript.address,
                        dedustNativeVault: poolMock.address, // the mock is the native vault too
                        dedustPool: dedust.address,
                        primesJettonVault: dedust.address,
                        tonstakersPool: poolMock.address,
                        dedustTstonVault: poolMock.address,
                        dedustTstonPool: dedust.address,
                        treasuryAddr: treasuryWallet.address,
                    },
                    codes.ratchet
                )
            );
            await stakingRatchet.sendDeploy(deployer.getSender(), toNano('20'));
            await stakingRatchet.sendSetJettonWallet(genesisScript.getSender(), {
                jettonWalletAddr: treasuryWallet.address,
                value: toNano('0.05'),
            });
            snapshot['ratchet.set_tston_wallet'] = gasAt(
                await stakingRatchet.sendSetTstonWallet(genesisScript.getSender(), {
                    tstonWalletAddr: poolMock.address,
                    value: toNano('0.05'),
                }),
                stakingRatchet.address
            );

            const inject = async (amount: bigint) =>
                stakingRatchet.sendPoolInject(minter.getSender(), {
                    amount,
                    tSnapshot: amount,
                    sSnapshot: toNano('1000000'),
                    value: amount + toNano('0.01'),
                });

            await inject(toNano('1000'));
            snapshot['ratchet.stake'] = gasAt(
                await stakingRatchet.sendStake(keeper.getSender(), { value: STAKE_VALUE }),
                stakingRatchet.address
            );

            // HARVEST needs the rate to have moved BETWEEN two deposits: the rate
            // is learned from a deposit and from nothing else, so one stake teaches
            // a rate consistent with itself and accrues exactly 0 (which refuses by
            // name, 229). A second stake at a higher rate is what makes the accrual
            // visible — tsTON does not rebase, so what changes is how little of it
            // the same cost is worth.
            await poolMock.sendSetRate(keeper.getSender(), {
                rateNum: toNano('1.05'),
                rateDen: toNano('1'),
                value: toNano('0.05'),
            });
            await inject(toNano('1000'));
            await stakingRatchet.sendStake(keeper.getSender(), { value: STAKE_VALUE });
            snapshot['ratchet.harvest'] = gasAt(
                await stakingRatchet.sendHarvest(keeper.getSender(), { value: HARVEST_VALUE }),
                stakingRatchet.address
            );

            // UNSTAKE is callable only with the reserve short, and `flush()` is the
            // only thing that shortens it. The mock swallows the swap; the burn
            // wallet's notification is the fill signal that clears `inFlightFlush`
            // (GAUNTLET B2.1), without which the staking arms fail closed (230).
            const target = (await stakingRatchet.getStaking()).reserveTarget;
            await stakingRatchet.sendFlush(keeper.getSender(), { value: FLUSH_VALUE, amount: target / 2n });
            await treasuryWallet.send({
                to: stakingRatchet.address,
                value: toNano('0.1'),
                body: beginCell()
                    .storeUint(0x7362d09c, 32)
                    .storeUint(0, 64)
                    .storeCoins(await stakingRatchet.getLastMinOut())
                    .storeAddress(dedust.address) // the venue's PRIMES jetton vault
                    .storeUint(0, 1)
                    .endCell(),
            });
            snapshot['ratchet.unstake'] = gasAt(
                await stakingRatchet.sendUnstake(keeper.getSender(), { value: UNSTAKE_VALUE }),
                stakingRatchet.address
            );

            // Audit H2 — a NON-OPTIMISTIC fill: the bill pays as a jetton transfer from the
            // payout collection with only 0.01 TON forwarded (`nft-collection.func:19`), so
            // the ratchet's tsTON handler (`creditStakeArrival` against the open stake) must
            // run inside ~25k gas or the tsTON lands uncounted.
            const billCollection = await blockchain.treasury('billCollection');
            await poolMock.sendSetOptimistic(keeper.getSender(), {
                optimistic: false,
                collection: billCollection.address,
                value: toNano('0.05'),
            });
            await inject(toNano('1000'));
            await stakingRatchet.sendStake(keeper.getSender(), { value: STAKE_VALUE });
            expect((await stakingRatchet.getStakingGates()).inFlightStake).toBeGreaterThan(0n);
            const billPays = await poolMock.sendSettleDepositBill(keeper.getSender(), { value: toNano('0.05') });
            expect(billPays.transactions).not.toHaveTransaction({ aborted: true });
            expect((await stakingRatchet.getStakingGates()).stakeCredited).toBeGreaterThan(0n);
            snapshot['ratchet.tston_notification'] = gasAt(billPays, stakingRatchet.address);
        }

        // ---------------- report + baseline diff ----------------
        const rows = Object.entries(snapshot)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([k, v]) => ({ entrypoint: k, gasUsed: v }));
         
        console.table(rows);
         
        console.table(mintCostReport);

        // Every snapshot must be a real measurement, not a silent zero.
        for (const [k, v] of Object.entries(snapshot)) {
            expect({ k, v }).toEqual({ k, v: expect.any(Number) });
            if (v === 0) throw new Error(`gas snapshot '${k}' measured 0 — the entrypoint was not exercised`);
        }

        if (process.env.GAS_BASELINE_UPDATE === '1' || !fs.existsSync(BASELINE_PATH)) {
            fs.writeFileSync(BASELINE_PATH, JSON.stringify(snapshot, null, 2) + '\n');
             
            console.log(`[gas] baseline written to ${BASELINE_PATH}`);
        } else {
            const baseline: Snapshot = JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8'));
            const regressions: string[] = [];
            for (const [k, v] of Object.entries(snapshot)) {
                const base = baseline[k];
                if (base === undefined) continue; // new entrypoint: not a regression
                if (v > base * (1 + TOLERANCE)) {
                    regressions.push(`${k}: ${base} -> ${v} (+${(((v - base) / base) * 100).toFixed(1)}%)`);
                }
            }
            expect(regressions).toEqual([]);
        }

        // ---- the gas & ops reconciliation: every row inside the sim-derived line (D-117) ----
        for (const row of mintCostReport) {
            expect({ label: row.label, withinLine: row.withinLine }).toEqual({ label: row.label, withinLine: true });
        }
    }, 300_000);
});
