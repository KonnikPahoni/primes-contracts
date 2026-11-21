/**
 * jest `globalSetup`: compile every contract exactly ONCE per run.
 *
 * Before this existed, each of the 22 suites compiled the ~11 contracts it needs
 * in its own `beforeAll` — ~240 Tolk compiles per run, ~35 s per suite, 451 s
 * total, and under parallel workers the compiles stampeded each other until five
 * suites blew jest's 60 s hook timeout (50 spurious failures, all of them
 * `Exceeded timeout of 60000 ms for a hook`). Warming here — in the single main
 * process, before any worker exists — makes every `beforeAll` a set of disk
 * reads.
 *
 * See `compile-cache.ts` for the cache key (a hash of every `.tolk` source, every
 * `*.compile.ts` config and the Tolk version), which is what guarantees a test can
 * never run against stale bytecode.
 */
import { existsSync, mkdirSync, readdirSync, renameSync, writeFileSync } from 'fs';
import path from 'path';
import { cacheDir, sourceFingerprint } from './compile-cache';

/**
 * DERIVED, NOT LISTED. This used to be a hand-maintained array of eleven names
 * and it was already wrong before D-100 touched it: eight contracts with
 * `*.compile.ts` configs were missing, so every suite that needed one paid the
 * per-suite compile this file exists to eliminate. D-100 then added three more
 * (`PrimesTreasury`, `PrimesLpPosition`, `PrimesLpSink`), which is the second
 * time the same list went stale for the same reason.
 *
 * A blueprint contract IS its `wrappers/<Name>.compile.ts`, so reading the
 * directory is both the shorter code and the only version that cannot drift: a
 * new contract joins the warm set by existing. The cache key is unchanged — see
 * `compile-cache.ts`, which hashes every `.tolk` source and every `*.compile.ts`
 * — so a name appearing here can never serve stale bytecode.
 */
const CONTRACTS = readdirSync(path.join(__dirname, '..', '..', 'wrappers'))
    .filter((f) => f.endsWith('.compile.ts'))
    .map((f) => f.replace(/\.compile\.ts$/, ''))
    .sort();

export default async function warmCompileCache(): Promise<void> {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { compile } = require('@ton/blueprint');

    const dir = cacheDir();
    mkdirSync(dir, { recursive: true });

    const missing = CONTRACTS.filter((name) => !existsSync(path.join(dir, `${name}.boc`)));
    if (missing.length === 0) {
        return;
    }

    const started = Date.now();
    process.stdout.write(
        `[compile-cache] warming ${missing.length}/${CONTRACTS.length} contracts (fingerprint ${sourceFingerprint()})\n`,
    );
    for (const name of missing) {
        const code = await compile(name);
        const file = path.join(dir, `${name}.boc`);
        const tmp = `${file}.${process.pid}.tmp`;
        writeFileSync(tmp, code.toBoc());
        // rename over a possibly-existing file: fs.renameSync overwrites on both
        // POSIX and Windows, so this stays atomic for concurrent readers.
        renameSync(tmp, file);
    }
    process.stdout.write(`[compile-cache] warmed in ${((Date.now() - started) / 1000).toFixed(1)}s\n`);
}
