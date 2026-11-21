/**
 * TON PRIMES — rewrite §4.1's invite words on the ledger (DECISIONS.md D-211).
 *
 * The ledger sends every invite as `<words>` followed by its own referral link for `n`
 * (`shared/invites.ts` `inviteCommentText`). The words are
 * `Config.inviteText`, settable by `set_invite_text` from `FeeDests.operatorAddr` (the
 * owner's wallet) and nobody else; the link is the ledger's own and cannot be changed.
 *
 *   npx tsx scripts/setInviteText.ts "<words>" [--mainnet]
 *
 * It READS the live words first and sends nothing if they already match (CLAUDE.md: a
 * driver decides on its read before it sends). It holds no key: it prints a `ton://`
 * transfer link carrying the message, which the owner opens in the operator wallet's app.
 * The 0.02 TON attached pays the handler's gas; the rest stays on the ledger, where the
 * permissionless `sweep_ops` returns it to the ratchet pool (D-117).
 */
import { Address, TonClient } from '@ton/ton';
import { PrimesLedger, setInviteTextBody, inviteCommentText } from '../wrappers/PrimesLedger';
import { INVITE_TEXT_MAX_BYTES } from '../../shared/invites';
import { hydrateProcessEnv } from './envFile';

hydrateProcessEnv();

const VALUE = 20_000_000n; // 0.02 TON

async function main() {
    const args = process.argv.slice(2);
    const mainnet = args.includes('--mainnet');
    const words = args.find((a) => !a.startsWith('--'));
    if (!words) throw new Error('usage: setInviteText.ts "<words>" [--mainnet]');
    const bytes = Buffer.byteLength(words, 'utf-8');
    if (bytes > INVITE_TEXT_MAX_BYTES) throw new Error(`"${words}" is ${bytes} bytes; the ledger takes at most ${INVITE_TEXT_MAX_BYTES}. Nothing to send.`);

    const ledgerAddr = process.env.PRIMES_LEDGER_ADDRESS?.trim();
    if (!ledgerAddr) throw new Error('PRIMES_LEDGER_ADDRESS is not set (/.env).');
    const endpoint = mainnet ? 'https://toncenter.com/api/v2/jsonRPC' : 'https://testnet.toncenter.com/api/v2/jsonRPC';
    const apiKey = (mainnet ? process.env.TONCENTER_API_KEY : process.env.TONCENTER_API_KEY_TESTNET)?.trim();
    const client = new TonClient({ endpoint, apiKey: apiKey || undefined });
    const ledger = client.open(PrimesLedger.createFromAddress(Address.parse(ledgerAddr)));

    const live = await ledger.getInviteText();
    console.log(`network:  ${mainnet ? 'MAINNET' : 'testnet'}`);
    console.log(`ledger:   ${ledgerAddr}`);
    console.log(`now:      "${inviteCommentText(1234n, live)}"`);
    console.log(`new:      "${inviteCommentText(1234n, words)}"  (${bytes}/${INVITE_TEXT_MAX_BYTES} bytes; 1234 stands for the minted n)`);
    if (live === words) {
        console.log('\nThe ledger already carries these words. Nothing to send.');
        return;
    }

    const bin = setInviteTextBody(words).toBoc().toString('base64url');
    const to = Address.parse(ledgerAddr).toString({ bounceable: true, testOnly: !mainnet });
    console.log('\nOpen this in the OPERATOR wallet (PRIMES_OPERATOR_ADDR); any other sender is refused (100):');
    console.log(`ton://transfer/${to}?amount=${VALUE}&bin=${bin}`);
    console.log(`\nThen re-run this script: "now" should show the new words.`);
}

main().catch((e) => {
    console.error(e?.message ?? e);
    process.exit(1);
});
