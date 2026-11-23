// TON PRIMES — D-212: the owner names a number once for a GRAM fee; a rename costs more.
// CONCEPT.md §4.7.1, §5 (a pure floor step); NAMING_PLAN.md §2 point 5.
//
// The route: owner -> collection `name_number` -> item(n) `item_name` (checks the owner
// and the count) -> collection `naming_paid` -> ledger `royalty_to_ratchet` -> ratchet.
//
// WHAT THIS FILE PROVES
//   1. The current owner names once at `nameFee`; every later naming needs `renameFee`.
//   2. `T` rises by EXACTLY the fee and `S` does not (§5: a pure floor step).
//   3. Every refusal refunds the whole value: a non-owner, an underpayment, an unminted
//      `n` (by bounce), a refs-carrying text. No naming fee ever rests on the collection,
//      whose catch-all arm would split it 50/50 with the operator as a royalty.
//   4. The pen follows the NFT: after a transfer the buyer renames, the seller cannot.
//   5. The item never pays out of its own balance (a prime's `owed` is in there).
//   6. The door minimum carries the fee all the way to the ratchet.
import { SandboxContract, TreasuryContract } from '@ton/sandbox';
import { Address, beginCell, Cell, toNano } from '@ton/core';
import '@ton/test-utils';
import { deployStack, factorize, Stack } from './helpers/stack';
import { PrimesItem } from '../wrappers/PrimesItem';
import { COLLECTION, ITEM, LEDGER } from '../../shared/opcodes';
import { NAME_RELAY_GAS_NANOTON } from '../../shared/messages';

const text = (t: string) => beginCell().storeStringTail(t).endCell();
const MARGIN = toNano('0.05');

describe('D-212 — naming a number for GRAM (§4.7.1)', () => {
    let s: Stack;
    let alice: SandboxContract<TreasuryContract>;
    let bob: SandboxContract<TreasuryContract>;
    let nameFee: bigint;
    let renameFee: bigint;

    const item = async (n: bigint) =>
        s.blockchain.openContract(PrimesItem.createFromAddress(await s.collection.getItemAddress(n)));
    const balanceOf = async (a: Address) => (await s.blockchain.getContract(a)).balance;
    const name = (who: SandboxContract<TreasuryContract>, n: bigint, t: string | Cell, value: bigint) =>
        s.collection.sendNameNumber(who.getSender(), { n, text: typeof t === 'string' ? text(t) : t, value });
    /** The head is a composite after the stack's genesis walk; mint it to `who`. */
    const mintHead = async (who: SandboxContract<TreasuryContract>) => {
        const n = await s.ledger.getHead();
        const r = await s.mint(who, n, 0, factorize(n));
        expect(r.transactions).not.toHaveTransaction({ aborted: true });
        return n;
    };

    beforeEach(async () => {
        s = await deployStack();
        alice = s.alice;
        bob = s.bob;
        ({ nameFee, renameFee } = await s.collection.getNaming());
    });

    it('the fees are deploy data the collection publishes, and nothing is named at genesis', async () => {
        expect(nameFee).toBeGreaterThan(0n);
        expect(renameFee).toBeGreaterThan(nameFee);
        expect(await s.registrar.getTrophyRenameFee()).toBe(renameFee);
        const b = await s.collection.getNaming();
        expect([b.named, b.renamed, b.toFloor]).toEqual([0, 0, 0n]);
    });

    it('the owner names once: T rises by exactly nameFee, S does not, the change comes home', async () => {
        const n = await mintHead(alice);
        const it_ = await item(n);
        expect((await it_.getNamer())!.equals(alice.address)).toBe(true);
        const T0 = await s.ledger.getFloorNum();
        const S0 = await s.ledger.getFloorDen();
        const royalty0 = await s.collection.getRoyaltySplit();
        const collBal0 = await balanceOf(s.collection.address);
        const itemBal0 = await balanceOf(it_.address);
        const alice0 = await alice.getBalance();

        const r = await name(alice, n, 'four', nameFee + NAME_RELAY_GAS_NANOTON + toNano('1'));
        expect(r.transactions).not.toHaveTransaction({ aborted: true });
        expect(r.transactions).toHaveTransaction({ from: s.collection.address, to: it_.address, op: ITEM.item_name, success: true });
        expect(r.transactions).toHaveTransaction({ from: it_.address, to: s.collection.address, op: COLLECTION.naming_paid, success: true });
        expect(r.transactions).toHaveTransaction({ from: s.collection.address, to: s.ledger.address, op: LEDGER.royalty_to_ratchet, success: true });
        expect(r.transactions).toHaveTransaction({ from: s.ledger.address, to: s.ratchet.address, success: true });

        const a = await it_.getAnnotation();
        expect(a.count).toBe(1);
        expect(a.text.beginParse().loadStringTail()).toBe('four');
        expect(await s.ledger.getFloorNum()).toBe(T0 + nameFee);
        expect(await s.ledger.getFloorDen()).toBe(S0);
        expect(await s.collection.getNaming()).toEqual({ nameFee, renameFee, named: 1, renamed: 0, toFloor: nameFee });
        // Trap 1: nothing reached the royalty arm, and the collection kept nothing.
        expect(await s.collection.getRoyaltySplit()).toEqual(royalty0);
        expect(await balanceOf(s.collection.address)).toBeLessThanOrEqual(collBal0);
        // Trap 3: the item paid nothing out of its own balance.
        expect(await balanceOf(it_.address)).toBeGreaterThanOrEqual(itemBal0 - toNano('0.001'));
        // The extra 1 GRAM came home: alice is out the fee plus gas, not the fee plus 1 GRAM.
        expect(alice0 - (await alice.getBalance())).toBeLessThan(nameFee + toNano('0.1'));
    });

    it('a second naming at nameFee is refunded whole; at renameFee it lands and counts as a rename', async () => {
        const n = await mintHead(alice);
        const it_ = await item(n);
        await name(alice, n, 'first', nameFee + NAME_RELAY_GAS_NANOTON + MARGIN);
        const T1 = await s.ledger.getFloorNum();

        const alice0 = await alice.getBalance();
        const cheap = await name(alice, n, 'cheap', nameFee + NAME_RELAY_GAS_NANOTON + MARGIN);
        expect(cheap.transactions).not.toHaveTransaction({ aborted: true });
        expect(cheap.transactions).toHaveTransaction({ from: it_.address, to: alice.address, success: true });
        expect(cheap.transactions).not.toHaveTransaction({ op: COLLECTION.naming_paid });
        expect(alice0 - (await alice.getBalance())).toBeLessThan(toNano('0.05'));
        expect((await it_.getAnnotation()).count).toBe(1);
        expect(await s.ledger.getFloorNum()).toBe(T1);

        const r = await name(alice, n, 'second', renameFee + NAME_RELAY_GAS_NANOTON + MARGIN);
        expect(r.transactions).not.toHaveTransaction({ aborted: true });
        const a = await it_.getAnnotation();
        expect(a.count).toBe(2);
        expect(a.text.beginParse().loadStringTail()).toBe('second');
        expect(await s.ledger.getFloorNum()).toBe(T1 + renameFee);
        const b = await s.collection.getNaming();
        expect([b.named, b.renamed, b.toFloor]).toEqual([1, 1, nameFee + renameFee]);
    });

    it('a non-owner is refunded whole and writes nothing', async () => {
        const n = await mintHead(alice);
        const it_ = await item(n);
        const T0 = await s.ledger.getFloorNum();
        const bob0 = await bob.getBalance();
        const r = await name(bob, n, 'not mine', nameFee + NAME_RELAY_GAS_NANOTON + MARGIN);
        expect(r.transactions).not.toHaveTransaction({ aborted: true });
        expect(r.transactions).toHaveTransaction({ from: it_.address, to: bob.address, success: true });
        expect(bob0 - (await bob.getBalance())).toBeLessThan(toNano('0.05'));
        expect((await it_.getAnnotation()).count).toBe(0);
        expect(await s.ledger.getFloorNum()).toBe(T0);
    });

    it('a text with refs is refunded (ONE cell, D-188 point 2)', async () => {
        const n = await mintHead(alice);
        const fat = beginCell().storeStringTail('x').storeRef(text('y')).endCell();
        const r = await name(alice, n, fat, nameFee + NAME_RELAY_GAS_NANOTON + MARGIN);
        expect(r.transactions).not.toHaveTransaction({ aborted: true });
        expect((await (await item(n)).getAnnotation()).count).toBe(0);
    });

    it('an UNMINTED n bounces home and the collection refunds the sender (trap 2)', async () => {
        const n = 999_999n;
        const itemAddr = await s.collection.getItemAddress(n);
        const T0 = await s.ledger.getFloorNum();
        const royalty0 = await s.collection.getRoyaltySplit();
        const collBal0 = await balanceOf(s.collection.address);
        const alice0 = await alice.getBalance();
        const r = await name(alice, n, 'ghost', nameFee + NAME_RELAY_GAS_NANOTON + MARGIN);
        // The one legitimate abort: the message to an address with no contract.
        for (const t of r.transactions) {
            const to = t.inMessage?.info.dest;
            if (to && Address.isAddress(to) && to.equals(itemAddr)) continue;
            expect(t.description.type === 'generic' && t.description.aborted).toBe(false);
        }
        expect(r.transactions).toHaveTransaction({ from: s.collection.address, to: alice.address, success: true });
        expect(alice0 - (await alice.getBalance())).toBeLessThan(toNano('0.05'));
        expect(await s.ledger.getFloorNum()).toBe(T0);
        expect(await s.collection.getRoyaltySplit()).toEqual(royalty0);
        expect(await balanceOf(s.collection.address)).toBeLessThanOrEqual(collBal0);
    });

    it('below the door minimum the collection refuses (103) and the message bounces home', async () => {
        const n = await mintHead(alice);
        const r = await name(alice, n, 'short', nameFee);
        expect(r.transactions).toHaveTransaction({ to: s.collection.address, success: false, exitCode: 103 });
        expect((await (await item(n)).getAnnotation()).count).toBe(0);
    });

    it('exactly the door minimum still carries the fee to the ratchet (trap 4)', async () => {
        const n = await mintHead(alice);
        const T0 = await s.ledger.getFloorNum();
        const r = await name(alice, n, 'exact', nameFee + NAME_RELAY_GAS_NANOTON);
        expect(r.transactions).not.toHaveTransaction({ aborted: true });
        expect(r.transactions).toHaveTransaction({ from: s.ledger.address, to: s.ratchet.address, success: true });
        expect(await s.ledger.getFloorNum()).toBe(T0 + nameFee);
    });

    it('the pen follows the NFT: the buyer renames at renameFee, the seller is refunded', async () => {
        const n = await mintHead(alice);
        const it_ = await item(n);
        await name(alice, n, 'alice was here', nameFee + NAME_RELAY_GAS_NANOTON + MARGIN);
        await it_.sendTransfer(alice.getSender(), { newOwner: bob.address, value: toNano('0.1') });
        expect((await it_.getNamer())!.equals(bob.address)).toBe(true);

        const seller = await name(alice, n, 'still mine?', renameFee + NAME_RELAY_GAS_NANOTON + MARGIN);
        expect(seller.transactions).toHaveTransaction({ from: it_.address, to: alice.address, success: true });
        expect((await it_.getAnnotation()).count).toBe(1);

        const buyer = await name(bob, n, 'bob now', renameFee + NAME_RELAY_GAS_NANOTON + MARGIN);
        expect(buyer.transactions).not.toHaveTransaction({ aborted: true });
        const a = await it_.getAnnotation();
        expect(a.count).toBe(2);
        expect(a.text.beginParse().loadStringTail()).toBe('bob now');
    });

    it('a PRIME names the same way, and its item balance (the owed GRAM) is untouched', async () => {
        await s.acquire(alice, 2n);
        const it_ = await item(2n);
        expect((await it_.getNumberData()).owner.equals(alice.address)).toBe(true);
        const bal0 = await balanceOf(it_.address);
        const owed0 = await it_.getOwed();
        const r = await name(alice, 2n, 'the even prime', nameFee + NAME_RELAY_GAS_NANOTON + toNano('3'));
        expect(r.transactions).not.toHaveTransaction({ aborted: true });
        expect((await it_.getAnnotation()).count).toBe(1);
        expect(await it_.getOwed()).toBe(owed0);
        expect(await balanceOf(it_.address)).toBeGreaterThanOrEqual(bal0 - toNano('0.001'));
    });

    it('only the collection may send item_name, and only an item or the registrar naming_paid', async () => {
        const n = await mintHead(alice);
        const it_ = await item(n);
        const forgedName = await alice.send({
            to: it_.address,
            value: toNano('5'),
            body: beginCell()
                .storeUint(ITEM.item_name, 32).storeUint(0, 64)
                .storeAddress(alice.address).storeRef(text('forged'))
                .storeCoins(0).storeCoins(0)
                .endCell(),
        });
        expect(forgedName.transactions).toHaveTransaction({ to: it_.address, success: false, exitCode: 100 });
        const forgedPaid = await bob.send({
            to: s.collection.address,
            value: toNano('1'),
            body: beginCell()
                .storeUint(COLLECTION.naming_paid, 32).storeUint(0, 64)
                .storeUint(n, 256).storeCoins(toNano('0.5')).storeUint(1, 16)
                .endCell(),
        });
        expect(forgedPaid.transactions).toHaveTransaction({ to: s.collection.address, success: false, exitCode: 100 });
        expect((await s.collection.getNaming()).named).toBe(0);
    });

    it('a fresh mint stores no name: the mint path writes no naming cell for a prime or a composite', async () => {
        const n = await mintHead(alice);
        expect((await (await item(n)).getAnnotation()).count).toBe(0);
        await s.acquire(alice, 3n);
        expect((await (await item(3n)).getAnnotation()).count).toBe(0);
    });
});
