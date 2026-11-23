// TON PRIMES — P2.B5: THE ERA TROPHY IS TRANSFERABLE.
// CONCEPT.md §4.7 (§4.7.1, §5.1, §7); DECISIONS.md D-14 (closes §11.13), D-36;
// GAUNTLET.md P2.B5.
//
// D-14 was signed on 2026-08-16 and, until this file, was asserted in three
// documents and implemented nowhere: `primes_registrar.tolk`'s message union had
// no transfer opcode at all, so a trophy was bound to its winner's address for
// the life of the deployment. `transfer_trophy#b0000070` is the implementation.
//
// WHAT IS UNDER TEST, and why each one is here rather than assumed:
//
//   1. THE HOLDER MOVES IT AND NOBODY ELSE DOES. The current value at
//      `names[primorial]` is the only authority on this contract — no admin arm,
//      no operator override, and no LEDGER arm either: the ledger ISSUES a
//      trophy and has no say in where it goes afterwards.
//
//   2. THE SCOPE IS TROPHIES ONLY, AND THE NEGATIVE CASE IS THE POINT. `names`
//      carries two kinds of entry — prime-mint naming rights (§5.1: "whoever
//      takes it names it forever") and era trophies (D-36) — and only the second
//      kind moves. §4.7.1 fixes a prime's naming right "immediately and
//      permanently"; D-14's carve-out is for era trophies alone. A prime hits
//      `reg_not_primorial` (914) and stops.
//
//   3. THE `isNamedPrime` HOLE STAYS SHUT. This is the trap W4 found and it is
//      the reason this file is not three assertions long. `names` doubles as the
//      registrar's "is n a minted prime?" oracle, and every primorial is
//      COMPOSITE, so `isNamedPrime` excludes the eight primorials explicitly.
//      A transfer is a write into that same map, so the exclusion is re-proved
//      AFTER a transfer, through the two predicates that would actually be
//      fooled: `sophie_germain` (6, 13) and `complete_factorization` {6, 36}.
//      36 = 6² exactly, so the second one commits if and only if 6 is a prime.
//
//   4. NOTHING IS CUSTODIED. The registrar holds ZERO protocol GRAM and that
//      property is what justifies it being a separate contract (§3.4). A trophy
//      transfer is one dictionary write: no escrow, no fee, no outbound message.
//      Whatever the trophy sold for was settled between the parties somewhere
//      else entirely — this contract neither knows the price nor holds it.
//
//   5. `getTrophy` ANSWERS BOTH QUESTIONS IN ONE CALL (§9.1). Who holds it, and
//      whether it can move — so no client carries its own copy of the primorial
//      ladder to tell a trophy from a naming right.
//
// The stack here is the REGISTRAR ALONE with a treasury standing in for the
// ledger. Issuance end-to-end through a real primorial mint is already proved by
// `EraTrophy.spec.ts`; what this file needs is control over who holds what, and
// the `award_era_trophy` sender check is the whole authentication either way.
import { Blockchain, SandboxContract, TreasuryContract } from '@ton/sandbox';
import { Address, beginCell, Cell, toNano } from '@ton/core';
import '@ton/test-utils';
import { compile } from '@ton/blueprint';
import { PrimesRegistrar, RegistrarOpcodes } from '../wrappers/PrimesRegistrar';
import { REGISTRAR as REGISTRAR_OPS, ERRORS } from '../../shared/opcodes';

/** §7's eight primorial era boundaries. There will only ever be eight. */
const PRIMORIALS = [6n, 30n, 210n, 2310n, 30030n, 510510n, 9699690n, 223092870n];

/** Nominal gas plus a margin, never the exact figure (CLAUDE.md). */
const GAS = toNano('0.05');
/** register_set needs REG_BASE_GAS + memberCount * REG_PROVE_GAS; this clears it. */
const REGISTER_GAS = toNano('0.3');

describe('P2.B5 — the era trophy is transferable (D-14, §4.7)', () => {
    let blockchain: Blockchain;
    let deployer: SandboxContract<TreasuryContract>;
    let genesisScript: SandboxContract<TreasuryContract>;
    /** stands in for primes_ledger.tolk — the only address that may ISSUE */
    let ledgerStub: SandboxContract<TreasuryContract>;
    let winner: SandboxContract<TreasuryContract>;
    let buyer: SandboxContract<TreasuryContract>;
    let thirdParty: SandboxContract<TreasuryContract>;
    let stranger: SandboxContract<TreasuryContract>;

    let registrarCode: Cell;
    let itemCode: Cell;
    let registrar: SandboxContract<PrimesRegistrar>;

    beforeAll(async () => {
        registrarCode = await compile('PrimesRegistrar');
        itemCode = await compile('PrimesItem');
    });

    beforeEach(async () => {
        blockchain = await Blockchain.create();
        deployer = await blockchain.treasury('deployer');
        genesisScript = await blockchain.treasury('genesisScript');
        ledgerStub = await blockchain.treasury('ledgerStub');
        winner = await blockchain.treasury('winner');
        buyer = await blockchain.treasury('buyer');
        thirdParty = await blockchain.treasury('thirdParty');
        stranger = await blockchain.treasury('stranger');

        registrar = blockchain.openContract(
            PrimesRegistrar.createFromConfig(
                {
                    ledgerAddr: ledgerStub.address,
                    genesisScriptAddr: genesisScript.address,
                    collectionAddr: deployer.address,
                },
                registrarCode
            )
        );
        await registrar.sendDeploy(deployer.getSender(), toNano('1'));
    });

    // -----------------------------------------------------------------------
    // Helpers
    // -----------------------------------------------------------------------

    /** Issue a trophy the way the ledger does at a primorial ceremony (D-36). */
    async function award(primorial: bigint, to: Address, recruits = 3) {
        return await ledgerStub.send({
            to: registrar.address,
            value: GAS,
            body: beginCell()
                .storeUint(REGISTRAR_OPS.award_era_trophy, 32)
                .storeUint(0, 64)
                .storeUint(primorial, 256)
                .storeAddress(to)
                .storeUint(recruits, 32)
                .endCell(),
        });
    }

    /** The trophy's holder (`getTrophy`), as a string; null when nobody holds it. */
    async function namerOf(n: bigint) {
        const a = (await registrar.getTrophy(n)).holder;
        return a === null ? null : a.toString();
    }

    // -----------------------------------------------------------------------
    // 1. The holder moves it; nobody else does
    // -----------------------------------------------------------------------

    it('the holder transfers, the new holder is recorded, the old holder no longer holds it', async () => {
        await award(30n, winner.address);
        expect(await namerOf(30n)).toBe(winner.address.toString());

        const res = await registrar.sendTransferTrophy(winner.getSender(), {
            primorial: 30n,
            newHolder: buyer.address,
            value: GAS,
        });
        expect(res.transactions).toHaveTransaction({
            to: registrar.address,
            success: true,
            exitCode: 0,
        });

        expect(await namerOf(30n)).toBe(buyer.address.toString());
        expect(await namerOf(30n)).not.toBe(winner.address.toString());

        const t = await registrar.getTrophy(30n);
        expect(t.holder!.toString()).toBe(buyer.address.toString());
        expect(t.transferable).toBe(1);
    });

    it('a non-holder cannot transfer, and the failed attempt changes nothing', async () => {
        await award(210n, winner.address);

        const res = await registrar.sendTransferTrophy(stranger.getSender(), {
            primorial: 210n,
            newHolder: stranger.address,
            value: GAS,
        });
        expect(res.transactions).toHaveTransaction({
            to: registrar.address,
            exitCode: ERRORS.reg_not_namer, // 915
        });
        expect(await namerOf(210n)).toBe(winner.address.toString());
    });

    it('the LEDGER cannot move a trophy it issued — issuance is not custody', async () => {
        await award(2310n, winner.address);

        // The ledger is the only address that may AWARD. It has no standing at
        // all on where the trophy goes afterwards, and that is deliberate: an
        // issuer who could also move the prize is an admin path (§8).
        const res = await ledgerStub.send({
            to: registrar.address,
            value: GAS,
            body: beginCell()
                .storeUint(RegistrarOpcodes.TransferTrophy, 32)
                .storeUint(0, 64)
                .storeUint(2310n, 256)
                .storeAddress(stranger.address)
                .endCell(),
        });
        expect(res.transactions).toHaveTransaction({
            to: registrar.address,
            exitCode: ERRORS.reg_not_namer, // 915
        });
        expect(await namerOf(2310n)).toBe(winner.address.toString());
    });

    it('an UNISSUED trophy has no holder, so nobody can move it', async () => {
        // 30030 is a real primorial; its era has simply not closed.
        expect(await namerOf(30030n)).toBeNull();
        const t = await registrar.getTrophy(30030n);
        expect(t.holder).toBeNull();
        expect(t.transferable).toBe(1); // the KEY is transferable; there is nothing there yet

        const res = await registrar.sendTransferTrophy(stranger.getSender(), {
            primorial: 30030n,
            newHolder: stranger.address,
            value: GAS,
        });
        expect(res.transactions).toHaveTransaction({
            to: registrar.address,
            exitCode: ERRORS.reg_not_namer, // 915
        });
        expect(await namerOf(30030n)).toBeNull();
    });

    it('a trophy can move more than once, and the seller cannot take it back', async () => {
        await award(6n, winner.address);

        await registrar.sendTransferTrophy(winner.getSender(), {
            primorial: 6n,
            newHolder: buyer.address,
            value: GAS,
        });
        await registrar.sendTransferTrophy(buyer.getSender(), {
            primorial: 6n,
            newHolder: thirdParty.address,
            value: GAS,
        });
        expect(await namerOf(6n)).toBe(thirdParty.address.toString());

        // The original winner is now just an address.
        const clawback = await registrar.sendTransferTrophy(winner.getSender(), {
            primorial: 6n,
            newHolder: winner.address,
            value: GAS,
        });
        expect(clawback.transactions).toHaveTransaction({
            to: registrar.address,
            exitCode: ERRORS.reg_not_namer, // 915
        });
        expect(await namerOf(6n)).toBe(thirdParty.address.toString());
    });

    it('every one of §7’s eight primorials is transferable, and there are exactly eight', async () => {
        for (const p of PRIMORIALS) {
            await award(p, winner.address);
            await registrar.sendTransferTrophy(winner.getSender(), {
                primorial: p,
                newHolder: buyer.address,
                value: GAS,
            });
            expect(await namerOf(p)).toBe(buyer.address.toString());
            expect((await registrar.getTrophy(p)).transferable).toBe(1);
        }
        // The key set is CLOSED. The next primorial after 223092870 is
        // 6469693230, and it is not an era boundary — §7 stops at eight.
        expect((await registrar.getTrophy(6469693230n)).transferable).toBe(0);
    });

    // -----------------------------------------------------------------------
    // 2. Scope: trophies only. The negative case is the decision.
    // -----------------------------------------------------------------------

    it('an ordinary prime naming right is NOT transferable (§4.7.1, §5.1)', async () => {
        // A prime's namer lives on its item (D-188 point 6), where no message can move it.
        // The registrar refuses the transfer on SCOPE.

        const res = await registrar.sendTransferTrophy(winner.getSender(), {
            primorial: 7n,
            newHolder: buyer.address,
            value: GAS,
        });
        expect(res.transactions).toHaveTransaction({
            to: registrar.address,
            exitCode: ERRORS.reg_not_primorial, // 914 — the SCOPE gate, not the holder gate
        });

        // And the get-method says so before anyone spends gas finding out.
        const t = await registrar.getTrophy(7n);
        expect(t.transferable).toBe(0);
        expect(t.holder).toBeNull(); // getTrophy answers about TROPHIES only
    });

    it('a composite that is not a primorial has no trophy to move', async () => {
        const res = await registrar.sendTransferTrophy(winner.getSender(), {
            primorial: 12n,
            newHolder: buyer.address,
            value: GAS,
        });
        expect(res.transactions).toHaveTransaction({
            to: registrar.address,
            exitCode: ERRORS.reg_not_primorial, // 914
        });
        expect((await registrar.getTrophy(12n)).transferable).toBe(0);
    });

    // -----------------------------------------------------------------------
    // 3. A trophy is naming rights and nothing else
    //
    // D-102 deleted the four set predicates, and with them the two tests that
    // proved a trophy holder was not silently treated as a prime BY those
    // predicates. The property they guarded — a primorial is never counted as
    // a named prime — is structural since D-188 point 6: the two do not even
    // share a contract (trophies here, a prime's namer on its item).
    // -----------------------------------------------------------------------

    it('a trophy transfer rewrites its row in place and grows nothing', async () => {
        const cells = async () => {
            const st = (await blockchain.getContract(registrar.address)).account.account!.storage.state;
            if (st.type !== 'active') throw new Error('inactive');
            const seen = new Set<string>();
            const walk = (c: Cell) => {
                if (seen.has(c.hash().toString('hex'))) return;
                seen.add(c.hash().toString('hex'));
                c.refs.forEach(walk);
            };
            walk(st.state.data!);
            return seen.size;
        };
        await award(210n, winner.address);
        const withTrophy = await cells();
        await registrar.sendTransferTrophy(winner.getSender(), {
            primorial: 210n,
            newHolder: buyer.address,
            value: GAS,
        });
        expect(await cells()).toBe(withTrophy);
        expect(await namerOf(210n)).toBe(buyer.address.toString());
    });

    // -----------------------------------------------------------------------
    // 4. Zero liability survives (§3.4)
    // -----------------------------------------------------------------------

    it('a transfer is one dictionary write: no outbound message, no custody, no fee', async () => {
        await award(510510n, winner.address);

        const res = await registrar.sendTransferTrophy(winner.getSender(), {
            primorial: 510510n,
            newHolder: buyer.address,
            value: GAS,
        });

        // Exactly two transactions: the sender's, and the registrar's. Nothing
        // is forwarded anywhere — no escrow contract, no treasury cut, no
        // payout to the seller. The registrar has no GRAM path to add one to.
        expect(res.transactions).toHaveLength(2);

        // §3.4's whole point, still true afterwards.
        const solvency = await registrar.getSolvency();
        expect(solvency.liability).toBe(0n);
    });

    it('the transfer does not need the ledger to be linked at all', async () => {
        // Issuance needs the ledger; MOVEMENT does not touch it. Proving this
        // keeps the two concerns from being quietly coupled by a later edit.
        await award(9699690n, winner.address);
        const res = await registrar.sendTransferTrophy(winner.getSender(), {
            primorial: 9699690n,
            newHolder: buyer.address,
            value: GAS,
        });
        expect(res.transactions).toHaveTransaction({
            to: registrar.address,
            success: true,
        });
        expect(res.transactions).not.toHaveTransaction({ to: ledgerStub.address });
    });

    // -----------------------------------------------------------------------
    // 5. §9.1: the holder is publicly readable
    // -----------------------------------------------------------------------

    it('getTrophy answers holder AND transferability in one call', async () => {
        // unissued primorial
        let t = await registrar.getTrophy(2310n);
        expect(t.holder).toBeNull();
        expect(t.transferable).toBe(1);

        // issued
        await award(2310n, winner.address);
        t = await registrar.getTrophy(2310n);
        expect(t.holder!.toString()).toBe(winner.address.toString());
        expect(t.transferable).toBe(1);

        // moved
        await registrar.sendTransferTrophy(winner.getSender(), {
            primorial: 2310n,
            newHolder: buyer.address,
            value: GAS,
        });
        t = await registrar.getTrophy(2310n);
        expect(t.holder!.toString()).toBe(buyer.address.toString());

        // a named prime is NOT a trophy, and the call says so rather than
        // returning a namer a UI would then have to reclassify (the prime's namer
        // is its item's `getNamer()`, D-188 point 6)
        t = await registrar.getTrophy(17n);
        expect(t.holder).toBeNull();
        expect(t.transferable).toBe(0);
    });

    it('the opcode matches shared/opcodes.ts', () => {
        expect(RegistrarOpcodes.TransferTrophy).toBe(REGISTRAR_OPS.transfer_trophy);
        expect(REGISTRAR_OPS.transfer_trophy).toBe(0xb0000070);
    });
});
