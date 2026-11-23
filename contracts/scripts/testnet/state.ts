/**
 * TON PRIMES — one read of everything a gauntlet phase asserts against, in one
 * call, so a run's journal is a diff of two of these rather than a dozen
 * scattered get-calls with their own retry loops.
 *
 *   npx tsx contracts/scripts/testnet/state.ts
 */
import { Address } from '@ton/core';
import { PrimesLedger } from '../../wrappers/PrimesLedger';
import { PrimesRatchet } from '../../wrappers/PrimesRatchet';
import { PrimesMarket } from '../../wrappers/PrimesMarket';
import { loadEnvFile, envValue } from '../envFile';
import { makeClient, retry } from './sender';

function addr(name: string): Address {
    const v = envValue(loadEnvFile(), name);
    if (!v) throw new Error(`${name} missing from /.env`);
    return Address.parse(v);
}

async function main() {
    const client = makeClient();
    const ledger = client.open(PrimesLedger.createFromAddress(addr('PRIMES_LEDGER_ADDRESS')));
    const ratchet = client.open(PrimesRatchet.createFromAddress(addr('PRIMES_RATCHET_ADDRESS')));
    const market = client.open(PrimesMarket.createFromAddress(addr('PRIMES_MARKET_ADDRESS')));

    const T = await retry(() => ledger.getFloorNum(), 'getFloorNum');
    const S = await retry(() => ledger.getFloorDen(), 'getFloorDen');
    console.log('head        ', await retry(() => ledger.getHead(), 'getHead'));
    console.log('T           ', T.toString());
    console.log('S           ', S.toString());
    console.log('p_f         ', (Number(T) / Number(S)).toExponential(4), 'GRAM/PRIMES');
    console.log('pending     ', (await retry(() => ratchet.getPending(), 'getPending')).toString());
    console.log('floorCache  ', await retry(() => ratchet.getFloorCache(), 'getFloorCache'));
    console.log('flushStatus ', await retry(() => ratchet.getFlushStatus(), 'getFlushStatus'));
    console.log('burnStats   ', await retry(() => ratchet.getBurnStats(), 'getBurnStats'));
    console.log('marketParams', await retry(() => market.getMarketParams(), 'getMarketParams'));
    console.log('marketStats ', await retry(() => market.getMarketStats(), 'getMarketStats'));
}

if (require.main === module) {
    main().catch((e) => {
        console.error(e?.message ?? e);
        process.exit(1);
    });
}
