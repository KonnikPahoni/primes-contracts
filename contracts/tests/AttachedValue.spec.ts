// TON PRIMES — D5: insufficient attached value. Every arm completes or bounces
// cleanly, and never half-applies (GAUNTLET.md D5).
//
// TWO PROPERTIES, AND THE ITEM NAMES THE SECOND ONE
//
// D5's own text points at P3.7's `sweep_ops` finding as "this class", and that
// finding is not about UNDER-payment at all — it is that the swept amount must
// not depend on the permissionless caller's own attached margin. So the class is
// wider than the heading, and both halves are tested here:
//
//   UNDER-funded — the arm must leave NO partial state. The dangerous shape is a
//     handler that mutates storage and then discovers it cannot pay for the
//     message that delivers the effect: state advanced, effect never delivered.
//     Asserted on a state vector rather than an exit code, for the same reason
//     D2 does it — a handler that "succeeds" while half-applying throws nothing.
//
//   OVER-funded — the arm's EFFECT must not scale with the money attached to it.
//     A split computed from `in.valueCoins` instead of from `MINT_PRICE` would
//     pass every closure test in the repo (the total would still be internally
//     consistent) and would let anyone inflate the floor, or their own rebate, by
//     overpaying. This is the half that has no exit code at all to catch it.
//
// WHAT THIS FOUND. The two lanes treat an overpayment DIFFERENTLY, and both are
// deliberate: the ledger's mint prices from the constant `MINT_PRICE`, keeps up to
// MINT_PRICE + MINT_MARGIN as before (so a small pad reaches the §4.1 gas-&-ops
// line and, above the reserve, the permissionless sweep) and, since D-109, refunds
// anything past that ceiling straight back to the sender rather than retaining it;
// the market charges `in.valueCoins` rather than the quoted price, so margin on a
// lot becomes D-7 premium and goes to the pool. Same word, two destinations for a
// modest overpayment, a third (the sender's own pocket) for a large one. Both
// lanes are pinned below so neither drifts into the other.
import { Blockchain, SandboxContract, TreasuryContract } from '@ton/sandbox';
import { Cell, toNano } from '@ton/core';
import '@ton/test-utils';
import { compile } from '@ton/blueprint';
import { PrimesLedger, FactorEntry } from '../wrappers/PrimesLedger';
import { PrimesRatchet } from '../wrappers/PrimesRatchet';
import { PrimesRegistrar } from '../wrappers/PrimesRegistrar';
import { PrimesCollection } from '../wrappers/PrimesCollection';
import { PrimesJettonMaster } from '../wrappers/PrimesJettonMaster';

const MINT_PRICE = toNano('1');
const TREASURY_AMOUNT = toNano('0.05');
const GAS_OPS_AMOUNT = toNano('0.20'); // §4.1's gas & ops line, D-117 (sim-derived; SimCrossCheck pins it)
const TRIBUTE_AMOUNT = toNano('0.1');
const BETA = MINT_PRICE - TRIBUTE_AMOUNT - TREASURY_AMOUNT - GAS_OPS_AMOUNT;
const FACTORS_4: FactorEntry[] = [{ prime: 2n, exponent: 2, s: 1n }];

describe('TON PRIMES — D5: attached value cannot half-apply an arm, nor inflate its effect', () => {
    let blockchain: Blockchain;
    let deployer: SandboxContract<TreasuryContract>;
    let genesisScript: SandboxContract<TreasuryContract>;
    let treasuryWallet: SandboxContract<TreasuryContract>;
    let player: SandboxContract<TreasuryContract>;
    let codes: Record<string, Cell>;
    let ledger: SandboxContract<PrimesLedger>;
    let ratchet: SandboxContract<PrimesRatchet>;
    let registrar: SandboxContract<PrimesRegistrar>;

    beforeAll(async () => {
        codes = {
            item: await compile('PrimesItem'),
            collection: await compile('PrimesCollection'),
            jettonWallet: await compile('PrimesJettonWallet'),
            jettonMaster: await compile('PrimesJettonMaster'),
            ledger: await compile('PrimesLedger'),
            ratchet: await compile('PrimesRatchet'),
            registrar: await compile('PrimesRegistrar'),
        };
    });

    beforeEach(async () => {
        blockchain = await Blockchain.create();
        blockchain.now = 1_770_000_000;
        deployer = await blockchain.treasury('deployer');
        genesisScript = await blockchain.treasury('genesisScript');
        treasuryWallet = await blockchain.treasury('treasury');
        player = await blockchain.treasury('player', { balance: toNano('500') });

        const collection = blockchain.openContract(
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
        const master = blockchain.openContract(
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
        ratchet = blockchain.openContract(
            PrimesRatchet.createFromConfig(
                {
                    venueTimelockAddr: deployer.address,
                    genesisScriptAddr: genesisScript.address,
                    dedustNativeVault: deployer.address,
                    dedustPool: deployer.address,
                    primesJettonVault: deployer.address,
                },
                codes.ratchet
            )
        );
        await ratchet.sendDeploy(deployer.getSender(), toNano('10'));
        registrar = blockchain.openContract(
            PrimesRegistrar.createFromConfig({ genesisScriptAddr: genesisScript.address }, codes.registrar)
        );
        await registrar.sendDeploy(deployer.getSender(), toNano('5'));

        await ratchet.sendSetLedger(genesisScript.getSender(), { ledgerAddr: ledger.address, value: toNano('0.05') });
        await registrar.sendSetLedger(genesisScript.getSender(), { ledgerAddr: ledger.address, value: toNano('0.05') });
        await ledger.sendSetSinks(genesisScript.getSender(), {
            ratchetAddr: ratchet.address,
            registrarAddr: registrar.address,
            value: toNano('0.05'),
        });
        await collection.sendSetLedger(genesisScript.getSender(), { ledgerAddr: ledger.address, value: toNano('0.05') });
        await master.sendSetLedger(genesisScript.getSender(), { ledgerAddr: ledger.address, value: toNano('0.05') });
        await master.sendSealAuthority(genesisScript.getSender(), { value: toNano('0.05') });
        await ledger.sendGenesisSeed(genesisScript.getSender(), {
            seedT: toNano('1000'),
            seedS: 1_200_000_000_000_000n,
            seedHead: 4n,
            value: toNano('0.05'),
        });
        await ledger.sendIgnite(genesisScript.getSender(), { owner: deployer.address, value: toNano('0.3') });
    });

    /** The declared state that must not half-move. Balances excluded — gas is spent either way. */
    async function snapshot(): Promise<Record<string, string>> {
        const br = await ledger.getLiabilityBreakdown();
        const ops = await ledger.getOperatorTotals();
        return {
            T: (await ledger.getFloorNum()).toString(),
            S: (await ledger.getFloorDen()).toString(),
            head: (await ledger.getHead()).toString(),
            pi: String(await ledger.getPrimesCount()),
            divAcc: (await ledger.getDivAcc()).toString(),
            tributeOwed: br.tributeOwed.toString(),
            divOutstanding: br.divOutstanding.toString(),
            // D-100 point 6 split this counter in two, because a §6 point 2
            // forfeit divides 58/42 (D-166) between the governed treasury contract and
            // the operator; D-152 then put §4.1's 5% line on the treasury side,
            // so `treasuryPaidTotal` carries two terms and `operatorPaidTotal`
            // carries the 42% remainder alone. Both halves are recorded here,
            // and the sum is what the "attached value changes nothing" identity
            // below reads: the question is whether a fee line moved by more
            // than its rate, not which pot it entered. The split itself is
            // asserted in FeeLines.spec.ts.
            operatorPaid: ops.operatorPaidTotal.toString(),
            treasuryPaid: ops.treasuryPaidTotal.toString(),
            feeLinesPaid: (ops.operatorPaidTotal + ops.treasuryPaidTotal).toString(),
            opsSwept: ops.opsSweptTotal.toString(),
            pending: (await ratchet.getPending()).toString(),
            swapped: (await ratchet.getSwapped()).toString(),
        };
    }

    const mint = (value: bigint) =>
        ledger.sendMint(player.getSender(), {
            n: 4n,
            kind: 0,
            factors: FACTORS_4,
            referralKey: 0,
            beneficiary: null,
            value,
        });

    // ------------------------------------------------------------------ //
    // Under-funded: refuse whole, never half
    // ------------------------------------------------------------------ //

    describe('under-funded arms leave no partial state', () => {
        it('a mint one nanoton short of the price changes nothing at all', async () => {
            // The boundary, not a token underpayment: `MINT_PRICE - 1` is the
            // largest value the guard must still refuse, and it is the value a
            // fee-margin miscalculation actually produces. CLAUDE.md's own
            // on-chain rule exists because of this edge.
            const before = await snapshot();
            const r = await mint(MINT_PRICE - 1n);
            // D-191 point 1: refused by the minter card, before it touches the
            // standing or forwards anything to the ledger.
            expect(r.transactions).toHaveTransaction({
                to: await ledger.getMinterCardAddress(player.address),
                success: false,
                exitCode: 103, // insufficient_value
            });
            expect(r.transactions).not.toHaveTransaction({ to: ledger.address });
            expect(await snapshot()).toEqual(before);
        });

        it('a mint at a fraction of the price changes nothing at all', async () => {
            const before = await snapshot();
            await mint(toNano('0.4'));
            expect(await snapshot()).toEqual(before);
        });

        it('a mint with almost nothing attached changes nothing at all', async () => {
            // Small enough that the handler could not pay for its own outbound
            // messages even if it wanted to — the case where "mutate then fail to
            // send" would show up if it existed.
            const before = await snapshot();
            await mint(toNano('0.01'));
            expect(await snapshot()).toEqual(before);
        });

        it('an under-funded ledger→ratchet hop cannot credit `pending` without the GRAM', async () => {
            // The clearing handler asserts `valueCoins >= amount + RATCHET_HOP_GAS`
            // precisely so a message that did not carry its money cannot inflate
            // the floor. Fired from a wrong sender it fails on that gate first,
            // so this asserts the state property rather than the exit code —
            // which is the honest assertion available from outside.
            const before = await snapshot();
            await ledger.sendSyncHead(player.getSender(), { value: 1n });
            expect(await snapshot()).toEqual(before);
        });

        it('a flush with no gas attached leaves `pending` and `swapped` untouched', async () => {
            await mint(MINT_PRICE);
            const before = await snapshot();
            await ratchet.sendFlush(player.getSender(), { value: 1n });
            const after = await snapshot();
            expect(after.pending).toBe(before.pending);
            expect(after.swapped).toBe(before.swapped);
        });
    });

    // ------------------------------------------------------------------ //
    // Over-funded: the effect is priced, not paid
    // ------------------------------------------------------------------ //

    describe('over-funded arms produce exactly the same effect', () => {
        /** The declared deltas a mint produces, so two mints can be compared. */
        async function mintDeltas(value: bigint) {
            const before = await snapshot();
            const r = await mint(value);
            expect(r.transactions).toHaveTransaction({ to: ledger.address, success: true });
            const after = await snapshot();
            return {
                dT: BigInt(after.T) - BigInt(before.T),
                dS: BigInt(after.S) - BigInt(before.S),
                dFeeLines: BigInt(after.feeLinesPaid) - BigInt(before.feeLinesPaid),
                dTribute: BigInt(after.tributeOwed) - BigInt(before.tributeOwed),
                dDiv: BigInt(after.divOutstanding) - BigInt(before.divOutstanding),
                dPending: BigInt(after.pending) - BigInt(before.pending),
            };
        }

        it('a mint at 1 GRAM and a mint at 50 GRAM move the protocol identically', async () => {
            // THE assertion of this file. A split computed from `in.valueCoins`
            // rather than from `MINT_PRICE` would pass every closure test in the
            // repo — the total would still reconcile — while letting anyone
            // inflate the floor, or their own rebate, simply by overpaying.
            // Nothing throws in that world; only this comparison catches it.
            const forfeitedAtStart = (await ledger.getForfeited(2n)) + (await ledger.getForfeited(3n));
            const cheap = await mintDeltas(MINT_PRICE);
            const cheapForfeited =
                (await ledger.getForfeited(2n)) + (await ledger.getForfeited(3n)) - forfeitedAtStart;
            const forfeitedBefore = (await ledger.getForfeited(2n)) + (await ledger.getForfeited(3n));
            // The head has moved on, so the second mint is a different number
            // with a different factor structure. Compare the PRICED components:
            // the treasury line is the cleanest, being a flat constant.
            const rich = await (async () => {
                const n = await ledger.getHead();
                const before = await snapshot();
                const r = await ledger.sendMint(player.getSender(), {
                    n,
                    kind: 0,
                    factors: [{ prime: 2n, exponent: 1, s: 1n }, { prime: 3n, exponent: 1, s: 1n }],
                    referralKey: 0,
                    beneficiary: null,
                    value: toNano('50'),
                });
                expect(r.transactions).toHaveTransaction({ to: ledger.address, success: true });
                const after = await snapshot();
                // §6 point 2 forfeiture also lands on a fee line, so it has to
                // come out before the 5% line is visible — the same
                // `dFeeLines - dForfeited == TREASURY_AMOUNT` identity C4 uses.
                // n = 6 cites 2 and 3, both unsold at genesis, so the WHOLE
                // divisor half is forfeit here and the raw treasury delta is
                // 0.13 rather than 0.05.
                let forfeited = 0n;
                for (const p of [2n, 3n]) forfeited += await ledger.getForfeited(p);
                return {
                    dFeeLines: BigInt(after.feeLinesPaid) - BigInt(before.feeLinesPaid),
                    forfeited: forfeited - forfeitedBefore,
                    dPending: BigInt(after.pending) - BigInt(before.pending),
                    dT: BigInt(after.T) - BigInt(before.T),
                };
            })();

            // The treasury takes its 5% and not a nanoton more, on a mint that
            // attached fifty times the price — once §6 point 2's forfeiture,
            // which is a function of WHICH primes were cited and not of what was
            // attached, is separated out.
            expect(rich.dFeeLines - rich.forfeited).toBe(TREASURY_AMOUNT);
            expect(cheap.dFeeLines - cheapForfeited).toBe(TREASURY_AMOUNT);
            // And the pool's step is bounded by the mint price's share, not by
            // what was attached: β plus at most the whole tribute line in dust
            // and folds — never the 49 GRAM of margin.
            expect(rich.dT).toBeLessThanOrEqual(BETA + TRIBUTE_AMOUNT);
            expect(rich.dPending).toBe(rich.dT);
        });

        it('D-109: the 49 GRAM of margin reaches neither the pool nor the ledger — it comes straight back to the sender', async () => {
            // Where the excess goes is a real design fact and worth pinning
            // rather than leaving to be discovered. The ledger prices from the
            // constant `MINT_PRICE`; anything sent past `MINT_PRICE +
            // MINT_MARGIN` (1.5 GRAM) is refunded whole, so a fat-fingered 50 GRAM
            // mint funds nobody — not the pool, not the ledger's own gas-&-ops
            // line via the sweep, and not the operator.
            //
            // Note the contrast with the MARKET, which charges `in.valueCoins`
            // rather than the quoted price, so margin on a lot becomes D-7
            // premium and goes to the pool. Same overpayment, two lanes, both
            // deliberate — pinned here so neither drifts into the other.
            const before = await snapshot();
            const balBefore = (await blockchain.getContract(ledger.address)).balance;
            const playerBefore = await player.getBalance();
            const r = await mint(toNano('50'));
            const after = await snapshot();
            const balAfter = (await blockchain.getContract(ledger.address)).balance;
            const playerAfter = await player.getBalance();

            // The pool did NOT receive the margin.
            expect(BigInt(after.T) - BigInt(before.T)).toBeLessThanOrEqual(BETA + TRIBUTE_AMOUNT);
            // Nor did the ledger's own balance — it grew by roughly what an
            // ordinary MINT_PRICE mint leaves behind (the gas-&-ops line, minus
            // this transaction's own hop fees), not by tens of GRAM.
            expect(balAfter - balBefore).toBeLessThan(toNano('1'));
            // The refund landed on the sender: a real outbound message, and the
            // sender is out only MINT_PRICE + MINT_MARGIN plus dust, not the
            // full 50 GRAM attached.
            expect(r.transactions).toHaveTransaction({ from: ledger.address, to: player.address, success: true });
            const netCost = playerBefore - playerAfter;
            expect(netCost).toBeGreaterThanOrEqual(MINT_PRICE);
            expect(netCost).toBeLessThan(toNano('1.6')); // MINT_PRICE + MINT_MARGIN + dust
        });

        it('an over-funded sweep pays the same as a minimally-funded one (P3.7)', async () => {
            // The finding D5's own text names. `sweep_ops` is permissionless, so
            // its caller attaches whatever they like; the swept amount is
            // `balance - liability - SWEEP_GAS` and must not move because the
            // caller was generous. Otherwise a caller could inflate the ops
            // payout by pre-funding the contract through the very call.
            await mint(MINT_PRICE);
            const beforeA = (await ledger.getOperatorTotals()).opsSweptTotal;
            await ledger.sendSweepOps(player.getSender(), { value: toNano('0.05') });
            const sweptSmall = (await ledger.getOperatorTotals()).opsSweptTotal - beforeA;

            // Re-mint to rebuild a surplus, then sweep with a fat margin.
            const n = await ledger.getHead();
            await ledger.sendMint(player.getSender(), {
                n,
                kind: 0,
                factors: [{ prime: 2n, exponent: 1, s: 1n }, { prime: 3n, exponent: 1, s: 1n }],
                referralKey: 0,
                beneficiary: null,
                value: MINT_PRICE,
            });
            const beforeB = (await ledger.getOperatorTotals()).opsSweptTotal;
            await ledger.sendSweepOps(player.getSender(), { value: toNano('20') });
            const sweptFat = (await ledger.getOperatorTotals()).opsSweptTotal - beforeB;

            // Neither sweep may have paid out the caller's own margin. Both are
            // below the reserve here, so both are zero — and the assertion that
            // matters is that the FAT one did not become non-zero because of the
            // 20 GRAM attached to it.
            expect(sweptFat).toBe(sweptSmall);
        });
    });
});
