/**
 * TON PRIMES — who holds PRIMES, across the cast and the funder.
 *
 * The swap lever (`pool.ts sell`) needs a wallet with enough PRIMES to push the
 * pool under `p_f`, and rebate emission is spread over whoever happened to mint.
 * This answers "who can afford the lever" in one call.
 *
 *   npx tsx contracts/scripts/testnet/primes.ts
 *   npx tsx contracts/scripts/testnet/primes.ts send <from> <to> <amount>
 *   npx tsx contracts/scripts/testnet/primes.ts ensure <from> <to> <amount>
 *
 * `send` exists because PRIMES reach a wallet only by EMISSION, and two of the
 * cast's roles emit nothing: a §4.5 gift mint pays the rebate to the beneficiary,
 * not the payer, and a prime mint emits nothing at all (§5.1, k = 0). So the
 * wallet that wins a prime lot — the only wallet §4.7.1 lets buy a PAID
 * annotation — is precisely the one that can hold zero PRIMES. Moving some in is
 * a wallet-level TEP-74 transfer, not a protocol action.
 *
 * `ensure` is the IDEMPOTENT form, and it is what `run.ts`'s funding steps call.
 * `send` states an amount to MOVE; `ensure` states a balance the destination must
 * HAVE, tops up only the shortfall, and exits 0 having sent nothing when the
 * destination is already funded. A run's funding steps are preconditions, not
 * transfers, and a precondition that re-fires unconditionally turns "already
 * true" into a stoppage: on 2026-09-21 phase 6 died on `send K S 150000` with
 * `S` already holding 200,000, because phase 5's sell lever had drained `K`
 * since. Five separate run stoppages came out of that one shape.
 */
import { Address, beginCell, fromNano, toNano } from '@ton/core';
import { TonClient } from '@ton/ton';
import { loadEnvFile, envValue } from '../envFile';
import { makeClient, openDeployWallet, retry } from './sender';
import { readCast } from './cast';
import { walletFor } from './chain';
import { jettonTransferBody } from '../dedust';

async function walletOf(client: TonClient, master: Address, owner: Address): Promise<Address> {
    const r = await retry(
        () =>
            client.runMethod(master, 'get_wallet_address', [
                { type: 'slice', cell: beginCell().storeAddress(owner).endCell() },
            ]),
        'get_wallet_address'
    );
    return r.stack.readAddress();
}

async function balance(client: TonClient, wallet: Address): Promise<bigint> {
    try {
        const r = await client.runMethod(wallet, 'get_wallet_data', []);
        return r.stack.readBigNumber();
    } catch {
        return 0n;
    }
}

/** The funder plus every cast handle — the roster both the bare read and `ensure` walk. */
async function roster(client: TonClient): Promise<[string, Address][]> {
    const funder = await openDeployWallet(client);
    const rows: [string, Address][] = [['K', funder.wallet.address]];
    for (const c of readCast()) rows.push([c.handle, Address.parse(c.address)]);
    return rows;
}

/** One wallet-level TEP-74 transfer of `units`, out of `from`'s own jetton wallet. */
async function transfer(client: TonClient, master: Address, from: string, to: string, units: bigint) {
    const w = await walletFor(client, from);
    const dest = (await walletFor(client, to)).wallet.address;
    const mine = await walletOf(client, master, w.wallet.address);
    await w.sender.send({
        to: mine,
        value: toNano('0.1'),
        bounce: true,
        body: jettonTransferBody({
            amount: units,
            destination: dest,
            responseAddress: w.wallet.address,
            forwardTon: toNano('0.02'),
        }),
    });
    console.log(`${from} -> ${to}: ${fromNano(units)} PRIMES sent; re-read with "primes.ts"`);
}

async function heldBy(client: TonClient, master: Address, handle: string): Promise<bigint> {
    const owner = (await walletFor(client, handle)).wallet.address;
    return balance(client, await walletOf(client, master, owner));
}

async function cmdSend(client: TonClient, master: Address, from: string, to: string, amount: string) {
    const units = toNano(amount);
    const held = await heldBy(client, master, from);
    if (held < units) throw new Error(`${from} holds ${fromNano(held)} PRIMES, short of ${amount}`);
    await transfer(client, master, from, to, units);
}

/**
 * Make it TRUE that `to` holds at least `amount`, and send as little as possible
 * to get there — including nothing at all. The failure arm names the shortfall,
 * what the source actually has, and which other handles could cover it, because
 * the operator's next question after "K is short" is always "then who isn't".
 */
async function cmdEnsure(client: TonClient, master: Address, from: string, to: string, amount: string) {
    const units = toNano(amount);
    const held = await heldBy(client, master, to);
    if (held >= units) {
        console.log(`${to} already holds ${fromNano(held)} PRIMES (>= ${amount}) — nothing sent`);
        return;
    }
    const shortfall = units - held;
    const srcHeld = await heldBy(client, master, from);
    if (srcHeld < shortfall) {
        const others: string[] = [];
        for (const [handle, owner] of await roster(client)) {
            if (handle === from || handle === to) continue;
            const b = await balance(client, await walletOf(client, master, owner));
            if (b >= shortfall) others.push(`${handle} (${fromNano(b)})`);
        }
        throw new Error(
            `${to} holds ${fromNano(held)} PRIMES and needs ${fromNano(shortfall)} more to reach ${amount}, ` +
                `but ${from} holds only ${fromNano(srcHeld)}. ` +
                (others.length
                    ? `These hold enough: ${others.join(', ')} — re-run as "primes.ts ensure <them> ${to} ${amount}".`
                    : `No other cast handle holds that much either.`)
        );
    }
    console.log(`${to} holds ${fromNano(held)} PRIMES of ${amount} — topping up ${fromNano(shortfall)}`);
    await transfer(client, master, from, to, shortfall);
}

async function main() {
    const client = makeClient();
    const master = Address.parse(envValue(loadEnvFile(), 'PRIMES_JETTON_MASTER_ADDRESS')!);
    const [cmd, ...rest] = process.argv.slice(2);
    if (cmd === 'send' || cmd === 'ensure') {
        if (rest.length < 3) throw new Error(`usage: primes.ts ${cmd} <from> <to> <amount>`);
        const run = cmd === 'send' ? cmdSend : cmdEnsure;
        return run(client, master, rest[0], rest[1], rest[2]);
    }
    for (const [handle, owner] of await roster(client)) {
        const w = await walletOf(client, master, owner);
        const b = await balance(client, w);
        if (b > 0n) console.log(handle.padEnd(3), fromNano(b), 'PRIMES');
    }
}

if (require.main === module) {
    main().catch((e) => {
        console.error(e?.message ?? e);
        process.exit(1);
    });
}
