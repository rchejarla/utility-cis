import { describe, it, expect, vi } from "vitest";
import { resetDb } from "./_effective-dating-fixtures.js";

/**
 * Unit coverage for `resetDb`'s lock handling. No container — a stub
 * client stands in for Prisma so this runs in the unit suite (and so in
 * CI, which does not run the testcontainers integration config).
 *
 * What's being guarded: a blocked TRUNCATE used to wait forever, because
 * Postgres has no default lock_timeout. That turned a transient lock on
 * the `meter_read` hypertable into a bare "Hook timed out in 120000ms"
 * with no mention of a lock. If the retry or the SET LOCAL ever gets
 * refactored away, these fail instead of the suite going flaky again.
 */

const LOCK_ERR = new Error(
  'ERROR: canceling statement due to lock timeout\n   0: sql_schema_connector::... (55P03)',
);

/**
 * Stub client whose TRUNCATE fails for the first `failures` attempts.
 * Records the SQL each attempt issued so the test can assert that the
 * lock_timeout is set on the same session as the TRUNCATE.
 */
function stubClient(failures: number) {
  const statements: string[][] = [];
  let attempt = 0;
  return {
    statements,
    get attempts() {
      return attempt;
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async $transaction(fn: (tx: any) => Promise<unknown>) {
      attempt += 1;
      const issued: string[] = [];
      statements.push(issued);
      const mine = attempt;
      return fn({
        async $executeRawUnsafe(sql: string) {
          issued.push(sql);
          if (sql.includes("TRUNCATE") && mine <= failures) throw LOCK_ERR;
          return 0;
        },
      });
    },
    async $queryRawUnsafe() {
      return [{ pid: 123, state: "idle in transaction", query: "LOCK TABLE premise" }];
    },
  };
}

describe("resetDb lock handling", () => {
  it("sets lock_timeout on the same session as the TRUNCATE", async () => {
    const client = stubClient(0);
    await resetDb(client);

    expect(client.statements).toHaveLength(1);
    const [first, second] = client.statements[0];
    expect(first).toMatch(/SET LOCAL lock_timeout = \d+/);
    expect(second).toMatch(/^TRUNCATE TABLE /);
  });

  it("retries a lock timeout and succeeds when the holder lets go", async () => {
    vi.useFakeTimers();
    try {
      const client = stubClient(2);
      const done = resetDb(client);
      await vi.runAllTimersAsync();
      await done;
      expect(client.attempts).toBe(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("gives up after three attempts and names the blocking sessions", async () => {
    vi.useFakeTimers();
    try {
      const client = stubClient(Number.POSITIVE_INFINITY);
      const failed = resetDb(client).catch((err: unknown) => err);
      await vi.runAllTimersAsync();
      const err = await failed;

      expect(client.attempts).toBe(3);
      expect(String(err)).toMatch(/still blocked after 3 attempts/);
      expect(String(err)).toMatch(/idle in transaction/);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not retry an error that is not a lock timeout", async () => {
    const boom = new Error("relation does not exist");
    const client = {
      attempts: 0,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      async $transaction(fn: (tx: any) => Promise<unknown>) {
        this.attempts += 1;
        return fn({
          async $executeRawUnsafe(sql: string) {
            if (sql.includes("TRUNCATE")) throw boom;
            return 0;
          },
        });
      },
    };

    await expect(resetDb(client)).rejects.toThrow("relation does not exist");
    expect(client.attempts).toBe(1);
  });
});
