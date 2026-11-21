/**
 * Shared, disk-backed cache for `compile()` from `@ton/blueprint`.
 *
 * WHY THIS EXISTS
 * ---------------
 * `@ton/blueprint`'s `compile(name)` has **no cache of any kind** — not on disk,
 * not even in-process (see `node_modules/@ton/blueprint/dist/compile/compile.js`:
 * `compile()` calls `doCompile()` calls the Tolk WASM compiler, every single
 * time). Every suite's `beforeAll` compiles the ~11 contracts it needs from
 * scratch, and 22 suites do that independently:
 *
 *   - one suite's `beforeAll` alone costs ~35 s unloaded, against jest's 60 s
 *     default hook timeout;
 *   - the whole run was 451 s wall clock, of which the overwhelming majority was
 *     the *same twelve contracts* being recompiled ~20 times over;
 *   - under jest's default parallelism every worker ran its own WASM compiler at
 *     once, so the ~35 s stretched past 60 s and the hooks timed out. Measured:
 *     `Test Suites: 5 failed, 17 passed` / `Tests: 50 failed, 209 passed`, every
 *     failure being `thrown: "Exceeded timeout of 60000 ms for a hook."` — while
 *     the very same suites pass clean when run alone.
 *
 * So the flake was never a contract regression; it was N× redundant compilation
 * stampeding the machine. Caching attacks the 35 s instead of raising the 60 s.
 *
 * HOW IT WORKS
 * ------------
 * `jest.config.ts` `globalSetup` warms this cache once, sequentially, before any
 * worker starts. `setupFiles` then monkeypatches `blueprint.compile` inside each
 * test realm so every `await compile('PrimesItem')` is a BOC read off disk
 * (~1 ms) instead of a WASM compile (~3 s).
 *
 * CORRECTNESS
 * -----------
 * The cache key is a SHA-256 over *every* `.tolk` source (INCLUDING `test-mocks/`,
 * which it did not until 2026-09-21 — see MOCKS_DIR below), *every*
 * `wrappers/*.compile.ts` compiler config, and the `version` field of the
 * `@ton/tolk-js` package blueprint itself resolves (which it did not until
 * 2026-09-21 either — see `tolkVersion()` below).
 * Any edit to any of those changes the fingerprint and the whole cache directory
 * is rebuilt from source. A test can therefore never run against stale bytecode,
 * which is the one thing a compile cache must not get wrong (CLAUDE.md: source
 * wins over anything already built).
 */
import { createHash } from 'crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'fs';
import path from 'path';
import { Cell } from '@ton/core';

const CONTRACTS_ROOT = path.resolve(__dirname, '..', '..');
const SOURCES_DIR = path.join(CONTRACTS_ROOT, 'contracts');
// THE MOCKS ARE SOURCES TOO, and leaving them out of the key was a real staleness
// bug, found 2026-09-21 building §4.3.2's staking specs: `mock_tonstakers_pool.tolk`
// grew three message arms, every spec kept running the PREVIOUS bytecode, and the
// new arms fell through the mock's catch-all as `throw 101` — a failure that reads
// exactly like a wire-format error in the contract under test. A mock lives in its
// own directory (NOT under `contracts/`, so `NoAdminWithdraw.spec.ts` does not scan
// it) and the fingerprint has to follow it there.
const MOCKS_DIR = path.join(CONTRACTS_ROOT, 'test-mocks');
const WRAPPERS_DIR = path.join(CONTRACTS_ROOT, 'wrappers');
const CACHE_ROOT = path.join(CONTRACTS_ROOT, '.cache', 'compile');

function walk(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir).sort()) {
        const full = path.join(dir, entry);
        if (statSync(full).isDirectory()) walk(full, out);
        else out.push(full);
    }
    return out;
}

let fingerprintMemo: string | undefined;

/**
 * The compiler version actually in use, or a throw.
 *
 * `require('@ton/tolk-js/package.json')` — what this used to do — **always throws**
 * here: under pnpm `@ton/tolk-js` is a transitive dependency of `@ton/blueprint` and
 * has no entry in `contracts/node_modules/@ton/`. The old code swallowed that in a
 * `catch` and hashed the literal `'unknown'` on every run, so the version component
 * of the fingerprint was a constant and **a compiler upgrade would have left every
 * cached BOC valid** — exactly the staleness the cache exists to prevent, and exactly
 * the kind of claim-with-no-test the `test-mocks/` omission above was.
 *
 * So resolve it the way blueprint itself does, from blueprint's own resolution paths,
 * and let a failure be loud: a fingerprint that degrades to a fixed string on error is
 * worse than a run that stops and says the compiler could not be identified.
 */
function tolkVersion(): string {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const pkgPath = require.resolve('@ton/tolk-js/package.json', { paths: [require.resolve('@ton/blueprint')] });
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const version = require(pkgPath).version;
    if (typeof version !== 'string' || version.length === 0) {
        throw new Error(`compile-cache: @ton/tolk-js at ${pkgPath} declares no version; refusing to fingerprint`);
    }
    return version;
}

/** SHA-256 over all Tolk sources + compile configs + the resolved Tolk compiler version. */
export function sourceFingerprint(): string {
    if (fingerprintMemo) return fingerprintMemo;
    const hash = createHash('sha256');

    hash.update(`tolk:${tolkVersion()}\n`);

    const files = [
        ...walk(SOURCES_DIR).filter((f) => f.endsWith('.tolk')),
        ...walk(MOCKS_DIR).filter((f) => f.endsWith('.tolk')),
        ...walk(WRAPPERS_DIR).filter((f) => f.endsWith('.compile.ts')),
    ];
    for (const file of files) {
        hash.update(path.relative(CONTRACTS_ROOT, file).replace(/\\/g, '/'));
        hash.update('\0');
        hash.update(readFileSync(file));
        hash.update('\0');
    }
    fingerprintMemo = hash.digest('hex').slice(0, 16);
    return fingerprintMemo;
}

export function cacheDir(): string {
    return path.join(CACHE_ROOT, sourceFingerprint());
}

function cachePath(name: string): string {
    return path.join(cacheDir(), `${name}.boc`);
}

/** In-realm memo so repeated `compile('X')` in one file is free. */
const memo = new Map<string, Cell>();

/**
 * The real compiler. `@ton/blueprint`'s barrel re-exports `compile` through a
 * getter, so the writable binding lives on the inner module — that is what we
 * both call through and patch. (`@ton/blueprint` has no `exports` map, so the
 * deep require is legal.)
 */
// eslint-disable-next-line @typescript-eslint/no-require-imports
const compileModule = require('@ton/blueprint/dist/compile/compile');

async function realCompile(name: string): Promise<Cell> {
    const original: (n: string) => Promise<Cell> = compileModule.__originalCompile ?? compileModule.compile;
    return await original(name);
}

/**
 * Cache-aware replacement for `blueprint.compile`. Reads the warmed BOC when it
 * is there; otherwise compiles for real and writes it (atomically, so parallel
 * workers racing on a cold cache cannot read a half-written file).
 */
export async function compileCached(name: string): Promise<Cell> {
    const hit = memo.get(name);
    if (hit) return hit;

    const file = cachePath(name);
    if (existsSync(file)) {
        const cell = Cell.fromBoc(readFileSync(file))[0];
        memo.set(name, cell);
        return cell;
    }

    const cell = await realCompile(name);

    mkdirSync(cacheDir(), { recursive: true });
    const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    writeFileSync(tmp, cell.toBoc());
    renameSync(tmp, file);

    memo.set(name, cell);
    return cell;
}

/** Swap `blueprint.compile` for the cached one. Idempotent. */
export function installCompileCache(): void {
    if (compileModule.__originalCompile) return;
    compileModule.__originalCompile = compileModule.compile;
    compileModule.compile = compileCached;
}
