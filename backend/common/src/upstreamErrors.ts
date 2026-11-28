/**
 * Deployment-version facts about an upstream get-method call, shared by every service that
 * makes one.
 *
 * `read-proxy` has classified these since 2026-08-14 (see `upstream.ts`, which now
 * re-exports this module): a get-method the deployed contract does not have is a *fact
 * about the deployment*, not a failure, and it answers `501` with the method name it is
 * waiting for. `read-index`'s sweeper had no such notion, and the cost was live: on
 * primes.live the `unclaimed` target called a get-method the deployed ledger does not have,
 * failed with `exit_code: 11` on every cycle, was re-queued every time, held
 * `catchUpComplete` false forever and pumped `consecutiveFailures` — so **every response the
 * index served was flagged degraded and the app-wide "the read index is behind" banner was
 * permanently on** (steward run #4). One definition, both services.
 */

/** Default backoff advertised to clients when we have no stale value to serve and the
 *  upstream is throttling. Deliberately larger than read-proxy's fast TTL (5s) so a client
 *  that honours it lands on a *repopulated* cache rather than on the same empty key. */
export const DEFAULT_RETRY_AFTER_SECONDS = 5;

/** Raised by `pace.ts`'s pacer when a caller's slot is further out than it is willing to
 *  wait — moved here (steward S18) so read-index, event-poller and keeper can share the
 *  same pacer read-proxy already proved, not just the same classification of its result. */
export class UpstreamThrottleError extends Error {
  readonly statusCode = 429;
  constructor(
    message: string,
    readonly retryAfterSeconds: number = DEFAULT_RETRY_AFTER_SECONDS,
    readonly cause?: unknown
  ) {
    super(message);
    this.name = "UpstreamThrottleError";
  }
}

/** An error's text, whatever shape it arrived in. Every classifier below — and read-proxy's
 *  `isUpstreamThrottle` / `isInactiveContract`, which match on the same strings — works on the
 *  message rather than on a structured field, because the message is the one part that
 *  survives being wrapped by axios, `@ton/ton` and a `Promise.all` in turn. Exported so those
 *  classifiers read the error the same way this one does; a second local copy diverging on,
 *  say, a non-Error throw would silently reclassify a whole failure mode. */
export function messageOf(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

/** True for "the deployed contract has no such get-method". TVM answers an unknown method
 *  selector with exit code 11; `@ton/sandbox` and `@ton/ton` both surface that as
 *  "Unable to execute get method. Got exit_code: 11". 13 (out of gas) and the various
 *  "unknown get method" phrasings are included for provider portability.
 *
 *  The sign is load-bearing and a `-?` here would be a bug: **-13** is not TVM's 13, it is
 *  the provider's "there is no account at this address at all", which read-proxy's
 *  `isInactiveContract` owns. Matching it here reported an unminted number's item as a
 *  deployment-version fact on the optional routes and left it unclassified elsewhere. */
export function isMissingGetMethod(err: unknown): boolean {
  const msg = messageOf(err);
  return (
    /exit_code:\s*(11|13)\b/.test(msg) ||
    /unknown\s+get[-_ ]?method/i.test(msg) ||
    /method\s+not\s+found/i.test(msg) ||
    /cannot\s+run\s+get\s+method/i.test(msg)
  );
}

/** True for "there is no account at this address" — the provider's `exit_code: -13` (and its
 *  phrasings), a fact about THIS address rather than about the deployment version. Shared so
 *  read-proxy's `isInactiveContract` and read-index's sweeper read it identically: the sweeper
 *  used to treat it as transient, so a referral key cited by a mint but never minted itself
 *  (`referral_paid:2`, `:1008` on primes.live, 2026-10-12) was retried every cycle, held
 *  `catchUpComplete` false for good and kept D-24's "index is lagging" strip up on every route. */
export function isNoAccount(err: unknown): boolean {
  const msg = messageOf(err);
  return (
    /exit_code:\s*-13\b/.test(msg) ||
    /non-?active\s+contract/i.test(msg) ||
    /account\s+(is\s+)?(not\s+active|uninit)/i.test(msg)
  );
}

/** True for an upstream 5xx — e.g. toncenter's `LITE_SERVER_NETWORK(during last block
 *  synchronization)` 500, a lite-server hiccup that clears in seconds. Retry-safe for reads
 *  only: toncenter also answers a refused `sendBoc` with a 500, and that one never clears. */
export function isUpstreamServerError(err: unknown): boolean {
  const s = httpStatusOf(err);
  return s !== undefined && s >= 500 && s < 600;
}

function httpStatusOf(err: unknown): number | undefined {
  const anyErr = err as { response?: { status?: number }; status?: number; statusCode?: number };
  return anyErr?.response?.status ?? anyErr?.status ?? anyErr?.statusCode;
}

/** True for "the upstream RPC provider refused this call because we're over budget". Matches
 *  both the structured axios shape `@ton/ton`'s TonClient produces and the bare message text,
 *  because the message is all that survives some wrappings. Moved from read-proxy so the
 *  keeper's send path can retry on the same classification. */
export function isUpstreamThrottle(err: unknown): boolean {
  if (err instanceof UpstreamThrottleError) return true;
  if (httpStatusOf(err) === 429) return true;
  const msg = messageOf(err);
  return /\b429\b/.test(msg) || /rate.?limit/i.test(msg) || /too many requests/i.test(msg);
}
