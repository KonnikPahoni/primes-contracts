/**
 * TON PRIMES — THE LAUNCH (CONCEPT §6 point 0).
 *
 *   npx blueprint run ignite --testnet --mnemonic
 *   npx blueprint run ignite --mainnet --tonconnect
 *   npx tsx scripts/ignite.ts --skew-safe [--mainnet]   # clock-lagging machine (G96)
 *
 * `--skew-safe` swaps blueprint's sender for `scriptHost.ts`'s +600s one (GAUNTLET.md
 * G55 folded the `igniteSkewSafe.ts` fork back into this file). It must be the SAME
 * wallet the genesis ran from — `PRIMES_DEPLOY_SUBWALLET_ID` — or the ledger refuses.
 *
 * `deployGenesis` builds the game and leaves it CLOSED. This starts it, in one
 * transaction, and there is no second one:
 *
 *   1. Number 1 — Unity — is minted to `PRIMES_UNITY_OWNER` (default: this
 *      wallet) as an ordinary transferable TEP-62 item carrying RARITY_UNITY.
 *      It is free, and it is economically inert forever: no rebates, no tribute,
 *      no dividend, no referral, no effect on T, S, p_f or the head. It is the
 *      founder's artifact and the fact that records who started the game.
 *   2. The ledger's `launched` flag flips, opening `mint` and
 *      `mint_won_lot`.
 *   3. A single `launch_open` goes to the market, opening both lot modes
 *      together (P2.A7: one peer where there were three).
 *
 *      D-20 removes the clock-anchoring this step used to do. The genesis
 *      auction's 90-day decay ran from DEPLOY, so igniting late meant lots had
 *      silently decayed while nobody could bid on them, and `launch_open` had to
 *      re-anchor the curve to this block to repair that. Every lot's decay now
 *      starts when that lot OPENS, and no lot can open before launch — so the
 *      window this repaired cannot occur, and there is nothing to re-anchor.
 *
 * IRREVERSIBLE. There is no un-ignite message, on this contract or any other:
 * `launched` is a starting gun, not a pause switch, and adding a way to close
 * the game again would be exactly the admin lever CONCEPT §8 forbids.
 *
 * Required env:
 *   PRIMES_LEDGER_ADDRESS   — the deployed ledger (docs/testnet-deployment.md)
 * Optional env:
 *   PRIMES_UNITY_OWNER      — who owns #1. Defaults to the sending wallet.
 *
 * The sending wallet MUST be the one the ledger holds as `genesisScriptAddr` —
 * i.e. the wallet that ran `deployGenesis`. No other sender is accepted, and
 * after this runs, that credential can do nothing further.
 */
import { Address, toNano } from '@ton/core';
import { NetworkProvider } from '@ton/blueprint';
import { PrimesLedger } from '../wrappers/PrimesLedger';
import { PrimesMarket } from '../wrappers/PrimesMarket';

import { hydrateProcessEnv } from './envFile';
import { ScriptHost, hostFromProvider, runSkewSafe } from './scriptHost';

// W10: `tsx` loads no `.env`, and every `process.env.PRIMES_*_ADDRESS` read below
// otherwise falls through to a hardcoded address from a genesis that is months dead
// — silently, because a dead-but-still-answering contract returns plausible numbers
// rather than an error. `hydrateProcessEnv()` is the one reader that ends that; it
// never overwrites a var the shell already set.
hydrateProcessEnv();

/** Give the network a moment to confirm before reading a flag back. */
async function settle(host: ScriptHost, label: string, seconds = 20) {
    host.write(`… ${label}`);
    await new Promise((r) => setTimeout(r, seconds * 1000));
}

export async function run(provider: NetworkProvider) {
    await ignite(hostFromProvider(provider));
}

export async function ignite(host: ScriptHost) {
    const raw = process.env.PRIMES_LEDGER_ADDRESS;
    if (!raw) {
        throw new Error(
            'PRIMES_LEDGER_ADDRESS is required — the ledger deployed by deployGenesis ' +
                '(see docs/testnet-deployment.md for the current addresses)'
        );
    }
    const ledger = host.open(PrimesLedger.createFromAddress(Address.parse(raw)));
    const sender = host.address;
    const unityOwner = process.env.PRIMES_UNITY_OWNER
        ? Address.parse(process.env.PRIMES_UNITY_OWNER)
        : sender;

    // PREFLIGHT. Every one of these is also asserted on chain — this is not the
    // security boundary, it is the difference between a clear message here and a
    // bare exit code from a failed transaction.
    const before = await host.retry(() => ledger.getLaunch(), 'getLaunch');
    if (before.launched) {
        throw new Error(
            'Refusing to run: this ledger is already launched. Ignition is one-shot. ' +
                'If a PEER is still closed, the fix is the permissionless `sync_launch` ' +
                '(PrimesLedger.sendSyncLaunch), not a second ignite.'
        );
    }
    const sinks = await host.retry(() => ledger.getSinks(), 'getSinks');
    const peers = await host.retry(() => ledger.getPeers(), 'getPeers');
    if (sinks.sinksSet !== 1) {
        throw new Error('Refusing to run: the ledger has no ratchet/registrar sinks — genesis is incomplete.');
    }
    if (peers.peersSet !== 1) {
        throw new Error('Refusing to run: the ledger has no peer addresses — genesis is incomplete.');
    }
    if ((await host.retry(() => ledger.getFloorDen(), 'getFloorDen')) === 0n) {
        throw new Error('Refusing to run: the ledger is unseeded (S = 0). Run the genesis seed first.');
    }
    if ((await host.retry(() => ledger.getFloorNum(), 'getFloorNum')) === 0n) {
        throw new Error(
            'Refusing to run: the floor p_f = T/S has nothing behind it (T = 0). D-93 — the ' +
                'launch order is seed -> donate -> ignite, and the ledger throws 218 here too. ' +
                'The seed writes S; only `donate_floor` writes T. Run scripts/donateFloor.ts ' +
                'first (D-92: 240 GRAM on mainnet; tranches or a smaller sum on testnet).'
        );
    }

    host.write(
        `About to IGNITE ${raw}\n` +
            `  Unity (#1) -> ${unityOwner.toString()}\n` +
            `  opens: mint, the ascending auction, the prime lane\n` +
            `  this is irreversible`
    );

    // Value covers four outbound hops (item deploy 0.025 + three launch hops at
    // 0.01) plus this transaction's own gas, with margin — an on-chain message
    // carrying exactly its nominal cost is rejected once compute is charged.
    await ledger.sendIgnite(host.sender, { owner: unityOwner, value: toNano('0.3') });
    await settle(host, 'ledger:ignite');

    const after = await host.retry(() => ledger.getLaunch(), 'getLaunch');
    if (!after.launched) {
        throw new Error('ignite did not land — the ledger is still closed. Check the transaction and retry.');
    }
    host.write(`ledger launched. items in collection: ${after.itemsMinted}`);
    host.write(`Unity item address: ${(await ledger.getItemAddress(1n)).toString()}`);

    // P2.A7: ONE peer where there were three. The market still opens by
    // NoBounce fan-out, so the ledger's own flag does not establish it — the
    // repair path is unchanged and still load-bearing, it simply has one flag
    // to read instead of three.
    const market = host.open(PrimesMarket.createFromAddress(peers.marketAddr));

    // The fan-out is an internal hop after the ledger's; on a slow chain it lands after `settle`
    // (2026-11-25: ~2 min). Poll before calling it incomplete, so a slow hop is not reported as a
    // failed launch and does not draw a needless second `sync_launch`.
    const marketOpen = async () => {
        for (let i = 0; i < 12; i++) {
            if (await host.retry(() => market.getLaunched(), 'market.getLaunched')) return true;
            await new Promise((r) => setTimeout(r, 15_000));
        }
        return host.retry(() => market.getLaunched(), 'market.getLaunched');
    };
    let open = { market: await marketOpen() };
    if (!open.market) {
        host.write(`peer fan-out incomplete (${JSON.stringify(open)}) — re-sending sync_launch`);
        await ledger.sendSyncLaunch(host.sender, { value: toNano('0.15') });
        await settle(host, 'ledger:sync-launch');
        open = { market: await marketOpen() };
    }

    const stillClosed = Object.entries(open)
        .filter(([, isOpen]) => !isOpen)
        .map(([name]) => name);
    if (stillClosed.length > 0) {
        throw new Error(
            `LAUNCHED, but still closed: ${stillClosed.join(', ')}. Minting works; those paths do not. ` +
                '`sync_launch` is permissionless — re-run it (it can only open, never close).'
        );
    }

    host.write('IGNITED. Mint and both market lot modes are live.');
    // D-20: nothing to anchor — each lot's decay starts when that lot opens.
}

// `npx tsx scripts/ignite.ts --skew-safe`; guarded so blueprint's own require runs `run()` only.
if (require.main === module) runSkewSafe('ignite', ignite);
