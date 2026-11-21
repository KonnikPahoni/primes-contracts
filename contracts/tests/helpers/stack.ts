import { Blockchain, SandboxContract, TreasuryContract } from '@ton/sandbox';
import { Address, beginCell, Cell, toNano } from '@ton/core';
import { compile } from '@ton/blueprint';
import { PrimesRatchet } from '../../wrappers/PrimesRatchet';
import { PrimesRegistrar } from '../../wrappers/PrimesRegistrar';
import { PrimesLedger, FactorEntry } from '../../wrappers/PrimesLedger';
import { PrimesCollection } from '../../wrappers/PrimesCollection';
import { PrimesJettonMaster } from '../../wrappers/PrimesJettonMaster';
import { PrimesBountyVault } from '../../wrappers/PrimesBountyVault';
import { PrimesMarket } from '../../wrappers/PrimesMarket';
import { acquirePrime, OPENING_HEAD, testMarketConfig } from './market';

/**
 * Shared full-stack deployment: collection, jetton, ledger, ratchet, registrar, bounty
 * vault and market, wired the way a real genesis wires them. It was
 * `constellationStack.ts` until DECISIONS.md D-202 deleted the constellations and
 * generators it also deployed.
 */

export const MINT_PRICE = toNano('1');

/**
 * The vault keys its allow-list by the ACCOUNT hash — `getWorkchainAndHash().1`
 * — not by the hash of a cell containing the address. The two differ, and using
 * the wrong one fails as `vault_not_allowlisted` (700), which reads like a
 * policy refusal rather than an encoding bug.
 */
export function addrHashOf(a: Address): bigint {
    return BigInt('0x' + a.hash.toString('hex'));
}

export type Stack = {
    blockchain: Blockchain;
    deployer: SandboxContract<TreasuryContract>;
    genesisScript: SandboxContract<TreasuryContract>;
    alice: SandboxContract<TreasuryContract>;
    bob: SandboxContract<TreasuryContract>;
    collection: SandboxContract<PrimesCollection>;
    master: SandboxContract<PrimesJettonMaster>;
    ledger: SandboxContract<PrimesLedger>;
    ratchet: SandboxContract<PrimesRatchet>;
    registrar: SandboxContract<PrimesRegistrar>;
    vault: SandboxContract<PrimesBountyVault>;
    /**
     * D-20: the stack carries a market because a prime cannot be obtained
     * without one. `acquire` below is the only way any suite here gets a prime.
     */
    market: SandboxContract<PrimesMarket>;
    /** The `ignite` transaction itself, for the suite that asserts it refuses. */
    igniteResult: any;
    itemCode: Cell;
    mint: (
        who: SandboxContract<TreasuryContract>,
        n: bigint,
        kind: number,
        factors: FactorEntry[]
    ) => Promise<any>;
    /** D-20: buy prime `p` off the market's MODE_DUTCH_BUYNOW lane. */
    acquire: (who: SandboxContract<TreasuryContract>, p: bigint) => Promise<any>;
    itemAddressOf: (n: bigint) => Promise<Address>;
};

let codes: Record<string, Cell> | undefined;

export async function compileAll() {
    if (codes) return codes;
    codes = {
        item: await compile('PrimesItem'),
        collection: await compile('PrimesCollection'),
        wallet: await compile('PrimesJettonWallet'),
        master: await compile('PrimesJettonMaster'),
        ledger: await compile('PrimesLedger'),
        ratchet: await compile('PrimesRatchet'),
        registrar: await compile('PrimesRegistrar'),
        vault: await compile('PrimesBountyVault'),
        market: await compile('PrimesMarket'),
    };
    return codes;
}

export async function deployStack(opts?: {
    seedHead?: bigint;
    /**
     * The `T` the genesis seed writes. Defaults to 1000 TON, which is what
     * every suite here wants: a floor that already exists. Pass `0n` to
     * reproduce the REAL pipeline (`genesisPipeline.ts`, D-46 point 2), which
     * seeds no backing at all — and note that `ignite` then REFUSES to launch
     * (218, `ledger_floor_unbacked`) unless `donateBeforeIgnite` funds it.
     */
    seedT?: bigint;
    /** The `S` the genesis seed writes (nano-PRIMES). Defaults to 1.2M PRIMES. */
    seedS?: bigint;
    /**
     * D-92 tranches sent as `donate_floor` between the genesis seed and
     * `ignite` — the real launch order, and the only way a `seedT: 0n` stack
     * reaches a launched state. Several entries exercise the op's incremental
     * shape (one tranche or ten; it takes money in and never out).
     */
    donateBeforeIgnite?: bigint[];
    seedPrimes?: bigint[];
    /**
     * Set false to leave the jetton authority OPEN — a genesis that has not
     * reached its `SealAuthority` step yet. `MintOp` throws 400 until it does,
     * so every ledger-sent `JettonMint` genuinely bounces in that window, which
     * is reachable in production because `donate_floor` is permissionless and
     * gated on nothing (D-91 point 4).
     */
    sealJetton?: boolean;
}): Promise<Stack> {
    const c = await compileAll();
    const blockchain = await Blockchain.create();
    blockchain.now = 1_770_000_000;

    const deployer = await blockchain.treasury('deployer');
    const genesisScript = await blockchain.treasury('genesisScript');
    const treasuryWallet = await blockchain.treasury('treasury');
    const dedustVault = await blockchain.treasury('dedustVault');
    const dedustPool = await blockchain.treasury('dedustPool');
    const alice = await blockchain.treasury('alice');
    const bob = await blockchain.treasury('bob');

    // The registrar's address does not depend on any peer (every peer field is
    // bootstrapped post-deploy), so it is computed first: the collection fixes it at
    // deploy as the one non-item sender of `naming_paid` (D-212).
    const registrar = blockchain.openContract(
        PrimesRegistrar.createFromConfig({ genesisScriptAddr: genesisScript.address }, c.registrar)
    );

    const collection = blockchain.openContract(
        PrimesCollection.createFromConfig(
            {
                nextIndex: opts?.seedHead ?? 2n,
                itemCode: c.item,
                ledgerAddr: deployer.address,
                genesisScriptAddr: genesisScript.address,
                registrarAddr: registrar.address,
            },
            c.collection
        )
    );
    await collection.sendDeploy(deployer.getSender(), toNano('5'));

    const master = blockchain.openContract(
        PrimesJettonMaster.createFromConfig(
            { ledgerAddr: deployer.address, genesisScriptAddr: genesisScript.address, walletCode: c.wallet },
            c.master
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
                    itemCode: c.item,
                },
                b: { genesisScriptAddr: genesisScript.address },
                seedHead: opts?.seedHead,
                seedPrimes: opts?.seedPrimes,
            },
            c.ledger
        )
    );
    await ledger.sendDeploy(deployer.getSender(), toNano('10'));

    const ratchet = blockchain.openContract(
        PrimesRatchet.createFromConfig(
            {
                venueTimelockAddr: deployer.address,
                genesisScriptAddr: genesisScript.address,
                dedustNativeVault: dedustVault.address,
                dedustPool: dedustPool.address,
                primesJettonVault: dedustPool.address,
            },
            c.ratchet
        )
    );
    await ratchet.sendDeploy(deployer.getSender(), toNano('10'));

    const vault = blockchain.openContract(
        PrimesBountyVault.createFromConfig(
            {
                schedule: [],
                ledgerAddr: ledger.address,
                jettonMasterAddr: master.address,
                genesisScriptAddr: genesisScript.address,
                fundedPrimes: 40_000_000_000_000n, // V26.7 — the genesis mint below
            },
            c.vault
        )
    );
    await vault.sendDeploy(deployer.getSender(), toNano('5'));
    await registrar.sendDeploy(deployer.getSender(), toNano('5'));

    await ratchet.sendSetLedger(genesisScript.getSender(), {
        ledgerAddr: ledger.address,
        value: toNano('0.05'),
    });
    await registrar.sendSetLedger(genesisScript.getSender(), {
        ledgerAddr: ledger.address,
        value: toNano('0.05'),
    });
    // The registrar relays a prime's paid annotation through the collection.
    await registrar.sendSetCollection(genesisScript.getSender(), {
        collectionAddr: collection.address,
        value: toNano('0.05'),
    });
    await ledger.sendSetSinks(genesisScript.getSender(), {
        ratchetAddr: ratchet.address,
        registrarAddr: registrar.address,
        value: toNano('0.05'),
    });

    await collection.sendSetLedger(genesisScript.getSender(), {
        ledgerAddr: ledger.address,
        value: toNano('0.05'),
    });
    await master.sendSetLedger(genesisScript.getSender(), {
        ledgerAddr: ledger.address,
        value: toNano('0.05'),
    });
    // The vault has to know its own jetton wallet before it can pay anything —
    // and genesis must FUND it before sealing mint authority, which is the
    // ordering the pre-v5 deployment got wrong (it sealed at walletSet = 0 and
    // became permanently unfundable).
    const vaultWallet = await master.getWalletAddress(vault.address);
    await vault.sendSetWallet(genesisScript.getSender(), {
        jettonWalletAddr: vaultWallet,
        value: toNano('0.05'),
    });
    await master.sendMintGenesis(genesisScript.getSender(), {
        to: vault.address,
        amount: 40_000_000_000_000n, // params.json genesis.bounty_vault_size_primes
        value: toNano('0.5'),
    });
    if (opts?.sealJetton !== false) {
        await master.sendSealAuthority(genesisScript.getSender(), { value: toNano('0.05') });
    }
    // D-20: with no explicit test seed the stack does the REAL genesis — the head
    // opens at the first composite and the walk to it marks 2 and 3 prime, counts
    // both into pi(n) and opens both their forfeit clocks. A suite that seeds its
    // own head keeps whatever it asked for.
    await ledger.sendGenesisSeed(genesisScript.getSender(), {
        seedT: opts?.seedT ?? toNano('1000'),
        seedS: opts?.seedS ?? 1_200_000_000_000_000n,
        seedHead: opts?.seedHead ?? OPENING_HEAD,
        value: toNano('0.05'),
    });

    // The market has to exist before `ignite` opens it, and after the ledger so
    // it can be pointed at one.
    const market = blockchain.openContract(
        PrimesMarket.createFromConfig(
            testMarketConfig({
                headHint: opts?.seedHead ?? OPENING_HEAD,
                ledgerAddr: ledger.address,
                ratchetAddr: ratchet.address,
            }),
            c.market
        )
    );
    await market.sendDeploy(deployer.getSender(), toNano('5'));

    // CONCEPT §6 point 0: nothing mints until Unity does. `ignite` mints #1 to the
    // founder and flips the ledger's launch flag; every fixture that mints has to
    // pass through it, exactly as a real deployment does. It also opens the
    // market, which is why `SetPeers` has to land first.
    await ledger.sendSetPeers(genesisScript.getSender(), {
        marketAddr: market.address,
        bountyVaultAddr: vault.address,
        value: toNano('0.05'),
    });
    // D-92 / D-46 point 2: the floor is created by `donate_floor`, not by the
    // seed, and `ignite` asserts it exists. Permissionless and asserting no
    // launch flag, so it belongs exactly here — after the seed, before ignition.
    for (const tranche of opts?.donateBeforeIgnite ?? []) {
        await ledger.sendDonateFloor(alice.getSender(), {
            amount: tranche,
            value: tranche + toNano('0.06'),
        });
    }
    const igniteResult = await ledger.sendIgnite(genesisScript.getSender(), {
        owner: deployer.address,
        value: toNano('0.3'),
    });

    const mint = (
        who: SandboxContract<TreasuryContract>,
        n: bigint,
        kind: number,
        factors: FactorEntry[]
    ) =>
        ledger.sendMint(who.getSender(), {
            n,
            kind,
            factors,
            referralKey: 0,
            beneficiary: null,
            value: MINT_PRICE,
        });

    const acquire = async (who: SandboxContract<TreasuryContract>, p: bigint) =>
        (await acquirePrime({ blockchain, market, ledger }, who, p)).result;

    const itemAddressOf = (n: bigint) => ledger.getItemAddress(n);

    return {
        blockchain,
        deployer,
        genesisScript,
        alice,
        bob,
        collection,
        master,
        ledger,
        ratchet,
        registrar,
        vault,
        market,
        itemCode: c.item,
        igniteResult,
        mint,
        acquire,
        itemAddressOf,
    };
}

export function factorize(n: bigint): FactorEntry[] {
    const out: FactorEntry[] = [];
    let q = n;
    for (let p = 2n; p * p <= q; p++) {
        if (q % p !== 0n) continue;
        let e = 0;
        while (q % p === 0n) {
            q /= p;
            e++;
        }
        out.push({ prime: p, exponent: e });
    }
    if (q > 1n) out.push({ prime: q, exponent: 1 });
    return out;
}
