// §4.1 / §3.1: an unresolvable referral line falls to the pool, never to the team.
//
// The referral relay (`forward_to_owner`) used to pass its 0.1 TON to `owner` with
// no `populated` check. Anyone can deploy an item's canonical empty state, whose
// `owner` is the collection placeholder, and a referral can overtake `Populate`
// (the V32 race), so the TON reached the collection's catch-all royalty arm: half
// to the operator. The item now refuses (307) and the ledger sends the relay
// bounceable, so the TON comes home as surplus for `sweep_ops` to pool.
import { Blockchain, SandboxContract, TreasuryContract } from '@ton/sandbox';
import { beginCell, Cell, contractAddress, toNano } from '@ton/core';
import '@ton/test-utils';
import { compile } from '@ton/blueprint';
import { ERRORS, ITEM } from '../../shared/opcodes';

describe('referral relay — an unpopulated item refuses it', () => {
    let blockchain: Blockchain;
    let ledgerStub: SandboxContract<TreasuryContract>;
    let collectionStub: SandboxContract<TreasuryContract>;
    let itemCode: Cell;

    beforeAll(async () => {
        itemCode = await compile('PrimesItem');
    });

    beforeEach(async () => {
        blockchain = await Blockchain.create();
        ledgerStub = await blockchain.treasury('ledgerStub');
        collectionStub = await blockchain.treasury('collectionStub');
    });

    it('a squatted empty item bounces the referral back to the ledger; the collection gets nothing', async () => {
        // The collection's `buildItemInitData`, byte for byte, with no Populate —
        // the same squat LotBlock.spec.ts deploys.
        const mutable = beginCell()
            .storeUint(0, 8) // populated
            .storeAddress(collectionStub.address) // owner placeholder
            .storeUint(0, 8) // isPrime
            .storeRef(beginCell().endCell()) // factorization
            .storeUint(0, 16) // rarityFlags
            .storeCoins(0) // owed
            .storeUint(0, 24) // mintedDay
            .storeCoins(0) // tributeTotal
            .storeCoins(0) // referralPaidTotal
            .storeCoins(0) // divEntry
            .storeCoins(0) // forfeitedTotal
            .storeMaybeRef(null) // naming
            .endCell();
        const data = beginCell()
            .storeUint(10n, 256)
            .storeAddress(collectionStub.address)
            .storeAddress(ledgerStub.address)
            .storeRef(mutable)
            .endCell();
        const init = { code: itemCode, data };
        const item = contractAddress(0, init);
        const squat = await ledgerStub.send({ to: item, value: toNano('0.02'), init, body: beginCell().endCell() });
        expect(squat.transactions).toHaveTransaction({ to: item, success: true, deploy: true });

        // The ledger's relay: bounceable, exactly REFERRAL_AMOUNT.
        const r = await ledgerStub.send({
            to: item,
            value: toNano('0.1'),
            bounce: true,
            body: beginCell().storeUint(ITEM.forward_to_owner, 32).storeUint(0, 64).endCell(),
        });
        expect(r.transactions).toHaveTransaction({
            from: ledgerStub.address,
            to: item,
            success: false,
            exitCode: ERRORS.item_not_populated,
        });
        expect(r.transactions).toHaveTransaction({ from: item, to: ledgerStub.address, inMessageBounced: true });
        expect(r.transactions).not.toHaveTransaction({ to: collectionStub.address });
    });
});
