import { Address, beginCell, toNano } from '@ton/core';
import '@ton/test-utils';
import { PrimesItem } from '../wrappers/PrimesItem';
import { compileAll, deployStack, factorize, Stack } from './helpers/stack';

/**
 * TEP-62 conformance for the ITEM's transfer path — the thing a marketplace
 * actually exercises when it takes custody of a number.
 *
 * The item used to parse a trimmed transfer body (`query_id`, `new_owner` and
 * nothing else). A wallet's standard body carries four more fields, so the
 * parse threw, and GetGems — which emulates the transfer into its sale contract
 * before it will list — answered "this NFT can't be listed for sale, please
 * contact the collection's creator". That made CONCEPT §3.1's secondary royalty
 * unearnable: a royalty is a marketplace convention, and no marketplace could
 * hold the number.
 *
 * The three things a sale contract needs, all asserted below:
 *   1. the full body parses and moves ownership,
 *   2. `ownership_assigned#05138d91` reaches the new owner carrying the
 *      forward payload (this is how a sale contract learns which lot arrived),
 *   3. `excesses#d53276db` returns the change to `response_destination`.
 */
describe('TEP-62 marketplace transfer', () => {
    const N = 4n; // the first composite, minted at the head for 1 TON

    let s: Stack;
    let item: ReturnType<Stack['blockchain']['openContract']> extends never ? never : any;

    beforeAll(async () => {
        await compileAll();
    });

    beforeEach(async () => {
        s = await deployStack();
        await s.mint(s.alice, N, 0, factorize(N));
        item = s.blockchain.openContract(PrimesItem.createFromAddress(await s.itemAddressOf(N)));
    });

    /** Exactly the body @ton/ton's NFT transfer builder produces. */
    function standardTransferBody(newOwner: Address, response: Address | null, fwd: bigint, payload: number) {
        return beginCell()
            .storeUint(0x5fcc3d14, 32)
            .storeUint(1234n, 64)
            .storeAddress(newOwner)
            .storeAddress(response)
            .storeMaybeRef(null)
            .storeCoins(fwd)
            .storeUint(0, 1) // forward_payload inline
            .storeUint(payload, 32)
            .endCell();
    }

    it('moves ownership, notifies the new owner, and refunds the response destination', async () => {
        const r = await s.alice.send({
            to: item.address,
            value: toNano('0.2'),
            body: standardTransferBody(s.bob.address, s.alice.address, toNano('0.05'), 0xdeadbeef),
        });

        expect(r.transactions).toHaveTransaction({ to: item.address, success: true });
        expect((await item.getNumberData()).owner.equals(s.bob.address)).toBe(true);

        // ownership_assigned, with the payload the sale contract reads back.
        expect(r.transactions).toHaveTransaction({
            from: item.address,
            to: s.bob.address,
            op: 0x05138d91,
            body: beginCell()
                .storeUint(0x05138d91, 32)
                .storeUint(1234n, 64)
                .storeAddress(s.alice.address)
                // the Either flag travels with the payload: `forward_payload` is
                // relayed as the untouched remainder of the transfer body.
                .storeUint(0, 1)
                .storeUint(0xdeadbeef, 32)
                .endCell(),
        });
        // TEP-62: the new owner receives `forward_amount` whole; the fee is paid on top.
        expect(r.transactions).toHaveTransaction({
            from: item.address,
            to: s.bob.address,
            op: 0x05138d91,
            value: toNano('0.05'),
        });

        // excesses back to response_destination.
        expect(r.transactions).toHaveTransaction({
            from: item.address,
            to: s.alice.address,
            op: 0xd53276db,
        });
    });

    it('a zero forward_amount and addr_none response send neither reply, and still transfer', async () => {
        const r = await s.alice.send({
            to: item.address,
            value: toNano('0.1'),
            body: standardTransferBody(s.bob.address, null, 0n, 0),
        });
        expect(r.transactions).toHaveTransaction({ to: item.address, success: true });
        expect((await item.getNumberData()).owner.equals(s.bob.address)).toBe(true);
        expect(r.transactions).not.toHaveTransaction({ from: item.address, op: 0x05138d91 });
        expect(r.transactions).not.toHaveTransaction({ from: item.address, op: 0xd53276db });
    });

    it('a non-owner still cannot transfer', async () => {
        const r = await s.bob.send({
            to: item.address,
            value: toNano('0.1'),
            body: standardTransferBody(s.bob.address, s.bob.address, 0n, 0),
        });
        expect(r.transactions).toHaveTransaction({ to: item.address, success: false, exitCode: 300 });
    });

    it('answers get_static_data with its index and collection', async () => {
        const r = await s.alice.send({
            to: item.address,
            value: toNano('0.05'),
            body: beginCell().storeUint(0x2fcb26a2, 32).storeUint(7n, 64).endCell(),
        });
        expect(r.transactions).toHaveTransaction({
            from: item.address,
            to: s.alice.address,
            body: beginCell()
                .storeUint(0x8b771735, 32)
                .storeUint(7n, 64)
                .storeUint(N, 256)
                .storeAddress(s.collection.address)
                .endCell(),
        });
    });

    it('get_nft_data reports init? as TVM true', async () => {
        const r = await s.blockchain.provider(item.address).get('get_nft_data', []);
        expect(r.stack.readNumber()).toBe(-1);
    });
});
