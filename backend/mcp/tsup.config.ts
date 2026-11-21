/**
 * The publish build (`AGENTS_PLAN.md` A5).
 *
 * This package is a bin, not a library, so there are no declarations to emit. Everything
 * it imports is a real npm package — `@ton-primes/agent` included — so nothing is bundled
 * in; `npx -y @ton-primes/mcp` installs the SDK alongside it and both resolve the same
 * `@ton/core`.
 */
import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  clean: true,
  sourcemap: true,
  target: "node20", // tsup carries the entry's own shebang through; no banner needed.
});
