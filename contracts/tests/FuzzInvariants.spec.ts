// TON PRIMES — fuzz corpus + property/invariant harness over generated
// operation sequences (docs/phase3-report.md §9.6 items 5 and 6).
//
// Two halves:
//
//   FUZZ  — malformed/truncated/wrong-opcode bodies fired at every contract,
//           adversarial factorizations, and bounce-storm interleavings on the
//           flush / claim / lot-close paths. The bar is not "these must
//           succeed" but "these must fail cleanly and leave no state damage":
//           after every fuzz case the harness re-checks the full invariant set.
//
//   INVARIANTS — a seeded, deterministic generator runs randomized operation
//           sequences (mint prime / mint composite / reserve / cancel / settle /
//           flush / claim / transfer / sync_head / hostile no-op) and asserts,
//           after EVERY step, the ten invariants listed below. The seed is
//           fixed so failures are reproducible; override with FUZZ_SEED.
//
// The ten invariants:
//   I1  floor ratchet: p_f = T/S never decreases, and strictly increases on a mint
//   I2  pool accounting (D-26, §5): the THREE-term backing identity,
//       T == seedT + pending + swapped, as an exact equality — INCLUDING
//       ACROSS A `donate_floor`, which is new and is the point (D-100 point 1)
//   I3  owed conservation: every nanoGRAM of tribute credited is either still
//       owed on an item or has been paid out to that item's owner
//   I4  head monotonicity: head only ever advances, by exactly 1, and only via a
//       successful mint or settlement
//   I5  no admin withdraw path: no privileged sender (genesis script, timelock,
//       proposer, book, vault, deployer) can move GRAM out of the ledger
//   I6  reservation exclusivity: a reserved n is never mintable through the
//       normal reveal path, and an unreserved n is never settleable
//   I7  jetton authority: post-seal, mint_genesis is dead and only the ledger mints
//   I8  pool conservation (C8): the ratchet answers `balance vs its own
//       DECLARED liability` in one get-call and is solvent (D-90 deleted the
//       escrow shards, the third pool this once covered)
//   I11 supply cap (D-156): S never exceeds S_MAX, on any path
//   I10 declared-liability reconciliation (B-1): the ledger's O(1) `tributeOwed`
//       meter equals `Σ_p item.owed` walked over every prime that was ever
//       credited. This is the one that proves the meter honest rather than
//       merely self-consistent — §3.2's tribute is credited to items as a
//       NUMBER while the GRAM stays on the ledger, so a missed decrement is
//       invisible everywhere else and hands player money to `sweep_ops`.
//   I9  monotone state vector: NO observable in the declared monotone set ever
//       decreases, under ANY message sequence — see below
//
// I9, and why it is not just I1 and I4 restated
// ---------------------------------------------
// I1 and I4 each assert monotonicity of ONE observable. That is the weaker
// statement. The protocol's actual claim is a structural one, and it is the
// classical "ratchet" of automata theory rather than of finance: the reachable
// state space is a partial order and the transition relation is monotone —
// state A may go to state B only if B >= A componentwise, so the transition
// matrix over the observable vector is upper-triangular and no reverse edge
// exists at all.
//
// That framing is what makes I9 catch a class the per-component asserts cannot:
// a bug that rolls back a *different* component (div_acc unwound by a bounced
// dividend claim, primesCount decremented on a partially-applied mint, a rank
// reset when the registrar re-links, swapped reduced by a failed DeDust round
// trip) is invisible to I1/I4 and fatal to the same claim. It is checked after
// EVERY step of EVERY test in this file, including the malformed-message corpus
// and the bounce storms, because the only interesting counterexample is one
// produced by a message that FAILED.
//
// The monotone set (all read through public get-methods, CONCEPT.md §9.1):
//
//   ledger.getFloorNum()          T, total GRAM ever committed to the pool (§5)
//   ledger.getFloorDen()          S, cumulative emission + bounty vault (§3.3, §5)
//   T/S                           the floor itself, cross-multiplied (== I1)
//   ledger.getHead()              the head (== I4)
//   ledger.getPrimesCount()       π(n), the flat dividend's divisor (§3.2)
//   ledger.getDivAcc()            the flat prime-dividend accumulator (§3.2)
//   ledger.getDivEntry(p)         per-prime claim stamp; only ever restamped up
//   ledger.getLastMintTime()      last settled mint, unix seconds
//   ratchet.getSwapped()          GRAM irreversibly swapped into the pool (§5)
//   ratchet.getLastFlushTs()      last flush, unix seconds
//   ledger.getMinterState(a)[0]   prime rank, lifetime, per owner (§4.7.1)
//   ledger.getRecruitRank(a)      lifetime recruits (SS4.7, D-106) -- LIVE now:
//                                 the recruit edge writes it on a gift mint to
//                                 an address minterState has never seen, and
//                                 nothing ever decrements it.
//
// Deliberately NOT in the set, and asserting them would be wrong:
//   ratchet.getPending()          drops at every flush — that is the mechanism
//   ratchet.getInFlightFlush()    round-trips to zero
//   item.getOwed()                drops at claim (I3 covers it as owed + paid)
//   getClaimableDividend(p)       drops at claim, by construction
//   getOpsSweep().sweepable       drops at sweep (§4.1)
//   getKMax(n) / getK(n,t)        k_max(n) DECLINES in n by design (§5)
//   shard balances                refunded on cancel (I8 covers them)
import { Blockchain, SandboxContract, TreasuryContract } from '@ton/sandbox';
import { Address, beginCell, Cell, toNano } from '@ton/core';
import '@ton/test-utils';
import { compile } from '@ton/blueprint';
import { PrimesRatchet, FLUSH_VALUE, STAKE_VALUE, UNSTAKE_VALUE } from '../wrappers/PrimesRatchet';
import { MockTonstakersPool } from '../wrappers/MockTonstakersPool';
import { internal as sandboxInternal } from '@ton/sandbox';
import { buildCloseLotMessage } from '../../shared/messages';
import { firstHop, outTo } from './helpers/inFlight';
import { PrimesRegistrar } from '../wrappers/PrimesRegistrar';
import { PrimesLedger, FactorEntry, isqrt } from '../wrappers/PrimesLedger';
import { PrimesCollection } from '../wrappers/PrimesCollection';
import * as fs from 'fs';
import * as path from 'path';

// D-156's cap, read from `shared/params.json` rather than retyped here. Rule 3:
// the params file is the authority, so a test that hardcoded 1.2e18 could agree
// with itself while disagreeing with the parameter it exists to guard.
const S_MAX: bigint = BigInt(
    JSON.parse(
        fs.readFileSync(path.join(__dirname, '..', '..', 'shared', 'params.json'), 'utf-8'),
    ).rebate.S_MAX_nanoprimes,
);
const STAKE_MIN_TON: number = JSON.parse(
    fs.readFileSync(path.join(__dirname, '..', '..', 'shared', 'params.json'), 'utf-8'),
).staked_reserve.stake_min_ton;
import { PrimesJettonMaster } from '../wrappers/PrimesJettonMaster';
import { PrimesItem } from '../wrappers/PrimesItem';
import { PrimesVenueTimelock } from '../wrappers/PrimesVenueTimelock';
import { PrimesMarket } from '../wrappers/PrimesMarket';
import { testMarketConfig, RESERVABLE_12, acquirePrime, OPENING_HEAD } from './helpers/market';
// D-100's three contracts, for the TR-1..TR-7 harness at the bottom of the file.
import {
    PrimesTreasury,
    TreasuryOpcodes,
    TreasuryAsset,
    TREASURY_TIERS,
    depositPayload,
} from '../wrappers/PrimesTreasury';
import { FOREVER_VOTE_MULTIPLIER } from '../../shared/opcodes';
import { PrimesLpPosition } from '../wrappers/PrimesLpPosition';
import { PrimesLpSink } from '../wrappers/PrimesLpSink';
// D-168's pair, for the ST-1/ST-2 harness at the very bottom of the file.
import { PrimesStake, stakePayload } from '../wrappers/PrimesStake';
import { PrimesStakePosition } from '../wrappers/PrimesStakePosition';
import { PrimesJettonWallet } from '../wrappers/PrimesJettonWallet';
import params from '../../shared/params.json';

const MINT_PRICE = toNano('1');
const SEED = Number(process.env.FUZZ_SEED ?? 20260814);
const STEPS = Number(process.env.FUZZ_STEPS ?? 60);
/**
 * The generated sequence runs once per seed. FUZZ_SEED pins it to one (the
 * reproduction knob); otherwise the fixed default plus two more, so a branch the
 * default seed happens never to roll is still walked.
 */
const SEEDS: number[] = process.env.FUZZ_SEED ? [SEED] : [SEED, 1337, 0x5eed5];

// deterministic xorshift PRNG so any failure is reproducible from the seed
function makeRng(seed: number) {
    let x = seed >>> 0 || 1;
    return () => {
        x ^= x << 13;
        x >>>= 0;
        x ^= x >> 17;
        x ^= x << 5;
        x >>>= 0;
        return x / 0x100000000;
    };
}

function factorize(n: number): FactorEntry[] {
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
}

/** §7: the era boundaries — `open_lot` refuses them (1008, mkt_primorial_not_auctionable). */
const PRIMORIALS = new Set([2, 6, 30, 210, 2310, 30030, 510510]);

function isPrimeJs(n: number) {
    if (n < 2) return false;
    for (let i = 2; i * i <= n; i++) if (n % i === 0) return false;
    return true;
}

describe('TON PRIMES — fuzz corpus + invariant harness', () => {
    let blockchain: Blockchain;
    let deployer: SandboxContract<TreasuryContract>;
    let genesisScript: SandboxContract<TreasuryContract>;
    let treasuryWallet: SandboxContract<TreasuryContract>;
    let proposer: SandboxContract<TreasuryContract>;
    let dedust: SandboxContract<TreasuryContract>;
    let bountyVault: SandboxContract<TreasuryContract>;
    let players: SandboxContract<TreasuryContract>[];
    let attacker: SandboxContract<TreasuryContract>;

    let codes: Record<string, Cell>;
    let collection: SandboxContract<PrimesCollection>;
    let master: SandboxContract<PrimesJettonMaster>;
    let ledger: SandboxContract<PrimesLedger>;
    let ratchet: SandboxContract<PrimesRatchet>;
    let registrar: SandboxContract<PrimesRegistrar>;
    let timelock: SandboxContract<PrimesVenueTimelock>;
    let book: SandboxContract<PrimesMarket>;
    /** §4.3.2's Tonstakers pool (the mock), so the ratchet's stake / exit legs run inside the walk. */
    let pool: SandboxContract<MockTonstakersPool>;

    // harness-side expected ledgers, used by I1/I3/I4
    let lastFloor: { T: bigint; S: bigint };
    /**
     * D-52 (I11): the post-genesis baseline for the emission identity. Genesis
     * writes `S` as a figure (`genesis_seed`'s `seedS`) while the jetton
     * master's `totalSupply` is the sum of the mints that actually ran, so the
     * two are not equal in absolute terms — the identity is over what happens
     * AFTERWARDS, and this is the zero it is measured from.
     */
    let emissionBase: { S: bigint; supply: bigint };
    let lastHead: bigint;
    let creditedPerPrime: Map<string, bigint>;
    let paidOutPerPrime: Map<string, bigint>;
    let liveReservations: Set<string>;
    /** D-20: primes already bought off the Dutch lane — a lot only ever sells once. */
    let boughtPrimes: Set<number>;
    // I9 — the previous reading of the monotone state vector
    let lastVector: Map<string, bigint>;

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
            pool: await compile('MockTonstakersPool'),
        };
    });

    beforeEach(async () => {
        blockchain = await Blockchain.create();
        blockchain.now = 1_770_000_000;
        deployer = await blockchain.treasury('deployer');
        genesisScript = await blockchain.treasury('genesisScript');
        treasuryWallet = await blockchain.treasury('treasury');
        proposer = await blockchain.treasury('proposer');
        dedust = await blockchain.treasury('dedust');
        bountyVault = await blockchain.treasury('bountyVault');
        attacker = await blockchain.treasury('attacker', { balance: toNano('500') });
        players = [];
        for (const n of ['p0', 'p1', 'p2']) players.push(await blockchain.treasury(n, { balance: toNano('100000') }));

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

        // 1 tsTON = 1 GRAM; a free-GRAM buffer deep enough that every exit fills on leg 1.
        pool = blockchain.openContract(
            MockTonstakersPool.createFromConfig({ rateNum: toNano('1'), rateDen: toNano('1'), freeTon: toNano('100000') }, codes.pool)
        );
        await pool.sendDeploy(deployer.getSender(), toNano('2000'));

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
                    // §4.3.2: the staked reserve, on the mock. The divided minimum
                    // (D-153; 50 / 100 = 0.5 GRAM) lets the walk stake without a
                    // 62.5 GRAM donation per cycle.
                    tonstakersPool: pool.address,
                    dedustTstonVault: pool.address,
                    dedustTstonPool: deployer.address,
                    treasuryAddr: treasuryWallet.address,
                    stakeDivisor: 100,
                },
                codes.ratchet
            )
        );
        await ratchet.sendDeploy(deployer.getSender(), toNano('10'));
        await ratchet.sendSetTstonWallet(genesisScript.getSender(), { tstonWalletAddr: pool.address, value: toNano('0.05') });
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

        await collection.sendSetLedger(genesisScript.getSender(), { ledgerAddr: ledger.address, value: toNano('0.05') });
        await master.sendSetLedger(genesisScript.getSender(), { ledgerAddr: ledger.address, value: toNano('0.05') });
        await timelock.sendSetRatchet(genesisScript.getSender(), { ratchetAddr: ratchet.address, value: toNano('0.05') });
        await master.sendSealAuthority(genesisScript.getSender(), { value: toNano('0.05') });
        await ledger.sendGenesisSeed(genesisScript.getSender(), {
            seedT: toNano('1000'),
            seedS: 1_200_000_000_000_000n,
            // D-20: the head opens at the first COMPOSITE; the walk marks 2 and 3.
            seedHead: OPENING_HEAD,
            value: toNano('0.05'),
        });
        await ledger.sendSetPeers(genesisScript.getSender(), {
            marketAddr: book.address,
            bountyVaultAddr: bountyVault.address,
            value: toNano('0.05'),
        });
        // CONCEPT §6 point 0: nothing mints until Unity does. `ignite` mints #1 to the
        // founder and flips the ledger's launch flag; every fixture that mints has to
        // pass through it, exactly as a real deployment does.
        await ledger.sendIgnite(genesisScript.getSender(), { owner: deployer.address, value: toNano('0.3') });

        lastFloor = { T: await ledger.getFloorNum(), S: await ledger.getFloorDen() };
        emissionBase = {
            S: await ledger.getFloorDen(),
            supply: (await master.getJettonData()).totalSupply,
        };
        lastHead = await ledger.getHead();
        creditedPerPrime = new Map();
        paidOutPerPrime = new Map();
        liveReservations = new Set();
        boughtPrimes = new Set();
        lastVector = await readStateVector();
    });

    // ---------------------------------------------------------------- I9 vector

    /**
     * One reading of the monotone state vector (see the header block for the set
     * and for what is deliberately excluded).
     *
     * Keys are stable strings so a failure names the component that regressed
     * rather than an index. Per-owner and per-prime components are read only for
     * the keys the harness already knows about; a component that appears for the
     * first time in this reading has no predecessor and is simply recorded — a
     * counter cannot "decrease" on the step that creates it.
     */
    async function readStateVector(): Promise<Map<string, bigint>> {
        const v = new Map<string, bigint>();
        v.set('ledger.T', await ledger.getFloorNum());
        v.set('ledger.S', await ledger.getFloorDen());
        v.set('ledger.head', await ledger.getHead());
        v.set('ledger.primesCount', BigInt(await ledger.getPrimesCount()));
        v.set('ledger.divAcc', await ledger.getDivAcc());
        v.set('ledger.lastMintTime', await ledger.getLastMintTime());
        v.set('ratchet.swapped', await ratchet.getSwapped());
        v.set('ratchet.lastFlushTs', await ratchet.getLastFlushTs());
        // per-owner rank ladders (§4.7, §4.7.1) — lifetime counters, never reset.
        // The attacker is included on purpose: a rank that a hostile no-op can
        // move at all is the bug, in either direction.
        const owners: [string, Address][] = [
            ...players.map((p, i) => [`p${i}`, p.address] as [string, Address]),
            ['attacker', attacker.address],
        ];
        for (const [name, addr] of owners) {
            v.set(`ledger.primeRank[${name}]`, BigInt((await ledger.getMinterState(addr)).primesMinted));
            v.set(`ledger.recruitRank[${name}]`, BigInt((await ledger.getRecruitRank(addr)).recruits));
        }
        // per-prime dividend stamp: `entry[p]` is restamped to `div_acc` at claim,
        // and `div_acc` is itself monotone, so `entry[p]` can only ever rise.
        for (const p of creditedPerPrime.keys()) {
            v.set(`ledger.divEntry[${p}]`, await ledger.getDivEntry(BigInt(p)));
        }
        return v;
    }

    /**
     * I9. Asserts the transition just taken was monotone on every component, i.e.
     * that the transition relation over the observable vector really is
     * upper-triangular. Reports EVERY regressed component at once rather than
     * failing on the first, because a single bad transition usually rolls back a
     * correlated group and seeing the whole group is what identifies it.
     */
    function assertMonotone(label: string, prev: Map<string, bigint>, next: Map<string, bigint>) {
        const regressions: { component: string; from: string; to: string }[] = [];
        for (const [key, now] of next) {
            const before = prev.get(key);
            if (before === undefined) continue; // component created this step
            if (now < before) regressions.push({ component: key, from: before.toString(), to: now.toString() });
        }
        // A component may never DISAPPEAR either: a get-method that stops
        // answering is a regression to "unknown", not a monotone step.
        for (const key of prev.keys()) {
            if (!next.has(key)) regressions.push({ component: key, from: prev.get(key)!.toString(), to: 'absent' });
        }
        expect({ label, i9: regressions }).toEqual({ label, i9: [] });
    }

    // ---------------------------------------------------------------- invariants
    async function checkInvariants(label: string) {
        const T = await ledger.getFloorNum();
        const S = await ledger.getFloorDen();
        const head = await ledger.getHead();
        const pending = await ratchet.getPending();

        // I1 — floor never decreases (cross-multiplied, no fractions)
        expect({ label, i1: T * lastFloor.S >= lastFloor.T * S }).toEqual({ label, i1: true });

        // I11 — D-156: `S` is bounded above by `S_MAX`, and still monotonic.
        //
        //      Checked after EVERY step rather than after mints, deliberately:
        //      the ledger has three `storage.S +=` sites and only one of them is
        //      the mint. A cap that the permissionless `donate_floor` path could
        //      step past would not be a cap, and asserting this here is what
        //      catches a fourth emission site added later without a taper.
        expect({ label, i11: S <= S_MAX && S >= lastFloor.S }).toEqual({ label, i11: true });

        // I2 — D-26 (§5): `T == seedT + pending + swapped`, EXACTLY.
        //
        //      This used to be the bound `T >= pending + swapped`, which is the
        //      two-term reading D-26 was filed against: it is satisfied by any
        //      upward drift in `T` whatsoever, so it could not fail. The residual
        //      it left unexplained is not in-flight flush value — it is the
        //      founder seed, and it is a get-method (`getSeedT`) precisely so the
        //      identity closes from chain state alone.
        //
        //      `inFlightFlush` is deliberately NOT a fourth term. `handleFlush`
        //      credits `swapped` at SEND time in the same step it debits
        //      `pending` (primes_ratchet.tolk §handleFlush), and the bounce path
        //      reverses both, so `pending + swapped` is conserved across a flush
        //      and the in-flight amount is already counted inside `swapped`.
        //      Adding it would double-count.
        //
        //      Every writer of `storage.T` on the ledger — the mint's
        //      `poolInjectionFinal + premium`, the tribute-divisor rounding
        //      remainder, the flat-dividend remainder, and the market's auction
        //      clearing — mirrors the same nanoGRAM into `poolToRatchet`, so an
        //      equality is the honest assertion here and a bound is not. Since
        //      `DECISIONS.md` D-114 (amends D-7), a clearing's `T` write and its
        //      `poolToRatchet` mirror are both only the RATCHET'S HALF of the
        //      premium — the treasury half never touches `T` at all — but the
        //      two still move together, so the identity is unaffected.
        //
        //      D-100 POINT 1 IS WHY THIS NOW MEANS SOMETHING ON A DONATION, and
        //      it is the one thing this harness could not prove before. Under
        //      D-91 `handleDonateFloor` did BOTH halves of two contradictory
        //      sentences: it credited `seedT += X` *and* forwarded the same `X`
        //      to the ratchet, where `PoolInject` did `pending += X`. So `T`
        //      rose by X while `seedT + pending + swapped` rose by 2X, and the
        //      identity was broken by exactly the donated amount, every time.
        //      Nothing in this file ever called `donate_floor`, so the equality
        //      above held vacuously over the donation path while the live
        //      testnet ratchet panel reported `beyond T 4.000 GRAM` and was
        //      right. D-100 deletes the `seedT` credit; the sequence below and
        //      the dedicated test after it now DONATE, so this line is the
        //      contract-level proof of the fix rather than a restatement of it.
        //      (MISTAKES.md, 2026-09-04.)
        //      §4.3.2 / D-151 GROWS IT TO FIVE TERMS, and the discipline is
        //      exactly the one the `inFlightFlush` paragraph above states. The
        //      ratchet's `pending` is now only its LIQUID GRAM — the whole
        //      obligation is `pending + stakedCost + exiting` — because
        //      `getSolvency().liability` must keep equalling `pending` exactly
        //      (DecompositionSolvency.spec.ts:336-338) and `balance >=
        //      liability` must stay true while the staked GRAM is physically
        //      somewhere else. `stake()` moves `pending -> stakedCost` in one
        //      step, an exit moves `stakedCost -> exiting` at send and
        //      `exiting -> pending` on arrival, and every failure route reverses
        //      the pair it moved.
        //
        //      `realizedLoss` is the SIXTH term and the only one that is not a
        //      pot of GRAM: if GRAM ever leaves `T` for good, no message can lower
        //      `T` — the ledger owns it — so the shortfall is recorded here
        //      instead of vanishing, which is the same thing as saying `T` is
        //      overstated by exactly `realizedLoss` and that the number is
        //      published (`getStaking()`, §5, §8) rather than absorbed.
        //
        //      NO PATH THE CONTRACT CHOOSES CAN MAKE IT NON-ZERO. Leg 2's
        //      `min_out` is floored at the tranche's cost basis, so a book that
        //      will not pay cost is refused into leg 3; legs 1 and 3 name no
        //      price at all. The term is defence in depth against a future change
        //      to that bound, and the honest landing place for a slashing loss —
        //      §5's one external risk — not a live route.
        //
        //      THE D-91 VACUITY TRAP: in the corpus and storm tests nothing
        //      stakes, so the three terms are 0 there. The generated sequence
        //      below closes it for `stakedCost` and `exiting`: it stakes and
        //      exits (leg 1) on a fixed cadence between mints, flushes and
        //      claims, and asserts it did. All three exit legs, a forged
        //      `distributed_asset` and a harvest are `RatchetStaking.spec.ts`;
        //      this line is the guarantee that the rest of the protocol cannot
        //      move the terms behind its back.
        const swapped = await ratchet.getSwapped();
        const seeded = await ledger.getSeedT();
        const stk = await ratchet.getStaking();
        expect({ label, i2: T }).toEqual({
            label,
            i2: seeded + pending + swapped + stk.stakedCost + stk.exiting + stk.realizedLoss,
        });

        // I2b — the mirror `/ratchet/identity` and RatchetPanel rely on. Every credit
        //      to `T` except the genesis seed sends a `PoolInject` carrying the
        //      post-credit `T`, so at rest (the sandbox settles every hop) the
        //      ratchet's `tCache` IS `T`. Live, `T − tCache` is then exactly GRAM in
        //      flight, never a standing gap. A new `T +=` path without a forward
        //      fails here. Below `seeded`, no inject has followed the seed yet.
        const { t: tCache } = await ratchet.getFloorCache();
        if (tCache >= seeded) {
            expect({ label, i2b: tCache }).toEqual({ label, i2b: T });
        }

        // I4 — head only ever advances
        expect({ label, i4: head >= lastHead }).toEqual({ label, i4: true });

        // I3 — owed conservation, per prime. `credited` covers BOTH tribute
        //      lines: the divisor line recorded at mint by `recordTribute`, and
        //      the flat dividend recorded at claim by `claimDividendTracked`.
        //
        // I10 — the same walk, summed, against the ledger's O(1) meter. The set
        //      of keys is complete by construction: `owed` only ever moves
        //      through a credit, and every credit passes through `recordTribute`
        //      or `claimDividendTracked`, so a prime absent from this map has
        //      `owed == 0` and contributes nothing to either side.
        let owedTotal = 0n;
        for (const [p, credited] of creditedPerPrime) {
            const itemAddr = await ledger.getItemAddress(BigInt(p));
            const item = blockchain.openContract(PrimesItem.createFromAddress(itemAddr));
            const owed = await item.getOwed();
            const paid = paidOutPerPrime.get(p) ?? 0n;
            expect({ label, p, i3: owed + paid }).toEqual({ label, p, i3: credited });
            owedTotal += owed;
        }

        // I10 — B-1. `tributeOwed` is the GRAM this contract custodies on behalf
        //       of item `owed` balances, and it is maintained O(1) precisely so
        //       `getSolvency` stays one call — which means nothing on chain
        //       forces it to match reality. This is the check that does.
        //
        //       Equality is exact, not a bound, and it holds across the bounce
        //       path too: a credit that bounced is owed on NO item and is
        //       carried in `unroutedHeld` instead, so both sides drop together.
        const br = await ledger.getLiabilityBreakdown();
        expect({ label, i10: br.tributeOwed }).toEqual({ label, i10: owedTotal });

        // and the itemized breakdown always sums to the number `getSolvency`
        // publishes — otherwise a reader reconciling against I10 would be
        // reconciling against a different liability than the sweep measures.
        const sol = await ledger.getSolvency();
        expect({ label, i10sum: br.tributeOwed + br.unroutedHeld + br.divOutstanding + br.treasuryHeld + br.operatorHeld }).toEqual({
            label,
            i10sum: sol.liability,
        });
        // the ledger can always cover what it declares — the property §3.4 says
        // the decomposition exists to produce, asserted on every fuzz step.
        expect({ label, i10solvent: sol.delta >= 0n }).toEqual({ label, i10solvent: true });

        // ---- C8: the OTHER TWO of §3.4's three pools, on the same footing ----
        //
        // §3.4's property is `balance ~= its own declared liability, in ONE
        // get-call`, per pool — `pending` (the ratchet, nobody's), `owed` (the
        // ledger, the prime owners'), escrow (the shards, refundable). The
        // ledger's half was asserted on every step above; the other two were
        // asserted once each, at a single state, in DecompositionSolvency's B1.
        // A property that only holds at one point of one workload is not the
        // property §3.4 claims, so both are read here on every step too — and
        // read from the SAME single get-call a dashboard would use, not
        // recomputed.
        const ratSol = await ratchet.getSolvency();
        // The delta is the get-method's own subtraction, not the caller's.
        expect({ label, c8RatDelta: ratSol.delta }).toEqual({
            label,
            c8RatDelta: ratSol.balance - ratSol.liability,
        });
        // The ratchet's declared liability IS `pending`, exactly — and
        // deliberately NOT `inFlightFlush`, which has physically left this
        // contract for the venue and either fills or is restored by the bounce
        // handler. Counting it would make the delta transiently negative for the
        // whole round trip. Pinned as an equality so that choice cannot drift.
        expect({ label, c8RatLiability: ratSol.liability }).toEqual({ label, c8RatLiability: pending });
        expect({ label, c8RatSolvent: ratSol.delta >= 0n }).toEqual({ label, c8RatSolvent: true });

        // D-90 DELETES THE PER-SHARD ESCROW CHECK that stood here. There is no
        // third pool: a won lot mints in its own close, so the money that used to
        // sit escrowed on a shard has already been split by §4.1 and is inside
        // the ledger's and the ratchet's declared liabilities, both checked
        // above. What replaces the check is the property that makes it
        // unnecessary — the market custodies nothing refundable — asserted once
        // against the market's own balance rather than per shard.

        // I6 — reserved numbers are never at the head as mintable
        for (const n of liveReservations) {
            expect({ label, n, i6: await ledger.isNumberOffHead(BigInt(n)) }).toEqual({ label, n, i6: 1 });
        }

        // I9 — the whole monotone vector, not just T/S and the head. Checked last
        // so that a failure here is reported against a state the narrower
        // invariants have already accepted: if I1..I8 pass and I9 fails, the
        // regression is in a component nothing else was watching, which is
        // exactly the class this invariant exists for.
        const vector = await readStateVector();
        assertMonotone(label, lastVector, vector);
        lastVector = vector;

        // I11 — D-52: every PRIMES `S` counts either reached a wallet or is
        // parked in the retry lane. Nothing evaporates, and nothing is invented.
        //
        //     ΔS − Δ(unmintedHeld) == Δ(master totalSupply)
        //
        // `S` is incremented BEFORE the `JettonMint` that pays it out, so
        // without this the two sides drift silently on any bounce — which is
        // exactly what R11 found and what `unmintedHeld` exists to name. As a
        // delta from the post-genesis baseline, because genesis writes `S` as a
        // figure rather than as the sum of mints (see `emissionBase`), and with
        // no burn term because this fixture deploys no sink: `S` is never
        // decremented by burns anyway (§3.3), so a sink would only add a term
        // to the right-hand side, never change the shape of the claim.
        const unminted = await ledger.getUnmintedHeld();
        const supply = (await master.getJettonData()).totalSupply;
        expect({
            label,
            i11: S - emissionBase.S - unminted === supply - emissionBase.supply,
        }).toEqual({ label, i11: true });

        lastFloor = { T, S };
        lastHead = head;
    }

    async function mint(who: SandboxContract<TreasuryContract>, n: bigint, kind: number, factors: FactorEntry[], referralKey = 0) {
        const r = await ledger.sendMint(who.getSender(), {
            n,
            kind,
            factors,
            referralKey,
            beneficiary: null,
            value: MINT_PRICE,
        });
        return r;
    }

    /**
     * D-100 point 1 — the permissionless floor donation, the flow whose
     * bookkeeping I2 could not check until D-100 gave it exactly one home.
     *
     * `T` rises by `amount`; the same `amount` is forwarded to the ratchet and
     * lands in `pending`; `seedT` is NOT touched. So the identity's left side
     * and right side move by the same X, which is the whole of the fix.
     *
     * CLAUDE.md's standing rule about on-chain value applies here as loudly as
     * anywhere: the message carries `amount` PLUS a margin, never the exact
     * figure, or the ledger cannot pay for the ratchet and jetton-mint hops it
     * has to make on the way out.
     */
    async function donate(who: SandboxContract<TreasuryContract>, amount: bigint) {
        return await ledger.sendDonateFloor(who.getSender(), {
            amount,
            value: amount + toNano('0.15'),
        });
    }

    /**
     * D-20 — buy a prime off the market's Dutch lane. There is no prime mint any
     * more, and the invariant harness cares because it is the ONLY way `owed`,
     * `primesCount` and the registrar's rank ever move for a prime; a suite that
     * kept sending `mint(p, 1, [])` would build no prime state at all and every
     * invariant below would hold vacuously.
     */
    async function buyPrime(who: SandboxContract<TreasuryContract>, p: bigint, referralKey = 0) {
        return (await acquirePrime({ blockchain, market: book, ledger }, who, p, { referralKey })).result;
    }

    /**
     * D-30 — win an ascending lot on composite `n`, which is the ONLY way to
     * hold a number ahead of the head now that the flat-fee `reserve` entry
     * point is deleted. Opening is a paid first bid at `P0(n)`; the 7-day clock
     * runs from it; the close writes the shard record and notifies the ledger.
     *
     * It MOVES the chain clock past the lot's `closesAt`, which the walk below
     * tolerates by construction: every invariant it checks is an inequality or
     * an identity over cumulative state, never a statement about elapsed time.
     */
    async function winClaim(who: SandboxContract<TreasuryContract>, n: bigint, factors: FactorEntry[]) {
        // PHASE 3 (PRICING_MODEL_PLAN.md §4): `open_lot` prices a composite off
        // the factorization it is sent, so the quote is asked the same way.
        // `getLotPrice(n)` is the lower bound for a caller without them.
        const p0 = (await book.getLotPriceFrom(n, factors)).p0;
        await book.sendOpenLot(who.getSender(), {
            n,
            kind: 0,
            factors,
            beneficiary: null,
            referralKey: 0,
            value: p0 + toNano('0.2'), // nominal PLUS the standing fee margin
        });
        const lot = await book.getLot(n);
        if (lot.closesAt > 0) blockchain.now = lot.closesAt + 1;
        return await book.sendClose(who.getSender(), { n, value: toNano('0.3') });
    }

    /**
     * `claim_dividend` for `p`, with I3's bookkeeping kept honest.
     *
     * §3.2 splits the tribute line 80/20: the divisor line credits `owed` at
     * mint time (that is what `recordTribute` mirrors), while the flat 20%
     * accrues to the global `div_acc` and only becomes a per-prime `owed`
     * balance when someone calls `claim_dividend`. So a dividend claim MOVES
     * value into `owed` that no mint ever recorded — and I3, which asserts
     * `owed + paid == credited` per prime, is wrong about that prime forever
     * afterwards unless the harness records the movement too.
     *
     * The credited amount is read off the chain rather than modelled: the
     * contract restamps `entry[p] = div_acc`, so `entry_after − entry_before` is
     * exactly what it credited, including on the cheap-fail paths where it
     * credits nothing and the delta is zero.
     */
    async function claimDividendTracked(who: SandboxContract<TreasuryContract>, p: bigint) {
        const key = p.toString();
        const entryBefore = await ledger.getDivEntry(p);
        const r = await ledger.sendClaimDividend(who.getSender(), { p, value: toNano('0.1') });
        const entryAfter = await ledger.getDivEntry(p);
        const credited = entryAfter - entryBefore;
        if (credited > 0n) creditedPerPrime.set(key, (creditedPerPrime.get(key) ?? 0n) + credited);
        return r;
    }

    /**
     * Reads `isPrimeUnsold` live rather than tracking a mirror set, and it is
     * safe to call on either side of the mint it mirrors: a mint only ever marks
     * primes ABOVE the old head, and every cited factor is strictly below it, so
     * a factor's sold/unsold status cannot change across its own mint. Only a
     * Dutch-lane purchase moves it, and that is a separate message.
     */
    async function recordTribute(n: number, factors: FactorEntry[]) {
        if (factors.length === 0) return;
        // §3.2: mirror of the contract's 80% divisor line, weighted e·⌊√p⌋
        // (the 20% flat line accrues to div_acc, not to `owed`, so it is not
        // part of I3's per-prime conservation).
        const sumWeights = factors.reduce((a, f) => a + BigInt(f.exponent) * isqrt(f.prime), 0n);
        for (const f of factors) {
            const share = (toNano('0.08') * BigInt(f.exponent) * isqrt(f.prime)) / sumWeights;
            // D-20 point 4 / CONCEPT §6 point 2: an UNSOLD prime's cited share is
            // forfeited to the treasury — it never reaches an item, because there
            // is no item, and it is never paid to whoever eventually buys the lot.
            // The denominator does NOT change: the forfeited share is removed from
            // the payout, not redistributed among the sold factors.
            if (await ledger.isPrimeUnsold(f.prime)) continue;
            const key = f.prime.toString();
            creditedPerPrime.set(key, (creditedPerPrime.get(key) ?? 0n) + share);
        }
    }

    // ---------------------------------------------------------------- fuzz half
    it('survives a corpus of malformed, truncated and wrong-opcode messages', async () => {
        const targets: { name: string; addr: Address }[] = [
            { name: 'ledger', addr: ledger.address },
            { name: 'collection', addr: collection.address },
            { name: 'jettonMaster', addr: master.address },
            { name: 'timelock', addr: timelock.address },
            { name: 'book', addr: book.address },
        ];
        const rng = makeRng(SEED);
        const bodies: Cell[] = [
            beginCell().endCell(), // empty
            beginCell().storeUint(0, 32).endCell(), // zero opcode, no query id
            beginCell().storeUint(0xffffffff, 32).storeUint(0, 64).endCell(),
            beginCell().storeUint(0xb0000002, 32).endCell(), // mint, truncated
            beginCell().storeUint(0xb0000002, 32).storeUint(0, 64).storeUint(1, 8).endCell(), // mint, garbage tail
            beginCell().storeUint(0xe0000001, 32).storeUint(0, 64).endCell(), // reserve, truncated
            beginCell().storeUint(0xa0000001, 32).storeUint(0, 64).storeUint(7, 3).endCell(), // queue, junk
            beginCell().storeUint(0xb0000020, 32).storeUint(0, 64).storeUint(2, 256).endCell(), // mint_won_lot forged, truncated
            beginCell().storeUint(0xb0000021, 32).storeUint(0, 64).storeUint(5, 256).endCell(), // mark_off_head forged by a stranger
            beginCell().storeUint(0xb0000040, 32).storeUint(0, 64).storeCoins(toNano('1')).storeCoins(1n).storeUint(9n, 256).endCell(), // re-seed attempt
        ];
        for (let i = 0; i < 12; i++) {
            const b = beginCell();
            const words = 1 + Math.floor(rng() * 6);
            for (let w = 0; w < words; w++) b.storeUint(Math.floor(rng() * 0xffffffff), 32);
            bodies.push(b.endCell());
        }

        const bankBalanceBefore = (await blockchain.getContract(ledger.address)).balance;
        for (const t of targets) {
            for (const body of bodies) {
                const r = await attacker.send({ to: t.addr, value: toNano('0.05'), body, bounce: true });
                // The only requirement: nothing may succeed that mutates protocol
                // state in the attacker's favour. Cheap-fail or throw are both fine.
                for (const tx of r.transactions) {
                    const desc: any = tx.description;
                    if (desc?.computePhase?.exitCode === undefined) continue;
                }
            }
        }
        // no state damage anywhere
        await checkInvariants('fuzz:malformed');
        expect(await ledger.getHead()).toBe(OPENING_HEAD);
        expect((await ledger.getPeers()).peersSet).toBe(1);
        expect((await master.getJettonData()).genesisSealed).toBe(1);
        // the attacker cannot have drained the ledger (I5): its balance only ever
        // grew, by the gas it burned on their messages
        const bankBalanceAfter = (await blockchain.getContract(ledger.address)).balance;
        expect(bankBalanceAfter).toBeGreaterThan(bankBalanceBefore - toNano('1'));
    }, 300_000);

    it('rejects every adversarial factorization and primality claim', async () => {
        await buyPrime(players[0], 2n);
        await buyPrime(players[0], 3n);
        expect(await ledger.getHead()).toBe(4n);

        // `exit` is the ledger's named refusal: 201 ledger_bad_factorization, 202
        // ledger_bad_primality_claim (the head mint runs Miller-Rabin itself).
        const cases: { label: string; n: bigint; kind: number; factors: FactorEntry[]; exit?: number }[] = [
            { label: 'wrong product', n: 4n, kind: 0, factors: [{ prime: 3n, exponent: 1 }], exit: 201 },
            { label: 'non-prime factor', n: 4n, kind: 0, factors: [{ prime: 4n, exponent: 1 }], exit: 201 },
            { label: 'zero exponent', n: 4n, kind: 0, factors: [{ prime: 2n, exponent: 0 }], exit: 201 },
            { label: 'empty factor list', n: 4n, kind: 0, factors: [], exit: 201 },
            { label: 'unminted prime factor', n: 4n, kind: 0, factors: [{ prime: 101n, exponent: 1 }], exit: 201 },
            { label: 'composite claimed prime', n: 4n, kind: 1, factors: [], exit: 202 },
            { label: 'huge factor', n: 4n, kind: 0, factors: [{ prime: (1n << 200n) + 1n, exponent: 1 }], exit: 201 },
            { label: 'huge exponent', n: 4n, kind: 0, factors: [{ prime: 2n, exponent: 255 }], exit: 201 },
            // deliberately LAST: 2^1 * 2^1 == 4 is an arithmetically valid but
            // non-canonical factorization, and is accepted (see below), which
            // advances the head and would invalidate the n = 4 cases after it.
            { label: 'duplicated factor entries', n: 4n, kind: 0, factors: [{ prime: 2n, exponent: 1 }, { prime: 2n, exponent: 1 }] },
        ];
        for (const c of cases) {
            const before = await ledger.getHead();
            const r = await mint(players[1], c.n, c.kind, c.factors);
            const after = await ledger.getHead();
            if (c.label === 'duplicated factor entries') {
                // 2^1 * 2^1 == 4 is an arithmetically VALID factorization of 4
                // expressed non-canonically; it must either be rejected or, if
                // accepted, split the tribute line across the same prime twice
                // without exceeding it. Assert only that the head advanced to the
                // NEXT COMPOSITE and the invariants hold — D-20 makes the step
                // size pi-dependent rather than 1 (minting 4 walks past 5), so a
                // fixed bound would be asserting the wrong thing.
                expect(after).toBeGreaterThanOrEqual(before);
                if (after > before) {
                    expect(after).toBe(6n); // 4 minted, 5 walked past, head rests on 6
                }
                if (after > before) await recordTribute(4, c.factors);
            } else {
                expect({ label: c.label, head: after }).toEqual({ label: c.label, head: before });
                expect(r.transactions).toHaveTransaction({ to: ledger.address, success: false, ...(c.exit ? { exitCode: c.exit } : {}) });
            }
            await checkInvariants(`fuzz:${c.label}`);
        }
    }, 300_000);

    // A cited factor above n used to reach Miller-Rabin before `product == n`
    // and overflow its 257-bit mulmod (TVM exit 4); `p < n` now runs first.
    it('a cited factor above n is refused by name (201), not by a TVM overflow', async () => {
        await buyPrime(players[0], 2n);
        await buyPrime(players[0], 3n);
        const r = await mint(players[1], 4n, 0, [{ prime: (1n << 200n) + 1n, exponent: 1 }]);
        expect(r.transactions).toHaveTransaction({ to: ledger.address, success: false, exitCode: 201 });
    });

    it('survives a bounce storm on the flush, claim and lot-close paths', async () => {
        await buyPrime(players[0], 2n);
        await buyPrime(players[0], 3n);
        await mint(players[1], 4n, 0, [{ prime: 2n, exponent: 2 }]);
        await recordTribute(4, [{ prime: 2n, exponent: 2 }]);
        await checkInvariants('bouncestorm:setup');

        // flush storm: repeated calls inside the cooldown must all fail cleanly
        await ratchet.sendFlush(players[0].getSender(), { value: FLUSH_VALUE });
        for (let i = 0; i < 5; i++) {
            const r = await ratchet.sendFlush(attacker.getSender(), { value: FLUSH_VALUE });
            expect(r.transactions).toHaveTransaction({ to: ratchet.address, success: false, exitCode: 207 });
        }
        await checkInvariants('bouncestorm:flush');

        // claim storm: repeat claims after the balance is zeroed
        const item2Addr = await ledger.getItemAddress(2n);
        const item2 = blockchain.openContract(PrimesItem.createFromAddress(item2Addr));
        const owed = await item2.getOwed();
        await item2.sendClaimTribute(players[0].getSender(), { value: toNano('0.05') });
        paidOutPerPrime.set('2', (paidOutPerPrime.get('2') ?? 0n) + owed);
        for (let i = 0; i < 3; i++) {
            await item2.sendClaimTribute(players[0].getSender(), { value: toNano('0.05') });
        }
        expect(await item2.getOwed()).toBe(0n);
        // a non-owner claim must never pay out
        const rogue = await item2.sendClaimTribute(attacker.getSender(), { value: toNano('0.05') });
        expect(rogue.transactions).toHaveTransaction({ to: item2Addr, success: false, exitCode: 300 });
        await checkInvariants('bouncestorm:claim');

        // LOT-CLOSE STORM, D-90 SHAPE. There is no claim to settle later any
        // more: winning the lot MINTS, in the close transaction. So what the
        // storm has to prove is that repeated attempts to close an
        // already-closed lot are refused cleanly — never a second mint, never a
        // second payout — and that the market keeps none of the money.
        //
        // (Pre-D-90 this stormed `settle(n)` against a shard record. D-45 had
        // already made the first settle succeed outright, so the "not yet
        // reachable, bounces and re-opens" state it was written for was gone;
        // D-90 removes the record itself.)
        const claimResult = await winClaim(players[2], RESERVABLE_12.n, RESERVABLE_12.factors);
        expect(claimResult.transactions).toHaveTransaction({ to: ledger.address, success: true });
        // I3's tracking must see this credit too — the close runs the ordinary
        // tribute split just like any other mint.
        await recordTribute(Number(RESERVABLE_12.n), RESERVABLE_12.factors);

        const marketBalBefore = (await blockchain.getContract(book.address)).balance;
        for (let i = 0; i < 4; i++) {
            const repeat = await book.sendClose(attacker.getSender(), {
                n: RESERVABLE_12.n,
                value: toNano('0.25'),
            });
            // Refused on the MARKET — the lot is already closed, and a closed
            // record is the tombstone that keeps the number from being minted or
            // auctioned a second time.
            expect(repeat.transactions).toHaveTransaction({ to: book.address, success: false });
        }
        // Nothing accumulated: the storm's gas is the only thing that moved, and
        // never anything close to a second MINT_PRICE.
        expect((await blockchain.getContract(book.address)).balance - marketBalBefore)
            .toBeLessThan(MINT_PRICE);

        // and re-opening a lot on a number already minted off-head is refused —
        // there is no path on either contract that takes a minted number back.
        // D-196: the ledger's claim is the tombstone — the reopen is unwound by
        // `mark_rejected` and refunded less REJECT_GAS.
        const balBefore = await players[2].getBalance();
        const { p0 } = await book.getLotPriceFrom(RESERVABLE_12.n, RESERVABLE_12.factors);
        const reopen = await book.sendOpenLot(players[2].getSender(), {
            n: RESERVABLE_12.n,
            kind: 0,
            factors: RESERVABLE_12.factors,
            beneficiary: null,
            referralKey: 0,
            value: p0 + toNano('0.1'),
        });
        expect(reopen.transactions).not.toHaveTransaction({ aborted: true });
        expect(reopen.transactions).toHaveTransaction({ from: ledger.address, to: book.address, success: true });
        expect((await book.getLot(RESERVABLE_12.n)).found).toBe(false);
        // Refused cleanly: at most gas and REJECT_GAS were spent.
        expect(balBefore - (await players[2].getBalance())).toBeLessThan(toNano('0.15'));
        await checkInvariants('bouncestorm:lotclose');
    }, 300_000);

    it('I5: no privileged sender has a withdraw path out of the ledger', async () => {
        await buyPrime(players[0], 2n);
        await buyPrime(players[0], 3n);
        const before = (await blockchain.getContract(ledger.address)).balance;

        const privileged: { name: string; who: SandboxContract<TreasuryContract> }[] = [
            { name: 'genesisScript', who: genesisScript },
            { name: 'proposer', who: proposer },
            { name: 'deployer', who: deployer },
            { name: 'treasury', who: treasuryWallet },
        ];
        // every opcode the ledger knows, fired from every privileged sender
        const opcodes = [
            0xb0000001, 0xb0000002, 0xb0000003, 0xb0000004, 0xb0000005, 0xb0000006, 0xb0000010, 0xb0000020,
            0xb0000021, 0xb0000022, 0xb0000023, 0xb0000030, 0xb0000040, 0xb0000041,
        ];
        const balancesBefore = new Map<string, bigint>();
        for (const p of privileged) balancesBefore.set(p.name, await p.who.getBalance());
        for (const p of privileged) {
            for (const op of opcodes) {
                const body = beginCell()
                    .storeUint(op, 32)
                    .storeUint(0, 64)
                    .storeUint(0, 256)
                    .storeCoins(toNano('5'))
                    .storeAddress(p.who.address)
                    .endCell();
                await p.who.send({ to: ledger.address, value: toNano('0.05'), body, bounce: true });
            }
        }
        const after = (await blockchain.getContract(ledger.address)).balance;
        // No privileged sender may end up richer: every probe cost them value
        // and gas, and none of the ledger's handlers paid anything back to them.
        // (The ledger's own balance dips slightly because IT pays the gas for the
        // failed messages and bounces the rest back — that is gas burn, not a
        // withdraw path, so the meaningful assertion is on the SENDERS.)
        for (const p of privileged) {
            const beforeBal = balancesBefore.get(p.name)!;
            const afterBal = await p.who.getBalance();
            expect({ name: p.name, richer: afterBal > beforeBal }).toEqual({ name: p.name, richer: false });
        }
        expect(after).toBeGreaterThan(before - toNano('5')); // only gas, never a drain
        await checkInvariants('I5');
    }, 300_000);

    it('I7: post-seal the jetton authority is dead and only the ledger mints', async () => {
        const mg = await master.sendMintGenesis(genesisScript.getSender(), {
            to: attacker.address,
            amount: toNano('1000'),
            value: toNano('0.2'),
        });
        expect(mg.transactions).toHaveTransaction({ to: master.address, success: false, exitCode: 400 });

        const forged = await attacker.send({
            to: master.address,
            value: toNano('0.1'),
            body: beginCell()
                .storeUint(0xd0000001, 32)
                .storeUint(0, 64)
                .storeAddress(attacker.address)
                .storeCoins(toNano('1000'))
                .storeCoins(0)
                .endCell(),
            bounce: true,
        });
        expect(forged.transactions).toHaveTransaction({ to: master.address, success: false, exitCode: 401 });
        expect((await master.getJettonData()).totalSupply).toBe(0n);
    }, 120_000);

    it('I9: no message sequence produces a reverse edge in the state vector', async () => {
        // Build real state first — an all-zero vector is trivially monotone and
        // proves nothing. After this the vector is non-trivial on T, S, head,
        // primesCount, div_acc, lastMintTime and at least one divEntry.
        await buyPrime(players[0], 2n);
        await buyPrime(players[0], 3n);
        await mint(players[1], 4n, 0, [{ prime: 2n, exponent: 2 }]);
        await recordTribute(4, [{ prime: 2n, exponent: 2 }]);
        await buyPrime(players[1], 5n);
        await mint(players[2], 6n, 0, [{ prime: 2n, exponent: 1 }, { prime: 3n, exponent: 1 }]);
        await recordTribute(6, [{ prime: 2n, exponent: 1 }, { prime: 3n, exponent: 1 }]);
        await checkInvariants('I9:setup');

        const built = await readStateVector();
        expect(built.get('ledger.head')).toBeGreaterThan(2n);
        expect(built.get('ledger.primesCount')!).toBeGreaterThan(0n);
        expect(built.get('ledger.divAcc')!).toBeGreaterThan(0n);
        expect(built.get('ledger.lastMintTime')!).toBeGreaterThan(0n);

        // Now the hunt. Every probe below is a message that is EXPECTED to fail,
        // bounce, or no-op. A monotone transition relation says a failed message
        // is the identity on the vector; a reverse edge, if one exists, is most
        // likely to be reachable exactly here — through a handler that mutates
        // state before it throws, or through a bounce that unwinds a counter the
        // narrow invariants are not watching.
        const probes: { label: string; run: () => Promise<unknown> }[] = [
            // re-seed the floor counters after genesis (would move T and S down)
            {
                label: 'reseed-after-genesis',
                run: () =>
                    ledger.sendGenesisSeed(genesisScript.getSender(), {
                        seedT: 1n,
                        seedS: 10n ** 18n,
                        seedHead: 2n,
                        value: toNano('0.05'),
                    }),
            },
            // re-link the sinks (a registrar re-link must not reset any rank)
            {
                label: 'relink-sinks',
                run: () =>
                    ledger.sendSetSinks(genesisScript.getSender(), {
                        ratchetAddr: attacker.address,
                        registrarAddr: attacker.address,
                        value: toNano('0.05'),
                    }),
            },
            {
                label: 'relink-registrar-ledger',
                run: () => registrar.sendSetLedger(genesisScript.getSender(), { ledgerAddr: attacker.address, value: toNano('0.05') }),
            },
            {
                label: 'relink-ratchet-ledger',
                run: () => ratchet.sendSetLedger(genesisScript.getSender(), { ledgerAddr: attacker.address, value: toNano('0.05') }),
            },
            // re-mint an already-minted number, and mint behind the head
            // D-20: 're-buy an already-sold prime'. `mint(2, kind = 1)` is not a
            // probe any more — 2 is not the head, so the ledger refunds it before
            // touching any state. A second bid on a CLOSED lot is the real edge.
            { label: 'rebuy-2', run: () => book.sendBid(players[0].getSender(), { n: 2n, beneficiary: null, referralKey: 0, value: toNano('12') }) },
            { label: 'remint-4', run: () => mint(players[1], 4n, 0, [{ prime: 2n, exponent: 2 }]) },
            // dividend claim on a number that is not a minted prime, and a repeat
            // claim on one that is — `entry[p]` must restamp upward or not at all
            { label: 'claim-dividend-composite', run: () => claimDividendTracked(attacker, 4n) },
            { label: 'claim-dividend-unminted', run: () => claimDividendTracked(attacker, 9973n) },
            { label: 'claim-dividend-2', run: () => claimDividendTracked(players[0], 2n) },
            { label: 'claim-dividend-2-again', run: () => claimDividendTracked(players[0], 2n) },
            // flush inside the cooldown, then a flush with nothing to flush
            { label: 'flush-cold', run: () => ratchet.sendFlush(attacker.getSender(), { value: FLUSH_VALUE }) },
            { label: 'flush-cold-again', run: () => ratchet.sendFlush(attacker.getSender(), { value: FLUSH_VALUE }) },
            // ops sweep: moves `sweepable` down and, since D-117, RAISES T (a pool credit); nothing may fall
            { label: 'sweep-ops', run: () => ledger.sendSweepOps(attacker.getSender(), { value: toNano('0.05') }) },
            { label: 'sweep-ops-again', run: () => ledger.sendSweepOps(attacker.getSender(), { value: toNano('0.05') }) },
            // D-90 replaces the `settle-unreserved` / `release-absent` probes:
            // both opcodes are retired, so the edge worth hunting now is a close
            // on a lot that does not exist, and a stale sender still holding the
            // retired `settle#e0000003` opcode.
            { label: 'close-absent', run: () => book.sendClose(attacker.getSender(), { n: 7n, value: toNano('0.3') }) },
            {
                label: 'retired-settle-opcode',
                run: () =>
                    attacker.send({
                        to: book.address,
                        value: toNano('0.3'),
                        bounce: true,
                        body: beginCell().storeUint(0xe0000003, 32).storeUint(0, 64).storeUint(7n, 64).endCell(),
                    }),
            },
            // forged rank credit straight at the registrar
            {
                label: 'forge-rank-credit',
                run: () =>
                    attacker.send({
                        to: registrar.address,
                        value: toNano('0.1'),
                        bounce: true,
                        // record_mint#b0000061 — retired by D-202; refused as an unknown op
                        body: beginCell()
                            .storeUint(0xb0000061, 32)
                            .storeUint(0, 64)
                            .storeUint(7n, 256)
                            .storeUint(1, 1)
                            .storeAddress(attacker.address)
                            .endCell(),
                    }),
            },
            // forged pool_inject at the ratchet, carrying counters BELOW the real
            // ones: the single most direct attempt at a reverse edge there is
            {
                label: 'forge-pool-inject-backwards',
                run: () =>
                    attacker.send({
                        to: ratchet.address,
                        value: toNano('1'),
                        bounce: true,
                        body: beginCell()
                            .storeUint(0xb0000050, 32)
                            .storeUint(0, 64)
                            .storeCoins(toNano('0.65'))
                            .storeCoins(1n)
                            .storeCoins(10n ** 18n)
                            .endCell(),
                    }),
            },
            { label: 'sync-head', run: () => ledger.sendSyncHead(attacker.getSender(), { value: toNano('0.05') }) },
        ];

        for (const probe of probes) {
            const before = await readStateVector();
            await probe.run();
            const after = await readStateVector();
            assertMonotone(`I9:${probe.label}`, before, after);
            lastVector = after;
            // and the narrow invariants still hold on top of it
            await checkInvariants(`I9:${probe.label}`);
        }

        // The vector must also have survived intact: none of the probes was
        // supposed to move the counters at all, so the identity check is stronger
        // than monotonicity here and is worth asserting separately.
        const end = await readStateVector();
        for (const key of ['ledger.head', 'ledger.primesCount', 'ledger.T', 'ledger.S'] as const) {
            expect({ key, value: end.get(key) }).toEqual({ key, value: built.get(key) });
        }
    }, 600_000);

    /**
     * I2 ACROSS A DONATION — the invariant that could not fail before D-100
     * because nothing in this file exercised the flow that broke it.
     *
     * D-91's `handleDonateFloor` credited `seedT += X` AND forwarded the same
     * `X` to the ratchet's `pending`. `T` therefore moved by X while
     * `seedT + pending + swapped` moved by 2X. The gap grew by the donated
     * amount on every donation, permanently, and the live testnet's ratchet
     * panel reported it as `beyond T 4.000 GRAM` against `seedT = 4.000 GRAM` —
     * the alarm was correct and the books were wrong (D-100 point 1,
     * MISTAKES.md 2026-09-04).
     *
     * So this test asserts three things, and the second is the one that would
     * have caught it:
     *
     *   1. the identity closes exactly after each donation (I2, via
     *      `checkInvariants`);
     *   2. `seedT` DOES NOT MOVE — it is the one-shot genesis credit and
     *      nothing else, which is D-26's definition restored;
     *   3. the whole donation lands in `pending + swapped`, i.e. `ΔT` equals
     *      what the ratchet took, so the money is counted once and is counted
     *      in the term that owns it.
     *
     * Deliberately several donations rather than one: the old bug was linear in
     * the number of donations, so a single-donation test that merely checked
     * "T went up" would have passed against the broken contract too.
     */
    it('I2: `T == seedT + pending + swapped` closes across a donation (D-100 point 1)', async () => {
        await buyPrime(players[0], 2n);
        await buyPrime(players[0], 3n);
        await mint(players[1], 4n, 0, [{ prime: 2n, exponent: 2 }]);
        await recordTribute(4, [{ prime: 2n, exponent: 2 }]);
        await checkInvariants('donate:setup');

        const seedTAtStart = await ledger.getSeedT();

        for (const amount of [toNano('0.25'), toNano('1'), toNano('4')]) {
            const tBefore = await ledger.getFloorNum();
            const ratchetBefore = (await ratchet.getPending()) + (await ratchet.getSwapped());

            const r = await donate(players[2], amount);
            expect(r.transactions).toHaveTransaction({ to: ledger.address, success: true });

            // (2) `seedT` is untouched. This is the assertion the pre-D-100
            //     contract fails on the FIRST donation, before any accumulation.
            expect({ amount: amount.toString(), seedT: await ledger.getSeedT() }).toEqual({
                amount: amount.toString(),
                seedT: seedTAtStart,
            });

            // (3) `T` moved by exactly the donation, and so did the ratchet's
            //     two terms together. Neither side is allowed to move by more.
            expect({ amount: amount.toString(), dT: (await ledger.getFloorNum()) - tBefore }).toEqual({
                amount: amount.toString(),
                dT: amount,
            });
            expect({
                amount: amount.toString(),
                dRatchet: (await ratchet.getPending()) + (await ratchet.getSwapped()) - ratchetBefore,
            }).toEqual({ amount: amount.toString(), dRatchet: amount });

            // (1) and the full invariant set, including I1's floor monotonicity:
            //     D-100's `min(X·L, X·S/T)` rate means a donation either holds
            //     `p_f` exactly (the floor-rate branch) or raises it (the flat-L
            //     branch below `1/L`), and never lowers it.
            await checkInvariants(`donate:${amount}`);
        }
    }, 300_000);

    /**
     * MINT-PATH BOUNCE: win an ascending lot on composite `n`, but run the close
     * one transaction at a time and deliver the market's REAL `mint_won_lot` to
     * the ledger 1 nanoGRAM under MINT_PRICE — the ledger's own 103 refuses it, TVM
     * bounces it, and the market's real handler refunds the winner. (A wired
     * stack has no natural refusal on this hop: `BounceCoverage.spec.ts`.) Nothing
     * is minted, so `n` is off-head for good with no owner and no tribute.
     */
    async function refusedLotSettle(who: SandboxContract<TreasuryContract>, n: bigint) {
        const factors = factorize(Number(n));
        const p0 = (await book.getLotPriceFrom(n, factors)).p0;
        const open = await book.sendOpenLot(who.getSender(), {
            n, kind: 0, factors, beneficiary: null, referralKey: 0, value: p0 + toNano('0.2'),
        });
        expect(open.transactions).not.toHaveTransaction({ aborted: true });
        const lot = await book.getLot(n);
        expect(lot.found).toBe(true);
        blockchain.now = lot.closesAt + 1;
        const hop = await firstHop(
            blockchain,
            sandboxInternal({ from: who.address, to: book.address, value: toNano('0.3'), body: buildCloseLotMessage({ n }).body })
        );
        expect(hop.first.description.aborted).toBe(false);
        const settle = outTo(hop.first, ledger.address);
        expect(settle.body.beginParse().preloadUint(32)).toBe(0xb0000020);
        // Anything else the close sent is delivered as it was.
        for (const m of hop.first.outMessages.values()) {
            if (m !== settle && m.info.type === 'internal') await blockchain.sendMessage(m);
        }
        const r = await blockchain.sendMessage({ ...settle, info: { ...settle.info, value: { coins: MINT_PRICE - 1n } } });
        expect(r.transactions).toHaveTransaction({ from: book.address, to: ledger.address, success: false, exitCode: 103 });
        expect(r.transactions).toHaveTransaction({ from: ledger.address, to: book.address, inMessageBounced: true, success: true });
        const red = r.transactions.filter((t: any) => t.description.aborted).map((t: any) => t.inMessage.info.dest.toString());
        expect(red).toEqual([ledger.address.toString()]);
        expect((await blockchain.getContract(await ledger.getItemAddress(n))).accountState?.type).not.toBe('active');
    }

    /** §4.3.2 STAKE: top `pending` up past the (divided) minimum and stake the excess. */
    async function stakeLeg(who: SandboxContract<TreasuryContract>) {
        // stake moves `pending - 0.2·(pending + stakedCost + exiting)`, and must move
        // more than the divided 5 GRAM minimum: donate whatever closes the gap, + 5 GRAM.
        const k = await ratchet.getStaking();
        const need = (toNano('5') * 10n + (k.stakedCost + k.exiting) * 2n) / 8n - (await ratchet.getPending()) + toNano('5');
        await donate(who, need > toNano('5') ? need : toNano('5'));
        blockchain.now! += 3601; // a flush the stub venue never answered goes stale (FLUSH_STALE_TIMEOUT)
        const before = (await ratchet.getStaking()).stakedCost;
        const r = await ratchet.sendStake(who.getSender(), { value: STAKE_VALUE });
        expect(r.transactions).not.toHaveTransaction({ aborted: true });
        expect((await ratchet.getStaking()).stakedCost).toBeGreaterThan(before);
    }

    /**
     * §4.3.2 EXIT: mints since the last stake have grown `pending` past its target,
     * so a stake brings it back ONTO the target, one flush (max(20%, FLUSH_MIN))
     * takes it under, and the unstake refills it on leg 1.
     */
    async function exitLeg(who: SandboxContract<TreasuryContract>) {
        blockchain.now! += 86400 + 10; // past FLUSH_COOLDOWN, and any flush's stale timeout
        // `staked_reserve.stake_min_ton` / stakeDivisor 100, the contract's own integer division.
        const STAKE_MIN_DIVIDED = toNano(String(STAKE_MIN_TON)) / 100n;
        if ((await ratchet.getPending()) - (await ratchet.getStaking()).reserveTarget > STAKE_MIN_DIVIDED) {
            const st = await ratchet.sendStake(who.getSender(), { value: STAKE_VALUE });
            expect(st.transactions).not.toHaveTransaction({ aborted: true });
        }
        for (let i = 0; i < 4 && (await ratchet.getPending()) >= (await ratchet.getStaking()).reserveTarget; i++) {
            if (i > 0) blockchain.now! += 86400 + 10;
            const f = await ratchet.sendFlush(who.getSender(), { value: FLUSH_VALUE });
            expect(f.transactions).not.toHaveTransaction({ aborted: true });
        }
        blockchain.now! += 3601; // past FLUSH_STALE_TIMEOUT, so the exit is not serialised behind it
        const s = await ratchet.getStaking();
        expect(await ratchet.getPending()).toBeLessThan(s.reserveTarget);
        const pendingBefore = await ratchet.getPending();
        const u = await ratchet.sendUnstake(who.getSender(), { value: UNSTAKE_VALUE });
        expect(u.transactions).not.toHaveTransaction({ aborted: true });
        const after = await ratchet.getStaking();
        expect(after.exiting).toBe(0n);
        expect(after.stakedCost).toBeLessThan(s.stakedCost);
        expect(await ratchet.getPending()).toBeGreaterThan(pendingBefore);
    }

    it.each(SEEDS)('holds all ten invariants across a generated operation sequence (seed %i)', async (seed) => {
        const rng = makeRng(seed);
        let mintedUpTo = 1;
        // Lots whose settle was refused: off-head forever, never minted.
        const deadLots = new Set<string>();
        const legs = { stake: 0, exit: 0, refusedSettle: 0 };

        for (let step = 0; step < STEPS; step++) {
            // THE CADENCE LEGS consume no `rng()`, so each seed's rolled sequence is
            // the one it always was; they only interleave with it.
            if (step % 20 === 5) {
                await stakeLeg(players[step % 3]);
                legs.stake++;
                await checkInvariants(`seq:step${step}:stake`);
            } else if (step % 20 === 12) {
                let n = Number(await ledger.getHead()) + 40;
                while (
                    isPrimeJs(n) || PRIMORIALS.has(n) ||
                    liveReservations.has(String(n)) ||
                    deadLots.has(String(n)) ||
                    (await book.getLot(BigInt(n))).found ||
                    (await ledger.isNumberOffHead(BigInt(n))) === 1
                ) n++;
                await refusedLotSettle(players[step % 3], BigInt(n));
                deadLots.add(String(n));
                legs.refusedSettle++;
                await checkInvariants(`seq:step${step}:refused-settle`);
            } else if (step % 20 === 18) {
                await exitLeg(players[step % 3]);
                legs.exit++;
                await checkInvariants(`seq:step${step}:exit`);
            }

            const roll = rng();
            const head = Number(await ledger.getHead());

            // D-20 AS A HARNESS-LEVEL INVARIANT, asserted every step rather than
            // assumed once: the head is defined over composites and Unity only, so
            // it can never come to rest on a prime. If it ever does, every branch
            // below is mis-shaped and the rest of this suite is measuring a game
            // that does not exist.
            expect({ step, head, prime: isPrimeJs(head) }).toEqual({ step, head, prime: false });

            if (roll < 0.45) {
                // mint the head — always a composite (D-20)
                const factors = factorize(head);
                if (await ledger.isNumberOffHead(BigInt(head))) {
                    // I6: must be rejected through the normal path
                    const r = await mint(players[step % 3], BigInt(head), 0, factors);
                    expect(r.transactions).toHaveTransaction({ to: ledger.address, success: false, exitCode: 209 });
                } else {
                    const referral = rng() < 0.5 && head > 3 ? 2 : 0;
                    const r = await mint(players[step % 3], BigInt(head), 0, factors, referral);
                    expect(r.transactions).toHaveTransaction({ to: ledger.address, success: true });
                    await recordTribute(head, factors);
                    mintedUpTo = head;
                }
            } else if (roll < 0.55) {
                // D-20: buy a prime the head has already walked past. This is the
                // ONLY way a prime enters the game, so leaving it out of the
                // sequence would mean the harness never exercised the path that
                // moves `primesCount`, the registrar's rank, or a prime's `owed`.
                const openPrimes: number[] = [];
                for (let n = 2; n < head && openPrimes.length < 4; n++) {
                    if (isPrimeJs(n) && !boughtPrimes.has(n)) openPrimes.push(n);
                }
                if (openPrimes.length > 0) {
                    const p = openPrimes[Math.floor(rng() * openPrimes.length)];
                    await buyPrime(players[step % 3], BigInt(p));
                    boughtPrimes.add(p);
                }
            } else if (roll < 0.7) {
                // Buy a number ahead of the head. D-30: that means winning an
                // ascending lot on it, which is the only route there is. D-90:
                // the CLOSE MINTS IT — there is no claim afterwards, so the
                // tribute is recorded here rather than at a later settlement.
                // COMPOSITES ONLY in this branch; primes go through the one
                // above.
                let n = head + 3 + Math.floor(rng() * 20);
                while (isPrimeJs(n) || PRIMORIALS.has(n)) n++; // a primorial is never auctionable (1008)
                if (!liveReservations.has(String(n)) && !deadLots.has(String(n)) && !(await book.getLot(BigInt(n))).found) {
                    await winClaim(players[step % 3], BigInt(n), factorize(n));
                    if ((await ledger.isNumberOffHead(BigInt(n))) === 1) {
                        liveReservations.add(String(n));
                        await recordTribute(n, factorize(n));
                    }
                }
            } else if (roll < 0.8) {
                // D-90 replaces the release/settle branches with the edge that
                // survives them: a second `close` on a lot that already minted
                // must change nothing at all — not the head, not the split, not
                // the counters. This is where a double-mint would show up.
                const live = [...liveReservations];
                const before = await ledger.getHead();
                if (live.length > 0) {
                    const n = live[Math.floor(rng() * live.length)];
                    await book.sendClose(players[step % 3].getSender(), {
                        n: BigInt(n),
                        value: toNano('0.35'),
                    });
                } else {
                    // I6: closing a lot that does not exist must not move the head
                    await book.sendClose(attacker.getSender(), { n: BigInt(head), value: toNano('0.3') });
                }
                expect(await ledger.getHead()).toBe(before);
            } else if (roll < 0.86) {
                blockchain.now! += 86400 + 10;
                await ratchet.sendFlush(players[0].getSender(), { value: FLUSH_VALUE });
            } else if (roll < 0.93) {
                // claim tribute on a random credited prime
                const keys = [...creditedPerPrime.keys()];
                if (keys.length > 0) {
                    const p = keys[Math.floor(rng() * keys.length)];
                    const itemAddr = await ledger.getItemAddress(BigInt(p));
                    const item = blockchain.openContract(PrimesItem.createFromAddress(itemAddr));
                    const owed = await item.getOwed();
                    const owner = (await item.getNumberData()).owner;
                    const who = players.find((pl) => pl.address.toString() === owner.toString());
                    if (who && owed > 0n) {
                        await item.sendClaimTribute(who.getSender(), { value: toNano('0.05') });
                        if ((await item.getOwed()) === 0n) {
                            paidOutPerPrime.set(p, (paidOutPerPrime.get(p) ?? 0n) + owed);
                        }
                    }
                }
            } else if (roll < 0.95) {
                // convert a random prime's accrued flat dividend into `owed`
                // (§3.2). Permissionless, so the caller is deliberately arbitrary.
                const keys = [...creditedPerPrime.keys()];
                if (keys.length > 0) {
                    await claimDividendTracked(attacker, BigInt(keys[Math.floor(rng() * keys.length)]));
                }
            } else if (roll < 0.96) {
                // D-100 point 1 — a donation, INTERLEAVED. The dedicated test
                // below proves the identity across a donation in isolation;
                // this branch is what proves it survives arriving between a
                // mint and a flush, which is the state the old double-count
                // was actually discovered in. The slice is carved out of the
                // `sync_head` branch's range on purpose, so every other roll
                // selects exactly the operation it selected before and the
                // seeded sequence stays comparable with its own history.
                await donate(players[step % 3], toNano('0.5'));
            } else if (roll < 0.97) {
                await ledger.sendSyncHead(attacker.getSender(), { value: toNano('0.05') });
            } else {
                // hostile no-op: a forged settlement from a non-book sender
                const before = await ledger.getHead();
                await attacker.send({
                    to: ledger.address,
                    value: MINT_PRICE + toNano('0.1'),
                    bounce: true,
                    body: beginCell()
                        .storeUint(0xb0000020, 32)
                        .storeUint(0, 64)
                        .storeUint(BigInt(head), 256)
                        .storeAddress(attacker.address)
                        .storeUint(0, 32)
                        .storeUint(1, 1)
                        .storeUint(0, 1)
                        .endCell(),
                });
                expect(await ledger.getHead()).toBe(before);
            }

            blockchain.now! += 30 + Math.floor(rng() * 600);
            await checkInvariants(`seq:step${step}`);

            // I8 moved INTO `checkInvariants` (C8), strengthened from a
            // test-computed bound to the contract's own one-get-call solvency
            // triple. It
            // therefore now runs on the corpus, the bounce storm and the I9
            // probe walk as well, not only here.
        }

        // the sequence actually did something
        expect(mintedUpTo).toBeGreaterThan(2);
         
        if (STEPS >= 19) expect(Math.min(legs.stake, legs.exit, legs.refusedSettle)).toBeGreaterThan(0);
        console.log(
            `[invariants] seed=${seed} steps=${STEPS} head=${await ledger.getHead()} ` +
                `T=${await ledger.getFloorNum()} S=${await ledger.getFloorDen()} liveReservations=${liveReservations.size} ` +
                `legs=${JSON.stringify(legs)} stakedCost=${(await ratchet.getStaking()).stakedCost}`
        );
    }, 600_000);
});

// ===========================================================================
// TR-1 .. TR-7 — the governed treasury, the LP miner and the LP sink.
// CONCEPT.md §5.5; DECISIONS.md D-100; TREASURY_PLAN.md §2.
//
// A SECOND FIXTURE, DELIBERATELY. The harness above deploys the ledger, the
// ratchet, the registrar, the market, the collection and the jetton family
// because I1..I11 are statements about how those six interact. D-100's three
// contracts interact with NONE of them — that is TR-4, and it is the reason
// they were safe to add at all (D-100's "entirely outside the split/ratchet/
// ledger core"). Bolting them onto the fixture above would have coupled two
// families the design keeps apart, and would have paid for the coupling on
// every one of the sixty steps up there.
//
// The seven, and what each is asserted against:
//
//   TR-1  DELETED by D-168 with the LP miner: nothing accrues inside the
//         treasury, so there is no accrual liability for it to cover.
//   TR-2  The treasury's own assets leave ONLY through `execute` (a passed
//         proposal) or through `distribute()` (D-168: PRIMES to the stake
//         master, at most once per interval, amount = the formula — asserted
//         per call in `distribute`). There is no third path, and this is the strongest claim in
//         D-100 point 7 — so it is PROVED here per step rather than asserted in
//         prose. See `assertNoThirdPath` for the one send that looks like a
//         counterexample and is not.
//   TR-3  A proposal transfers ≤ `proposalCapBps` of the named asset's balance
//         AT EXECUTE TIME. Read off `getExecutable(seq)` — the contract's own
//         arithmetic — immediately before the execute lands, never at open time.
//   TR-4  `S` is untouched: nothing in this family mints. Proved structurally —
//         the only jetton opcode any of these contracts emits is TEP-74
//         `transfer#0f8a7ea5`; a `JettonMint` never appears.
//   TR-5  `Σ positions[·].amount == lpHeld`, and `lpHeld` equals the LP the
//         harness actually delivered less what left. The miner's books equal the
//         wallet, and every LP token there is a depositor's (D-167).
//   TR-6  The sink's `getLocked()` is monotone non-decreasing, equals the
//         harness's own tally of what it accepted, and the sink emits no
//         outbound internal message on any step.
//   TR-7  Vote weight is a pure function of `(amount, tier, cooldownRequested)`
//         — recomputed here by a function that reads no snapshot, no oracle and
//         no `p_f`, and compared against `getVoteWeight()`.
//
// The generator is the same seeded xorshift the sequence above uses, for the
// same reason: a failure has to be reproducible from `FUZZ_SEED` alone.
// ===========================================================================
describe('TON PRIMES — TR-1..TR-7, the governed treasury (D-100)', () => {
    let blockchain: Blockchain;
    let deployer: SandboxContract<TreasuryContract>;
    let genesisScript: SandboxContract<TreasuryContract>;
    let operator: SandboxContract<TreasuryContract>;
    let stranger: SandboxContract<TreasuryContract>;
    let holders: SandboxContract<TreasuryContract>[];
    /**
     * Stand-ins for the treasury's own two jetton wallets and the sink's. A real
     * DeDust LP wallet is not needed to state any of TR-1..TR-7: every one of
     * them is about what these contracts BOOK and what they SEND, and the wallet
     * is on the far side of both. `LpMiner.spec.ts` uses the same stand-ins.
     */
    let lpWallet: SandboxContract<TreasuryContract>;
    let primesWallet: SandboxContract<TreasuryContract>;
    let sinkLpWallet: SandboxContract<TreasuryContract>;

    let treasuryCode: Cell;
    let positionCode: Cell;
    let sinkCode: Cell;
    let treasury: SandboxContract<PrimesTreasury>;
    let sink: SandboxContract<PrimesLpSink>;

    /** TR-5's right-hand side: LP the harness handed the treasury, less what left. */
    let lpDelivered: bigint;
    /** TR-6's right-hand side: LP the harness handed the sink and the sink accepted. */
    let sinkTally: bigint;
    // D-214: LP each owner locked forever through a position — it keeps voting.
    let foreverOf: Map<string, bigint>;
    let lastLocked: bigint;
    /** Owners the harness has ever deposited for — the set TR-5 and TR-7 walk. */
    let known: Set<string>;
    /** TR-2's `distribute()` tally: Σ budgets the harness saw booked out. */
    let distributedSeen: bigint;

    const RATE_BPS_PER_DAY = 100; // fixture; the rate is deploy data the sim selects
    const FORWARD = toNano('0.6'); // never the exact minimum (CLAUDE.md)
    const T0 = 1_800_000_000;

    beforeAll(async () => {
        treasuryCode = await compile('PrimesTreasury');
        positionCode = await compile('PrimesLpPosition');
        sinkCode = await compile('PrimesLpSink');
    });

    beforeEach(async () => {
        blockchain = await Blockchain.create();
        blockchain.now = T0;
        deployer = await blockchain.treasury('deployer');
        genesisScript = await blockchain.treasury('genesisScript');
        operator = await blockchain.treasury('operator');
        stranger = await blockchain.treasury('stranger', { balance: toNano('5000') });
        lpWallet = await blockchain.treasury('lpWallet');
        primesWallet = await blockchain.treasury('primesWallet');
        sinkLpWallet = await blockchain.treasury('sinkLpWallet');
        holders = [];
        for (const n of ['h0', 'h1', 'h2']) {
            holders.push(await blockchain.treasury(n, { balance: toNano('5000') }));
        }

        sink = blockchain.openContract(
            PrimesLpSink.createFromConfig({ genesisScriptAddr: genesisScript.address }, sinkCode)
        );
        await sink.sendDeploy(deployer.getSender(), toNano('1'));
        await sink.sendSetWallet(genesisScript.getSender(), {
            lpJettonWalletAddr: sinkLpWallet.address,
            value: toNano('0.05'),
        });

        treasury = blockchain.openContract(
            PrimesTreasury.createFromConfig(
                {
                    operatorAddr: operator.address,
                    sinkAddr: sink.address,
                    // D-168: `distribute()`'s recipient. A stand-in wallet — every
                    // TR is about what the TREASURY books and sends.
                    stakeAddr: stranger.address,
                    distributionRateBpsPerDay: RATE_BPS_PER_DAY,
                    positionCode,
                    genesisScriptAddr: genesisScript.address,
                },
                treasuryCode
            )
        );
        await treasury.sendDeploy(deployer.getSender(), toNano('200'));
        await treasury.sendSetWallets(genesisScript.getSender(), {
            lpJettonWallet: lpWallet.address,
            primesJettonWallet: primesWallet.address,
            value: toNano('0.1'),
        });

        lpDelivered = 0n;
        sinkTally = 0n;
        foreverOf = new Map();
        lastLocked = 0n;
        known = new Set();
        distributedSeen = 0n;
    });

    function childOf(owner: Address) {
        return blockchain.openContract(
            PrimesLpPosition.createFromConfig({ owner, treasuryAddr: treasury.address }, positionCode)
        );
    }

    /** The vest arriving — PRIMES `distribute()` sends a fraction of per epoch. */
    async function fundPrimes(amount: bigint) {
        return await treasury.sendTransferNotification(primesWallet.getSender(), {
            amount,
            from: deployer.address,
            value: toNano('0.15'),
        });
    }

    async function depositLp(
        who: SandboxContract<TreasuryContract>,
        amount: bigint,
        tier: number,
        payload: Cell = depositPayload(tier)
    ) {
        known.add(who.address.toString());
        return await treasury.sendTransferNotification(lpWallet.getSender(), {
            amount,
            from: who.address,
            value: FORWARD,
            forwardPayload: payload,
        });
    }

    // ------------------------------------------------------------------ TR-7
    /**
     * TR-7's right-hand side, written as the pure function the invariant claims
     * exists. Note what it does NOT take: no accumulator, no treasury balance, no
     * floor. Under D-147 it DOES take the clock, because a term expires — but only
     * through `expired`, the flag the permissionless `expire` sets, because that is
     * what the child's maintained `voteWeight` tracks. The exact live rule
     * (`maturesAt` against the clock) is what `position_vote` enforces, and the
     * aggregate is deliberately its upper bound until someone pokes it.
     */
    function voteWeightOf(ps: { amount: bigint; tier: number; expired: number }[]) {
        let w = 0n;
        for (const p of ps) {
            if (p.expired !== 0) continue; // retired: out of both aggregates
            w += p.amount * BigInt(TREASURY_TIERS[p.tier].voteMultiplier);
        }
        return w;
    }

    /** Every live position of every owner the harness has ever touched. */
    async function walkPositions() {
        const out: {
            owner: string;
            id: number;
            amount: bigint;
            tier: number;
            maturesAt: number;
            expired: number;
        }[] = [];
        for (const owner of known) {
            const child = childOf(Address.parse(owner));
            let nextId: number;
            try {
                nextId = (await child.getPositions()).nextId;
            } catch {
                continue; // child not deployed yet — no positions to walk
            }
            // Ids are never reused, so `0..nextId-1` is the stable enumeration
            // even after a withdrawal has removed one from the middle.
            for (let id = 0; id < nextId; id++) {
                const p = await child.getPosition(id);
                if (p.amount === 0n) continue;
                out.push({
                    owner,
                    id,
                    amount: p.amount,
                    tier: p.tier,
                    maturesAt: p.maturesAt,
                    expired: p.expired,
                });
            }
        }
        return out;
    }

    // ------------------------------------------------------------------ TR-2
    /**
     * TR-2, per step: the treasury's own assets left only through a path D-100
     * point 7 names.
     *
     * The treasury sends value in exactly four places (five `sendJetton` call
     * sites plus the one `TonPayout`), and three inbound messages account for
     * all the ones that spend its books:
     *
     *   Execute      a passed proposal — GRAM, PRIMES or tsTON
     *   Distribute   D-168's monthly budget to the stake master, by formula
     *   WithdrawLp   a depositor taking back their OWN LP
     *
     * THE FOURTH IS NOT A COUNTEREXAMPLE, and skipping past it would be the
     * dishonest way to make this pass: an LP transfer arriving with an
     * unrecognised or malformed payload is REFUNDED to its sender from the
     * `TransferNotification` handler. That send moves LP the treasury never
     * credited — `lpHeld` and `primesBalance` are both untouched across
     * it — so it is a pass-through, not a spend, and the assertion below says
     * exactly that rather than looking away.
     *
     * `tonBalance` is deliberately NOT in the decrease check: it is the
     * account's real balance and it falls by gas on every message, so a
     * "did it go down" test on it would fire on a refused message. GRAM leaving
     * as VALUE is caught by the outbound `TonPayout` arm instead, which is
     * gas-independent.
     */
    const SPEND_OPS = new Set<number>([
        TreasuryOpcodes.Execute,
        TreasuryOpcodes.Distribute,
        TreasuryOpcodes.WithdrawLp,
    ]);
    const VALUE_OPS = new Set<number>([TreasuryOpcodes.JettonTransfer, TreasuryOpcodes.TonPayout]);

    function inboundOpsToTreasury(result: { transactions: any[] }): number[] {
        const ops: number[] = [];
        for (const tx of result.transactions) {
            const inMsg = tx.inMessage;
            if (!inMsg || inMsg.info.type !== 'internal') continue;
            if (!inMsg.info.dest.equals(treasury.address)) continue;
            const s = inMsg.body.beginParse();
            ops.push(s.remainingBits >= 32 ? s.loadUint(32) : 0);
        }
        return ops;
    }

    /** Every outbound message the TREASURY itself sent in this step. */
    function treasuryOutbound(result: { transactions: any[] }): number[] {
        const out: number[] = [];
        for (const tx of result.transactions) {
            const inMsg = tx.inMessage;
            if (!inMsg || inMsg.info.type !== 'internal') continue;
            if (!inMsg.info.dest.equals(treasury.address)) continue;
            for (const m of tx.outMessages.values()) {
                if (m.info.type !== 'internal') continue;
                const s = m.body.beginParse();
                out.push(s.remainingBits >= 32 ? s.loadUint(32) : 0);
            }
        }
        return out;
    }

    type Booked = { primesBalance: bigint; lpHeld: bigint };

    function assertNoThirdPath(
        label: string,
        before: Booked,
        after: Booked,
        result: { transactions: any[] }
    ) {
        const ops = inboundOpsToTreasury(result);
        const spent =
            after.primesBalance < before.primesBalance ||
            after.lpHeld < before.lpHeld;
        if (spent) {
            expect({ label, tr2: ops.some((o) => SPEND_OPS.has(o)), ops }).toEqual({
                label,
                tr2: true,
                ops,
            });
        }
        // The other half, and the one that catches a NEW path rather than a
        // misuse of an old one: any value-bearing outbound the treasury emitted
        // must have been provoked by one of the three. A `sendToChild`
        // bookkeeping hop carries only gas and names no asset, so it is excluded
        // by opcode rather than by value.
        const unprovoked = treasuryOutbound(result).filter(
            (op) => VALUE_OPS.has(op) && !ops.some((o) => SPEND_OPS.has(o))
        );
        if (unprovoked.length > 0) {
            // The refund arm. It is allowed, and the price of allowing it is
            // that it must be provably free: neither of the two booked figures
            // may have moved across it.
            expect({
                label,
                refundIsPassThrough: {
                    primes: after.primesBalance === before.primesBalance,
                    lpHeld: after.lpHeld === before.lpHeld,
                },
            }).toEqual({
                label,
                refundIsPassThrough: { primes: true, lpHeld: true },
            });
        }
    }

    // ------------------------------------------------------------ TR-4 / TR-6
    /**
     * TR-4 as a structural fact rather than as a balance comparison. `S` lives
     * on the ledger and rises through exactly one message, `JettonMint`
     * (`0xd0000001`), which only the ledger may send. No contract in this family
     * has that opcode anywhere in it — so the check is that none of them ever
     * emits it, on any step, under any sequence. There is no jetton master in
     * this fixture at all, which is itself the point: these contracts cannot
     * reach one.
     *
     * TR-6's second half rides here too: the sink emits NO outbound internal
     * message, ever. `LpSink.spec.ts` proves the same thing statically by
     * grepping the compiled cell for `SENDRAWMSG`; this is the runtime half.
     */
    const JETTON_MINT_OP = 0xd0000001;

    function assertNothingMintsAndSinkIsSilent(label: string, result: { transactions: any[] }) {
        const offenders: string[] = [];
        for (const tx of result.transactions) {
            const inMsg = tx.inMessage;
            const dest = inMsg && inMsg.info.type === 'internal' ? inMsg.info.dest.toString() : '';
            for (const m of tx.outMessages.values()) {
                if (m.info.type !== 'internal') continue;
                const s = m.body.beginParse();
                const op = s.remainingBits >= 32 ? s.loadUint(32) : 0;
                if (op === JETTON_MINT_OP) offenders.push(`tr4:JettonMint from ${dest}`);
                if (dest === sink.address.toString()) offenders.push(`tr6:sink sent op ${op}`);
            }
        }
        expect({ label, tr4tr6: offenders }).toEqual({ label, tr4tr6: [] });
    }

    // --------------------------------------------------------- the whole set
    async function checkTr(label: string) {
        // TR-1 is DELETED (D-168): nothing accrues inside the treasury any more.
        // TR-2's `distribute()` half: the amount is the formula, never more, and
        // the running total is exactly what the harness saw leave by that path.
        const dist = await treasury.getDistribution();
        expect({ label, tr2distributed: dist.distributedTotal }).toEqual({
            label,
            tr2distributed: distributedSeen,
        });

        const bal = await treasury.getTreasuryBalances();
        const positions = await walkPositions();

        // TR-5 — the miner's books equal the wallet, in both directions.
        const summed = positions.reduce((a, p) => a + p.amount, 0n);
        expect({ label, tr5: bal.lpHeld }).toEqual({ label, tr5: summed });
        // and the wallet-side statement: everything the harness delivered is
        // either still a depositor's or has left (D-167: there is no other LP).
        expect({ label, tr5wallet: bal.lpHeld }).toEqual({
            label,
            tr5wallet: lpDelivered,
        });

        // TR-6 — locked depth only ever grows, and equals what the sink took.
        const locked = await sink.getLocked();
        expect({ label, tr6monotone: locked >= lastLocked }).toEqual({ label, tr6monotone: true });
        expect({ label, tr6tally: locked }).toEqual({ label, tr6tally: sinkTally });
        lastLocked = locked;

        // TR-7 — vote weight is the pure function, per owner and in aggregate.
        let eligible = 0n;
        for (const owner of known) {
            const mine = positions.filter((p) => p.owner === owner);
            const expected =
                voteWeightOf(mine) + (foreverOf.get(owner) ?? 0n) * BigInt(FOREVER_VOTE_MULTIPLIER);
            eligible += expected;
            let actual = 0n;
            try {
                actual = await childOf(Address.parse(owner)).getVoteWeight();
            } catch {
                actual = 0n; // child not deployed: no positions, no weight
            }
            expect({ label, owner, tr7: actual }).toEqual({ label, owner, tr7: expected });
        }
        // The treasury's aggregate is the same sum.
        const gov = await treasury.getGov();
        expect({ label, tr7aggregate: gov.eligibleWeight }).toEqual({
            label,
            tr7aggregate: eligible,
        });
    }

    /** One step: run it, then assert the whole set plus the per-step TR-2/TR-4. */
    async function step(label: string, run: () => Promise<any>) {
        const b = await treasury.getTreasuryBalances();
        const result = await run();
        const a = await treasury.getTreasuryBalances();
        if (result && Array.isArray(result.transactions)) {
            assertNoThirdPath(label, b, a, result);
            assertNothingMintsAndSinkIsSilent(label, result);
        }
        await checkTr(label);
        return result;
    }

    /**
     * `distribute()`, with TR-2's "amount = the formula, never more" checked on
     * the step itself: the booked decrease equals the estimate read immediately
     * before, and a refused call (interval not up) books nothing.
     */
    async function distribute(label: string) {
        const est = await treasury.getDistribution();
        const before = (await treasury.getTreasuryBalances()).primesBalance;
        const r = await treasury.sendDistribute(stranger.getSender());
        const after = (await treasury.getTreasuryBalances()).primesBalance;
        const due = blockchain.now! - est.lastDistributeTime >= est.interval;
        expect({ label, tr2formula: before - after }).toEqual({
            label,
            tr2formula: due ? est.nextBudgetEstimate : 0n,
        });
        distributedSeen += before - after;
        return { r, sent: before > after };
    }

    it('TR-2..TR-7 hold across a generated treasury / custody / governance sequence', async () => {
        const rng = makeRng(SEED);
        let distributes = 0;
        let withdrawals = 0;
        let sinkForwards = 0;

        await step('tr:seed:primes', async () => await fundPrimes(toNano('1000000')));
        // One deposit in every tier, so all four ladders are live from step 0 and
        // no branch below is passing because its tier was never used.
        for (let tier = 0; tier < TREASURY_TIERS.length; tier++) {
            const who = holders[tier % holders.length];
            const amount = toNano(String(100 + tier * 10));
            await step(`tr:seed:deposit t${tier}`, async () => {
                const r = await depositLp(who, amount, tier);
                lpDelivered += amount;
                return r;
            });
        }

        for (let s = 0; s < STEPS; s++) {
            const roll = rng();
            const who = holders[s % holders.length];
            const child = childOf(who.address);
            const positions = await walkPositions();
            const mine = positions.filter((p) => p.owner === who.address.toString());
            const label = `tr:step${s}`;

            if (roll < 0.2) {
                const tier = Math.floor(rng() * TREASURY_TIERS.length);
                const amount = toNano(String(10 + Math.floor(rng() * 90)));
                await step(label, async () => {
                    const r = await depositLp(who, amount, tier);
                    lpDelivered += amount;
                    return r;
                });
            } else if (roll < 0.28) {
                // An unrecognised payload: refunded, never kept. This is the send
                // TR-2's fourth arm exists for, fired on purpose so the assertion
                // that it is a pass-through is not vacuous.
                await step(
                    label,
                    async () =>
                        await depositLp(
                            who,
                            toNano('7'),
                            0,
                            beginCell().storeUint(0xdeadbeef, 32).endCell()
                        )
                );
            } else if (roll < 0.34) {
                // The RETIRED donate tag (D-167). It must refund like any unknown
                // tag — nothing booked, nothing delivered — which TR-5's wallet
                // check and TR-2's pass-through check are what prove.
                await step(
                    label,
                    async () =>
                        await treasury.sendTransferNotification(lpWallet.getSender(), {
                            amount: toNano('50'),
                            from: operator.address,
                            value: FORWARD,
                            forwardPayload: beginCell().storeUint(0x54444f4e, 32).endCell(), // "TDON"
                        })
                );
            } else if (roll < 0.44) {
                // Plain GRAM in: the 58% forfeit share (D-100 point 6, D-166).
                await step(label, async () => await treasury.sendTon(stranger.getSender(), toNano('3')));
            } else if (roll < 0.56) {
                // D-168's permissionless `distribute()` — refused (and booking
                // nothing) until an interval has passed since the last one.
                await step(label, async () => {
                    const { r, sent } = await distribute(label);
                    if (sent) distributes += 1;
                    return r;
                });
            } else if (roll < 0.66) {
                // D-147's permissionless `expire`, fired from a STRANGER on whatever
                // has matured. It moves no asset and changes no rule, so every TR
                // below must be indifferent to it — which is the point of firing it
                // inside the sequence rather than in a test of its own.
                const ripe = mine.filter(
                    (p) =>
                        p.expired === 0 &&
                        p.maturesAt <= blockchain.now! &&
                        TREASURY_TIERS[p.tier].voteMultiplier > 0
                );
                if (ripe.length === 0) continue;
                const p = ripe[Math.floor(rng() * ripe.length)];
                await step(
                    label,
                    async () =>
                        await child.sendExpire(stranger.getSender(), {
                            positionId: p.id,
                            value: FORWARD,
                        })
                );
            } else if (roll < 0.74) {
                if (mine.length === 0) continue;
                const p = mine[Math.floor(rng() * mine.length)];
                // Jump past the tier's TERM. Time only ever moves forward here,
                // exactly as in the sequence above, and every TR is a statement
                // over cumulative state rather than over elapsed time.
                blockchain.now = Math.max(blockchain.now!, p.maturesAt + 10);
                await step(label, async () => {
                    const r = await child.sendWithdraw(who.getSender(), {
                        positionId: p.id,
                        value: FORWARD,
                    });
                    if ((await child.getPosition(p.id)).amount === 0n) {
                        lpDelivered -= p.amount;
                        withdrawals += 1;
                    }
                    return r;
                });
            } else if (roll < 0.8) {
                // Lock forever. The LP leaves the treasury for the sink, so TR-5's
                // wallet term drops and TR-6's rises by the same amount — and the
                // sink itself must stay silent throughout (TR-4/TR-6).
                if (mine.length === 0) continue;
                const p = mine[Math.floor(rng() * mine.length)];
                await step(label, async () => {
                    const r = await child.sendToSink(who.getSender(), {
                        positionId: p.id,
                        value: FORWARD,
                    });
                    if ((await child.getPosition(p.id)).amount === 0n) {
                        lpDelivered -= p.amount;
                        foreverOf.set(who.address.toString(), (foreverOf.get(who.address.toString()) ?? 0n) + p.amount);
                        // The treasury's transfer would have credited the SINK's
                        // own LP wallet, which then notifies it. The stand-in
                        // wallet cannot, so the harness plays that hop — and
                        // records it on the same tally TR-6 checks against, so
                        // the tally can never be quietly bent to match.
                        const before = await sink.getLocked();
                        await sink.sendTransferNotification(sinkLpWallet.getSender(), {
                            amount: p.amount,
                            from: treasury.address,
                            value: toNano('0.1'),
                        });
                        if ((await sink.getLocked()) > before) {
                            sinkTally += p.amount;
                            sinkForwards += 1;
                        }
                    }
                    return r;
                });
            } else if (roll < 0.9) {
                // Propose, from whoever has the weight. Below the 1% threshold it
                // is refused; that is a fine step too — TR-2 says the refusal
                // moves nothing.
                await step(
                    label,
                    async () =>
                        await child.sendPropose(who.getSender(), {
                            asset: [TreasuryAsset.GRAM, TreasuryAsset.PRIMES, TreasuryAsset.TSTON][
                                Math.floor(rng() * 3)
                            ],
                            amount: toNano('1'),
                            dest: stranger.address,
                            // D-147: a proposal carries ONE position's weight.
                            positionId: mine.length > 0 ? mine[0].id : 0,
                            value: FORWARD,
                        })
                );
            } else if (roll < 0.96) {
                const seq = (await treasury.getGov()).proposalSeq - 1;
                if (seq < 0) continue;
                // D-173 amendment 2026-11-19: a vote before `opens` is refused
                // (1206), so step out of the newest proposal's notice first.
                blockchain.now = Math.max(blockchain.now!, (await treasury.getProposal(seq)).opens);
                await step(
                    label,
                    async () =>
                        await child.sendVote(who.getSender(), {
                            seq,
                            support: rng() < 0.7,
                            // D-147: a vote names its position and is weighed
                            // against that position's own clock.
                            positionId: mine.length > 0 ? mine[0].id : 0,
                            value: FORWARD,
                        })
                );
            } else {
                // Execute the newest proposal, permissionlessly, from a stranger.
                const seq = (await treasury.getGov()).proposalSeq - 1;
                if (seq < 0) continue;
                // Past the proposal's own close (notice + vote), read off the row.
                blockchain.now = Math.max(blockchain.now!, (await treasury.getProposal(seq)).closes) + 60;
                // TR-3 — the cap and the available balance AS THE CONTRACT SEES
                // THEM RIGHT NOW, read immediately before the execute. Reading
                // them at open time is exactly the bug TR-3 forbids, and the
                // proposals in this sequence routinely open against a balance
                // that has since moved.
                const ex = await treasury.getExecutable(seq);
                const prop = await treasury.getProposal(seq);
                const gov = await treasury.getGov();
                expect({ label, tr3cap: ex.cap }).toEqual({
                    label,
                    tr3cap: (ex.available * BigInt(gov.proposalCapBps)) / 10000n,
                });
                await step(
                    label,
                    async () =>
                        await treasury.sendExecute(stranger.getSender(), { seq, value: toNano('2') })
                );
                if ((await treasury.getProposal(seq)).executed === 1) {
                    // It executed, so TR-3 held at execute time — asserted against
                    // the figures read a moment ago, not against the proposal's
                    // own opening state.
                    expect({ label, tr3: prop.amount <= ex.cap }).toEqual({ label, tr3: true });
                }
            }

            blockchain.now! += 60 + Math.floor(rng() * 3600);
        }

        // A DETERMINISTIC EPILOGUE, and it is not decoration. The non-vacuity
        // guard below is the whole reason the counters exist — a run in which
        // nothing was ever claimed, withdrawn or locked would satisfy every
        // assertion above by never spending anything. But
        // whether the seeded walk happens to complete a full
        // request -> wait -> withdraw depends on the seed, and a guard that a
        // different `FUZZ_SEED` can turn red is a flaky test rather than a
        // proof. So the walk explores and this drives: one fresh position taken
        // all the way out, through the same `step()` wrapper, so TR-1..TR-7 are
        // checked over it exactly as over every random step.
        {
            const who = holders[0];
            const tier = 0; // 30 days — every tier votes since D-168, so the
                            // withdraw has to move `eligibleWeight` and TR-7's
                            // aggregate check sees it.
            const amount = toNano('123');
            await step('tr:drain:deposit', async () => {
                const r = await depositLp(who, amount, tier);
                lpDelivered += amount;
                return r;
            });
            const child = childOf(who.address);
            const id = (await child.getPositions()).nextId - 1;
            // D-147: no request to send — wait the term out and withdraw.
            blockchain.now = (await child.getPosition(id)).maturesAt + 10;
            await step('tr:drain:withdraw', async () => {
                const r = await child.sendWithdraw(who.getSender(), {
                    positionId: id,
                    value: FORWARD,
                });
                if ((await child.getPosition(id)).amount === 0n) {
                    lpDelivered -= amount;
                    withdrawals += 1;
                }
                return r;
            });
            // …and one `distribute()` a full interval after whatever the walk did
            // last, so the non-vacuity guard does not depend on the seed.
            const d = await treasury.getDistribution();
            blockchain.now = Math.max(blockchain.now!, d.lastDistributeTime + d.interval);
            await step('tr:drain:distribute', async () => {
                const { r, sent } = await distribute('tr:drain:distribute');
                if (sent) distributes += 1;
                return r;
            });
        }

        // The sequence must actually have exercised the paths TR-2 is about.
        expect({
            distributes: distributes > 0,
            withdrawals: withdrawals > 0,
            sinkForwards: sinkForwards > 0,
        }).toEqual({ distributes: true, withdrawals: true, sinkForwards: true });

        console.log(
            `[TR] seed=${SEED} steps=${STEPS} distributes=${distributes} withdrawals=${withdrawals} ` +
                `sinkForwards=${sinkForwards} locked=${await sink.getLocked()} ` +
                `eligibleWeight=${(await treasury.getGov()).eligibleWeight}`
        );
    }, 900_000);

    it('TR-2: a corpus of malformed and forged messages moves nothing at all', async () => {
        await fundPrimes(toNano('1000000'));
        await depositLp(holders[0], toNano('1000'), 2);
        lpDelivered += toNano('1000');
        await checkTr('tr:corpus:setup');

        const before = await treasury.getTreasuryBalances();
        const rng = makeRng(SEED);
        const bodies: Cell[] = [
            beginCell().storeUint(0x96000001, 32).storeUint(0, 64).endCell(), // re-bootstrap
            beginCell().storeUint(0x96000002, 32).storeUint(0, 64).endCell(), // forged RelockVote
            beginCell().storeUint(0x96000003, 32).storeUint(0, 64).endCell(), // forged WithdrawLp
            beginCell().storeUint(0x96000004, 32).storeUint(0, 64).endCell(), // forged Vote
            beginCell().storeUint(0x96000007, 32).storeUint(0, 64).endCell(), // forged ExpireVote (D-147)
            beginCell().storeUint(0x96000005, 32).storeUint(0, 64).endCell(), // forged Propose
            beginCell().storeUint(0x96000006, 32).storeUint(0, 64).storeUint(99, 32).endCell(),
            beginCell().storeUint(0x7362d09c, 32).storeUint(0, 64).endCell(), // notification, truncated
            beginCell().storeUint(0x96009999, 32).storeUint(0, 64).endCell(), // unknown opcode
            beginCell().storeUint(0xffffffff, 32).storeUint(0, 64).endCell(),
        ];
        for (let i = 0; i < 10; i++) {
            const b = beginCell();
            const words = 1 + Math.floor(rng() * 6);
            for (let w = 0; w < words; w++) b.storeUint(Math.floor(rng() * 0xffffffff), 32);
            bodies.push(b.endCell());
        }

        for (const [i, body] of bodies.entries()) {
            // From a stranger AND from the operator: D-100 point 7 says the
            // operator has no authority here whatsoever, and the only way to
            // check "no authority" is to fire the whole corpus from them too.
            for (const who of [stranger, operator]) {
                const r = await who.send({
                    to: treasury.address,
                    value: toNano('0.3'),
                    body,
                    bounce: true,
                });
                const now = await treasury.getTreasuryBalances();
                assertNoThirdPath(`tr:corpus${i}`, before, now, r);
                assertNothingMintsAndSinkIsSilent(`tr:corpus${i}`, r);
            }
        }

        const after = await treasury.getTreasuryBalances();
        // Nothing the treasury BOOKS moved. `tonBalance` is excluded for the
        // reason given on `assertNoThirdPath`: it pays the gas for every one of
        // these refusals, which is a burn and not a withdraw path.
        expect({
            primes: after.primesBalance,
            lpHeld: after.lpHeld,
        }).toEqual({
            primes: before.primesBalance,
            lpHeld: before.lpHeld,
        });
        // And the sink never moved either — it has no inbound any of these reach.
        expect(await sink.getLocked()).toBe(0n);
        await checkTr('tr:corpus:end');
    }, 300_000);
});

// ---------------------------------------------------------------------------
// ST-1 / ST-2 — PRIMES staking (CONCEPT.md §5.3, DECISIONS.md D-168).
//
// A seeded random walk over the stake master and its children, with real jettons
// and the real treasury's `distribute()` feeding the stream. After EVERY step:
//   ST-1  the master's wallet balance (`get_wallet_data`) >= lockedTotal +
//         streamRemaining + unclaimedTotal (`getStakeSolvency()`);
//   ST-2  budgetsIn == claimedTotal + unclaimedTotal + streamRemaining, exactly;
//   and two book-keeping identities the invariants rest on: `lockedTotal` equals
//   the sum of every child's `stakedTotal`, and `totalWeight` equals the sum of
//   `amount × tierWeight` over positions not yet expired.
// ---------------------------------------------------------------------------
describe('TON PRIMES — ST-1..ST-2, PRIMES staking (D-168)', () => {
    const P = 1_000_000_000n;
    const STEPS = Number(process.env.FUZZ_STEPS_ST ?? 60);
    const WEIGHTS = params.staking.tier_weights.map(BigInt);

    it(`holds ST-1 and ST-2 after every step of a seeded walk (seed=${SEED})`, async () => {
        const rand = makeRng(SEED ^ 0x5354);
        const pick = (n: number) => Math.floor(rand() * n);
        const blockchain = await Blockchain.create();
        blockchain.now = 1_800_000_000;
        const deployer = await blockchain.treasury('st-deployer');
        const genesis = await blockchain.treasury('st-genesis');
        const users = await Promise.all([0, 1, 2, 3].map((i) => blockchain.treasury(`st-user-${i}`)));

        const walletCode = await compile('PrimesJettonWallet');
        const jetton = blockchain.openContract(
            PrimesJettonMaster.createFromConfig(
                { ledgerAddr: deployer.address, genesisScriptAddr: genesis.address, walletCode },
                await compile('PrimesJettonMaster'),
            ),
        );
        await jetton.sendDeploy(deployer.getSender(), toNano('1'));
        const walletOf = async (a: Address) =>
            blockchain.openContract(PrimesJettonWallet.createFromAddress(await jetton.getWalletAddress(a)));
        const positionCode = await compile('PrimesStakePosition');
        const stake = blockchain.openContract(
            PrimesStake.createFromConfig(
                { jettonMasterAddr: jetton.address, positionCode, genesisScriptAddr: genesis.address, clockDivisor: 168 },
                await compile('PrimesStake'),
            ),
        );
        await stake.sendDeploy(deployer.getSender(), toNano('1'));
        const treasury = blockchain.openContract(
            PrimesTreasury.createFromConfig(
                {
                    operatorAddr: deployer.address,
                    sinkAddr: deployer.address,
                    stakeAddr: stake.address,
                    distributionRateBpsPerDay: params.staking.distribution_rate_bps_per_day,
                    positionCode: await compile('PrimesLpPosition'),
                    genesisScriptAddr: genesis.address,
                    clockDivisor: 168,
                },
                await compile('PrimesTreasury'),
            ),
        );
        await treasury.sendDeploy(deployer.getSender(), toNano('1'));
        await treasury.sendSetWallets(genesis.getSender(), {
            lpJettonWallet: deployer.address,
            primesJettonWallet: await jetton.getWalletAddress(treasury.address),
            value: toNano('0.05'),
        });
        await stake.sendSetWallet(genesis.getSender(), {
            jettonWalletAddr: await jetton.getWalletAddress(stake.address),
            treasuryAddr: treasury.address,
            value: toNano('0.05'),
        });
        for (const u of users) {
            await jetton.sendMintGenesis(genesis.getSender(), { to: u.address, amount: 100_000n * P, value: toNano('0.3') });
        }
        await jetton.sendMintGenesis(genesis.getSender(), { to: genesis.address, amount: 250_000n * P, value: toNano('0.3') });
        await (await walletOf(genesis.address)).sendTransfer(genesis.getSender(), {
            destination: treasury.address, responseAddr: genesis.address, amount: 250_000n * P,
            value: toNano('0.3'), forwardTonAmount: toNano('0.05'),
        });
        const stakeWallet = await walletOf(stake.address);
        const childOf = (a: Address) =>
            blockchain.openContract(PrimesStakePosition.createFromConfig({ owner: a, stakeAddr: stake.address, clockDivisor: 168 }, positionCode));

        const check = async (label: string) => {
            const s = await stake.getStakeSolvency();
            const t = await stake.getStakeTotals();
            // The master's wallet deploys on the first PRIMES it receives.
            const walletLive = (await blockchain.getContract(stakeWallet.address)).accountState?.type === 'active';
            const bal = walletLive ? (await stakeWallet.getWalletData()).balance : 0n;
            expect({ label, st1: bal >= s.lockedTotal + s.streamRemaining + s.unclaimedTotal }).toEqual({ label, st1: true });
            expect({ label, st2: t.claimedTotal + s.unclaimedTotal + s.streamRemaining }).toEqual({ label, st2: t.budgetsIn });
            let locked = 0n;
            let weight = 0n;
            for (const u of users) {
                const c = childOf(u.address);
                const deployed = (await blockchain.getContract(c.address)).accountState?.type === 'active';
                if (!deployed) continue;
                const ps = await c.getPositions();
                locked += ps.stakedTotal;
                for (let id = 0; id < ps.nextId; id++) {
                    const p = await c.getPosition(id);
                    if (p.maturesAt !== 0 && p.expired === 0) weight += p.amount * WEIGHTS[p.tier];
                }
            }
            expect({ label, locked }).toEqual({ label, locked: s.lockedTotal });
            expect({ label, weight }).toEqual({ label, weight: (await stake.getStakeStream()).totalWeight });
        };

        let distributes = 0;
        let settles = 0;
        for (let step = 0; step < STEPS; step++) {
            const u = users[pick(users.length)];
            const c = childOf(u.address);
            const op = pick(6);
            if (op === 0) {
                await (await walletOf(u.address)).sendTransfer(u.getSender(), {
                    destination: stake.address, responseAddr: u.address, amount: BigInt(1 + pick(5000)) * P,
                    value: toNano('0.4'), forwardTonAmount: toNano('0.2'), forwardPayload: stakePayload(pick(4)),
                });
            } else if (op === 1) {
                const d = await treasury.getDistribution();
                if (d.lastDistributeTime === 0 || blockchain.now! >= d.lastDistributeTime + d.interval) {
                    await treasury.sendDistribute(deployer.getSender());
                    distributes++;
                }
            } else if (op === 2) {
                blockchain.now = blockchain.now! + 1 + pick(20_000);
            } else {
                const deployed = (await blockchain.getContract(c.address)).accountState?.type === 'active';
                if (deployed) {
                    const ps = await c.getPositions();
                    const id = pick(Math.max(1, ps.nextId));
                    const p = await c.getPosition(id);
                    // Read before send (CLAUDE.md driver rule): only legal moves go out.
                    if (p.maturesAt !== 0 && p.inFlight === 0) {
                        const matured = blockchain.now! >= p.maturesAt;
                        if (op === 3) await c.sendClaim(u.getSender(), { positionId: id });
                        else if (op === 4 && matured) await c.sendWithdraw(u.getSender(), { positionId: id });
                        else if (op === 4) await c.sendRelock(u.getSender(), { positionId: id, tier: Math.max(p.tier, pick(4)) });
                        else if (matured && p.expired === 0) await c.sendExpire(deployer.getSender(), { positionId: id });
                        settles++;
                    }
                }
            }
            await check(`st:${step}:op${op}`);
        }
        // Non-vacuity: the walk exercised the stream, not just the stakes.
        expect(distributes).toBeGreaterThan(0);
        expect(settles).toBeGreaterThan(0);
    }, 300_000);
});
