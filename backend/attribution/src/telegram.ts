/**
 * TON PRIMES — Telegram-side verification for the §9.4 social quest track.
 *
 * ---- What this module is for ----
 *
 * The social quests pay from the bounty vault through a §9.5 signed voucher, so
 * every fact behind one is a fact an operator is asserting on a money path. The
 * whole design question is therefore: what makes that assertion worth anything?
 *
 * The answer here is that neither fact originates with the claimant:
 *
 *  1. WHO IS ASKING. Telegram Mini Apps hand the client an `initData` string that
 *     Telegram itself HMAC-signs with a key derived from the bot token. Verifying
 *     it turns "the request says it is user 12345" into "Telegram says it is user
 *     12345". A claimant cannot mint a Telegram identity out of a request body;
 *     they have to actually have the account.
 *  2. WHETHER THEY JOINED. `getChatMember` is a question put TO Telegram with the
 *     bot's own token, at issuance time. The claimant never touches the answer.
 *
 * Neither is a chain fact and neither is ever labelled `proved` — see `funnel.ts`
 * for the evidence ladder this service is built around. `counted` is the honest
 * class for both, and §9.4's mint gate is what stands between a `counted` fact and
 * the vault.
 *
 * ---- What this module deliberately does not do ----
 *
 * It does not decide anything. It answers two questions and returns what Telegram
 * said. The gate, the scoring and the signing all live elsewhere, so that this
 * file can be read as "is the Telegram half correct" without also having to hold
 * the economics in your head.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * §9.4's two chats. Owner-supplied 2026-08-19.
 *
 * Public @usernames rather than numeric ids on purpose: they are the strings a
 * player sees on the quest card and types into Telegram, so the value the bot
 * checks and the value the UI advertises are the same value. A numeric id would
 * be faster for the Bot API and impossible for a reader to check against the
 * card, which is the §9.1 problem in miniature.
 */
export const SOCIAL_CHANNEL = "@gram_primes";
export const SOCIAL_GROUP = "@primes_community";

/** Membership statuses Telegram reports for someone who is actually IN the chat. */
const MEMBER_STATUSES = new Set(["creator", "administrator", "member"]);

/**
 * How long a verified `initData` payload is accepted for.
 *
 * Telegram stamps `auth_date` into the signed payload precisely so a replayed
 * capture stops working. Without a check the signature proves the payload was
 * genuine ONCE, which is not the claim the voucher route needs. An hour matches
 * `VOUCHER_TTL_SECONDS` — a voucher outlives its own authorisation by nothing.
 */
export const INITDATA_MAX_AGE_SECONDS = 3600;

export class TelegramAuthError extends Error {
  constructor(
    message: string,
    readonly code: "bad_signature" | "expired" | "malformed"
  ) {
    super(message);
    this.name = "TelegramAuthError";
  }
}

export interface TelegramIdentity {
  /** The Telegram user id Telegram vouched for. */
  telegramUserId: string;
  /** When Telegram signed it. */
  authDate: Date;
  /**
   * The rest of the signed `user` blob — display name, @handle and public userpic URL —
   * carried so the auto-link can write WHO it just linked (migration 010) and `/me` can
   * draw a face instead of a numeric id. Every field is optional at the source: `username`
   * does not exist on every account and `photo_url` is absent when the avatar is private.
   *
   * Signed by the same HMAC as the id, so this is Telegram's word and not the browser's —
   * which is the whole reason it is read here rather than accepted from a request body.
   */
  profile: { name?: string; username?: string; photo?: string };
}

/**
 * Verify a Mini App `initData` string and return who Telegram says is asking.
 *
 * The algorithm is Telegram's, not ours: sort the fields, join them as
 * `key=value` with newlines, and HMAC that with a key which is itself
 * `HMAC_SHA256(botToken, "WebAppData")`. The nesting is the part people get
 * wrong — the bot token is the MESSAGE of the outer HMAC and the literal string
 * "WebAppData" is its key, not the other way round.
 *
 * @throws TelegramAuthError on a bad, malformed or stale payload. Never returns a
 *         partial or "probably fine" result: the caller is about to sign money
 *         against this, so there is no degraded mode worth having.
 */
export function verifyInitData(
  initData: string,
  botToken: string,
  now: Date = new Date()
): TelegramIdentity {
  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  if (!hash) throw new TelegramAuthError("initData carries no hash", "malformed");
  params.delete("hash");

  const checkString = [...params.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");

  const secret = createHmac("sha256", "WebAppData").update(botToken).digest();
  const expected = createHmac("sha256", secret).update(checkString).digest();

  // Format-check the STRING before decoding it: a SHA-256 HMAC hex digest is
  // always exactly 64 lowercase-or-uppercase hex characters, and Node's
  // `Buffer.from(x, "hex")` silently drops a trailing odd nibble instead of
  // erroring — so a tampered hash one character longer or shorter than a real
  // signature can decode to the same 32-byte buffer as the untampered original,
  // sailing past the *buffer*-length check below (GAUNTLET.md T17).
  if (!/^[0-9a-f]{64}$/i.test(hash)) {
    throw new TelegramAuthError(
      "initData hash is not a 64-character hex digest",
      "malformed"
    );
  }

  const given = Buffer.from(hash, "hex");
  // Length-check first: timingSafeEqual THROWS on a length mismatch rather than
  // returning false, and an exception is not the failure mode this should have.
  // (Now redundant with the regex above, since a 64-hex-char string always
  // decodes to exactly 32 bytes — kept as defence in depth.)
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    throw new TelegramAuthError(
      "initData signature does not verify against the bot token",
      "bad_signature"
    );
  }

  const authDateRaw = params.get("auth_date");
  if (!authDateRaw) throw new TelegramAuthError("initData carries no auth_date", "malformed");
  const authDate = new Date(Number(authDateRaw) * 1000);
  if (Number.isNaN(authDate.getTime())) {
    throw new TelegramAuthError("initData auth_date is not a unix timestamp", "malformed");
  }
  const ageSeconds = (now.getTime() - authDate.getTime()) / 1000;
  if (ageSeconds > INITDATA_MAX_AGE_SECONDS) {
    throw new TelegramAuthError(
      `initData is ${Math.round(ageSeconds)}s old; the limit is ${INITDATA_MAX_AGE_SECONDS}s`,
      "expired"
    );
  }
  // A payload from the future is a clock problem rather than an attack, but it is
  // also not something to sign against silently — testnet already cost a day to
  // clock skew once (docs/testnet-deployment.md).
  if (ageSeconds < -INITDATA_MAX_AGE_SECONDS) {
    throw new TelegramAuthError(
      "initData auth_date is in the future; check the host clock",
      "expired"
    );
  }

  const userRaw = params.get("user");
  if (!userRaw) throw new TelegramAuthError("initData carries no user", "malformed");
  let user: { id?: unknown; first_name?: unknown; last_name?: unknown; username?: unknown; photo_url?: unknown };
  try {
    user = JSON.parse(userRaw) as typeof user;
  } catch {
    throw new TelegramAuthError("initData user is not JSON", "malformed");
  }
  const userId = user.id;
  if (typeof userId !== "number" && typeof userId !== "string") {
    throw new TelegramAuthError("initData user has no id", "malformed");
  }

  // Only the id is REQUIRED — a display name is not a security property, and a payload that
  // verified is not going to be rejected over a missing @handle. Each field is taken only
  // when Telegram sent it as a string, so a hostile-but-signed shape cannot put an object
  // into a column.
  const str = (v: unknown) => (typeof v === "string" && v.length > 0 ? v : undefined);
  const name = [str(user.first_name), str(user.last_name)].filter(Boolean).join(" ") || undefined;

  return {
    telegramUserId: String(userId),
    authDate,
    profile: { name, username: str(user.username), photo: str(user.photo_url) },
  };
}

/** Minimal shape of the Bot API's `getChatMember` result that this cares about. */
interface ChatMemberResponse {
  ok: boolean;
  result?: { status?: string };
  description?: string;
}

export interface ChatMembership {
  channel: boolean;
  group: boolean;
  /**
   * Whether Telegram actually ANSWERED both questions.
   *
   * `channel`/`group` collapse every failure to `false`, which is the right degradation for
   * the LIVE question — a player who cannot be seen to have joined costs themselves a
   * refresh, and nothing is ever invented in the other direction. It is the wrong
   * degradation for a DURABLE one: `membership_observations` rows are the evidence
   * §9.4's `social-stay-7d` streak is walked over, so writing `both_chats = false` because
   * our own request failed would break a streak the player kept, out of an outage they had
   * no part in.
   *
   * `false` here means "we could not ask", not "they are not in". A writer of durable
   * evidence must skip; a reader of the live board may treat it exactly as a `false`.
   */
  observed: boolean;
}

/**
 * Ask Telegram whether a user is in each of §9.4's two chats.
 *
 * `fetchImpl` is injectable so the tests exercise this exact code path rather
 * than a reimplementation of it — the same reasoning as `InMemoryAttributionStore`
 * (see `store.ts`).
 *
 * A chat that ERRORS is reported as `false`, not thrown. The bot being removed
 * from the channel, or Telegram rate-limiting, must degrade to "we could not see
 * that you joined" — which costs the player a retry — rather than to a 500 that
 * looks like the quest board is broken. It can never degrade the other way: there
 * is no path here that reports membership Telegram did not confirm.
 */
export async function fetchChatMembership(
  telegramUserId: string,
  botToken: string,
  fetchImpl: typeof fetch = fetch
): Promise<ChatMembership> {
  // `member` is what the live board reads; `observed` says whether Telegram answered at
  // all, so a durable writer can tell "they are not in" from "we could not ask". A
  // non-member is `{ member: false, observed: true }` — Telegram reports that as a normal
  // `ok: true` result with status `left` or `kicked`, not as an error.
  const check = async (chat: string): Promise<{ member: boolean; observed: boolean }> => {
    try {
      const url =
        `https://api.telegram.org/bot${botToken}/getChatMember` +
        `?chat_id=${encodeURIComponent(chat)}&user_id=${encodeURIComponent(telegramUserId)}`;
      const res = await fetchImpl(url);
      if (!res.ok) return { member: false, observed: false };
      const body = (await res.json()) as ChatMemberResponse;
      // `ok: false` is the bot being removed from the chat, a bad chat id, or a rate
      // limit — our problem, never a fact about the player.
      if (!body.ok || !body.result?.status) return { member: false, observed: false };
      return { member: MEMBER_STATUSES.has(body.result.status), observed: true };
    } catch {
      return { member: false, observed: false };
    }
  };

  const [channel, group] = await Promise.all([
    check(SOCIAL_CHANNEL),
    check(SOCIAL_GROUP),
  ]);
  return {
    channel: channel.member,
    group: group.member,
    // Both, not either: the fact recorded is "in BOTH chats", so a half-answer is not a
    // basis for writing it down either way.
    observed: channel.observed && group.observed,
  };
}
