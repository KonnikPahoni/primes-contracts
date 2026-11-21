// TON PRIMES — D12: front-running the head — can a mint be sniped between quote
// and settle? (GAUNTLET.md D12).
//
// WHAT "FRONT-RUNNING" CAN AND CANNOT MEAN HERE
//
// On an EVM chain, front-running means outbidding someone for block position
// with a higher gas price, and it is profitable because the attacker extracts a
// PRICE difference. Neither half transfers to this design:
//
//   * TON has no gas auction. Ordering is shard and block sequencing, not fee
//     bidding, so an attacker cannot buy priority over a transaction already in
//     flight. What they can do is watch the head and race — the ordinary race
//     every first-come-first-served system has.
//   * Every head mint costs the same flat 1 TON (§4.1). There is no price to
//     extract. Winning the race takes the NUMBER, not a margin.
//
// So the real question D12 asks is narrower and more useful: **when the race is
// lost, what happens to the loser's money, and can the race itself be weaponised
// against the protocol?** Both are measured below.
//
// THE ANSWER TO THE FIRST is that the loser is made almost whole. `handleCardMint`
// compares `msg.n` against the head BEFORE it asserts anything about value,
// and a mismatch refunds `valueCoins` minus the real gas, carry-all, back
// through the loser's minter card (D-191 point 1), which passes it on. Before
// GAUNTLET V6 the refund was the whole amount via `SEND_MODE_REGULAR`, so the
// LEDGER's own balance quietly paid for every ordinary lost race; V6 retained a
// fixed floor (`LOST_RACE_GAS`), and D-191 replaced the floor with the mode.
// The loser pays gas and keeps the rest of their TON.
//
// THE ANSWER TO THE SECOND is the interesting one, and it is where this differs
// from D8. Before V6, the refund path was cheap but not free, and spamming
// stale mints cost the ledger real gas — the question was the RATIO, measured
// here: did the attacker pay more than the protocol lost? After V6 the
// question is sharper: the retained floor means the protocol is never worse
// off at all, typically gaining a small margin per stale mint rather than
// merely losing less than the attacker. That is the comparison D8's
// zero-exponent padding fails — there, one paid mint burns more protocol gas
// than the gas-&-ops line allocates — and making the same measurement in both
// places is what lets the two be told apart.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Blockchain, SandboxContract, TreasuryContract } from '@ton/sandbox';
import { Cell, toNano } from '@ton/core';
import '@ton/test-utils';
import { compile } from '@ton/blueprint';
import { PrimesLedger, FactorEntry } from '../wrappers/PrimesLedger';
import { PrimesRatchet } from '../wrappers/PrimesRatchet';
import { PrimesRegistrar } from '../wrappers/PrimesRegistrar';
import { PrimesCollection } from '../wrappers/PrimesCollection';
import { PrimesJettonMaster } from '../wrappers/PrimesJettonMaster';

const CONTRACTS_DIR = join(__dirname, '..', 'contracts');
const MINT_PRICE = toNano('1');
const FACTORS_4: FactorEntry[] = [{ prime: 2n, exponent: 2, s: 1n }];

describe('TON PRIMES — D12: losing the race for the head costs the loser nothing but gas', () => {
    let blockchain: Blockchain;
    let deployer: SandboxContract<TreasuryContract>;
    let genesisScript: SandboxContract<TreasuryContract>;
    let treasuryWallet: SandboxContract<TreasuryContract>;
    let winner: SandboxContract<TreasuryContract>;
    let loser: SandboxContract<TreasuryContract>;
    let codes: Record<string, Cell>;
    let ledger: SandboxContract<PrimesLedger>;

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
        winner = await blockchain.treasury('winner', { balance: toNano('500') });
        loser = await blockchain.treasury('loser', { balance: toNano('500') });

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
    });

    const mint = (who: SandboxContract<TreasuryContract>, n: bigint, value = MINT_PRICE) =>
        ledger.sendMint(who.getSender(), {
            n,
            kind: 0,
            factors: FACTORS_4,
            referralKey: 0,
            beneficiary: null,
            value,
        });

    // ------------------------------------------------------------------ //
    // The race itself
    // ------------------------------------------------------------------ //

    describe('the loser of the race keeps their money', () => {
        it('a mint for a number the head has already passed refunds the attached value minus a small gas floor', async () => {
            // The race, as it actually happens: both players read head = 4, both
            // build a mint for 4, one lands first. The second arrives against a
            // head that has moved.
            await mint(winner, 4n);
            expect(await ledger.getHead()).toBeGreaterThan(4n);

            const before = await loser.getBalance();
            const r = await mint(loser, 4n);
            const after = await loser.getBalance();

            // The refund came back to the loser, through their minter card
            // (D-191 point 1)...
            const card = await ledger.getMinterCardAddress(loser.address);
            expect(r.transactions).toHaveTransaction({ from: ledger.address, to: card });
            expect(r.transactions).toHaveTransaction({ from: card, to: loser.address });
            // ...and they are out real gas — nowhere near the full 1 TON mint
            // price. A generous bound because gas itself is a measurement and
            // this is not a gas test.
            expect(before - after).toBeLessThan(toNano('0.02'));
        });

        it('a stale mint at the price is refunded, not thrown; under the price the CARD refuses it first', async () => {
            // Ordering that matters: `handleCardMint` compares `msg.n` to the head
            // before its own value assert, so a stale mint is REFUNDED rather than
            // thrown — the friendlier behaviour for a racing client, and the reason
            // the spam question below is worth asking at all.
            const r = await mint(loser, 999n);
            expect(r.transactions).toHaveTransaction({ to: ledger.address, success: true });
            expect(r.transactions).toHaveTransaction({ from: ledger.address, to: await ledger.getMinterCardAddress(loser.address) });
            // D-191 point 1: below MINT_PRICE the minter card refuses before it
            // forwards anything (103, bounced to the sender), so an under-price mint
            // — stale or not — never reaches the ledger at all.
            const cheap = await mint(loser, 999n, toNano('0.02'));
            expect(cheap.transactions).toHaveTransaction({ to: await ledger.getMinterCardAddress(loser.address), exitCode: 103 });
            expect(cheap.transactions).not.toHaveTransaction({ to: ledger.address });
        });

        it('the winner is entirely unaffected by the loser\'s arrival', async () => {
            await mint(winner, 4n);
            const headAfterWin = await ledger.getHead();
            const T = await ledger.getFloorNum();
            const S = await ledger.getFloorDen();

            await mint(loser, 4n);

            expect(await ledger.getHead()).toBe(headAfterWin);
            expect(await ledger.getFloorNum()).toBe(T);
            expect(await ledger.getFloorDen()).toBe(S);
        });
    });

    // ------------------------------------------------------------------ //
    // Can the race be weaponised against the protocol?
    // ------------------------------------------------------------------ //

    describe('spamming stale mints is unprofitable — GAUNTLET V6, the protocol is never worse off at all', () => {
        /** One stale mint. Returns what it cost each side. */
        async function staleMint(value: bigint) {
            const ledgerBefore = (await blockchain.getContract(ledger.address)).balance;
            const attackerBefore = await loser.getBalance();
            await mint(loser, 999n, value);
            const ledgerAfter = (await blockchain.getContract(ledger.address)).balance;
            const attackerAfter = await loser.getBalance();
            return {
                protocolCost: ledgerBefore - ledgerAfter,
                attackerCost: attackerBefore - attackerAfter,
            };
        }

        it('THE RATIO: the ledger is never worse off, and the attacker always pays more than the protocol does', async () => {
            // Before GAUNTLET V6 this measured "the attacker pays more than the
            // protocol loses" — true, but the protocol still LOST something on
            // every stale mint, which is exactly the shape D8's zero-exponent
            // padding has (there, one paid mint burns more protocol gas than
            // the gas-&-ops line allocates). V6's retained floor
            // changed the claim: the protocol's "cost" is now never positive —
            // D-191's carry-all refund takes this handler's real gas out of the
            // refunded value, so the ledger's balance does not move at all.
            const { protocolCost, attackerCost } = await staleMint(MINT_PRICE);
            expect(protocolCost).toBeLessThanOrEqual(0n); // never a net loss for the ledger
            expect(attackerCost).toBeGreaterThan(protocolCost);
            console.log(
                `[front-run] stale mint: protocol ${protocolCost <= 0n ? '+' : '-'}${protocolCost < 0n ? -protocolCost : protocolCost}, attacker -${attackerCost} nanoton`
            );
        });

        it('and the protocol\'s cost does NOT scale with what the attacker attaches', async () => {
            // The amplification question. If attaching more TON made the refund
            // more expensive for the ledger, an attacker could buy protocol pain
            // cheaply by sending large values that come straight back. It does
            // not: the refund is one message whatever it carries, so the
            // protocol's cost is flat and the attacker's own gas is the only
            // thing that moves. Both values are at or above MINT_PRICE, the
            // least the minter card forwards (D-191 point 1).
            const small = await staleMint(MINT_PRICE);
            const large = await staleMint(toNano('50'));
            expect(large.protocolCost).toBe(small.protocolCost);
        });
    });

    // ------------------------------------------------------------------ //
    // What losing actually costs — the honest limit of the above
    // ------------------------------------------------------------------ //

    it('losing the race costs the OPPORTUNITY, and nothing protects a valuable number', () => {
        // The limit of everything above, stated rather than left implied. Being
        // made whole in TON is not the same as being made whole: the loser
        // wanted THAT NUMBER, and for a number that carries an era trophy (§7) or
        // a special-number rebate (§9.6) the value at stake is real and the
        // refund does not replace it.
        //
        // There is no mechanism that protects it, and that is the design: the
        // head is strictly sequential and first-come-first-served, which is what
        // makes §4.4's "one route, and it depends only on primality" true. A
        // commit-reveal would close the race and was REMOVED deliberately —
        // the mint is one signature now — so this is a decision already taken,
        // not an oversight to file.
        //
        // Asserted as a source fact so the claim stays honest: nothing in the
        // mint path treats a valuable n differently from any other.
        const src = readFileSync(join(CONTRACTS_DIR, 'primes_ledger.tolk'), 'utf8');
        const handler = src.slice(src.indexOf('fun handleCardMint'), src.indexOf('fun executeMint'));
        // The head comparison is unconditional — no carve-out for primorials,
        // memorable numbers, or any other "valuable" class.
        expect(handler).toMatch(/msg\.n\s*!=\s*storage\.head/);
        // D-99 renames what must not appear here. `specialNumberTier` is deleted;
        // `scoreOf` is its replacement and is a STRICTLY worse thing to find on
        // this path, because it runs Miller-Rabin. The head decides who may mint;
        // what a number is worth is decided somewhere else, at a price, ahead of it.
        expect(handler).not.toMatch(/isPrimorial|scoreOf|specialNumberTier/);
    });
});
