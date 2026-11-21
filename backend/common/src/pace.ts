import { UpstreamThrottleError } from "./upstreamErrors.ts";

/**
 * Outbound pacing against a Toncenter key's per-second budget.
 *
 * Moved from `read-proxy/src/pace.ts` (steward S18): the pacer proved itself there — it is
 * the fix for the live 2026-09-09 429 storm — but read-proxy pacing itself was never enough,
 * because `read-index`, `event-poller` and `keeper` shared the SAME key from the SAME host
 * and were not paced at all. A per-process budget cannot bound a four-process spend against
 * one key; the only paced process was the player-facing one, so it was the one that starved.
 * One definition, wired into all four.
 *
 * The cache bounds REPETITION and `SingleFlight` bounds CONCURRENCY on one key. Neither
 * bounds the BURST: one dashboard mount fans out across a dozen different routes, each of
 * which calls three or four different get-methods, so ~40 distinct keys miss together and
 * fire ~40 upstream calls inside one second. A free Toncenter key allows 10/s — measured
 * live on 2026-09-09: 15 parallel `getMasterchainInfo` calls with the key returned fourteen
 * 200s and one 429, and read-proxy's own logs showed a steady drip of
 * `Request failed with status code 429` at an AVERAGE spend of only ~2.6 calls/s. Average
 * spend was never the problem; the shape of it was.
 *
 * So the calls are spaced instead of thrown away. Each caller claims the next free slot
 * `1000/rps` ms after the previous one and sleeps until it. There is no queue array and no
 * concurrency counter — the slot cursor IS the queue, and its depth is `nextSlot - now`.
 *
 * A caller whose slot is further out than `maxWaitMs` is refused immediately with the same
 * `UpstreamThrottleError` a real upstream 429 raises, which is what makes this safe to put
 * in front of everything: read-proxy's stale-while-revalidate rescue (cache.ts) and its
 * `429 + Retry-After` surface (server.ts's error handler) both already treat it as one. The
 * other three services are background loops, not request/response, so they treat it as any
 * other failed cycle: log and retry next tick (`backoffMs`).
 *
 * **Background work takes the slots users leave free** (dashboard load speed, perf plan
 * 2026-10-07). read-proxy's stale-while-revalidate refreshes and its 150s dashboard warm used to
 * claim slots on the same cursor as a visitor's cold miss: one warm tick queued ~60 refreshes
 * at once, so the visitor behind them waited up to `maxWaitMs` or was refused, and the refreshes
 * past the 4s line were refused themselves — measured live as /stake, /market, /lp/locked and
 * /treasury 429ing on 42 of 48 ticks, then aging out of grace into a 4.4s cold miss. A caller
 * passing `background = true` now waits in its own FIFO and claims a slot only once the cursor
 * is idle (`nextSlot <= now`), so a foreground caller never waits more than one spacing behind
 * background work, and both lanes still share one cursor, so the total stays at `rps`. The
 * background lane's own refusal line is `maxBackgroundWaitMs`, far past one warm tick's depth.
 *
 * ponytail: in-process, single instance per service — the same assumption `SingleFlight` and
 * read-proxy's cache already make. A second replica of any paced service spends 2x its share.
 */
export const DEFAULT_UPSTREAM_RPS = 6;

/** Under `DEFAULT_RETRY_AFTER_SECONDS` (5s), so a refused caller is told to come back after
 *  the queue it could not join has drained. */
export const DEFAULT_MAX_WAIT_MS = 4_000;

/** Depth past which a BACKGROUND caller is refused. One warm tick is ~60 calls (10s at 6/s);
 *  this is six of them, and well inside read-proxy's 300s stale grace, so a refresh that is
 *  admitted lands while the value it replaces is still servable. */
export const DEFAULT_MAX_BACKGROUND_WAIT_MS = 60_000;

export interface PacerOptions {
  rps?: number;
  maxWaitMs?: number;
  maxBackgroundWaitMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export type Pacer = <T>(fn: () => Promise<T>, background?: boolean) => Promise<T>;

export function createPacer(opts: PacerOptions = {}): Pacer {
  const rps = opts.rps ?? DEFAULT_UPSTREAM_RPS;
  const maxWaitMs = opts.maxWaitMs ?? DEFAULT_MAX_WAIT_MS;
  const maxBackgroundWaitMs = opts.maxBackgroundWaitMs ?? DEFAULT_MAX_BACKGROUND_WAIT_MS;
  const now = opts.now ?? (() => Date.now());
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const spacingMs = 1000 / rps;
  let nextSlot = 0;
  // The background FIFO: a promise chain, so one background caller at a time watches the
  // cursor, and `backgroundQueued` is its depth for the refusal line.
  let backgroundTail: Promise<void> = Promise.resolve();
  let backgroundQueued = 0;

  return async function paced<T>(fn: () => Promise<T>, background = false): Promise<T> {
    if (background) {
      if (backgroundQueued * spacingMs > maxBackgroundWaitMs) {
        throw new UpstreamThrottleError(
          `background call queue is ${backgroundQueued} deep against a ${rps}/s budget; refused before it was sent`
        );
      }
      backgroundQueued++;
      // Admission assumes the queue drains at the full `rps`; foreground demand at or past it
      // never leaves the cursor idle, so the head would wait for ever and park every refresh
      // (and the `SingleFlight` entry a foreground miss on the same key then joins) behind it.
      // The deadline turns that into the same refusal admission gives.
      const enqueuedAt = now();
      const turn = backgroundTail.then(async () => {
        for (let w = nextSlot - now(); w > 0; w = nextSlot - now()) {
          if (now() - enqueuedAt > maxBackgroundWaitMs) {
            backgroundQueued--;
            throw new UpstreamThrottleError(
              `background call waited ${Math.round(now() - enqueuedAt)}ms for an idle slot against a ${rps}/s budget; refused before it was sent`
            );
          }
          await sleep(w);
        }
        nextSlot = now() + spacingMs;
        backgroundQueued--;
      });
      // A refused turn must not reject the chain, or every later `.then` skips its turn.
      backgroundTail = turn.catch(() => {});
      await turn;
      return fn();
    }
    const t = now();
    const slot = Math.max(t, nextSlot);
    const wait = slot - t;
    if (wait > maxWaitMs) {
      throw new UpstreamThrottleError(
        `upstream call queue is ${Math.round(wait)}ms deep against a ${rps}/s budget; refused before it was sent`
      );
    }
    nextSlot = slot + spacingMs;
    if (wait > 0) await sleep(wait);
    return fn();
  };
}

/** `UPSTREAM_RPS` from the environment, or `fallback`. Anything unparseable or ≤ 0 is the
 *  fallback rather than an error — a typo in a compose file must not take the service down.
 *  `envVar` lets a caller read a service-specific override (e.g. `READ_INDEX_UPSTREAM_RPS`)
 *  without every service fighting over the same `UPSTREAM_RPS` name. */
export function pacerRpsFrom(env: NodeJS.ProcessEnv, envVar = "UPSTREAM_RPS", fallback = DEFAULT_UPSTREAM_RPS): number {
  const parsed = Number(env[envVar]);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
