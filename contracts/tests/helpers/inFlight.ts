import { Blockchain } from '@ton/sandbox';
import { Message } from '@ton/core';

/**
 * Run ONLY the first transaction of `msg`'s chain, on its own queue
 * (`allowParallel`), and hand back the rest. Between `first` and `rest()` the
 * caller may send other messages against the state the first hop left — which is
 * how a test puts a second request on top of a round trip that is still open
 * (an `inFlight` flag set, the reply not yet delivered).
 */
export async function firstHop(blockchain: Blockchain, msg: Message) {
    const it = await blockchain.sendMessageIter(msg, { allowParallel: true });
    const first = (await it.next()).value as any;
    async function rest() {
        const txs: any[] = [];
        for (let r = await it.next(); !r.done; r = await it.next()) txs.push(r.value);
        return txs;
    }
    return { first, rest };
}

/** The internal out-message of `tx` addressed to `dest` (a real message, ready to re-deliver). */
export function outTo(tx: any, dest: { equals(a: any): boolean }): any {
    return [...tx.outMessages.values()].find((m: any) => m.info.type === 'internal' && dest.equals(m.info.dest));
}
