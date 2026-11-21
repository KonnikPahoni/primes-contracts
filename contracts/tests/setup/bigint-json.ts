/**
 * Make BigInt survive the jest worker boundary.
 *
 * jest-worker ships every result, buffered console message and failure payload
 * back to the parent with `parentProcess.send(...)` — child_process IPC, which
 * serializes with JSON. `JSON.stringify(1n)` throws
 * `TypeError: Do not know how to serialize a BigInt`, and because the throw
 * happens in the *reporting* path rather than in the test, jest reports the whole
 * suite as "failed to run" and its real results are discarded.
 *
 * This repo is BigInt-dense — every TON amount, every `n`, every get-method
 * return is a bigint — so four suites (PrimesReservation, EscrowAggregate,
 * ReservationPricing, PrimesTrophyAuction) were silently contributing **zero**
 * to the failure count while hiding 23 genuine failures. A gate that under-reports
 * is worse than a red one.
 *
 * Giving BigInt a `toJSON` makes the IPC path lossless-enough (values arrive as
 * decimal strings, which is all the reporter ever renders anyway) without
 * switching jest to `workerThreads`, which is still experimental in jest 29.
 *
 * Scope: test process only. Nothing in `contracts/`, `shared/` or the wrappers
 * relies on `JSON.stringify` throwing on a bigint.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(BigInt.prototype as any).toJSON = function (this: bigint): string {
    return this.toString();
};

export {};
