// TON PRIMES — D9: storage-fee starvation of a long-lived contract
// (GAUNTLET.md D9).
//
// TON charges rent per cell per second, deducted at the next transaction. A
// contract whose balance cannot cover its accumulated rent is FROZEN, and a
// frozen contract answers nothing: no transfer, no claim, no get-method. So
// "does this contract still have money in ten years" is a liveness question, not
// an accounting one, and it has two very different shapes here:
//
//   GROWING storage, with income — the ledger, the registrar, the market. Their
//     dicts grow with adoption, so rent grows too, but every mint pays them a
//     hop and the §4.1 gas-&-ops line exists to cover exactly this.
//     `params.json` models it: `fees.ops_reserve_derivation` prices `owed`
//     storage rent over a 10,000-mint horizon at 4.73 GRAM and folds it into
//     `OPS_RESERVE`. That is the half already thought about.
//
//   FIXED storage, with NO income — an ITEM. A number NFT's data does not grow;
//     it is deployed once with `ITEM_DEPLOY_VALUE` and, if it is a COMPOSITE,
//     nothing ever pays it again. Composites are never cited as tribute factors
//     (only primes are), so no `credit_tribute` tops it up. Its balance is a
//     one-time endowment against a perpetual bill.
//
// HOW THE NUMBERS BELOW WERE TAKEN. Rent is only deducted when a transaction
// touches the contract, so a balance read after advancing the clock shows
// nothing until something pokes it — and the poke's own gas contaminates the
// measurement. These tests therefore run the SAME scenario to two different
// horizons and difference the results: the poke cost is identical in both and
// cancels, leaving rent alone. Measuring a single horizon and subtracting an
// estimated poke was the first approach and it was wrong by roughly 2x.
import { Blockchain, SandboxContract, TreasuryContract } from '@ton/sandbox';
import { Address, Cell, beginCell, toNano } from '@ton/core';
import '@ton/test-utils';
import { compile } from '@ton/blueprint';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PrimesLedger, FactorEntry } from '../wrappers/PrimesLedger';
import { PrimesRatchet } from '../wrappers/PrimesRatchet';
import { PrimesRegistrar } from '../wrappers/PrimesRegistrar';
import { PrimesCollection, CollectionOpcodes } from '../wrappers/PrimesCollection';
import { PrimesItem } from '../wrappers/PrimesItem';
import { PrimesJettonMaster } from '../wrappers/PrimesJettonMaster';
import { PrimesMarket } from '../wrappers/PrimesMarket';
import { acquirePrime, testMarketConfig } from './helpers/market';

const REPO = join(__dirname, '..', '..');
const params = JSON.parse(readFileSync(join(REPO, 'shared', 'params.json'), 'utf8'));
const YEAR = 365 * 24 * 3600;
const MINT_PRICE = toNano('1');

describe('TON PRIMES — D9: storage rent, measured, against every contract that must outlive it', () => {
    let codes: Record<string, Cell>;

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

    /** Deploy, mint once, advance `years`, poke everything, return final balances. */
    async function balancesAfter(years: number): Promise<Record<string, bigint>> {
        const blockchain = await Blockchain.create();
        blockchain.now = 1_770_000_000;
        const deployer = await blockchain.treasury('deployer');
        const genesisScript = await blockchain.treasury('genesisScript');
        const treasuryWallet = await blockchain.treasury('treasury');
        const player = await blockchain.treasury('player', { balance: toNano('500') });

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
        const ledger = blockchain.openContract(
            PrimesLedger.createFromConfig(
                {
                    a: {
                        collectionAddr: collection.address,
                        jettonMasterAddr: master.address,
                        treasuryAddr: treasuryWallet.address,
                        itemCode: codes.item,
                    },
                    b: { genesisScriptAddr: genesisScript.address },
                    seedHead: 4n,
                    seedPrimes: [2n, 3n],
                },
                codes.ledger
            )
        );
        await ledger.sendDeploy(deployer.getSender(), toNano('20'));
        const ratchet = blockchain.openContract(
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
        const registrar = blockchain.openContract(
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
            value: toNano('0.2'),
        });
        await ledger.sendIgnite(genesisScript.getSender(), { owner: deployer.address, value: toNano('0.3') });
        await ledger.sendMint(player.getSender(), {
            n: 4n,
            kind: 0,
            factors: [{ prime: 2n, exponent: 2, s: 1n }] as FactorEntry[],
            referralKey: 0,
            beneficiary: null,
            value: MINT_PRICE,
        });

        const targets: [string, Address][] = [
            ['ledger', ledger.address],
            ['registrar', registrar.address],
            ['collection', collection.address],
            ['ratchet', ratchet.address],
            ['master', master.address],
            ['item', await ledger.getItemAddress(4n)],
        ];
        blockchain.now = blockchain.now + YEAR * years;
        // The poke is identical across horizons, so its cost cancels in the diff.
        //
        // D-128 MADE THE COLLECTION A SPECIAL CASE, and the reason is the measurement's
        // own premise. A bare transfer to the collection is now a ROYALTY: the catch-all
        // arm reserves `ROYALTY_STORAGE_FLOOR` and forwards everything above it, so a
        // poke pins the balance to the floor at BOTH horizons and the difference is
        // zero — which reads as "this contract pays no rent" when in fact it does and
        // the poke swept the evidence. So the collection is poked with a real TEP-66
        // royalty query instead: it goes through `GetRoyaltyParams`, whose reply carries
        // the incoming value straight back out, so the balance moves only by rent and by
        // a fee that is identical across horizons — which is exactly what the poke was
        // always meant to be.
        for (const [name, a] of targets) {
            if (name === 'collection') {
                await deployer.send({
                    to: a,
                    value: toNano('0.01'),
                    bounce: false,
                    body: beginCell().storeUint(CollectionOpcodes.GetRoyaltyParams, 32).storeUint(0, 64).endCell(),
                });
            } else {
                await deployer.send({ to: a, value: toNano('0.01'), bounce: false });
            }
        }

        const out: Record<string, bigint> = {};
        for (const [n, a] of targets) out[n] = (await blockchain.getContract(a)).balance;
        // D-72/T4: keep the last run's live item reachable so the runway get-method
        // can be read off the SAME chain state this suite differences its rent from,
        // rather than a second setup that might not price identically.
        lastRun = { blockchain, itemAddr: targets[targets.length - 1][1] };
        return out;
    }

    let lastRun: { blockchain: Blockchain; itemAddr: Address } | null = null;
    const rentPerYear: Record<string, bigint> = {};

    it('measures annual rent for every contract, by differencing two horizons', async () => {
        const oneYear = await balancesAfter(1);
        const threeYears = await balancesAfter(3);
        for (const k of Object.keys(oneYear)) {
            rentPerYear[k] = (oneYear[k] - threeYears[k]) / 2n;
            console.log(`[rent] ${k}: ${rentPerYear[k]} nanoton/year`);
        }
        // Every contract really is paying rent — a zero would mean the sandbox
        // is not modelling it and every conclusion below would be vacuous.
        for (const [k, v] of Object.entries(rentPerYear)) {
            expect({ contract: k, paysRent: v > 0n }).toEqual({ contract: k, paysRent: true });
        }
    }, 600_000);

    it('the contracts with INCOME are nowhere near starvation', () => {
        // The ledger holds `OPS_RESERVE` = 94 GRAM (params.json-derived, see below) and is paid a hop on every
        // mint; its measured rent at an empty dict is a rounding error against
        // that. The point of the assertion is the ORDER OF MAGNITUDE, not the
        // exact figure — a regression that made rent comparable to income would
        // blow past this by orders.
        const opsReserve = BigInt(Math.round(params.fees.ops_reserve_ton * 1e9));
        expect(rentPerYear['ledger'] * 100n).toBeLessThan(opsReserve);
        expect(rentPerYear['registrar']).toBeLessThan(rentPerYear['ledger']);
    });

    it('params.json already models the ledger\'s rent GROWING with the `owed` dict', () => {
        // The measured figure above is rent at an almost-empty dict. The ledger's
        // storage grows with adoption, and the parameter file knows: the
        // OPS_RESERVE derivation prices `owed` rent over a 10,000-mint horizon
        // and folds it in. Binding it here so the model cannot quietly drop the
        // term — it is the only rent figure in the repo that scales.
        const d = params.fees.ops_reserve_derivation;
        expect(d.owed_rent_ton).toBeGreaterThan(0);
        expect(d.owed_rent_ton_per_second).toBeGreaterThan(0);
        expect(d.horizon_mints).toBe(10_000);
        // and the reserve covers the whole deferred draw, rent included
        expect(params.fees.ops_reserve_ton).toBeGreaterThanOrEqual(d.unrounded_total_ton);
    });

    it('D9.1 — an ITEM has fixed storage, no income, and a FINITE runway', () => {
        // The exposed class, and the one nothing had priced. A number NFT's data
        // does not grow, so its rent is flat — but it is endowed exactly once,
        // with `ITEM_DEPLOY_VALUE`, and a COMPOSITE item is never paid again:
        // only primes are cited as tribute factors, so no `credit_tribute` ever
        // tops it up. A one-time endowment against a perpetual bill has a
        // finite, computable life.
        const rent = rentPerYear['item'];
        expect(rent).toBeGreaterThan(0n);
        // Deployed with ITEM_DEPLOY_VALUE (0.025 GRAM) less deploy gas. The
        // runway is what that buys at the measured rate.
        const endowment = toNano('0.025');
        const years = Number(endowment / rent);
        console.log(`[rent] item runway: ~${years} years on a ${endowment} nanoton endowment`);
        // Pinned as a RANGE, not a point: the exact figure moves with TON's fee
        // config, and what matters is the order — this is years, not decades,
        // and not centuries.
        expect(years).toBeGreaterThan(3);
        expect(years).toBeLessThan(40);
    });

    it('D-72/T4 — getStorageRunway() reports that finite runway, priced off live config-18', async () => {
        // D-62 shipped the permissionless `TopUp` so anyone CAN extend a composite
        // item's rent; nothing reported when to. This get-method is the other half,
        // and §9.1 is why it is a get-method rather than a read of raw account state.
        //
        // Cross-checked against THIS suite's own differencing measurement rather than
        // against a constant: the contract prices the runway with TVM's GETSTORAGEFEE
        // (live config 18), the test prices it by differencing two horizons, and the
        // two must land on the same figure by independent routes. A hardcoded
        // expectation would pass even if both drifted together.
        expect(lastRun).not.toBeNull();
        const { blockchain, itemAddr } = lastRun!;
        const item = blockchain.openContract(PrimesItem.createFromAddress(itemAddr));

        const runwaySeconds = await item.getStorageRunway();
        // The basechain charges for cells (`cell_price_ps` 135) even though
        // `bit_price_ps` is 0, so the runway here is finite and -1 would be a bug.
        expect(runwaySeconds).toBeGreaterThan(0n);

        const balance = (await blockchain.getContract(itemAddr)).balance;
        const expectedSeconds = (balance * BigInt(YEAR)) / rentPerYear['item'];
        console.log(
            `[rent] item runway: get-method ${runwaySeconds}s (~${Number(runwaySeconds) / YEAR} y), ` +
                `differenced ${expectedSeconds}s (~${Number(expectedSeconds) / YEAR} y)`
        );

        // Within 5%. Not exact, and the gap is explainable rather than slack: the
        // differencing measurement pays a poke message's forward fee at each horizon
        // and reads a balance AFTER the storage phase, while the get-method reads the
        // balance as it stands and subtracts only the settled due. Anything larger
        // than a few percent would mean the contract is pricing a different state
        // than the one being charged for.
        const ratio = Number(runwaySeconds) / Number(expectedSeconds);
        expect(ratio).toBeGreaterThan(0.95);
        expect(ratio).toBeLessThan(1.05);
    }, 60_000);

    it('...and a PRIME item is topped up by every mint that cites it, so it is not exposed', () => {
        // The contrast that makes D9.1 precise rather than alarmist. A prime's
        // item receives `CREDIT_TRIBUTE_VALUE` (0.008 GRAM) of gas on every
        // composite mint citing it — more than two years of rent, per citation
        // (it was over three until D-188 points 4 and 6 put the dividend
        // bookmark, its `credit_dividend` arm and the naming right on the item:
        // the code cells are rented too). The exposure is specific to
        // composites, and to composites nobody ever transfers or interacts with.
        const CREDIT_TRIBUTE_VALUE = toNano('0.008');
        expect(CREDIT_TRIBUTE_VALUE).toBeGreaterThan(rentPerYear['item'] * 2n);
    });

    it('D-62/D9.1 — anyone can top up a composite item, extending its runway indefinitely', async () => {
        // The owner's fix for the finite runway above: a permissionless message
        // ANY sender may fire, from anywhere, with no relationship to the item
        // at all. Confirms two things a UI or a script would need to trust: the
        // sender is genuinely unauthenticated (not the owner, not the ledger,
        // not the collection), and the item's balance actually rises by (most
        // of) what was sent — proving the value lands rather than the message
        // merely being accepted and the value going nowhere.
        const blockchain = await Blockchain.create();
        blockchain.now = 1_770_000_000;
        const deployer = await blockchain.treasury('deployer');
        const genesisScript = await blockchain.treasury('genesisScript');
        const player = await blockchain.treasury('player', { balance: toNano('500') });
        const stranger = await blockchain.treasury('stranger', { balance: toNano('10') });

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
        const ledger = blockchain.openContract(
            PrimesLedger.createFromConfig(
                {
                    a: {
                        collectionAddr: collection.address,
                        jettonMasterAddr: deployer.address,
                        treasuryAddr: deployer.address,
                        itemCode: codes.item,
                    },
                    b: { genesisScriptAddr: genesisScript.address },
                    seedHead: 4n,
                    seedPrimes: [2n, 3n],
                },
                codes.ledger
            )
        );
        await ledger.sendDeploy(deployer.getSender(), toNano('20'));
        const ratchet = blockchain.openContract(
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
        const registrar = blockchain.openContract(
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
        await ledger.sendGenesisSeed(genesisScript.getSender(), {
            seedT: toNano('1000'),
            seedS: 1_200_000_000_000_000n,
            seedHead: 4n,
            value: toNano('0.2'),
        });
        await ledger.sendIgnite(genesisScript.getSender(), { owner: deployer.address, value: toNano('0.3') });
        await ledger.sendMint(player.getSender(), {
            n: 4n,
            kind: 0,
            factors: [{ prime: 2n, exponent: 2, s: 1n }] as FactorEntry[],
            referralKey: 0,
            beneficiary: null,
            value: MINT_PRICE,
        });

        const itemAddr = await ledger.getItemAddress(4n);
        const item = blockchain.openContract(PrimesItem.createFromAddress(itemAddr));
        const before = (await blockchain.getContract(itemAddr)).balance;

        // The stranger is not the owner (player owns #4), not the ledger, not
        // the collection — an address the contract has never seen before.
        const topUp = await item.sendTopUp(stranger.getSender(), { value: toNano('1') });
        expect(topUp.transactions).toHaveTransaction({ to: itemAddr, success: true });

        const after = (await blockchain.getContract(itemAddr)).balance;
        // Most of the 1 GRAM landed (some is spent on this transaction's own
        // gas) — an order-of-magnitude check that the value was credited, not
        // merely accepted and burned.
        expect(after - before).toBeGreaterThan(toNano('0.9'));

        // And ownership/claim state is untouched by an unrelated top-up.
        const data = await item.getNumberData();
        expect(data.owner.toString()).toBe(player.address.toString());
    });

    it('GAUNTLET V10 — claim_tribute no longer spends the item\'s own rent endowment', async () => {
        // Needs a PRIME item with real `owed`: bought off the market (D-20 —
        // there is no other way to get a prime item at all), then cited as a
        // factor in a later composite mint, which is what credits `owed`.
        const blockchain = await Blockchain.create();
        blockchain.now = 1_770_000_000;
        const deployer = await blockchain.treasury('deployer');
        const genesisScript = await blockchain.treasury('genesisScript');
        const treasuryWallet = await blockchain.treasury('treasury');
        const player = await blockchain.treasury('player', { balance: toNano('500') });
        const minter = await blockchain.treasury('minter', { balance: toNano('500') });

        const collection = blockchain.openContract(
            PrimesCollection.createFromConfig(
                { nextIndex: 2n, itemCode: codes.item, ledgerAddr: deployer.address, genesisScriptAddr: genesisScript.address },
                codes.collection
            )
        );
        await collection.sendDeploy(deployer.getSender(), toNano('5'));
        const master = blockchain.openContract(
            PrimesJettonMaster.createFromConfig(
                { ledgerAddr: deployer.address, genesisScriptAddr: genesisScript.address, walletCode: codes.jettonWallet },
                codes.jettonMaster
            )
        );
        await master.sendDeploy(deployer.getSender(), toNano('5'));
        const ledger = blockchain.openContract(
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
        await ledger.sendDeploy(deployer.getSender(), toNano('10'));
        const ratchet = blockchain.openContract(
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
        const registrar = blockchain.openContract(
            PrimesRegistrar.createFromConfig({ genesisScriptAddr: genesisScript.address }, codes.registrar)
        );
        await registrar.sendDeploy(deployer.getSender(), toNano('5'));
        const market = blockchain.openContract(
            PrimesMarket.createFromConfig(
                testMarketConfig({ ledgerAddr: ledger.address, ratchetAddr: ratchet.address }),
                codes.market
            )
        );
        await market.sendDeploy(deployer.getSender(), toNano('5'));

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
        await ledger.sendSetPeers(genesisScript.getSender(), {
            marketAddr: market.address,
            bountyVaultAddr: deployer.address,
            value: toNano('0.05'),
        });
        await ledger.sendIgnite(genesisScript.getSender(), { owner: deployer.address, value: toNano('0.3') });

        await acquirePrime({ blockchain, market, ledger }, player, 2n);
        await ledger.sendMint(minter.getSender(), {
            n: 4n,
            kind: 0,
            factors: [{ prime: 2n, exponent: 2, s: 1n }],
            referralKey: 0,
            beneficiary: null,
            value: MINT_PRICE,
        });

        const item2Addr = await ledger.getItemAddress(2n);
        const item2 = blockchain.openContract(PrimesItem.createFromAddress(item2Addr));
        const owed = await item2.getOwed();
        expect(owed).toBeGreaterThan(0n); // a real tribute credit exists to claim

        // Below the new floor: refused cleanly, `owed` untouched, no send —
        // the old bug's failure mode (draining the endowment) only fires
        // AFTER the send, so this is the case that used to slip through.
        const before = (await blockchain.getContract(item2Addr)).balance;
        const tooLow = await item2.sendClaimTribute(player.getSender(), { value: toNano('0.005') });
        expect(tooLow.transactions).toHaveTransaction({ to: item2Addr, success: false, exitCode: 103 });
        expect(await item2.getOwed()).toBe(owed);
        const afterRefusal = (await blockchain.getContract(item2Addr)).balance;
        // The refusal itself must not cost the item anything either — it
        // throws before any state mutation or send.
        expect(afterRefusal).toBeGreaterThanOrEqual(before);

        // At or above the floor: succeeds, and the item's OWN balance is not
        // lower afterwards — the caller's attached value funds the claim
        // fully, the endowment is untouched.
        const claim = await item2.sendClaimTribute(player.getSender(), { value: toNano('0.03') });
        expect(claim.transactions).toHaveTransaction({ to: item2Addr, success: true });
        expect(await item2.getOwed()).toBe(0n);
        const afterClaim = (await blockchain.getContract(item2Addr)).balance;
        expect(afterClaim).toBeGreaterThanOrEqual(afterRefusal);
        // Measured (`CLAIM_TRIBUTE_MIN_VALUE`'s own comment): 0.03 GRAM attached
        // leaves the item ~0.0096 GRAM RICHER, not merely unchanged — real
        // break-even is closer to ~0.0204 GRAM. A wide floor either side keeps
        // this from chasing gas-model noise while still pinning the sign.
        expect(afterClaim - before).toBeGreaterThan(toNano('0.005'));
        expect(afterClaim - before).toBeLessThan(toNano('0.015'));
    });
});
