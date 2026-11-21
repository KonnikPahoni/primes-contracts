/**
 * One timed HTTP client for the services that were each re-deriving it (GAUNTLET.md E24).
 *
 * `fetch` has NO DEFAULT TIMEOUT in Node. Seventeen call sites across `bot/` and
 * `event-poller/` hand-rolled the same trailing-slash strip + `res.ok` + `res.json()`
 * shape with no `AbortSignal`, so a hung read-proxy pinned a grammY handler
 * indefinitely — and `bot/src/index.ts`'s `getMe` hung STARTUP while the health server
 * was already answering 200, which is the worst version: a process that reports healthy
 * and serves nothing.
 *
 * The pattern is `backend/attribution/src/eventIndex.ts`'s, which already had it right;
 * this is that pattern moved somewhere the other packages can reach.
 */

/** Long enough for a cold read-proxy round trip, short enough that a player notices a
 *  refusal instead of a spinner. `eventIndex.ts` uses 3s for the same class of hop. */
export const DEFAULT_FETCH_TIMEOUT_MS = 5_000;

/**
 * A non-2xx response, carrying the status so a caller can treat one specially.
 *
 * `whoisChain.ts` reads 501 as "the registrar is not deployed on this snapshot" and
 * returns rank 0 rather than failing — a real distinction that a helper which only threw
 * `Error` would have forced back into string matching.
 */
export class HttpStatusError extends Error {
  constructor(
    readonly status: number,
    readonly url: string,
    message?: string
  ) {
    super(message ?? `${url} answered ${status}`);
    this.name = "HttpStatusError";
  }
}

/** Strip trailing slashes from a base URL, so `${base}/path` never doubles up. */
export const baseUrl = (url: string) => url.replace(/\/+$/, "");

/**
 * `fetch` with a timeout. Returns the `Response` untouched — for the callers that want
 * bytes rather than JSON (the `.tgs` sticker reads).
 *
 * A timed-out request rejects with `TimeoutError` from `AbortSignal.timeout`, which is
 * distinguishable from a network error, so a caller that wants to say WHICH happened can.
 */
export function timedFetch(url: string, timeoutMs = DEFAULT_FETCH_TIMEOUT_MS): Promise<Response> {
  return fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
}

/**
 * `fetch` + timeout + status check + JSON parse — the shape all seventeen sites wrote.
 *
 * Throws `HttpStatusError` on a non-2xx, so the status survives for a caller that cares.
 */
export async function fetchJson<T>(url: string, timeoutMs = DEFAULT_FETCH_TIMEOUT_MS): Promise<T> {
  const res = await timedFetch(url, timeoutMs);
  if (!res.ok) throw new HttpStatusError(res.status, url);
  return (await res.json()) as T;
}
