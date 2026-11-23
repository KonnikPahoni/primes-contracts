// TON PRIMES — §4.1's split is CLOSED AT 100%, under every unresolvable-line
// combination (GAUNTLET.md C4).
//
// CLAUDE.md states the invariant as: "The split is closed at 100%; unresolvable
// lines (no referral key, no tribute recipient) fall to the pool, never to the
// team (§3.1, §4.1)." Two suites are cited elsewhere in the repo as proving it —
// `DecompositionSolvency.spec.ts` and `FeeLines.spec.ts` — and both prove
// something real but adjacent: that each contract's DECLARED LIABILITY matches
// what it custodies. Neither adds the lines of a single mint up and requires the
// total to be exactly 1 GRAM, and neither varies the lines that can fail to
// resolve. (The now-deleted `PatronageEndToEnd.spec.ts` said as much in its
// D-23 block.)
//
// This suite is the direct statement. For one mint it measures every destination
// a nanoGRAM of the mint price can reach, and requires them to sum to MINT_PRICE
// with no slack — then repeats that across the matrix of lines that can fail to
// resolve.
//
// THE CLOSURE EQUATION, and where each term is observed:
//
//   MINT_PRICE  ==  dT                     ledger.getFloorNum()
//                                          (poolInjectionFinal, plus the tribute
//                                          divisor and flat-dividend remainders
//                                          that fold back into the pool)
//               +   d(tributeOwed)         ledger.getLiabilityBreakdown()
//                                          (§3.2's 80% divisor line, credited to
//                                          the cited primes' items)
//               +   d(unroutedHeld)        ledger.getLiabilityBreakdown()
//                                          (a divisor credit whose delivery
//                                          bounced — same line, retry lane)
//               +   d(divOutstanding)      ledger.getLiabilityBreakdown()
//                                          (§3.2's 20% flat dividend, accrued
//                                          against div_acc)
//               +   d(operatorPaidTotal)   ledger.getOperatorTotals()
//               +   d(treasuryPaidTotal)   (§4.1's 5% line — the governed
//                                          TREASURY's since D-152 — plus any
//                                          §6 point 2 forfeited tribute, which
//                                          D-100 point 6 splits 80/20 (58/42 since D-166)
//                                          treasury/operator. Two counters, one
//                                          term: the closure cares how much
//                                          left, not which pot it entered.)
//               +   referral               the residual, pinned below
//               +   GAS_OPS_AMOUNT         §4.1's 10%, which is not sent
//                                          anywhere: it stays on the ledger as
//                                          the operating balance `sweep_ops`
//                                          later draws its surplus from.
//
// WHY THE REFERRAL LINE IS THE RESIDUAL AND THAT IS NOT A CHEAT. Every other
// term is read from a get-method, independently of this arithmetic. So the
// residual is over-determined:
// it is required to be REFERRAL_AMOUNT exactly when the key resolves and 0
// exactly when it does not, and any nanoGRAM that went missing, was paid twice or
// was invented shows up here as a residual that matches neither. Reading the
// referral leg off the receiving wallet instead would measure
// `REFERRAL_AMOUNT - fwd_fee` and force a tolerance into the one assertion that
// must not have one.
//
// WHAT "UNRESOLVABLE" MEANS, line by line — all three vary across the matrix:
//   * referral — `referralKey == 0`, or a key that does not name an
//     already-minted number. Folds into the pool injection.
//   * tribute recipients — a PRIME mint cites no factors at all, so §3.2's whole
//     10% line has nobody to pay. Folds into the pool injection.
//
// D-106 DELETED A THIRD UNRESOLVABLE LINE. §4.1 had a patron line (φ₁ = 0.25 on
// a recruit's activation mint, φ₂ = 0.075 after, to a cumulative PATRON_CAP),
// with four states of its own — none / φ₁ / φ₂ / clipped / tombstoned — each of
// which had to fold into the pool when it could not resolve. The line is gone,
// so the matrix below is smaller and the closure equation has one term fewer.
//
// and the one named exception, asserted on every row rather than assumed:
//   * forfeited tribute (§6 point 2 / D-20 point 4) — a cited factor that is
//     still an unsold prime lot is paid down a FEE LINE, not to the pool
//     (D-100 point 6 splits it 80% to the governed treasury contract, 20% to the
//     operator; this suite reads the two counters as one term because closure is
//     about how much left, not about which pot it entered). Since D-152 moved
//     §4.1's 5% line onto the treasury too, that 42% remainder (D-166) is the ONLY
//     route by which an unpayable line reaches an address the team holds a key
//     to — and it is itemized here
//     through `getForfeited(p)` so that "never to the team" can be stated as an
//     equality on every row: once forfeiture is subtracted, the fee lines' take
//     is TREASURY_AMOUNT and nothing else, whichever lines resolved.
import { Blockchain, SandboxContract, TreasuryContract, createEmptyShardAccount } from '@ton/sandbox';
import { Address, Cell, toNano } from '@ton/core';
import '@ton/test-utils';
import { compile } from '@ton/blueprint';
import { PrimesLedger, FactorEntry } from '../wrappers/PrimesLedger';
import { PrimesRatchet } from '../wrappers/PrimesRatchet';
import { PrimesRegistrar } from '../wrappers/PrimesRegistrar';
import { PrimesCollection } from '../wrappers/PrimesCollection';
import { PrimesJettonMaster } from '../wrappers/PrimesJettonMaster';
import { PrimesMarket } from '../wrappers/PrimesMarket';
import { INVITE_GENESIS_VALUE_NANOTON, INVITE_SEND_FEE_NANOTON } from '../../shared/invites';

/** D-215: one sent invite costs the line its value plus the per-transfer fee allowance. */
const INVITE_SLOT_COST = INVITE_GENESIS_VALUE_NANOTON + INVITE_SEND_FEE_NANOTON;
import { testMarketConfig, acquirePrime, OPENING_HEAD } from './helpers/market';

/** §4.1's lines, from `primes_ledger.tolk`. params.json economics.*. */
const MINT_PRICE = toNano('1');
const TRIBUTE_AMOUNT = toNano('0.1'); // 10%
const TRIBUTE_DIVISOR_AMOUNT = toNano('0.08'); // §3.2's 80% half
const REFERRAL_AMOUNT = toNano('0.1'); // 10%
const TREASURY_AMOUNT = toNano('0.05'); // 5%
const GAS_OPS_AMOUNT = toNano('0.20'); // §4.1's gas & ops line, D-117 (sim-derived; SimCrossCheck pins it)

describe('TON PRIMES — §4.1: the split is closed at 100%, every unresolvable-line combination', () => {
    let blockchain: Blockchain;
    let deployer: SandboxContract<TreasuryContract>;
    let genesisScript: SandboxContract<TreasuryContract>;
    let treasuryWallet: SandboxContract<TreasuryContract>;
    let dedust: SandboxContract<TreasuryContract>;
    let payer: SandboxContract<TreasuryContract>;
    /** Stands in for any third-party address the suite needs (invite slots). */
    let bystander: SandboxContract<TreasuryContract>;

    let codes: Record<string, Cell>;
    let collection: SandboxContract<PrimesCollection>;
    let master: SandboxContract<PrimesJettonMaster>;
    let ledger: SandboxContract<PrimesLedger>;
    let ratchet: SandboxContract<PrimesRatchet>;
    let registrar: SandboxContract<PrimesRegistrar>;
    let book: SandboxContract<PrimesMarket>;

    beforeAll(async () => {
        codes = {
            item: await compile('PrimesItem'),
            collection: await compile('PrimesCollection'),
            jettonWallet: await compile('PrimesJettonWallet'),
            jettonMaster: await compile('PrimesJettonMaster'),
            ledger: await compile('PrimesLedger'),
            ratchet: await compile('PrimesRatchet'),
            registrar: await compile('PrimesRegistrar'),
            market: await compile('PrimesMarket'),
        };
    });

    /**
     * The full stack, with the market present because D-20 makes the Dutch lane
     * the only way a prime is acquired — and a prime mint is the "no tribute
     * recipient" row of the matrix, so this suite cannot skip it.
     *
     */
    async function deployStack() {
        blockchain = await Blockchain.create();
        blockchain.now = 1_770_000_000;
        deployer = await blockchain.treasury('deployer');
        genesisScript = await blockchain.treasury('genesisScript');
        treasuryWallet = await blockchain.treasury('treasury');
        dedust = await blockchain.treasury('dedust');
        payer = await blockchain.treasury('payer', { balance: toNano('100000') });
        bystander = await blockchain.treasury('bystander');

        collection = blockchain.openContract(
            PrimesCollection.createFromConfig(
                {
                    nextIndex: 2n,
                    itemCode: codes.item,
                    ledgerAddr: deployer.address,
                    genesisScriptAddr: genesisScript.address,
                },
                codes.collection
            )
        );
        await collection.sendDeploy(deployer.getSender(), toNano('5'));

        master = blockchain.openContract(
            PrimesJettonMaster.createFromConfig(
                {
                    ledgerAddr: deployer.address,
                    genesisScriptAddr: genesisScript.address,
                    walletCode: codes.jettonWallet,
                },
                codes.jettonMaster
            )
        );
        await master.sendDeploy(deployer.getSender(), toNano('5'));

        ledger = blockchain.openContract(
            PrimesLedger.createFromConfig(
                {
                    a: {
                        collectionAddr: collection.address,
                        jettonMasterAddr: master.address,
                        treasuryAddr: treasuryWallet.address,
                        itemCode: codes.item,
                    },
                    b: { genesisScriptAddr: genesisScript.address },
                },
                codes.ledger
            )
        );
        await ledger.sendDeploy(deployer.getSender(), toNano('20'));

        registrar = blockchain.openContract(
            PrimesRegistrar.createFromConfig({ genesisScriptAddr: genesisScript.address }, codes.registrar)
        );
        await registrar.sendDeploy(deployer.getSender(), toNano('5'));

        ratchet = blockchain.openContract(
            PrimesRatchet.createFromConfig(
                {
                    venueTimelockAddr: deployer.address,
                    genesisScriptAddr: genesisScript.address,
                    dedustNativeVault: dedust.address,
                    dedustPool: dedust.address,
                    primesJettonVault: dedust.address,
                },
                codes.ratchet
            )
        );
        await ratchet.sendDeploy(deployer.getSender(), toNano('10'));

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
        await ratchet.sendSetLedger(genesisScript.getSender(), { ledgerAddr: ledger.address, value: toNano('0.05') });
        await registrar.sendSetLedger(genesisScript.getSender(), { ledgerAddr: ledger.address, value: toNano('0.05') });
        await ledger.sendSetSinks(genesisScript.getSender(), {
            ratchetAddr: ratchet.address,
            registrarAddr: registrar.address,
            value: toNano('0.05'),
        });
        await ledger.sendGenesisSeed(genesisScript.getSender(), {
            seedT: toNano('1000'),
            seedS: 1_200_000_000_000_000n,
            seedHead: OPENING_HEAD,
            value: toNano('0.05'),
        });
        await ledger.sendSetPeers(genesisScript.getSender(), {
            marketAddr: book.address,
            bountyVaultAddr: treasuryWallet.address,
            value: toNano('0.05'),
        });
        // §6 point 0: nothing mints until Unity does.
        await ledger.sendIgnite(genesisScript.getSender(), { owner: deployer.address, value: toNano('0.3') });
    }

    // ------------------------------------------------------------------ //
    // The measurement
    // ------------------------------------------------------------------ //

    type Ledgers = {
        T: bigint;
        tributeOwed: bigint;
        unroutedHeld: bigint;
        divOutstanding: bigint;
        feeLinesPaid: bigint;
        forfeited: bigint;
        inviteLinePaid: bigint;
        premiumTreasuryPaid: bigint;
    };

    /**
     * Every destination the mint price can reach, in one reading.
     *
     * `forfeited` is summed over the primes the mint under test cites, because
     * §6 point 2's counter is per prime. A prime not cited cannot have its
     * counter moved by this mint, so the sum over the cited set is the whole
     * forfeiture — and reading it separately is what lets the treasury term be
     * split into "the 5% line" and "the named exception".
     */
    async function read(who: Address, citedPrimes: bigint[]): Promise<Ledgers> {
        const br = await ledger.getLiabilityBreakdown();
        const ops = await ledger.getOperatorTotals();
        let forfeited = 0n;
        for (const p of citedPrimes) forfeited += await ledger.getForfeited(p);
        return {
            T: await ledger.getFloorNum(),
            tributeOwed: br.tributeOwed,
            unroutedHeld: br.unroutedHeld,
            divOutstanding: br.divOutstanding,
            // D-100 point 6: two counters where there was one, because a
            // forfeit splits 58/42 (D-166) between the governed treasury contract and
            // the operator; D-152 then put §4.1's 5% line on the treasury side
            // of that pair, so the treasury counter now carries two terms and
            // the operator counter carries one. Their SUM is what
            // this identity needs — §4.1's closure is about how much of the mint
            // price left down a fee line, not about which of the team's two pots
            // it landed in, and the split between them is asserted where it
            // belongs, in FeeLines.spec.ts.
            feeLinesPaid: ops.operatorPaidTotal + ops.treasuryPaidTotal,
            forfeited,
            // D-101's invite line, as the ledger's own counter reports it:
            // `filled x (value + INVITE_SEND_FEE)` for the slots that were actually
            // FILLED (D-215; the fee part pays the transfers' own fees, and what it
            // overstates stays on the ledger balance for `sweep_ops`). A declared-but-unnamed slot never enters this figure,
            // which is the whole of decision 4 -- an unspent slot is not
            // refunded, credited or carried, it is simply never deducted.
            inviteLinePaid: (await ledger.getInviteSpend()).linePaid,
            // D-114: the treasury's PREMIUM_TREASURY_BPS share of every
            // auction clearing, its own counter for the same reason
            // `treasuryPaidTotal` is kept apart from `operatorPaidTotal` —
            // a distinct revenue event, read separately here because it is
            // on the premium side of the closure, not the §4.1 side.
            premiumTreasuryPaid: ops.premiumTreasuryPaidTotal,
        };
    }

    /**
     * Run `act` — exactly one mint — and assert §4.1's closure over it.
     *
     * Every term but the referral is read from its own get-method before the
     * residual arithmetic runs, so none of them is a free parameter of it; the
     * referral line is then what the residual is required to be.
     *
     * `act` may return a D-7 PREMIUM — the excess a Dutch or ascending lot
     * cleared above the nominal mint price. That is not one of §4.1's lines: it
     * is a separate leg that, since `DECISIONS.md` D-114 amended D-7, splits
     * `PREMIUM_TREASURY_BPS` / remainder between the governed treasury and the
     * ratchet as a pure floor step, so it is carried here as its own term (split
     * across `dT` and `dPremiumTreasury`) and the closure is against
     * `MINT_PRICE + premium`. Requiring the premium to show up whole, split only
     * between those two, is the assertion that it never leaks into a §4.1 fee
     * line.
     */
    async function assertClosed(
        who: Address,
        citedPrimes: bigint[],
        act: () => Promise<unknown>,
        expected: { referral: bigint; label: string; inviteLine?: bigint }
    ) {
        const L = expected.label;
        const before = await read(who, citedPrimes);
        // A mint helper returns its transaction result; a lot purchase returns the
        // premium it cleared above the nominal price. Only the latter is a term.
        const produced = await act();
        const premium = typeof produced === 'bigint' ? produced : 0n;
        const after = await read(who, citedPrimes);

        const dT = after.T - before.T;
        const dTribute = after.tributeOwed - before.tributeOwed;
        const dUnrouted = after.unroutedHeld - before.unroutedHeld;
        const dDiv = after.divOutstanding - before.divOutstanding;
        const dFeeLines = after.feeLinesPaid - before.feeLinesPaid;
        const dForfeited = after.forfeited - before.forfeited;
        // D-101: the invite line, from its own counter and BEFORE the residual
        // arithmetic runs, so it is a measured term of the closure and not a
        // free parameter of it.
        const inviteLine = after.inviteLinePaid - before.inviteLinePaid;
        expect({ L, inviteLine }).toEqual({ L, inviteLine: expected.inviteLine ?? 0n });
        // D-114: the premium's treasury half, measured the same way — a term
        // of the closure against `MINT_PRICE + premium`, not against §4.1's
        // own six lines (`feeLinesPaid` deliberately excludes it, above).
        const dPremiumTreasury = after.premiumTreasuryPaid - before.premiumTreasuryPaid;

        // §3.1/§4.1: "unresolvable lines fall to the pool, NEVER TO THE TEAM."
        // Stated as an equality on every row: strip §6 point 2's named exception
        // and what left down a fee line is the 5% line and nothing else,
        // whichever of the other lines resolved. Since D-152 that 5% is the
        // governed treasury's, so this equality no longer bounds the TEAM's
        // take — it bounds it far below itself, and the team's own bound is
        // the forfeit remainder asserted in FeeLines.spec.ts. A dead referral that leaked to a fee line would
        // show up right here.
        expect({ L, feesBeyondTheirLine: dFeeLines - dForfeited }).toEqual({
            L,
            feesBeyondTheirLine: TREASURY_AMOUNT,
        });
        // §6 point 2 is carved out of §3.2's 80% divisor half and can never
        // exceed it — the exception is bounded, not open-ended.
        expect({ L, forfeitBounded: dForfeited >= 0n && dForfeited <= TRIBUTE_DIVISOR_AMOUNT }).toEqual({
            L,
            forfeitBounded: true,
        });

        const accounted =
            dT + dTribute + dUnrouted + dDiv + dFeeLines + inviteLine + GAS_OPS_AMOUNT + dPremiumTreasury;
        const referral = MINT_PRICE + premium - accounted;

        // The residual IS the referral line — exactly, in nanoton, no tolerance.
        // Note the premium is on the OTHER side: it is D-7/D-114's leg, not
        // §4.1's, so it has to be accounted for (across `dT` AND
        // `dPremiumTreasury`, its two destinations since D-114) before the
        // residual can mean anything.
        expect({ L, referral }).toEqual({ L, referral: expected.referral });
        // and therefore the lines sum to the mint price (plus any premium) with
        // nothing left over.
        expect({ L, total: accounted + referral }).toEqual({ L, total: MINT_PRICE + premium });
    }

    /**
     * The head walks 4 -> 6 -> 8 -> 9 under D-20 (5 and 7 are primes and are
     * walked past, not minted). Naming the factor lists per head rather than
     * hardcoding `n` at a call site is the same discipline the other suites use:
     * the mint is strictly sequential, so a test that names a number goes stale
     * the moment an earlier test mints one more.
     */
    const FACTORS: Record<string, FactorEntry[]> = {
        '4': [{ prime: 2n, exponent: 2, s: 1n }],
        '6': [
            { prime: 2n, exponent: 1, s: 1n },
            { prime: 3n, exponent: 1, s: 1n },
        ],
        '8': [{ prime: 2n, exponent: 3, s: 1n }],
        '9': [{ prime: 3n, exponent: 2, s: 1n }],
    };

    /** The head, its factor list, and the primes it cites. */
    async function headMint() {
        const n = await ledger.getHead();
        const factors = FACTORS[n.toString()];
        expect({ head: n.toString(), known: factors !== undefined }).toEqual({
            head: n.toString(),
            known: true,
        });
        return { n, factors, cited: factors.map((f) => f.prime) };
    }

    async function mintHead(who: SandboxContract<TreasuryContract>, n: bigint, factors: FactorEntry[], referralKey = 0) {
        return await ledger.sendMint(who.getSender(), {
            n,
            kind: 0,
            factors,
            referralKey,
            beneficiary: null,
            value: MINT_PRICE,
        });
    }

    // ------------------------------------------------------------------ //
    // The matrix
    // ------------------------------------------------------------------ //

    describe('the referral line, resolved and unresolvable', () => {
        it('composite, NO referral key — the dead line folds into the pool', async () => {
            await deployStack();
            const { n, factors, cited } = await headMint();
            await assertClosed(payer.address, cited, () => mintHead(payer, n, factors), {
                referral: 0n,
                label: 'composite/no-referral',
            });
        });

        it('composite, VALID referral key', async () => {
            await deployStack();
            // GAUNTLET V7: key 2 (walked past at genesis, never sold) no longer
            // qualifies — see the unsold-prime case below, which is exactly the
            // bug this test used to paper over by using a walked-but-unsold
            // prime as its "valid" example. A genuinely resolvable key is one
            // that has actually been MINTED: mint the opening head first (with
            // no referral of its own), then cite IT as the referral key on the
            // next mint.
            const first = await headMint();
            await mintHead(payer, first.n, first.factors);
            const { n, factors, cited } = await headMint();
            await assertClosed(payer.address, cited, () => mintHead(payer, n, factors, Number(first.n)), {
                referral: REFERRAL_AMOUNT,
                label: 'composite/referral',
            });
        });

        it('composite, referral key naming an UNSOLD PRIME — unresolvable (GAUNTLET V7), folds to the pool', async () => {
            await deployStack();
            // 2 is marked eligible at genesis (the walk to `OPENING_HEAD`
            // passes it) but was never actually minted — primes are never
            // minted at the head at all (D-20) — so under the pre-V7 check
            // (`referralKey < storage.head`) this looked "valid" and sent
            // REFERRAL_AMOUNT to primeItemAddress(2), which has no item
            // deployed at it and never will unless/until 2 is sold. Exactly
            // the bug this item closes.
            const { n, factors, cited } = await headMint();
            await assertClosed(payer.address, cited, () => mintHead(payer, n, factors, 2), {
                referral: 0n,
                label: 'composite/referral-unsold-prime',
            });
        });

        it('composite, referral key naming a RESERVED (auctioned) composite — unresolvable (GAUNTLET V7), folds to the pool', async () => {
            await deployStack();
            // A composite far ahead of the head, marked reserved by the market
            // (mirroring what `open_lot` does) but never settled — so, like the
            // unsold prime above, it has no item deployed at it. D-45's own bit
            // is permanent and does not distinguish "reserved and pending" from
            // "reserved and settled", which is why this fix is conservative
            // rather than exact: see primes_ledger.tolk's own note on
            // `referralValid`.
            const RESERVED_N = 5000n;
            const RESERVED_FACTORS: FactorEntry[] = [
                { prime: 2n, exponent: 3, s: 1n },
                { prime: 5n, exponent: 4, s: 2n },
            ]; // 5000 = 2^3 * 5^4
            const { p0 } = await book.getLotPriceFrom(RESERVED_N, RESERVED_FACTORS);
            await book.sendOpenLot(payer.getSender(), {
                n: RESERVED_N,
                kind: 0,
                factors: RESERVED_FACTORS,
                beneficiary: null,
                referralKey: 0,
                value: p0 + toNano('0.3'),
            });
            expect(await ledger.isNumberOffHead(RESERVED_N)).toBe(1);

            const { n, factors, cited } = await headMint();
            await assertClosed(payer.address, cited, () => mintHead(payer, n, factors, Number(RESERVED_N)), {
                referral: 0n,
                label: 'composite/referral-reserved-unsettled',
            });
        });

        it('composite, referral key AHEAD of the head — unresolvable, folds to the pool', async () => {
            await deployStack();
            const { n, factors, cited } = await headMint();
            await assertClosed(
                payer.address,
                cited,
                () => mintHead(payer, n, factors, Number(n) + 5),
                { referral: 0n, label: 'composite/referral-ahead-of-head' }
            );
        });
    });

    describe('no tribute recipient at all — the prime lane (§5.1, D-20)', () => {
        /**
         * 2 rests far above the universal 1 GRAM clamp, and since D-99 for one
         * reason rather than two: its NPV. It is the only even prime and earns
         * tribute for the whole life of the game, so `0.5 x NPV(2)` governs its
         * floor outright. The rarity TIER that used to lift it, and D-68's crown
         * curve before that, are both deleted — D-88 point 1 had already made
         * resting above MINT_PRICE the rule for every prime rather than a named
         * exception, and D-99 removed the last thing that was a lift rather than
         * a price. So everything this clears above the nominal price is a real
         * D-7 premium and not a decay bug.
         *
         * The premium is read off the lot rather than asserted, which is why
         * D-68 moved it by two orders of magnitude without touching this test's
         * arithmetic: what is being tested is CLOSURE, not the price.
         *
         * It is carried as its own term rather than engineered away, and that
         * makes this row do double duty: a premium the closure has to account for
         * is a stronger test than one that is absent, because it forces the
         * assertion that D-7's leg reaches the pool WHOLE and touches none of
         * §4.1's six lines on the way.
         */
        async function buyPrimeTwo(): Promise<bigint> {
            const acq = await acquirePrime({ blockchain, market: book }, payer, 2n);
            expect(acq.premium).toBeGreaterThan(0n);
            return acq.premium;
        }

        it('closes at 100% with the tribute line unresolvable, and the treasury still takes only 5%', async () => {
            await deployStack();
            await assertClosed(
                payer.address,
                [], // a prime cites nothing, so nothing can forfeit
                buyPrimeTwo,
                { referral: 0n, label: 'prime/no-tribute-recipient' }
            );
        });

        it('the pool got the tribute line ON TOP of β — the fold is visible, not inferred', async () => {
            await deployStack();
            const before = await read(payer.address, []);
            const premium = await buyPrimeTwo();
            const after = await read(payer.address, []);

            // Neither half of §3.2 moved: no divisor credit, no flat accrual.
            // A prime cites no factors, so the line has nobody to pay.
            expect(after.tributeOwed - before.tributeOwed).toBe(0n);
            expect(after.divOutstanding - before.divOutstanding).toBe(0n);
            // So the pool's step is β PLUS the whole tribute line — and the
            // D-7/D-114 premium on top of both, split: since D-114 amended
            // D-7, only PREMIUM_TREASURY_BPS's complement (the ratchet's
            // half) reaches the pool; the rest goes to the governed treasury,
            // asserted separately below.
            const beta = MINT_PRICE - TRIBUTE_AMOUNT - TREASURY_AMOUNT - GAS_OPS_AMOUNT;
            const premiumTreasuryShare = (premium * 5000n) / 10000n; // PREMIUM_TREASURY_BPS
            const premiumRatchetShare = premium - premiumTreasuryShare;
            expect(after.T - before.T).toBe(beta + TRIBUTE_AMOUNT + premiumRatchetShare);
            expect(after.premiumTreasuryPaid - before.premiumTreasuryPaid).toBe(premiumTreasuryShare);
            // §5.1: the treasury's 5% is charged on a prime exactly as on a
            // composite — the premium's treasury half is D-114's own leg, not
            // this one, so this line does not enlarge for it.
            expect(after.feeLinesPaid - before.feeLinesPaid).toBe(TREASURY_AMOUNT);
        });

        it('a Dutch buyer\'s fee margin comes back as change, never as premium (audit Low)', async () => {
            await deployStack();
            const before = await read(payer.address, []);
            const margin = toNano('0.5');
            const balanceBefore = await payer.getBalance();
            const acq = await acquirePrime({ blockchain, market: book }, payer, 2n, { margin });
            const after = await read(payer.address, []);
            // The premium is the clock's price above MINT_PRICE + RES_GAS, and the
            // margin is in none of it.
            expect(acq.premium).toBeGreaterThan(0n);
            expect(after.premiumTreasuryPaid - before.premiumTreasuryPaid).toBe((acq.premium * 5000n) / 10000n);
            // The payer is out the price, the 0.2 head-lot open and gas -- not the margin.
            expect(balanceBefore - (await payer.getBalance())).toBeLessThan(acq.price - margin + toNano('0.35'));
        });
    });

    describe('the one named exception: §6 point 2 forfeited tribute', () => {
        it('a cited factor that is still an UNSOLD prime lot pays the treasury, and only that', async () => {
            await deployStack();
            // The head is 4 = 2², and prime 2 has never been bought off the Dutch
            // lane, so its share of the divisor line is forfeit and goes to the
            // treasury rather than to the item or the pool. Every other row of
            // this matrix runs through `assertClosed`, which subtracts exactly
            // this counter before checking the team's take — this test is what
            // proves the counter is non-zero there, so that subtraction is doing
            // real work rather than removing a zero.
            const { n, factors, cited } = await headMint();
            const before = await read(payer.address, cited);
            await mintHead(payer, n, factors);
            const after = await read(payer.address, cited);

            const dForfeited = after.forfeited - before.forfeited;
            expect(dForfeited).toBeGreaterThan(0n);
            expect(after.feeLinesPaid - before.feeLinesPaid).toBe(TREASURY_AMOUNT + dForfeited);
            // Forfeiture is carved out of the divisor half, so the divisor line's
            // three destinations — item credit, forfeiture, pool remainder —
            // account for all 0.08 of it and nothing else.
            const credited = after.tributeOwed - before.tributeOwed + (after.unroutedHeld - before.unroutedHeld);
            expect(credited + dForfeited).toBeLessThanOrEqual(TRIBUTE_DIVISOR_AMOUNT);
        });

        it('a prime that HAS been bought forfeits nothing on a later mint that cites it', async () => {
            await deployStack();
            await acquirePrime({ blockchain, market: book }, payer, 2n, { atFloor: true });
            const { n, factors, cited } = await headMint();
            const before = await read(payer.address, cited);
            await mintHead(payer, n, factors);
            const after = await read(payer.address, cited);

            // 4 = 2² cites only 2, which is now sold: the divisor line has a real
            // recipient, so nothing forfeits and the treasury takes its 5% flat.
            expect(after.forfeited - before.forfeited).toBe(0n);
            expect(after.feeLinesPaid - before.feeLinesPaid).toBe(TREASURY_AMOUNT);
            expect(after.tributeOwed - before.tributeOwed).toBeGreaterThan(0n);
        });

        it('a SOLD prime whose item account is gone forfeits nothing: the credit parks for retry_credit (audit Low)', async () => {
            await deployStack();
            await acquirePrime({ blockchain, market: book }, payer, 2n, { atFloor: true });
            // A real owner's item frozen or deleted for rent: the credit's compute is
            // skipped, exactly as for an ownerless prime. Behind the frontier and
            // sold, it is the owner's, not the treasury's and operator's.
            const item2 = await ledger.getItemAddress(2n);
            await blockchain.setShardAccount(item2, createEmptyShardAccount(item2));
            const { n, factors, cited } = await headMint();
            const before = await read(payer.address, cited);
            await mintHead(payer, n, factors);
            const after = await read(payer.address, cited);

            expect(after.forfeited - before.forfeited).toBe(0n);
            expect(after.feeLinesPaid - before.feeLinesPaid).toBe(TREASURY_AMOUNT);
            expect(after.unroutedHeld - before.unroutedHeld).toBeGreaterThan(0n);
        });
    });

    // ------------------------------------------------------------------ //
    // D-202 — the SEVENTH LINE, and the slot that is declared and not spent
    //
    // The invite line is the only one whose SIZE the minter chooses, and the
    // only one where the interesting case is a subtraction that does NOT
    // happen. `count` is what the minter declares; the deduction is
    // `filled x (value + INVITE_SEND_FEE)`, and a declared-but-unnamed slot is never
    // deducted at all -- so it stays inside the residual, which is beta.
    //
    // The closure harness above is what makes that checkable rather than
    // asserted: it accounts every destination the 1 GRAM can reach and requires
    // the remainder to be exactly the referral line. If an unspent slot were
    // refunded, credited, held or paid to the operator, the referral residual
    // would come out wrong by 0.101 GRAM per slot and every row below would fail.
    // ------------------------------------------------------------------ //
    describe('the invite line, funded and short (D-202)', () => {
        async function mintInvited(
            n: bigint,
            factors: FactorEntry[],
            count: number,
            slots: number[]
        ) {
            const addresses = new Map<number, Address>();
            for (const slot of slots) addresses.set(slot, bystander.address);
            return await ledger.sendMint(payer.getSender(), {
                n,
                kind: 0,
                factors,
                referralKey: 0,
                beneficiary: null,
                invites: { count, addresses },
                value: MINT_PRICE,
            });
        }

        it('three declared and three named: the line is 3 x (0.1 + fee) GRAM and the split still closes', async () => {
            await deployStack();
            const { n, factors, cited } = await headMint();
            await assertClosed(
                payer.address,
                cited,
                () => mintInvited(n, factors, 3, [1, 2, 3]),
                {
                    label: 'invited x3',
                    // No referral key on these mints, so §4.1's referral line
                    // is unresolvable and folds into the pool — it is already
                    // inside `dT`, and the residual is therefore zero. Which
                    // makes this the sharper row: with the referral line at
                    // zero, the invite line is the ONLY thing standing
                    // between the injection and the named ones.
                    referral: 0n,
                    inviteLine: 3n * INVITE_SLOT_COST,
                }
            );
        });

        it('three declared and ONE named: the line is one slot — the other two stayed in β', async () => {
            await deployStack();
            const { n, factors, cited } = await headMint();
            await assertClosed(
                payer.address,
                cited,
                () => mintInvited(n, factors, 3, [2]),
                {
                    label: 'invited 3 declared / 1 named',
                    referral: 0n,
                    inviteLine: 1n * INVITE_SLOT_COST,
                }
            );
            // ...and the ledger says so in its own words: two slots to the
            // pool, on a get-method a reader can call (§9.1).
            const spend = await ledger.getInviteSpend();
            expect({ funded: spend.slotsFunded, sent: spend.transfersSent, toPool: spend.slotsToPool }).toEqual(
                { funded: 3n, sent: 1n, toPool: 2n }
            );
        });

        it('β is strictly larger on the short list than on the full one — by exactly the two slots', async () => {
            // The two rows above each close at 100%, which proves nothing left
            // the mint unaccounted. This one proves WHERE the difference went:
            // the same number, minted twice on two identical fixtures, differing
            // only in how many slots were named.
            await deployStack();
            const full = await headMint();
            const tBeforeFull = await ledger.getFloorNum();
            await mintInvited(full.n, full.factors, 3, [1, 2, 3]);
            const dTFull = (await ledger.getFloorNum()) - tBeforeFull;

            await deployStack();
            const short = await headMint();
            expect(short.n).toBe(full.n);
            const tBeforeShort = await ledger.getFloorNum();
            await mintInvited(short.n, short.factors, 3, [2]);
            const dTShort = (await ledger.getFloorNum()) - tBeforeShort;

            // Two unspent slots, and `T` is larger by exactly their value.
            // Not "roughly", not "at least": the unspent slot has no other
            // destination in the contract, so the difference is exact.
            expect(dTShort - dTFull).toBe(2n * INVITE_SLOT_COST);
        });
    });
});
