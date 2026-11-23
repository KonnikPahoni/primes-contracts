/**
 * TON PRIMES — a RESALE, end to end, against GetGems' own sale contract. **Testnet only.**
 *
 * `GAUNTLET.md` H18. Every number this game has ever minted went from the mint to a wallet and
 * stopped there. The secondary market — a sale contract taking custody, a stranger buying, and
 * the TEP-66 royalty being forwarded by somebody else's code — was proven in `@ton/sandbox` and
 * on nothing else, and `H16` closed the royalty split by the route that deliberately skips it
 * (`proveRoyaltySplitLive.ts` pays a royalty that no sale contract sent).
 *
 * WHY THIS DOES NOT NEED THE GETGEMS WEBSITE, AND WHAT IT THEREFORE DOES NOT PROVE.
 * The bytecode below is GetGems' `nft-fixprice-sale-v3r3`, verbatim from
 * `getgems-io/nft-contracts`. The contract initialises itself from whoever transfers the NFT in
 * (`throw_unless(500, equal_slices(sender_address, nft_address))`), so a sale is three ordinary
 * messages and needs no website and no wallet app:
 *
 *   1. the MARKETPLACE address deploys it (`if (~ is_initialized) { if (sender == marketplace)
 *      return (); }` — the "just accept coins on deploy" arm);
 *   2. the SELLER sends a TEP-62 `transfer` of the number into it, and its `ownership_assigned`
 *      is what records who the seller is;
 *   3. the BUYER sends `op = 2` with at least `full_price + 0.1 GRAM`.
 *
 * What it does NOT prove is that the sale appears ON getgems.io. Their indexer only follows sale
 * contracts whose `marketplace_address` is their own marketplace contract, and that contract
 * deploys a sale only on a message their backend has signed
 * (`nft-marketplace-v2.fc`: `throw_unless(35, check_signature(slice_hash(in_msg_body), signature,
 * public_key))`). So `marketplace_address` here is OUR wallet. The chain mechanics are identical;
 * the listing page is not part of them.
 *
 * WHAT IS ACTUALLY UNDER TEST — the last hop, which is the one that has bitten this project three
 * times (`MISTAKES.md`: DeDust's `payout`, `provide_wallet_address`, TEP-74's `excesses`). The
 * sale contract pays the royalty with `send_money`, which builds
 * `.store_uint(0x10, 6) ... .store_uint(0, 1 + 4 + 4 + 64 + 32 + 1 + 1)` — a NON-BOUNCEABLE
 * message with an EMPTY BODY. That lands on the collection's catch-all arm, which since D-128 is
 * the splitter rather than `assert (in.body.isEmpty()) throw 101`. The asserts below are that it
 * split, and that the ratchet leg landed in `T` exactly:
 *
 *   - `getRoyaltySplit()`: `forwards` +1 and both legs up;
 *   - the ledger's `T` (`getFloorNum`) up by EXACTLY the ratchet leg — a royalty is injection
 *     without emission, so `S` (`getFloorDen`) must NOT move and the floor takes a pure step;
 *   - the number's owner is the BUYER, and the head has not moved.
 *
 * AND ONE THING THAT IS NOT A BUG BUT IS A FACT NOBODY HAD WRITTEN DOWN. `ClaimTribute` is gated
 * `assert (in.senderAddress == m.owner) throw 300`, so while the number sits in the sale contract
 * the SALE CONTRACT owns it and nobody can claim the accrued tribute — it stays on the item and
 * passes to the buyer with the number. This script reads `getOwed()` at both ends so the journal
 * carries the figure.
 *
 *   PRIMES_RESALE_N=899809363 PRIMES_RESALE_PRICE_TON=2 npx tsx scripts/proveResaleLive.ts
 */
import { Address, Cell, beginCell, contractAddress, fromNano, toNano } from '@ton/core';
import { PrimesCollection } from '../wrappers/PrimesCollection';
import { PrimesLedger } from '../wrappers/PrimesLedger';
import { PrimesItem } from '../wrappers/PrimesItem';
import { makeClient, openDeployWallet, openWallet, retry } from './testnet/sender';
import { readCast } from './testnet/cast';
import { hydrateProcessEnv } from './envFile';

// W10: `tsx` loads no `.env`, and every PRIMES_*_ADDRESS read below would otherwise fall
// through to a hardcoded address from a dead genesis.
hydrateProcessEnv();

/**
 * `nft-fixprice-sale-v3r3`, compiled by GetGems (func 0.4.4), copied from
 * `getgems-io/nft-contracts/packages/contracts/nft-fixprice-sale-v3/NftFixpriceSaleV3.source.ts`.
 * Kept as the base64 BOC rather than as FunC source on purpose: the point of the test is that
 * OUR collection survives THEIR code, so recompiling it here would be testing the wrong artifact.
 */
const SALE_V3R3_CODE_B64 =
    'te6ccgECDwEAA5MAART/APSkE/S88sgLAQIBYgIDAgLNBAUCASANDgL30A6GmBgLjYSS+CcH0gGHaiaGmAaY/9IH0gfSB9AGppj+mfmBg4KYVjgGAASpiFaY+F7xDhgEoYBWmfxwjFsxsLcxsrZBZjgsk5mW8oBfEV4ADJL4dwEuuk4QEWQIEV3RXgAJFZ2Ngp5OOC2HGBFWAA+WjKFkEINjYQQF1AYHAdFmCEAX14QBSYKBSML7y4cIk0PpA+gD6QPoAMFOSoSGhUIehFqBSkCH6RFtwgBDIywVQA88WAfoCy2rJcfsAJcIAJddJwgKwjhtQRSH6RFtwgBDIywVQA88WAfoCy2rJcfsAECOSNDTiWoMAGQwMWyy1DDQ0wchgCCw8tGVIsMAjhSBAlj4I1NBobwE+CMCoLkTsPLRlpEy4gHUMAH7AATwU8fHBbCOXRNfAzI3Nzc3BPoA+gD6ADBTIaEhocEB8tGYBdD6QPoA+kD6ADAwyDICzxZY+gIBzxZQBPoCyXAgEEgQNxBFEDQIyMsAF8sfUAXPFlADzxYBzxYB+gLMyx/LP8ntVOCz4wIwMTcowAPjAijAAOMCCMACCAkKCwCGNTs7U3THBZJfC+BRc8cF8uH0ghAFE42RGLry4fX6QDAQSBA3VTIIyMsAF8sfUAXPFlADzxYBzxYB+gLMyx/LP8ntVADiODmCEAX14QAYvvLhyVNGxwVRUscFFbHy4cpwIIIQX8w9FCGAEMjLBSjPFiH6Astqyx8Vyz8nzxYnzxYUygAj+gITygDJgwb7AHFwVBcAXjMQNBAjCMjLABfLH1AFzxZQA88WAc8WAfoCzMsfyz/J7VQAGDY3EDhHZRRDMHDwBQAgmFVEECQQI/AF4F8KhA/y8ADsIfpEW3CAEMjLBVADzxYB+gLLaslx+wBwIIIQX8w9FMjLH1Iwyz8kzxZQBM8WE8oAggnJw4D6AhLKAMlxgBjIywUnzxZw+gLLaswl+kRbyYMG+wBxVWD4IwEIyMsAF8sfUAXPFlADzxYBzxYB+gLMyx/LP8ntVACHvOFnaiaGmAaY/9IH0gfSB9AGppj+mfmC3ofSB9AH0gfQAYKaFQkNDggPlozJP9Ii2TfSItkf0iLcEIIySsKAVgAKrAQAgb7l72omhpgGmP/SB9IH0gfQBqaY/pn5gBaH0gfQB9IH0AGCmxUJDQ4ID5aM0U/SItlH0iLZH9Ii2F4ACFiBqqiU';

const OP_ACCEPT_COINS = 1;
const OP_BUY = 2;
const OP_TRANSFER = 0x5fcc3d14;

const N = BigInt(process.env.PRIMES_RESALE_N ?? '899809363');
const PRICE = toNano(process.env.PRIMES_RESALE_PRICE_TON ?? '2');
/** The buyer attaches `full_price + this`; the contract's own floor is `min_gas_amount` 0.1 GRAM
 *  (`throw_unless(450, msg_value >= full_price + min_gas_amount())`). Lower it only when the
 *  buyer's float is the binding constraint, which on a swept testnet set it often is. */
const BUY_MARGIN = toNano(process.env.PRIMES_RESALE_BUY_MARGIN_TON ?? '0.15');
/** `created_at` is part of the sale contract's DATA, so it is part of its ADDRESS. It was
 *  `Date.now()` for one run, which meant a re-run computed a different address and could not
 *  find the sale it had already deployed. Fixed at 0 unless asked otherwise: the contract only
 *  stores the field, and a deterministic address is what makes this script resumable. */
const CREATED_AT = Number(process.env.PRIMES_RESALE_CREATED_AT ?? '0');

function need(name: string): string {
    const v = process.env[name];
    if (!v) throw new Error(`missing required env var ${name} (see .env)`);
    return v;
}

/**
 * The v3r3 storage, in `load_data`'s order. `sold_at` and `query_id` are what v3r3 added over
 * v3r2 and they must be PRESENT at deploy even though they are zero — `load_data` reads them
 * unconditionally, so a data cell built to the older layout throws on the first message.
 */
function saleData(args: {
    marketplace: Address;
    nft: Address;
    fullPrice: bigint;
    feeAddress: Address;
    fee: bigint;
    royaltyAddress: Address;
    royalty: bigint;
    createdAt: number;
}): Cell {
    const fees = beginCell()
        .storeAddress(args.feeAddress)
        .storeCoins(args.fee)
        .storeAddress(args.royaltyAddress)
        .storeCoins(args.royalty)
        .endCell();
    return beginCell()
        .storeUint(0, 1) // is_complete
        .storeUint(args.createdAt, 32)
        .storeAddress(args.marketplace)
        .storeAddress(args.nft)
        .storeAddress(null) // nft_owner_address — the NFT itself fills this in
        .storeCoins(args.fullPrice)
        .storeRef(fees)
        .storeUint(0, 32) // sold_at
        .storeUint(0, 64) // query_id
        .endCell();
}

async function main() {
    const client = makeClient(); // asserts testnet twice (D-95)
    const collection = client.open(
        PrimesCollection.createFromAddress(Address.parse(need('PRIMES_COLLECTION_ADDRESS')))
    );
    const ledger = client.open(PrimesLedger.createFromAddress(Address.parse(need('PRIMES_LEDGER_ADDRESS'))));

    // The marketplace is US. See the header: GetGems' own marketplace contract will not deploy a
    // sale without a signature from their backend, and that is the ONLY part of a listing that a
    // key holder cannot reproduce.
    const market = await openDeployWallet(client);

    const nftAddress = await retry(() => collection.getNftAddressByIndex(N), 'getNftAddressByIndex');
    const item = client.open(PrimesItem.createFromAddress(nftAddress));
    const nft: any = await retry(() => item.getNftData(), 'getNftData');
    const ownerNow: Address = nft.ownerAddress;

    // The seller is whoever owns it; the buyer is any cast wallet that is not the seller. A
    // resale where the two are the same address proves the royalty leg and nothing about custody.
    //
    // ON A RESUMED RUN THE OWNER IS THE SALE CONTRACT, and demanding a key for it would refuse
    // the very state this script is meant to be able to finish from. So the override is consulted
    // BEFORE the seller is resolved: if the number is already in the named sale contract, the
    // listing half is done and no seller signature is needed again.
    const overrideSale = process.env.PRIMES_RESALE_SALE_ADDRESS
        ? Address.parse(process.env.PRIMES_RESALE_SALE_ADDRESS)
        : null;
    const resumed = overrideSale?.equals(ownerNow) ?? false;
    const cast = readCast();
    const sellerEntry = cast.find((w) => Address.parse(w.address).equals(ownerNow));
    const seller = sellerEntry
        ? await openWallet(client, sellerEntry.mnemonic.split(/\s+/), undefined, sellerEntry.version)
        : ownerNow.equals(market.wallet.address) || resumed
          ? market
          : null;
    if (!seller) {
        throw new Error(
            `${N} is owned by ${ownerNow.toString()}, which is neither the deploy subwallet nor a ` +
                `cast wallet — this script can only sell a number whose key it holds.`
        );
    }
    // PRIMES_RESALE_BUYER names the buyer's handle (e.g. the owner's W5 play wallet `P`); unset,
    // it is the first cast wallet that is not the seller.
    const buyerHandle = process.env.PRIMES_RESALE_BUYER;
    const buyerEntry = buyerHandle
        ? cast.find((w) => w.handle === buyerHandle && !Address.parse(w.address).equals(seller.wallet.address))
        : cast.find((w) => !Address.parse(w.address).equals(seller.wallet.address));
    if (!buyerEntry) throw new Error('no cast wallet available to act as the buyer');
    const buyer = await openWallet(client, buyerEntry.mnemonic.split(/\s+/), undefined, buyerEntry.version);

    // The royalty is read from the collection, never assumed: this is D-128 point 1 — TEP-66
    // carries ONE destination, so the split can only happen at the address that IS declared, and
    // the whole test is void if that address is not the collection itself.
    const rp: any = await retry(() => collection.getRoyaltyParams(), 'getRoyaltyParams');
    const royaltyDest: Address = rp.destination ?? rp.destinationAddress;
    if (!royaltyDest.equals(collection.address)) {
        throw new Error(
            `royalty_params() names ${royaltyDest.toString()}, not the collection — against a ` +
                `pre-D-128 set the operator would silently take 100% of this royalty.`
        );
    }
    const royalty = (PRICE * BigInt(rp.numerator)) / BigInt(rp.denominator);
    const fee = (PRICE * 5n) / 100n; // our own marketplace's cut, returned to us; not under test

    const data = saleData({
        marketplace: market.wallet.address,
        nft: nftAddress,
        fullPrice: PRICE,
        feeAddress: market.wallet.address,
        fee,
        royaltyAddress: royaltyDest,
        royalty,
        createdAt: CREATED_AT,
    });
    const code = Cell.fromBase64(SALE_V3R3_CODE_B64);
    // `PRIMES_RESALE_SALE_ADDRESS` adopts a sale contract this script deployed under different
    // data (an earlier run's `created_at`, say) so the run can be resumed rather than repeated.
    const saleAddress = overrideSale ?? contractAddress(0, { code, data });

    const show = async (label: string) => {
        // NOT `: any`. `any - any` evaluates to `number` in TypeScript, so annotating this
        // away made `dRatchet` a number and the `dT === dRatchet` assertion below always
        // false at compile time — the one comparison the whole script exists to make.
        const split = await retry(() => collection.getRoyaltySplit(), 'getRoyaltySplit');
        const T = await retry(() => ledger.getFloorNum(), 'getFloorNum');
        const S = await retry(() => ledger.getFloorDen(), 'getFloorDen');
        const head = await retry(() => ledger.getHead(), 'getHead');
        const owed = await retry(() => item.getOwed(), 'getOwed');
        const owner: Address = ((await retry(() => item.getNftData(), 'getNftData')) as any).ownerAddress;
        console.log(
            `${label.padEnd(16)} forwards=${split.forwards} ratchet=${fromNano(split.toRatchetNanoton)} ` +
                `operator=${fromNano(split.toOperatorNanoton)}  T=${T} S=${S} head=${head} ` +
                `owed=${fromNano(owed)} owner=${owner.toString()}`
        );
        return { split, T, S, head, owed, owner };
    };

    console.log(`number       ${N}`);
    console.log(`item         ${nftAddress.toString()}`);
    console.log(`seller       ${seller.wallet.address.toString()}`);
    console.log(`buyer        ${buyer.wallet.address.toString()} (${buyerEntry.handle})`);
    console.log(`marketplace  ${market.wallet.address.toString()} (us — see the header)`);
    console.log(`sale         ${saleAddress.toString()}  code hash ${code.hash().toString('hex').slice(0, 16)}`);
    console.log(
        `price ${fromNano(PRICE)} GRAM = seller ${fromNano(PRICE - fee - royalty)} + fee ${fromNano(fee)} ` +
            `+ royalty ${fromNano(royalty)} (${rp.numerator}/${rp.denominator} to the collection)\n`
    );

    const before = await show('before:');

    // RESUMABLE. The listing half is two messages and the purchase is a third, and a run that
    // dies between them (a buyer one nanoton short of the sender's own affordability guard, on
    // the first live run) must be finishable rather than restartable: re-sending step 2 against
    // a number the sale contract already owns throws 300, because the seller is no longer the
    // owner.
    // THE SALE CONTRACT IS ONE-SHOT, AND ITS ADDRESS IS DETERMINISTIC. `created_at` is fixed
    // at 0 so a run can resume into the sale it already deployed (see the constant) — but the
    // same determinism means a SECOND resale of the same number lands on the CLOSED sale from
    // the first, which answers every op with exit 404. That is not a harmless refusal: step 2
    // transfers the number IN first, and a completed sale has no path that hands it back, so
    // the number is stuck there for good. It happened to 899809363 on 20260924. So: ask before
    // sending anything, and refuse with the way out rather than the NFT.
    const saleState = await retry(() => client.getContractState(saleAddress), 'state(sale)');
    if (saleState.state === 'active') {
        const sd = await retry(() => client.runMethod(saleAddress, 'get_sale_data'), 'get_sale_data');
        sd.stack.readBigNumber(); // magic
        if (sd.stack.readBigNumber() !== 0n) {
            throw new Error(
                `the sale contract at ${saleAddress.toString({ testOnly: true })} is ALREADY COMPLETE ` +
                    '(is_complete = 1) and refuses every op with 404, including the incoming NFT. Nothing ' +
                    'is sent. Set PRIMES_RESALE_CREATED_AT to any unused value (it is part of the data, so ' +
                    'it is part of the address) to get a fresh sale for this number.'
            );
        }
    }

    const alreadyListed = before.owner.equals(saleAddress);
    if (alreadyListed) console.log('\n[1,2] skipped — the sale contract already holds this number');

    if (!alreadyListed) {
    // 1. Deploy, from the marketplace address — the sale contract's own "just accept coins on
    //    deploy" arm is the only way in before the NFT arrives.
    console.log('\n[1] deploying the sale contract (from the marketplace address)');
    await retry(
        () =>
            market.sender.send({
                to: saleAddress,
                value: toNano('0.05'),
                init: { code, data },
                body: beginCell().storeUint(OP_ACCEPT_COINS, 32).storeUint(0, 64).endCell(),
                bounce: false,
            }),
        'deploy sale'
    );

    // 2. The seller hands the number over. `forwardAmount` is what pays for the sale contract's
    //    `ownership_assigned` handler; with 0 it would receive nothing and never initialise.
    console.log('[2] seller transfers the number into the sale contract');
    await retry(
        () =>
            seller.sender.send({
                to: nftAddress,
                value: toNano('0.2'),
                body: beginCell()
                    .storeUint(OP_TRANSFER, 32)
                    .storeUint(0, 64)
                    .storeAddress(saleAddress)
                    .storeAddress(seller.wallet.address)
                    .storeMaybeRef(null)
                    .storeCoins(toNano('0.05'))
                    .storeUint(0, 1)
                    .endCell(),
            }),
        'transfer into sale'
    );
    await new Promise((r) => setTimeout(r, 45_000));
    }
    const listed = await show('listed:');
    if (!listed.owner.equals(saleAddress)) {
        throw new Error('the sale contract did not take custody — the listing half failed, stop here');
    }
    console.log(
        `  ^ the sale contract owns it. \`owed\` is ${fromNano(listed.owed)} and is UNCLAIMABLE while ` +
            `it sits here: ClaimTribute is gated senderAddress == owner (throw 300), and the owner is ` +
            `now a contract with no claim path.`
    );

    // 3. The purchase. `throw_unless(450, msg_value >= full_price + min_gas_amount())` — 0.1 GRAM.
    console.log('\n[3] buyer buys');
    await retry(
        () =>
            buyer.sender.send({
                to: saleAddress,
                value: PRICE + BUY_MARGIN,
                body: beginCell().storeUint(OP_BUY, 32).storeUint(0, 64).endCell(),
            }),
        'buy'
    );
    await new Promise((r) => setTimeout(r, 60_000));
    const after = await show('after:');

    const dRatchet = after.split.toRatchetNanoton - before.split.toRatchetNanoton;
    const dOperator = after.split.toOperatorNanoton - before.split.toOperatorNanoton;
    const dT = after.T - before.T;

    // `T`, `S` and `head` are GLOBAL CUMULATIVE COUNTERS, and testnet is a shared
    // network: anyone may mint inside the ~3 minutes this proof takes. When that
    // happens the three deltas below stop being attributable to the resale, and reading
    // them as if they were reports the resale broken — which is exactly what happened on
    // 20260924, where a stranger's mint of 45 landed between `listed:` and `after:` and
    // painted all three lines as bugs. The HEAD is the detector: the only thing that
    // moves it is a mint, a resale never does, so a moved head means the window was
    // contaminated, and the proof says so instead of accusing the contract.
    const minted = after.head !== before.head;
    console.log(`
--- what moved ---`);
    console.log(`forwards  ${before.split.forwards} -> ${after.split.forwards}`);
    console.log(`ratchet leg +${fromNano(dRatchet)} GRAM      operator leg +${fromNano(dOperator)} GRAM`);
    if (minted) {
        console.log(
            `head      ${before.head} -> ${after.head}  MOVED — a third party MINTED during this window. ` +
                'A resale never moves the head, so the three global counters below carry that mint too and ' +
                'are NOT attributable to this sale. Re-run on a quiet head to read them.'
        );
        console.log(`T         ${before.T} -> ${after.T}  (+${dT})  not attributable (ratchet leg was +${dRatchet})`);
        console.log(`S         ${before.S} -> ${after.S}  not attributable (a mint emits; a royalty must not)`);
    } else {
        console.log(
            `T         ${before.T} -> ${after.T}  (+${dT})  ` +
                `${dT === dRatchet ? 'EXACTLY the ratchet leg — the royalty landed as backing' : 'MISMATCH — that is the bug'}`
        );
        console.log(
            `S         ${before.S} -> ${after.S}  ` +
                `${after.S === before.S ? 'UNCHANGED — injection without emission, a pure floor step' : 'MOVED — a royalty must not emit'}`
        );
        console.log(`head      ${before.head} -> ${after.head}  UNCHANGED`);
    }
    console.log(`owed      ${fromNano(listed.owed)} -> ${fromNano(after.owed)}  (it travelled with the number)`);
    console.log(`owner     ${after.owner.toString()}`);
    console.log(
        after.owner.equals(buyer.wallet.address)
            ? "  ^ THE BUYER. A resale completed on chain against GetGems' own sale bytecode."
            : '  ^ NOT the buyer — the sale did not deliver.'
    );
    if (dRatchet <= 0n || dOperator <= 0n || after.split.forwards <= before.split.forwards) {
        throw new Error("the royalty did not split — the collection refused the sale contract's payout");
    }
}

main().catch((e) => {
    console.error(e?.message ?? e);
    process.exit(1);
});
