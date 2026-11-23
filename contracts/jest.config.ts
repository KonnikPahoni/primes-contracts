import type { Config } from 'jest';

const config: Config = {
    preset: 'ts-jest',
    testEnvironment: 'node',
    testTimeout: 60000,
    // THE GATE MUST NOT UNDER-REPORT. jest-worker's default transport is
    // child_process IPC, which serializes results with JSON — and
    // `JSON.stringify(1n)` throws. In a repo where every GRAM amount and every `n`
    // is a bigint, that threw in the *reporting* path and jest recorded four
    // suites as "failed to run" while discarding 23 real failures, so the
    // headline count read 3 when the truth was 27.
    //
    // Worker threads transport results with structured clone, which handles
    // BigInt natively, so the results survive the boundary intact. Patching
    // `BigInt.prototype.toJSON` from `setupFiles` does NOT fix this: the setup
    // file runs inside the test sandbox realm, while the failing
    // `JSON.stringify` runs in the worker's outer realm and looks up `toJSON`
    // on a `BigInt.prototype` the sandbox cannot reach.
    workerThreads: true,
    // Leave half the machine for the person using it: jest defaults to cores-1 workers and
    // a sandbox suite pins each one, which makes the laptop unusable for the whole run.
    // ...unless JEST_MAX_WORKERS overrides it (e.g. 100% on a dedicated test machine).
    maxWorkers: process.env.JEST_MAX_WORKERS ?? '50%',
    // Kept as defence in depth: any BigInt that reaches a JSON path *inside* a
    // test now stringifies instead of throwing.
    setupFiles: ['<rootDir>/tests/setup/bigint-json.ts', '<rootDir>/tests/setup/install-compile-cache.ts'],
    // COMPILE ONCE PER RUN, NOT ONCE PER SUITE.
    //
    // `@ton/blueprint`'s `compile()` has no cache at all — not on disk, not even
    // in-process — so all 22 suites were each recompiling the ~11 contracts they
    // need in `beforeAll`. Measured on a developer machine before this change:
    // one suite's `beforeAll` cost ~35 s *unloaded* against jest's 60 s hook
    // timeout, the full run took 451 s, and with workers compiling in parallel
    // five suites tipped past the timeout —
    //   Test Suites: 5 failed, 17 passed, 22 total
    //   Tests:       50 failed, 209 passed, 259 total
    // every failure being `Exceeded timeout of 60000 ms for a hook`, while those
    // same suites passed clean when run alone. The right fix is to delete the
    // redundant work rather than raise the limit until the flake stops: this
    // globalSetup compiles each contract exactly once, up front, into a cache
    // keyed by a hash of every `.tolk` source and `*.compile.ts` config, and the
    // setupFile above makes `compile()` read from it. `beforeAll` drops from ~35 s
    // to well under a second, so the 60 s timeout is no longer load-bearing.
    globalSetup: '<rootDir>/tests/setup/warm-compile-cache.ts',
};

export default config;
