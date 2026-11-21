/**
 * TON PRIMES — §4.1's invite line, defined once (DECISIONS.md D-202).
 *
 * A mint may name up to `INVITE_MAX_COUNT` recipients; the ledger sends each one a
 * plain NoBounce transfer of `INVITE_TRANSFER_VALUE_NANOTON` carrying a text comment.
 * There is no operator signature (D-202 deleted it with the generators): the minter
 * picks the addresses, the operator's wallet sets the words (D-211), the ledger adds the link.
 *
 * Two layouts live here so the contract tests, the keeper and the webapp share them:
 *
 *  - `inviteListCell` — the mint body's `InviteList` ref: `addresses:(HashmapE 3 MsgAddress)`,
 *    keyed BY SLOT 1..INVITE_MAX_COUNT, holes allowed.
 *  - `inviteCommentText` — the exact text `primes_ledger.tolk`'s `inviteComment(n)` sends
 *    under given words (D-211: the words are operator-set on chain, the link is fixed).
 *    `InviteCrossCheck.spec.ts` pins it to the Tolk literals and `InviteTransfers.spec.ts`
 *    to the bytes a real mint emits.
 *
 * The two numbers mirror `primes_ledger.tolk`'s `INVITE_MAX_COUNT` / `INVITE_TRANSFER_VALUE`,
 * which `SimCrossCheck.spec.ts` pins to `shared/params.json` `invites.max_count` /
 * `invites.transfer_value_ton` (owner-set, D-202). The chain publishes both through the
 * ledger's `getInviteTerms`.
 */

import { Address, beginCell, Cell, Dictionary } from '@ton/core';

/** `primes_ledger.tolk` `INVITE_MAX_COUNT`. The minter declares `count` ∈ 0..3; over that is error 221. */
export const INVITE_MAX_COUNT = 3;

/** `primes_ledger.tolk` `INVITE_TRANSFER_VALUE`: 0.1 TON per funded slot. */
export const INVITE_TRANSFER_VALUE_NANOTON = 100_000_000n;

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
 * D-211: the invite WORDS are operator-set on the ledger (`set_invite_text`, read back with
 * `getInviteText`); the link after them is the ledger's own. This is the text genesis deploys
 * with — the 25 Nov 2026 launch dedication. Change it on chain, not here, once deployed.
 */
export const INVITE_TEXT_GENESIS = 'The Riemann hypothesis is proved! Celebrate on TON PRIMES: own a number forever.';
/** `primes_ledger.tolk` `INVITE_TEXT_MAX_BYTES`: UTF-8 bytes, so a non-ASCII character costs 2+. */
export const INVITE_TEXT_MAX_BYTES = 86;

/** The fixed text the ledger writes around `n`, after the operator's words. */
export const INVITE_COMMENT_PREFIX = ' primes.live/?ref=';
export const INVITE_COMMENT_SUFFIX = '_tg';

/** The words as `set_invite_text` carries them (bytes only). Throws past the ledger's cap. */
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

/** `InviteList.addresses`, keyed BY SLOT (1..INVITE_MAX_COUNT). Empty map → no dict. */
export function inviteAddressDict(addresses: Map<number, Address>): Dictionary<number, Address> | undefined {
    if (addresses.size === 0) return undefined;
    const d = Dictionary.empty(Dictionary.Keys.Uint(3), Dictionary.Values.Address());
    for (const [slot, a] of addresses) d.set(slot, a);
    return d;
}

/** The mint body's `InviteList` ref, byte for byte as the ledger parses it. */
export function inviteListCell(addresses: Map<number, Address>): Cell {
    return beginCell().storeDict(inviteAddressDict(addresses)).endCell();
}
