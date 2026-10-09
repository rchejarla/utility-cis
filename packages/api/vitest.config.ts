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
