import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["src/**/*.test.ts"],
    // Integration tests run under vitest.integration.config.ts with
    // testcontainers — exclude them from the unit suite so `pnpm test`
    // doesn't try to spin up Docker on every dev run. Two naming
    // conventions are excluded:
    //   - `worker-*.test.ts` — BullMQ worker integrations (legacy)
    //   - `*.integration.test.ts` — newer convention; everything that
    //     wants a real Postgres lives here.
    exclude: [
      "src/__tests__/integration/worker-*.test.ts",
      "src/__tests__/integration/*.integration.test.ts",
      "**/node_modules/**",
    ],
    setupFiles: ["src/__tests__/vitest.setup.ts"],
    /*
     * Both raised from the 5s/10s defaults, because what these hooks do
     * is load modules, not wait on anything.
     *
     * `schedulers.test.ts` is the one that proved it: its `beforeEach`
     * does `await import("../../lib/schedulers.js")`, which pulls in the
     * six worker modules and the service layer behind them. That import
     * was already within a hair of 10 seconds on a machine running a dev
     * stack, so adding one small module to an unrelated service — a
     * shared pagination helper — tipped it over and failed a test that
     * has nothing to do with pagination. Several route suites build a
     * Fastify app per test and sit close to the 5s test default for the
     * same reason.
     *
     * A genuine hang is still caught: nothing here legitimately takes
     * thirty seconds. The weight itself is the real problem — CLAUDE.md
     * records why `lib/schedulers.ts` drags the worker layer in — and a
     * stopwatch measuring the machine's spare capacity is the wrong
     * place to find out.
     */
    testTimeout: 20_000,
    hookTimeout: 30_000,
    // Tell Vitest to look for modules in the monorepo root node_modules as well
    // This is needed for pnpm workspaces where hoisted deps live in the root
    server: {
      deps: {
        // Inline all packages to bypass Vite's ESM resolution issues with
        // pnpm symlinks — except vitest itself and ioredis.
        //
        // ioredis has to be excluded here, in the pattern, rather than
        // via `deps.external`: external does not override a matching
        // inline pattern, so listing it there changed nothing. Inlining
        // it runs Vite's ESM transform over a
        // CJS module that does `exports = module.exports = require(...)`
        // and then redefines `default` on it, which throws
        // "TypeError: Cannot redefine property: default" at import time.
        // That took out 12 test FILES before they collected a single
        // test — auth, authorization, routes, validation, health,
        // tenant-config, automation-config, service-requests,
        // attachments and all three contract suites — so the API job in
        // ci.yml exited 1 while reporting every test it did run as
        // passing. Externalizing lets Node's own CJS resolution load it,
        // which is exactly what vitest.integration.config.ts already
        // relies on and documents.
        inline: [/^(?!.*(?:vitest|ioredis)).*$/],
      },
    },
  },
});
