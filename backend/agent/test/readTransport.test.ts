import { afterEach, describe, expect, it, vi } from "vitest";
import { PrimesRead } from "../src/index.ts";

const ok = () =>
  ({ ok: true, status: 200, json: async () => ({ data: { head: "42" } }), headers: new Headers() }) as Response;
const tooMany = (retryAfter: string | null) =>
  ({
    ok: false,
    status: 429,
    json: async () => ({}),
    text: async () => "",
    headers: new Headers(retryAfter == null ? {} : { "retry-after": retryAfter }),
  }) as Response;

afterEach(() => vi.restoreAllMocks());

describe("PrimesRead — Retry-After is delta-seconds, and nonsense waits 1s rather than 0", () => {
  it.each([
    ["", 1000],
    ["   ", 1000],
    ["-5", 1000],
    ["abc", 1000],
    ["Wed, 21 Oct 2026 07:28:00 GMT", 1000],
    [null, 1000],
    ["0", 0],
    ["3", 3000],
    ["999", 30_000],
  ])("Retry-After %j waits %ims", async (header, ms) => {
    const delays: number[] = [];
    vi.spyOn(globalThis, "setTimeout").mockImplementation(((fn: () => void, d?: number) => {
      delays.push(d ?? 0);
      fn();
      return 0;
    }) as typeof setTimeout);
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(tooMany(header)).mockResolvedValueOnce(ok());
    expect(await new PrimesRead({ fetchImpl, rps: 1000 }).head()).toBe(42n);
    // The pacer's own sleeps at 1000 rps are ~1ms; the backoff is the only long one.
    expect(delays.filter((d) => d >= 100)).toEqual(ms === 0 ? [] : [ms]);
  });
});

describe("PrimesRead — every request carries a timeout", () => {
  it("a hung service rejects with TimeoutError instead of hanging the caller", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(
      (_url, init) =>
        new Promise((_, reject) => init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason))),
    );
    await expect(new PrimesRead({ fetchImpl, rps: 1000, timeoutMs: 20 }).head()).rejects.toMatchObject({
      name: "TimeoutError",
    });
  });

  it("defaults the timeout when none is passed", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(ok());
    await new PrimesRead({ fetchImpl, rps: 1000 }).head();
    expect(fetchImpl.mock.calls[0][1]?.signal).toBeInstanceOf(AbortSignal);
  });
});
