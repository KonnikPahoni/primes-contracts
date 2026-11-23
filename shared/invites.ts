/**
 * TON PRIMES — §4.1's invite line, defined once (DECISIONS.md D-202, D-215).
 *
 * A mint may name up to the ledger's live invite count; the ledger sends each one a
 * plain NoBounce transfer of the live invite value, fees paid on top, carrying a text
 * comment. There is no operator signature (D-202 deleted it with the generators): the
 * minter picks the addresses, the operator's wallet sets count, value and words (D-211,
 * D-215, `set_invite_terms`), the ledger adds the link. Clients read the live terms off
 * `getInviteTerms`; the `INVITE_GENESIS_*` numbers below are only what genesis deploys.
 *
 * Two layouts live here so the contract tests, the keeper and the webapp share them:
 *
 *  - `inviteListCell` — the mint body's `InviteList` ref: `addresses:(HashmapE 7 MsgAddress)`,
 *    keyed BY SLOT 1..count, holes allowed.
 *  - `inviteCommentText` — the exact text `primes_ledger.tolk`'s `inviteComment(n)` sends
 *    under given words (D-211: the words are operator-set on chain, the link is fixed).
 *    `InviteCrossCheck.spec.ts` pins it to the Tolk literals and `InviteTransfers.spec.ts`
 *    to the bytes a real mint emits.
 *
 * The three bounds mirror `primes_ledger.tolk`'s `INVITE_COUNT_CEILING` / `INVITE_LINE_CAP` /
 * `INVITE_SEND_FEE`, which `SimCrossCheck.spec.ts` pins to `shared/params.json`
 * `invites.count_ceiling` / `invites.line_cap_ton` / `invites.send_fee_allowance_ton`
 * (owner-set, D-215). The chain publishes them beside the live terms through `getInviteTerms`.
 */

import { Address, beginCell, Cell, Dictionary } from '@ton/core';
import { LEDGER } from './opcodes';

/** `primes_ledger.tolk` `INVITE_COUNT_CEILING`: no terms may let one mint fund more transfers. */
export const INVITE_COUNT_CEILING = 100;
/** `primes_ledger.tolk` `INVITE_LINE_CAP`: count × (value + send fee) ≤ 0.31 GRAM. */
export const INVITE_LINE_CAP_NANOTON = 310_000_000n;
/** `primes_ledger.tolk` `INVITE_SEND_FEE`: what the line pays per transfer for its own fees. */
export const INVITE_SEND_FEE_NANOTON = 1_000_000n;

/** D-215: the terms genesis deploys with — 3 transfers that each deliver 0.1 GRAM whole. */
export const INVITE_GENESIS_COUNT = 3;
export const INVITE_GENESIS_VALUE_NANOTON = 100_000_000n;

/** Would the ledger accept these terms? `handleSetInviteTerms`'s check (238), restated. */
export function inviteTermsValid(count: number, valueNano: bigint): boolean {
    return Number.isInteger(count) && count >= 0 && count <= INVITE_COUNT_CEILING && valueNano >= 1n
        && BigInt(count) * (valueNano + INVITE_SEND_FEE_NANOTON) <= INVITE_LINE_CAP_NANOTON;
}

/** `set_invite_terms#b0000086` (D-215): count, value and words in one message, operator only. */
export function setInviteTermsBody(count: number, valueNano: bigint, words: string, queryId = 0n): Cell {
    return beginCell()
        .storeUint(LEDGER.set_invite_terms, 32)
        .storeUint(queryId, 64)
        .storeUint(count, 7)
        .storeCoins(valueNano)
        .storeRef(inviteTextCell(words))
        .endCell();
}

/**
 * Is `a` an address the ledger will invite? Workchain 0 only: `primes_ledger.tolk` refuses
 * the whole mint (`invite_bad_workchain`, 236) if any named slot is anywhere else (audit
 * R2-L1). Every list builder filters on this; the encoders below stay faithful so the
 * contract tests can still put a refused address on the wire.
 */
export function isInvitable(a: Address): boolean {
    return a.workChain === 0;
}

/**
 * D-211: the invite WORDS are operator-set on the ledger (`set_invite_terms`, read back with
 * `getInviteText`); the link after them is the ledger's own. This is the text genesis deploys
 * with. D-215 (2026-11-22): mainnet probes found Telegram Wallet pushes a notification for
 * these words sent alone (no link) and drops the push for the longer launch dedication, so
 * the dedication is retired. Whether they still push WITH the ledger's link after them is
 * unmeasured — D-215 point 4. Change it on chain, not here, once deployed.
 */
export const INVITE_TEXT_GENESIS = 'Hi from @primes_live_bot';
/** `primes_ledger.tolk` `INVITE_TEXT_MAX_BYTES`: UTF-8 bytes, so a non-ASCII character costs 2+. */
export const INVITE_TEXT_MAX_BYTES = 86;

/** The fixed text the ledger writes around `n`, after the operator's words. */
export const INVITE_COMMENT_PREFIX = ' primes.live/?ref=';
export const INVITE_COMMENT_SUFFIX = '_tg';

/** The words as `set_invite_terms` carries them (bytes only). Throws past the ledger's cap. */
export function inviteTextCell(words: string): Cell {
    const bytes = Buffer.byteLength(words, 'utf-8');
    if (bytes > INVITE_TEXT_MAX_BYTES) throw new Error(`invite text is ${bytes} bytes; the ledger takes ${INVITE_TEXT_MAX_BYTES}`);
    return beginCell().storeBuffer(Buffer.from(words, 'utf-8')).endCell();
}

/** The comment an invite for the mint of `n` carries, as text, under the words `words`. */
export function inviteCommentText(n: bigint, words: string = INVITE_TEXT_GENESIS): string {
    return `${words}${INVITE_COMMENT_PREFIX}${n.toString(10)}${INVITE_COMMENT_SUFFIX}`;
}

/** The same comment as the message body: op 0 (32 zero bits) then the bytes, one cell. */
export function inviteCommentCell(n: bigint, words: string = INVITE_TEXT_GENESIS): Cell {
    return beginCell().storeUint(0, 32).storeStringTail(inviteCommentText(n, words)).endCell();
}

/** `InviteList.addresses`, keyed BY SLOT (1..count, uint7). Empty map → no dict. */
export function inviteAddressDict(addresses: Map<number, Address>): Dictionary<number, Address> | undefined {
    if (addresses.size === 0) return undefined;
    const d = Dictionary.empty(Dictionary.Keys.Uint(7), Dictionary.Values.Address());
    for (const [slot, a] of addresses) d.set(slot, a);
    return d;
}

/** The mint body's `InviteList` ref, byte for byte as the ledger parses it. */
export function inviteListCell(addresses: Map<number, Address>): Cell {
    return beginCell().storeDict(inviteAddressDict(addresses)).endCell();
}
