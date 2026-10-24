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
 * Pool whose TRUNCATE fails for the first `failures` attempts.
 *
 * Records the SQL each attempt issued, so a test can assert the
 * lock_timeout lands on the same session as the TRUNCATE. It is a pool
 * rather than a Prisma client because `resetDb` now runs these
 * statements on the owner connection — `cis_app`, which the application
 * connects as, is granted DML and has no TRUNCATE privilege.
 */
function stubPool(failures: number) {
  const statements: string[][] = [];
  let attempt = 0;
  return {
    statements,
    get attempts() {
      return attempt;
    },
    async connect() {
      attempt += 1;
      const issued: string[] = [];
      statements.push(issued);
      const mine = attempt;
      return {
        async query(sql: string) {
          // BEGIN/COMMIT/ROLLBACK are the transaction, not the work.
          if (!/^(BEGIN|COMMIT|ROLLBACK)$/.test(sql.trim())) issued.push(sql);
          if (sql.includes("TRUNCATE") && mine <= failures) throw LOCK_ERR;
          if (sql.includes("pg_stat_activity")) {
            return {
              rows: [
                { pid: 123, state: "idle in transaction", query: "LOCK TABLE premise" },
              ],
            };
          }
          return { rows: [] };
        },
        release() {},
      };
    },
  };
}

describe("resetDb lock handling", () => {
  it("sets lock_timeout on the same session as the TRUNCATE", async () => {
    const pool = stubPool(0);
    await resetDb(pool);

    expect(pool.statements).toHaveLength(1);
    const [first, second] = pool.statements[0];
    expect(first).toMatch(/SET LOCAL lock_timeout = \d+/);
    expect(second).toMatch(/^TRUNCATE TABLE /);
  });

  it("retries a lock timeout and succeeds when the holder lets go", async () => {
    vi.useFakeTimers();
    try {
      const pool = stubPool(2);
      const done = resetDb(pool);
      await vi.runAllTimersAsync();
      await done;
      expect(pool.attempts).toBe(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("gives up after three attempts and names the blocking sessions", async () => {
    vi.useFakeTimers();
    try {
      const pool = stubPool(Number.POSITIVE_INFINITY);
      const failed = resetDb(pool).catch((err: unknown) => err);
      await vi.runAllTimersAsync();
      const err = await failed;

      // Three TRUNCATE attempts plus the connection that reads
      // pg_stat_activity to name the holder.
      expect(pool.attempts).toBe(4);
      expect(String(err)).toMatch(/still blocked after 3 attempts/);
      expect(String(err)).toMatch(/idle in transaction/);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not retry an error that is not a lock timeout", async () => {
    const boom = new Error("relation does not exist");
    const pool = {
      attempts: 0,
      async connect() {
        this.attempts += 1;
        return {
          async query(sql: string) {
            if (sql.includes("TRUNCATE")) throw boom;
            return { rows: [] };
          },
          release() {},
        };
      },
    };

    await expect(resetDb(pool)).rejects.toThrow("relation does not exist");
    expect(pool.attempts).toBe(1);
  });
});
