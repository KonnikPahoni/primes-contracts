/**
 * TON PRIMES — rewrite §4.1's invite terms on the ledger (DECISIONS.md D-211, D-215).
 *
 * The ledger sends up to `count` invites per mint, each delivering `value` whole (it pays
 * the forward fee on top), carrying `<words>` as the whole comment, no link (D-215;
 * `shared/invites.ts` `inviteCommentText`). All three are `Config`, settable by
 * `set_invite_terms` from `FeeDests.operatorAddr` (the owner's wallet) and nobody else,
 * inside bounds the ledger fixes: count <= 100 and count x (value + 0.001) <= 0.31 GRAM.
 *
 *   npx tsx scripts/setInviteTerms.ts [--words "<words>"] [--count N] [--value GRAM] [--mainnet]
 *
 * Anything not passed keeps its live value. It READS the live terms first and sends nothing
 * if they already match or the new ones are out of bounds (CLAUDE.md: a driver decides on
 * its read before it sends). It holds no key: it prints a `ton://` transfer link carrying
 * the message, which the owner opens in the operator wallet's app. The 0.02 GRAM attached
 * pays the handler's gas; the rest stays on the ledger, where the permissionless
 * `sweep_ops` returns it to the ratchet pool (D-117).
 */
import { Address, TonClient } from '@ton/ton';
import { PrimesLedger, setInviteTermsBody, inviteCommentText } from '../wrappers/PrimesLedger';
import { INVITE_TEXT_MAX_BYTES, INVITE_SEND_FEE_NANOTON, INVITE_LINE_CAP_NANOTON, inviteTermsValid } from '../../shared/invites';
import { hydrateProcessEnv } from './envFile';

hydrateProcessEnv();

const VALUE = 20_000_000n; // 0.02 GRAM

function arg(args: string[], name: string): string | undefined {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
}

async function main() {
    const args = process.argv.slice(2);
    const mainnet = args.includes('--mainnet');

    const ledgerAddr = process.env.PRIMES_LEDGER_ADDRESS?.trim();
    if (!ledgerAddr) throw new Error('PRIMES_LEDGER_ADDRESS is not set (/.env).');
    const endpoint = mainnet ? 'https://toncenter.com/api/v2/jsonRPC' : 'https://testnet.toncenter.com/api/v2/jsonRPC';
    const apiKey = (mainnet ? process.env.TONCENTER_API_KEY : process.env.TONCENTER_API_KEY_TESTNET)?.trim();
    const client = new TonClient({ endpoint, apiKey: apiKey || undefined });
    const ledger = client.open(PrimesLedger.createFromAddress(Address.parse(ledgerAddr)));

    const live = await ledger.getInviteTerms();
    const liveWords = await ledger.getInviteText();
    const words = arg(args, '--words') ?? liveWords;
    const count = arg(args, '--count') !== undefined ? Number(arg(args, '--count')) : live.count;
    const valueArg = arg(args, '--value');
    const value = valueArg !== undefined ? BigInt(Math.round(Number(valueArg) * 1e9)) : live.value;

    const fmt = (c: number, v: bigint, w: string) =>
        `${c} x ${Number(v) / 1e9} GRAM, line ${(Number(BigInt(c) * (v + INVITE_SEND_FEE_NANOTON)) / 1e9).toFixed(4)}/${Number(INVITE_LINE_CAP_NANOTON) / 1e9} GRAM, "${inviteCommentText(w)}"`;
    console.log(`network:  ${mainnet ? 'MAINNET' : 'testnet'}`);
    console.log(`ledger:   ${ledgerAddr}`);
    console.log(`now:      ${fmt(live.count, live.value, liveWords)}`);
    console.log(`new:      ${fmt(count, value, words)}  (1234 stands for the minted n)`);

    const bytes = Buffer.byteLength(words, 'utf-8');
    if (bytes > INVITE_TEXT_MAX_BYTES) throw new Error(`the words are ${bytes} bytes; the ledger takes at most ${INVITE_TEXT_MAX_BYTES}. Nothing to send.`);
    if (!inviteTermsValid(count, value)) throw new Error('the ledger would refuse these terms (238: count <= 100, value >= 1 nanoGRAM, count x (value + 0.001) <= 0.31). Nothing to send.');
    if (count === live.count && value === live.value && words === liveWords) {
        console.log('\nThe ledger already carries these terms. Nothing to send.');
        return;
    }

    const bin = setInviteTermsBody(count, value, words).toBoc().toString('base64url');
    const to = Address.parse(ledgerAddr).toString({ bounceable: true, testOnly: !mainnet });
    console.log('\nOpen this in the OPERATOR wallet (operator_addr in shared/networks/<network>.yaml); any other sender is refused (100):');
    console.log(`ton://transfer/${to}?amount=${VALUE}&bin=${bin}`);
    console.log(`\nThen re-run this script with no flags: "now" should show the new terms.`);
    // GAUNTLET.md E31: the app and keeper read `getInviteTerms` live, behind caches.
    console.log('The app follows within ~90s (read-proxy 30s tier + webapp 60s poll), the keeper within 30s.');
    console.log('LOWERING the count: a checkout opened before that still declares the old count and is refused 221 until it refreshes.');
}

main().catch((e) => {
    console.error(e?.message ?? e);
    process.exit(1);
});
