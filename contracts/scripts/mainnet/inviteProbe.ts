/**
 * TON PRIMES — DECISIONS.md D-202 Phase 0: does a CONTRACT-sent comment show in Telegram?
 *
 * **MAINNET. The owner runs this, by hand. Nothing in the repo calls it.**
 *
 * Every test of the invite text so far was a transfer from a wallet; the ledger is not a
 * wallet. This deploys `invite_probe.tolk` (a few lines: on its deploy message it sends
 * 0.1 TON, NoBounce, mode REGULAR, carrying the comment it was deployed with — the same
 * shape `primes_ledger.tolk`'s invite line sends) and has it send that transfer, ONCE, to
 * the address you name. The comment is built by `shared/invites.ts` `inviteCommentCell(n)`,
 * the builder `InviteTransfers.spec.ts` pins to the ledger's own bytes.
 *
 * Cost: 0.2 TON attached to the deploy. 0.1 reaches the target; the rest is fees and the
 * probe's own balance, which stays on it (about 0.09 TON — it has no withdraw arm).
 *
 * HOW TO RUN (from `contracts/`):
 *
 *   PROBE_WALLET_MNEMONIC="word1 ... word24" \
 *   [PROBE_WALLET_VERSION=v5r1|v4r2]   # default v5r1 (Tonkeeper / Telegram Wallet W5)
 *   [TONCENTER_API_KEY=...]            # optional, mainnet toncenter key
 *     npx tsx scripts/mainnet/inviteProbe.ts <your Telegram wallet address> [n] [--send]
 *
 *   Without `--send` it prints the sender wallet, the probe address and the exact comment,
 *   and sends nothing. `n` is the number the comment names (default 4).
 *
 * WHAT TO RECORD (append to DECISIONS.md D-202 status note; the owner ran it 2026-11-07, text shown):
 *   1. Does the comment show as TEXT in the Telegram wallet, from the probe's address?
 *      (yes / no — a screenshot if you can). If NO, stop: Phase 1 is not worth building.
 *   2. Did a PUSH NOTIFICATION arrive? (yes / no)
 *   3. The probe address and the transaction hash (tonviewer.com/<probe address>).
 */
import fs from 'fs';
import path from 'path';
import { Address, beginCell, Cell, contractAddress, internal, SendMode, StateInit } from '@ton/core';
import { TonClient, WalletContractV4, WalletContractV5R1 } from '@ton/ton';
import { mnemonicToPrivateKey } from '@ton/crypto';
import { inviteCommentCell, inviteCommentText } from '../../../shared/invites';

const MAINNET_ENDPOINT = 'https://toncenter.com/api/v2/jsonRPC';
const DEPLOY_VALUE = 200_000_000n; // 0.2 TON: the 0.1 transfer, its fees, and the probe's rent

/** `@ton/tolk-js` is a dependency of `@ton/blueprint`, not of this package, so resolve it from there. */
async function compileProbe(): Promise<Cell> {
    const tolkPath = require.resolve('@ton/tolk-js', { paths: [path.dirname(require.resolve('@ton/blueprint'))] });
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { runTolkCompiler } = require(tolkPath);
    const entry = path.join(__dirname, 'invite_probe.tolk');
    const r = await runTolkCompiler({
        entrypointFileName: entry,
        fsReadCallback: (p: string) => fs.readFileSync(path.isAbsolute(p) ? p : path.join(__dirname, p), 'utf8'),
    });
    if (r.status !== 'ok') throw new Error(`invite_probe.tolk did not compile: ${r.message}`);
    return Cell.fromBase64(r.codeBoc64);
}

async function main() {
    const args = process.argv.slice(2);
    const send = args.includes('--send');
    const positional = args.filter((a) => !a.startsWith('--'));
    if (positional.length < 1) throw new Error('usage: inviteProbe.ts <target address> [n] [--send]');
    const target = Address.parse(positional[0]);
    const n = BigInt(positional[1] ?? '4');

    const mnemonic = process.env.PROBE_WALLET_MNEMONIC?.trim();
    if (!mnemonic) throw new Error('PROBE_WALLET_MNEMONIC is not set (the mainnet wallet that pays for the probe).');
    const key = await mnemonicToPrivateKey(mnemonic.split(/\s+/));
    const version = (process.env.PROBE_WALLET_VERSION ?? 'v5r1').toLowerCase();
    const wallet =
        version === 'v4r2'
            ? WalletContractV4.create({ workchain: 0, publicKey: key.publicKey })
            : WalletContractV5R1.create({ publicKey: key.publicKey });

    const code = await compileProbe();
    const comment = inviteCommentCell(n);
    const data = beginCell().storeAddress(target).storeRef(comment).storeUint(0, 1).endCell();
    const init: StateInit = { code, data };
    const probe = contractAddress(0, init);

    console.log(`sender wallet (${version}): ${wallet.address.toString({ bounceable: false })}`);
    console.log(`probe contract:            ${probe.toString({ bounceable: false })}`);
    console.log(`target:                    ${target.toString({ bounceable: false })}`);
    console.log(`comment:                   "${inviteCommentText(n)}"`);
    console.log(`attached:                  ${Number(DEPLOY_VALUE) / 1e9} TON (0.1 of it reaches the target)`);
    if (!send) {
        console.log('\ndry run — nothing sent. Re-run with --send to deploy the probe on MAINNET.');
        return;
    }

    const client = new TonClient({ endpoint: MAINNET_ENDPOINT, apiKey: process.env.TONCENTER_API_KEY || undefined });
    const opened = client.open(wallet);
    const balance = await opened.getBalance();
    if (balance < DEPLOY_VALUE + 50_000_000n) {
        throw new Error(`the sender wallet holds ${Number(balance) / 1e9} TON; it needs at least 0.25. Nothing sent.`);
    }
    if ((await client.getContractState(probe)).state === 'active') {
        throw new Error('the probe for this (target, n) is already deployed and has already sent. Nothing sent.');
    }
    const seqno = await opened.getSeqno();
    await opened.sendTransfer({
        seqno,
        secretKey: key.secretKey,
        sendMode: SendMode.PAY_GAS_SEPARATELY | SendMode.IGNORE_ERRORS,
        messages: [internal({ to: probe, value: DEPLOY_VALUE, bounce: false, init, body: beginCell().endCell() })],
    });
    console.log(`\nsent (seqno ${seqno}). Wait ~15 s, then check the Telegram wallet and`);
    console.log(`https://tonviewer.com/${probe.toString({ bounceable: false })}`);
    console.log('Record: text shown (yes/no), push notification (yes/no), the tx hash.');
}

main().catch((e) => {
    console.error(e?.message ?? e);
    process.exit(1);
});
