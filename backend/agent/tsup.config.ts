/**
 * The publish build (`AGENTS_PLAN.md` A5).
 *
 * `@ton-primes/shared` and `@ton-primes/common` are workspace packages and are not on npm,
 * so they are BUNDLED into the output rather than declared as dependencies — a consumer
 * installs `@ton-primes/agent` and gets the same message builders the app signs with, with
 * no second registry entry to keep in step. The GRAM libraries stay external: they are real
 * npm packages and a consumer's wallet code needs the same `@ton/core` instances this does.
 */
import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  dts: true,
  clean: true,
  sourcemap: true,
  target: "node20",
  external: ["@ton/core", "@ton/ton", "@ton/crypto"],
  noExternal: [/^@ton-primes\//],
});
