import { Address, toNano } from '@ton/core';
import { Blockchain, createShardAccount } from '@ton/sandbox';
import { minterCardCode } from '../../../shared/minterCard';
import { MinterCardState, minterCardDataWith } from '../../wrappers/PrimesMinterCard';
import { minterCardAddress } from '../../../shared/minterCard';

/**
 * TEST HARNESSES ONLY — D-191 point 1. Puts a minter card holding `seed` at the address
 * the ledger derives for `seed.owner`, the sandbox's own seam for state no message can
 * write (the address is a hash of the EMPTY state, so no deploy can land a seeded one).
 * It replaces the ledger's old `minters` config seed: all four uplift terms can be live on
 * one wallet in production, but assembling them in a sandbox would mean standing up the
 * whole market. A seeded card is `seen` — some accepted event made it.
 */
export async function seedMinterCard(
    blockchain: Blockchain,
    ledger: Address,
    seed: Partial<MinterCardState> & { owner: Address }
) {
    const address = minterCardAddress(ledger, seed.owner);
    await blockchain.setShardAccount(
        address,
        createShardAccount({
            address,
            code: minterCardCode(),
            data: minterCardDataWith(ledger, seed.owner, { seen: true, ...seed }),
            balance: toNano('0.05'),
        })
    );
    return address;
}
