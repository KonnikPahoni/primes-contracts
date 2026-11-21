// TON PRIMES — GAUNTLET.md V3: ω(n) ≤ 12 (CONCEPT.md §3.2) is now an explicit
// bound in both loops that walk an attacker-submitted `factors` list BEFORE it
// is proven to belong to `n` — the market's `open_lot` (`primes_market.tolk`)
// and the ledger's own mint verification (`primes_ledger.tolk`'s
// `executeMint`). Neither loop bounded the entry count before this, and
// `product == n` alone never forbade citing the same prime as several separate
// entries — CONCEPT.md's own worked example is 45 copies of `{2, 1, 1}` for
// n = 2^45, mathematically redundant with one entry of exponent 45 but costing
// a full `credit_tribute` fan-out per copy.
//
// Two loops, two properties each: the COUNT cap (a legitimate ω = 12 number
// still opens; a 13th entry is refused before its content is even read) and
// DISTINCTNESS (the same prime cited twice is refused, regardless of count).
import { Blockchain, SandboxContract, TreasuryContract } from '@ton/sandbox';
import { beginCell, Cell, toNano } from '@ton/core';
import '@ton/test-utils';
import { compile } from '@ton/blueprint';
import { PrimesLedger, FactorEntry, encodeFactors } from '../wrappers/PrimesLedger';
import { PrimesRatchet } from '../wrappers/PrimesRatchet';
import { PrimesRegistrar } from '../wrappers/PrimesRegistrar';
import { PrimesCollection } from '../wrappers/PrimesCollection';
import { PrimesJettonMaster } from '../wrappers/PrimesJettonMaster';
import { PrimesMarket } from '../wrappers/PrimesMarket';
import { PrimesItem } from '../wrappers/PrimesItem';
import { testMarketConfig, OPENING_HEAD, F } from './helpers/market';

const MINT_PRICE = toNano('1');

// 12 DISTINCT primes (2, 3, 5, 7, 11, 13, 17, 19, 23, 29, 31, 37), 2 raised to
// the second power so the product is NOT 37# itself (37# is a primorial and
// `open_lot` refuses primorials outright, 1008 — a different check than the
// one under test here). ω = 12 either way: exponents are weights on an
// existing recipient, not extra recipients (CONCEPT.md §3.2).
const AT_BOUND_N = 14_841_476_269_620n; // 2^2 * 3 * 5 * 7 * 11 * 13 * 17 * 19 * 23 * 29 * 31 * 37
const AT_BOUND_FACTORS: FactorEntry[] = [
    F(2n, 2, 1n),
    F(3n, 1, 1n),
    F(5n, 1, 2n),
    F(7n, 1, 2n),
    F(11n, 1, 3n),
    F(13n, 1, 3n),
    F(17n, 1, 4n),
    F(19n, 1, 4n),
    F(23n, 1, 4n),
    F(29n, 1, 5n),
    F(31n, 1, 5n),
    F(37n, 1, 6n),
];
// A 13th entry. Its own content is irrelevant — the count cap throws before
// this entry (index 12) is even read — so it need not make the product agree
// with any real `n`.
const THIRTEENTH_ENTRY: FactorEntry = F(41n, 1, 6n);

describe('GAUNTLET.md V3 — ω(n) ≤ 12 is an explicit bound, not an accident of gas', () => {
    let blockchain: Blockchain;
    let deployer: SandboxContract<TreasuryContract>;
    let genesisScript: SandboxContract<TreasuryContract>;
    let treasuryWallet: SandboxContract<TreasuryContract>;
    let dedust: SandboxContract<TreasuryContract>;
    let bountyVault: SandboxContract<TreasuryContract>;
    let buyer: SandboxContract<TreasuryContract>;
    let marketStub: SandboxContract<TreasuryContract>;

    let itemCode: Cell;
    let collectionCode: Cell;
    let walletCode: Cell;
    let masterCode: Cell;
    let ledgerCode: Cell;
    let ratchetCode: Cell;
    let registrarCode: Cell;
    let marketCode: Cell;

    let collection: SandboxContract<PrimesCollection>;
    let master: SandboxContract<PrimesJettonMaster>;
    let ledger: SandboxContract<PrimesLedger>;
    let ratchet: SandboxContract<PrimesRatchet>;
    let registrar: SandboxContract<PrimesRegistrar>;
    let market: SandboxContract<PrimesMarket>;

    beforeAll(async () => {
        itemCode = await compile('PrimesItem');
        collectionCode = await compile('PrimesCollection');
        walletCode = await compile('PrimesJettonWallet');
        masterCode = await compile('PrimesJettonMaster');
        ledgerCode = await compile('PrimesLedger');
        ratchetCode = await compile('PrimesRatchet');
        registrarCode = await compile('PrimesRegistrar');
        marketCode = await compile('PrimesMarket');
    });

    beforeEach(async () => {
        blockchain = await Blockchain.create();
        blockchain.now = 1_770_000_000;
        deployer = await blockchain.treasury('deployer');
        genesisScript = await blockchain.treasury('genesisScript');
        treasuryWallet = await blockchain.treasury('treasury');
        dedust = await blockchain.treasury('dedust');
        bountyVault = await blockchain.treasury('bountyVault');
        buyer = await blockchain.treasury('buyer', { balance: toNano('100000') });
        marketStub = await blockchain.treasury('marketStub');

        collection = blockchain.openContract(
            PrimesCollection.createFromConfig(
                { nextIndex: 2n, itemCode, ledgerAddr: deployer.address, genesisScriptAddr: genesisScript.address },
                collectionCode
            )
        );
        await collection.sendDeploy(deployer.getSender(), toNano('5'));

        master = blockchain.openContract(
            PrimesJettonMaster.createFromConfig(
                { ledgerAddr: deployer.address, genesisScriptAddr: genesisScript.address, walletCode },
                masterCode
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
                        itemCode,
                    },
                    b: { genesisScriptAddr: genesisScript.address },
                },
                ledgerCode
            )
        );
        await ledger.sendDeploy(deployer.getSender(), toNano('10'));

        ratchet = blockchain.openContract(
            PrimesRatchet.createFromConfig(
                {
                    venueTimelockAddr: deployer.address,
                    genesisScriptAddr: genesisScript.address,
                    dedustNativeVault: dedust.address,
                    dedustPool: dedust.address,
                    primesJettonVault: dedust.address,
                },
                ratchetCode
            )
        );
        await ratchet.sendDeploy(deployer.getSender(), toNano('10'));

        registrar = blockchain.openContract(
            PrimesRegistrar.createFromConfig({ genesisScriptAddr: genesisScript.address }, registrarCode)
        );
        await registrar.sendDeploy(deployer.getSender(), toNano('5'));

        await ratchet.sendSetLedger(genesisScript.getSender(), { ledgerAddr: ledger.address, value: toNano('0.05') });
        await registrar.sendSetLedger(genesisScript.getSender(), { ledgerAddr: ledger.address, value: toNano('0.05') });
        await ledger.sendSetSinks(genesisScript.getSender(), {
            ratchetAddr: ratchet.address,
            registrarAddr: registrar.address,
            value: toNano('0.05'),
        });

        market = blockchain.openContract(
            PrimesMarket.createFromConfig(
                testMarketConfig({
                    headHint: OPENING_HEAD,
                    ledgerAddr: ledger.address,
                    ratchetAddr: ratchet.address,
                }),
                marketCode
            )
        );
        await market.sendDeploy(deployer.getSender(), toNano('5'));

        await collection.sendSetLedger(genesisScript.getSender(), { ledgerAddr: ledger.address, value: toNano('0.05') });
        await master.sendSetLedger(genesisScript.getSender(), { ledgerAddr: ledger.address, value: toNano('0.05') });
        await master.sendSealAuthority(genesisScript.getSender(), { value: toNano('0.05') });
        await ledger.sendGenesisSeed(genesisScript.getSender(), {
            seedT: toNano('1000'),
            seedS: 1_200_000_000_000_000n,
            seedHead: OPENING_HEAD,
            value: toNano('0.05'),
        });
        await ledger.sendSetPeers(genesisScript.getSender(), {
            marketAddr: market.address,
            bountyVaultAddr: bountyVault.address,
            value: toNano('0.05'),
        });
        await ledger.sendIgnite(genesisScript.getSender(), { owner: deployer.address, value: toNano('0.3') });
    });

    describe('the market: open_lot', () => {
        it('AT the bound: a real ω = 12 composite opens cleanly', async () => {
            const { p0 } = await market.getLotPriceFrom(AT_BOUND_N, AT_BOUND_FACTORS);
            const r = await market.sendOpenLot(buyer.getSender(), {
                n: AT_BOUND_N,
                kind: 0,
                factors: AT_BOUND_FACTORS,
                beneficiary: null,
                referralKey: 0,
                value: p0 + toNano('0.3'),
            });
            expect(r.transactions).toHaveTransaction({ to: market.address, success: true });
            const lot = await market.getLot(AT_BOUND_N);
            expect(lot.found).toBe(true);
            expect(lot.closed).toBe(false);
        });

        it('OVER the bound: a 13th entry is refused before it is even read (201)', async () => {
            const factors13 = [...AT_BOUND_FACTORS, THIRTEENTH_ENTRY];
            const r = await market.sendOpenLot(buyer.getSender(), {
                n: AT_BOUND_N,
                kind: 0,
                factors: factors13,
                beneficiary: null,
                referralKey: 0,
                value: toNano('1000'), // plenty — this must fail on the bound, not on funding
            });
            expect(r.transactions).toHaveTransaction({ to: market.address, success: false, exitCode: 201 });
        });

        it('DUPLICATE padding: the same prime cited twice is refused regardless of count (201)', async () => {
            const n = 8192n; // 2^13, real ω = 1
            const padded: FactorEntry[] = [F(2n, 6, 1n), F(2n, 7, 1n)]; // product = 2^13 = n, but two entries
            const r = await market.sendOpenLot(buyer.getSender(), {
                n,
                kind: 0,
                factors: padded,
                beneficiary: null,
                referralKey: 0,
                value: toNano('1000'),
            });
            expect(r.transactions).toHaveTransaction({ to: market.address, success: false, exitCode: 201 });
        });
    });

    describe('the ledger: MintWonLot (the same verification the direct mint runs)', () => {
        // A SEPARATE, self-contained ledger stack, deployed with `marketStub` as
        // its market peer from the start — `SetPeers` is one-shot, so the shared
        // stack above (whose peer is the real `market` contract, needed for the
        // `mark_off_head` round trip `open_lot` sends) cannot be repointed here.
        it('DUPLICATE padding is refused on the ledger side too, not just the market (201)', async () => {
            const n = 8192n;
            const padded: FactorEntry[] = [F(2n, 6, 1n), F(2n, 7, 1n)];

            // A DISTINCT genesis identity, not the outer stack's — a solo
            // deploy config identical field-for-field to the shared stack's
            // would compute the SAME contract addresses (address is a pure
            // function of code + init data) and silently reuse the already
            // `set_peers`'d shared ledger instead of a fresh one.
            const soloGenesisScript = await blockchain.treasury('soloGenesisScript');

            const soloCollection = blockchain.openContract(
                PrimesCollection.createFromConfig(
                    { nextIndex: 2n, itemCode, ledgerAddr: deployer.address, genesisScriptAddr: soloGenesisScript.address },
                    collectionCode
                )
            );
            await soloCollection.sendDeploy(deployer.getSender(), toNano('5'));
            const soloMaster = blockchain.openContract(
                PrimesJettonMaster.createFromConfig(
                    { ledgerAddr: deployer.address, genesisScriptAddr: soloGenesisScript.address, walletCode },
                    masterCode
                )
            );
            await soloMaster.sendDeploy(deployer.getSender(), toNano('5'));
            const soloLedger = blockchain.openContract(
                PrimesLedger.createFromConfig(
                    {
                        a: {
                            collectionAddr: soloCollection.address,
                            jettonMasterAddr: soloMaster.address,
                            treasuryAddr: treasuryWallet.address,
                            itemCode,
                        },
                        b: { genesisScriptAddr: soloGenesisScript.address },
                    },
                    ledgerCode
                )
            );
            await soloLedger.sendDeploy(deployer.getSender(), toNano('10'));
            await soloCollection.sendSetLedger(soloGenesisScript.getSender(), { ledgerAddr: soloLedger.address, value: toNano('0.05') });
            await soloMaster.sendSetLedger(soloGenesisScript.getSender(), { ledgerAddr: soloLedger.address, value: toNano('0.05') });
            await soloMaster.sendSealAuthority(soloGenesisScript.getSender(), { value: toNano('0.05') });
            await soloLedger.sendSetSinks(soloGenesisScript.getSender(), {
                ratchetAddr: deployer.address,
                registrarAddr: deployer.address,
                value: toNano('0.05'),
            });
            await soloLedger.sendGenesisSeed(soloGenesisScript.getSender(), {
                seedT: toNano('1000'),
                seedS: 1_200_000_000_000_000n,
                seedHead: OPENING_HEAD,
                value: toNano('0.05'),
            });
            await soloLedger.sendSetPeers(soloGenesisScript.getSender(), {
                marketAddr: marketStub.address,
                bountyVaultAddr: bountyVault.address,
                value: toNano('0.05'),
            });
            await soloLedger.sendIgnite(soloGenesisScript.getSender(), { owner: deployer.address, value: toNano('0.3') });

            await marketStub.send({
                to: soloLedger.address,
                value: toNano('0.1'),
                bounce: true,
                body: beginCell()
                    .storeUint(0xb0000021, 32) // MarkOffHead
                    .storeUint(0, 64)
                    .storeUint(n, 256)
                    .endCell(),
            });

            const r = await marketStub.send({
                to: soloLedger.address,
                value: toNano('1.1'),
                bounce: true,
                body: beginCell()
                    .storeUint(0xb0000020, 32) // MintWonLot
                    .storeUint(0, 64)
                    .storeUint(n, 256)
                    .storeAddress(buyer.address)
                    .storeUint(0, 32)
                    .storeUint(0, 1) // kind = composite
                    .storeDict(encodeFactors(padded))
                    .endCell(),
            });
            expect(r.transactions).toHaveTransaction({ to: soloLedger.address, success: false, exitCode: 201 });
        });
    });
});
