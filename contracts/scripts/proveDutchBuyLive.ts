/**
 * TON PRIMES — buy a PARKED descending lot, the one lane the acceptance walks never
 * reached. **Testnet only, enforced.**
 *
 * `DECISIONS.md` D-88 point 1 / D-90. A prime never reaches the head (D-20), so the
 * descending lane exists for it and for nothing else: `open_head_lot` opens a lot at
 * `P0(p)`, it descends to `max(MINT_PRICE, P0(p)/3, NPV(p)/2)` over `PRIME_DUTCH_SECONDS`
 * (divided by D-139's deploy-time `clockDivisor`), and then **PARKS there until bought,
 * with no expiry**. On the descending lane a BID IS THE PURCHASE — there is no clock to
 * open, no second close message, and no escrowed claim: D-90 mints the number in the
 * transaction that takes the lot.
 *
 * THE ASSERTION IS WHO OWNS THE NUMBER AFTERWARDS. `open_head_lot` is permissionless and
 * places no bid, so the opener has paid nothing and must receive nothing; the item belongs
 * to whoever pays the standing price. That is the same property `X11` broke on the
 * ascending lane — where the close minted to the OPENER rather than the winner — and this
 * is the descending lane's copy of that check, which is why the script refuses to run if
 * the buyer and the opener are the same wallet.
 *
 * The head must also not move. An auctioned number is marked off its sequential line the
 * moment `open_lot` runs (D-45) and the head-advance walk skips that position forever, so
 * a purchase here changes no route to any other number.
 *
 *   PRIMES_DUTCH_N=11 npx tsx scripts/proveDutchBuyLive.ts
 *
 * The lot must already be open — this script does not open one, because the decay is a
 * wall-clock hour and opening is a separate, permissionless, gas-only message.
 */
import { Address, TonClient, WalletContractV4, toNano, fromNano } from '@ton/ton';
import { mnemonicToPrivateKey } from '@ton/crypto';
import { PrimesMarket } from '../wrappers/PrimesMarket';
import { PrimesLedger } from '../wrappers/PrimesLedger';
import { PrimesCollection } from '../wrappers/PrimesCollection';
import { PrimesItem } from '../wrappers/PrimesItem';

import { deploySubwalletId, hydrateProcessEnv, loadEnvFile } from './envFile';

// W10: `tsx` loads no `.env`, and every `process.env.PRIMES_*_ADDRESS` read below would
// otherwise fall through to a hardcoded address from a dead genesis — silently, because a
// dead-but-still-answering contract returns plausible numbers rather than an error.
hydrateProcessEnv();

const TESTNET_ENDPOINT = 'https://testnet.toncenter.com/api/v2/jsonRPC';
const N = BigInt(process.env.PRIMES_DUTCH_N ?? '11');

/** D-95, as in smokeMintLive.ts: two independent checks, either alone defeatable by an edit. */
function assertTestnetOnly(endpoint: string): void {
    if (!/(^|[./])testnet\./.test(endpoint)) {
        throw new Error(`D-95: this script is testnet-only and ${endpoint} is not a testnet endpoint.`);
    }
    const declared = (process.env.PRIMES_NETWORK ?? process.env.TON_NETWORK ?? '').trim().toLowerCase();
    if (declared === 'mainnet') throw new Error('D-95: PRIMES_NETWORK/TON_NETWORK says mainnet.');
}

function need(name: string): string {
    const v = process.env[name];
    if (!v) throw new Error(`missing required env var ${name} (see .env)`);
    return v;
}

async function retry<T>(fn: () => Promise<T>, label: string, attempts = 8): Promise<T> {
    for (let i = 0; i < attempts; i++) {
        try {
            return await fn();
        } catch (e: any) {
            console.log(`[retry] ${label} attempt ${i + 1}: ${e?.message ?? e}`);
            await new Promise((r) => setTimeout(r, 3000 + i * 2000));
        }
    }
    return fn();
}

async function main() {
    assertTestnetOnly(TESTNET_ENDPOINT);
    const envFile = loadEnvFile();
    const client = new TonClient({
        endpoint: TESTNET_ENDPOINT,
        apiKey: process.env.TONCENTER_API_KEY_TESTNET || undefined,
    });
    const market = client.open(PrimesMarket.createFromAddress(Address.parse(need('PRIMES_MARKET_ADDRESS'))));
    const ledger = client.open(PrimesLedger.createFromAddress(Address.parse(need('PRIMES_LEDGER_ADDRESS'))));
    const collection = client.open(PrimesCollection.createFromAddress(Address.parse(need('PRIMES_COLLECTION_ADDRESS'))));

    const keyPair = await mnemonicToPrivateKey(need('KEEPER_WALLET_MNEMONIC').split(/\s+/));
    const wallet = WalletContractV4.create({
        workchain: 0,
        publicKey: keyPair.publicKey,
        walletId: deploySubwalletId(envFile),
    });
    const buyer = client.open(wallet);

    const lot: any = await retry(() => market.getLot(N), 'getLot');
    if (!lot?.found || lot.closed) throw new Error(`no open lot on ${N} — open_head_lot first`);
    if (lot.mode !== 2) throw new Error(`lot on ${N} is mode ${lot.mode}, not MODE_DUTCH_BUYNOW (2)`);
    // The whole point of the run: the buyer must not be the opener. `open_head_lot` places
    // no bid, so `highBidder` on an untouched descending lot is the opener.
    if (Address.isAddress(lot.highBidder) && lot.highBidder.equals(wallet.address)) {
        throw new Error('buyer is the wallet that opened this lot — use another wallet, that is the assertion');
    }

    const headBefore = await retry(() => ledger.getHead(), 'getHead');
    const Tbefore = await retry(() => ledger.getFloorNum(), 'getFloorNum');
    const Sbefore = await retry(() => ledger.getFloorDen(), 'getFloorDen');
    const balBefore = await retry(() => client.getBalance(wallet.address), 'balance');

    console.log(`lot ${N}: mode=${lot.mode} p0=${fromNano(lot.p0)} standing=${fromNano(lot.standingPrice)} ` +
        `minPayment=${fromNano(lot.minPayment)} closesAt=${lot.closesAt} opener=${lot.highBidder?.toString?.() ?? 'n/a'}`);
    console.log(`buyer ${wallet.address.toString()} balance ${fromNano(balBefore)} GRAM`);
    console.log(`before: head=${headBefore} T=${Tbefore} S=${Sbefore}`);

    // On-chain messages carry the nominal price PLUS a fee margin, never the exact price
    // (CLAUDE.md, and `minPayment` already folds in RES_GAS). Refusing here rather than
    // sending an underfunded 138 GRAM message is the cheap half of that rule.
    const value = (lot.minPayment as bigint) + toNano('0.2');
    if (balBefore < value + toNano('0.5')) {
        throw new Error(`buyer holds ${fromNano(balBefore)} GRAM, needs ${fromNano(value + toNano('0.5'))} — fund it first`);
    }

    console.log(`\nbidding ${fromNano(value)} GRAM — on the descending lane a bid IS the purchase (D-88 pt 1)`);
    await market.sendBid(buyer.sender(keyPair.secretKey), {
        n: N,
        beneficiary: null,
        referralKey: 0,
        value,
    });
    await new Promise((r) => setTimeout(r, 45_000));

    const after: any = await retry(() => market.getLot(N), 'getLot after');
    const headAfter = await retry(() => ledger.getHead(), 'getHead after');
    const Tafter = await retry(() => ledger.getFloorNum(), 'getFloorNum after');
    const Safter = await retry(() => ledger.getFloorDen(), 'getFloorDen after');
    const itemAddr = await retry(() => collection.getNftAddressByIndex(N), 'getNftAddressByIndex');
    const item = client.open(PrimesItem.createFromAddress(itemAddr));
    const nft = await retry(() => item.getNftData(), 'getNftData');

    console.log(`\nlot after: closed=${after.closed} highBid=${fromNano(after.highBid ?? 0n)}`);
    console.log(`head ${headBefore} -> ${headAfter}   ${headBefore === headAfter ? 'UNCHANGED (an auction mints off-head, D-45)' : 'MOVED — that is a bug'}`);
    console.log(`T    ${Tbefore} -> ${Tafter}`);
    console.log(`S    ${Sbefore} -> ${Safter}`);
    console.log(`item ${itemAddr.toString()}`);
    console.log(`owner ${nft.ownerAddress.toString()}`);
    console.log(
        nft.ownerAddress.equals(wallet.address)
            ? '  ^ THE BUYER, not the opener — D-90 mints in the transaction that takes the lot.'
            : '  ^ NOT the buyer. That is the X11 failure on the descending lane.'
    );
}

main().catch((e) => {
    console.error(e?.message ?? e);
    process.exit(1);
});
