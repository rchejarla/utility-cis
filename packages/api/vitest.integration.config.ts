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
    // Run integration suites one at a time, each in its own fork.
    //
    // `fileParallelism: false` keeps them serial: every file boots its
    // own containers, and running them in parallel would multiply that
    // startup cost for no real benefit at our current size. What it
    // deliberately does NOT do is put all 58 files in one process, which
    // `singleFork: true` used to.
    //
    // That sharing cost an evening of misattributed errors.
    // worker-suspension.test.ts sets `process.env.REDIS_URL` to its Redis
    // container's mapped port and never restores it, and afterAll stops
    // the container. Four files later bill-creation built the first Redis
    // client of the run, read that dead address, and ioredis retried it
    // forever — one client logging 861 "Unhandled error event" lines
    // across the remaining 51 files, each attributed to whichever file
    // happened to be running. Reproduce the old behaviour by running
    // worker-suspension followed by bill-creation under `singleFork`.
    //
    // A fork per file means leaked env vars and leaked handles die with
    // the file that created them, so a failure belongs to the file it is
    // reported against.
    pool: "forks",
    fileParallelism: false,
    poolOptions: { forks: { isolate: true } },
    // Do NOT use the unit-test config's blanket `server.deps.inline`
    // here. Inlining ioredis (and other CJS modules with `default`
    // exports) collides with Vite's ESM transform — the resulting
    // "Cannot redefine property: default" is misleading. Vanilla
    // Node CJS resolution works fine for integration code.
  },
});
