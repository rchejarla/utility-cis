import { defineConfig } from "vitest/config";

/**
 * Vitest config for testcontainers-backed integration tests.
 *
 * Distinct from the unit test config in three ways:
 *   - No global mocks setup file. Integration tests use real Prisma +
 *     real Redis (in containers).
 *   - Longer timeouts. Container start + migration apply takes 20-40s
 *     on a cold cache; each test asserts against a real DB.
 *   - Different include glob — only `__tests__/integration/**`.
 *
 * Exclude unit-test setup explicitly because vitest will otherwise
 * pick up any `vitest.setup.ts` adjacent to the test file. We do NOT
 * mock prisma here.
 */
export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    // Testcontainers-backed integration tests. The other
    // src/__tests__/integration/*.test.ts files are in-memory suites
    // that depend on the unit-test setup file's prisma mocks; they're
    // excluded here so we don't spin up containers for them. Globs
    // match the testcontainers files by naming convention:
    //   - worker-*.test.ts — BullMQ worker integrations
    //   - audit-wrap.integration.test.ts — atomicity verification
    include: [
      "src/__tests__/integration/worker-*.test.ts",
      "src/__tests__/integration/*.integration.test.ts",
    ],
    // No setupFiles — integration tests handle their own container
    // lifecycle via beforeAll/afterAll.
    testTimeout: 60_000,
    hookTimeout: 120_000,
    // Run integration suites serially. Each one boots its own
    // containers; running in parallel would multiply startup cost
    // for no real benefit at our current size.
    pool: "forks",
    poolOptions: { forks: { singleFork: true } },
    // Do NOT use the unit-test config's blanket `server.deps.inline`
    // here. Inlining ioredis (and other CJS modules with `default`
    // exports) collides with Vite's ESM transform — the resulting
    // "Cannot redefine property: default" is misleading. Vanilla
    // Node CJS resolution works fine for integration code.
  },
});
