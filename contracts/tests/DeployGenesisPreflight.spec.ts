// TON PRIMES — G17 (filed from E14a, 2026-08-29): deployGenesis.ts's preflight (formerly deployGenesisSkewSafe.ts's, G55)
// that PRIMES_PROPOSER_ADDR matches the wallet that will actually send the venue
// timelock's `Queue`.
//
// The venue timelock bakes in `proposerAddr` at deploy time from
// `genesisParams.proposerAddr` (i.e. `PRIMES_PROPOSER_ADDR`), then checks it against the
// real sender when `Queue` arrives. `deployGenesis.ts` always sends `Queue` as
// `env.proposerSender`, which is always the same wallet as `genesisSender`/`genesisAddress`
// — a single hand-rolled `Sender` derived from `PRIMES_DEPLOY_SUBWALLET_ID`. If
// `PRIMES_PROPOSER_ADDR` names a different wallet (e.g. the subwallet id was bumped for a
// fresh-subwallet redeploy but the proposer address wasn't), the mismatch bakes in
// silently and only surfaces 38 pipeline steps later when `timelock:queue` bounces with
// `throw 800` (wrong_sender) — exactly what happened on the 2026-08-29 genesis (E14a).
// This pins the preflight that now refuses before any gas is spent.
import { Address, TupleReader, beginCell } from '@ton/core';
import { assertProposerMatchesSender } from '../scripts/deployGenesis';
import { assertDedustKeyedOnMaster } from '../scripts/dedust';

// Two distinct, valid testnet addresses (arbitrary but real bounceable encodings).
const WALLET_A = Address.parse('EQAUQ0rxnuESeB1EB1ckW1nMtudkdeEUsgPbg96zmfyLcfmp');
const WALLET_B = Address.parse('EQCbbfpZ8yN7UAglOeHzAMhR7ZE-CNduM5txOpgEJY6a-aaR');

describe('G17 · assertProposerMatchesSender', () => {
    it('passes silently when PRIMES_PROPOSER_ADDR names the sending wallet', () => {
        expect(() => assertProposerMatchesSender(WALLET_A, WALLET_A, 20260829)).not.toThrow();
    });

    it('throws before any gas is spent when the proposer address names a different wallet', () => {
        expect(() => assertProposerMatchesSender(WALLET_B, WALLET_A, 20260829)).toThrow(
            /PRIMES_PROPOSER_ADDR.*does not match the deploy wallet/s
        );
    });

    it('names the offending subwallet id in the error, so the fix is obvious', () => {
        expect(() => assertProposerMatchesSender(WALLET_B, WALLET_A, 20260829)).toThrow(/20260829/);
    });

    it('reports "<default>" when no PRIMES_DEPLOY_SUBWALLET_ID was set', () => {
        expect(() => assertProposerMatchesSender(WALLET_B, WALLET_A, undefined)).toThrow(/<default>/);
    });
});

// GAUNTLET.md R17: the testnet-only LP wallet stand-in that lets step 25b run on a
// testnet with no real DeDust pool. What matters is that it is pure (the read-back
// compares against it a second time), distinct per owner, and never the address of a
// wallet this repo actually deploys.
import { standInLpWalletFor } from '../scripts/genesisPipeline';

describe('R17 · standInLpWalletFor', () => {
    it('is deterministic and distinct per owner', () => {
        expect(standInLpWalletFor(WALLET_A).equals(standInLpWalletFor(WALLET_A))).toBe(true);
        expect(standInLpWalletFor(WALLET_A).equals(standInLpWalletFor(WALLET_B))).toBe(false);
        expect(standInLpWalletFor(WALLET_A).workChain).toBe(0);
    });

    it('never aliases the owner itself', () => {
        expect(standInLpWalletFor(WALLET_A).equals(WALLET_A)).toBe(false);
    });
});

// MISTAKES.md 2026-11-12: a pool created from a stale build is keyed on a master genesis never
// deploys. The guard asks the factory which pool/vault THIS run's master implies.
describe('assertDedustKeyedOnMaster', () => {
    const POOL = Address.parse('EQAUQ0rxnuESeB1EB1ckW1nMtudkdeEUsgPbg96zmfyLcfmp');
    const VAULT = Address.parse('EQCbbfpZ8yN7UAglOeHzAMhR7ZE-CNduM5txOpgEJY6a-aaR');
    const MASTER = Address.parse('EQBl7rH4x7xDHNU2omt2siBN-mXsW8BkWPArD9XDEeKQMamc');
    const answer = (a: Address) => new TupleReader([{ type: 'slice', cell: beginCell().storeAddress(a).endCell() }]);
    const factory = async (_: Address, method: string) => answer(method === 'get_pool_address' ? POOL : VAULT);

    it('passes when the env pool and vault are the ones the factory derives', async () => {
        await expect(assertDedustKeyedOnMaster(factory, MASTER, POOL, VAULT)).resolves.toBeUndefined();
    });

    it('refuses a pool keyed on another master, before any send', async () => {
        await expect(assertDedustKeyedOnMaster(factory, MASTER, VAULT, VAULT)).rejects.toThrow(/PRIMES_DEDUST_POOL_ADDR/);
    });

    it('refuses a stale jetton vault too', async () => {
        await expect(assertDedustKeyedOnMaster(factory, MASTER, POOL, POOL)).rejects.toThrow(/PRIMES_DEDUST_JETTON_VAULT_ADDR/);
    });
});
