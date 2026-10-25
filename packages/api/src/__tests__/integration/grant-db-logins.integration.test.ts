import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { bootPostgres, TENANT_A } from "./_effective-dating-fixtures.js";

/**
 * The production step that makes `cis_app` and `cis_platform`
 * connectable.
 *
 * The migration leaves both roles NOLOGIN with no password on purpose,
 * so some step has to grant credentials from deployment secrets. These
 * cases are about that step being trustworthy: that the credential it
 * sets actually works, that the cleartext never reaches the server, and
 * that it refuses a database whose roles are not shaped the way the
 * migration left them.
 *
 * The last of those is the reason this is an integration test rather
 * than a unit one. Every refusal it makes is a question about catalog
 * state, and a mocked catalog would only prove the script can read a
 * mock.
 */

const SCRIPT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../scripts/grant-db-logins.mjs",
);

const APP_PW = "an-application-password-1";
const PLATFORM_PW = "a-different-platform-password-2";

let pgContainer: StartedPostgreSqlContainer;
let adminUrl: string;

/** Run the script, returning its exit status and output together. */
function run(env: Record<string, string | undefined>): { ok: boolean; out: string } {
  try {
    const out = execFileSync(process.execPath, [SCRIPT], {
      env: { ...process.env, ...env },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { ok: true, out };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string };
    return { ok: false, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
}

const asRole = (role: string, pw: string) =>
  adminUrl.replace(/\/\/[^@]+@/, `//${role}:${encodeURIComponent(pw)}@`);

beforeAll(async () => {
  const booted = await bootPostgres({ utilities: [TENANT_A] });
  pgContainer = booted.container;
  adminUrl = booted.dbUrl;
}, 240_000);

afterAll(async () => {
  await pgContainer?.stop().catch(() => {});
});

describe("granting the deployment's database logins", () => {
  it("sets a credential each role can actually connect with", async () => {
    const result = run({
      ADMIN_DATABASE_URL: adminUrl,
      CIS_APP_PASSWORD: APP_PW,
      CIS_PLATFORM_PASSWORD: PLATFORM_PW,
    });
    expect(result.out).toContain("cis_app can now log in");
    expect(result.ok).toBe(true);

    /*
     * The point of the whole script. A verifier computed locally is only
     * correct if the server accepts the matching cleartext at login —
     * get the derivation wrong and the role ends up with a password
     * nobody can use, which no amount of reading the script would show.
     */
    for (const [role, pw] of [
      ["cis_app", APP_PW],
      ["cis_platform", PLATFORM_PW],
    ] as const) {
      const client = new pg.Client({ connectionString: asRole(role, pw) });
      await client.connect();
      try {
        const { rows } = await client.query("SELECT current_user AS who");
        expect(rows[0].who).toBe(role);
      } finally {
        await client.end();
      }
    }
  });

  /*
   * The reason it sends a verifier rather than the password: a statement
   * carrying cleartext is visible in `pg_stat_activity` and lands in the
   * server log under `log_statement = ddl`. Asserted by reading back
   * what the server stored — a verifier, never the secret.
   */
  it("never sends the cleartext, only the verifier", async () => {
    const admin = new pg.Client({ connectionString: adminUrl });
    await admin.connect();
    try {
      const { rows } = await admin.query(
        `SELECT rolname, rolpassword::text AS stored
           FROM pg_authid WHERE rolname = ANY($1)`,
        [["cis_app", "cis_platform"]],
      );
      expect(rows).toHaveLength(2);
      for (const row of rows) {
        expect(row.stored).toMatch(/^SCRAM-SHA-256\$4096:/);
        expect(row.stored).not.toContain(APP_PW);
        expect(row.stored).not.toContain(PLATFORM_PW);
      }
    } finally {
      await admin.end();
    }
  });

  it("refuses one password used for both roles", () => {
    const result = run({
      ADMIN_DATABASE_URL: adminUrl,
      CIS_APP_PASSWORD: APP_PW,
      CIS_PLATFORM_PASSWORD: APP_PW,
    });
    expect(result.ok).toBe(false);
    expect(result.out).toMatch(/same/i);
  });

  it("refuses the development password", () => {
    const result = run({
      ADMIN_DATABASE_URL: adminUrl,
      CIS_APP_PASSWORD: "cis_dev_password",
      CIS_PLATFORM_PASSWORD: PLATFORM_PW,
    });
    expect(result.ok).toBe(false);
    expect(result.out).toMatch(/development password/i);
  });

  /*
   * Handing out a credential is the wrong moment to discover that the
   * role it belongs to cannot isolate anything. `assertRlsEnforced`
   * catches this at startup; catching it here says so while someone is
   * still watching a terminal.
   */
  it("refuses to grant a login to an application role that bypasses RLS", async () => {
    const admin = new pg.Client({ connectionString: adminUrl });
    await admin.connect();
    try {
      await admin.query("ALTER ROLE cis_app BYPASSRLS");
      const result = run({
        ADMIN_DATABASE_URL: adminUrl,
        CIS_APP_PASSWORD: APP_PW,
        CIS_PLATFORM_PASSWORD: PLATFORM_PW,
      });
      expect(result.ok).toBe(false);
      expect(result.out).toMatch(/BYPASSRLS/);
    } finally {
      await admin.query("ALTER ROLE cis_app NOBYPASSRLS").catch(() => {});
      await admin.end();
    }
  });

  /*
   * And the subtler one: a role that is a *member* of `cis_platform` can
   * `SET ROLE` to it and inherit the bypass, which would make the split
   * decorative while every attribute on `cis_app` still looked correct.
   */
  it("refuses when one role can assume the other", async () => {
    const admin = new pg.Client({ connectionString: adminUrl });
    await admin.connect();
    try {
      await admin.query("GRANT cis_platform TO cis_app");
      const result = run({
        ADMIN_DATABASE_URL: adminUrl,
        CIS_APP_PASSWORD: APP_PW,
        CIS_PLATFORM_PASSWORD: PLATFORM_PW,
      });
      expect(result.ok).toBe(false);
      expect(result.out).toMatch(/member of the other/);
    } finally {
      await admin.query("REVOKE cis_platform FROM cis_app").catch(() => {});
      await admin.end();
    }
  });
});
