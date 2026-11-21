import { Blockchain } from '@ton/sandbox';
import { Dictionary } from '@ton/core';

/**
 * The global id the emulator reports (config param 19, what the voucher reads). Read, not
 * assumed: a signed voucher binds it (audit 2026-11-19 M2), so a test that hardcoded the
 * wrong network would refuse every claim for a reason that has nothing to do with the test.
 */
export function sandboxGlobalId(blockchain: Blockchain): number {
    const config = Dictionary.loadDirect(Dictionary.Keys.Int(32), Dictionary.Values.Cell(), blockchain.config);
    return config.get(19)!.beginParse().loadInt(32);
}
