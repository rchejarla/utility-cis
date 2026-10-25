#!/usr/bin/env node
/**
 * Make `cis_app` and `cis_platform` connectable in a real deployment.
 *
 * The `20261024140000_rls_roles` migration creates both roles NOLOGIN
 * with no password, on purpose: credentials are not a migration's
 * business, and a password committed to a migration is a password in
 * every clone of the repository forever. Development gets throwaway
 * logins from `scripts/grant-dev-db-logins.sql`. This is the production
 * counterpart, and it takes the passwords from deployment secrets by way
 * of the environment.
 *
 *   ADMIN_DATABASE_URL     a connection that may ALTER ROLE — the owner
 *                          (`cis`) or a superuser. Not `DATABASE_URL`,
 *                          which by this point names `cis_app` and
 *                          cannot alter anything.
 *   CIS_APP_PASSWORD       the application role's password
 *   CIS_PLATFORM_PASSWORD  the cross-tenant role's password
 *
 *   node packages/api/scripts/grant-db-logins.mjs
 *
 * Idempotent, so it is also how a password is rotated: run it again with
 * new secrets.
 *
 * **The cleartext never reaches the server.** `ALTER ROLE … PASSWORD
 * 'secret'` sends the password in a statement, which means it is visible
 * in `pg_stat_activity` while it runs and is written to the server log
 * whenever `log_statement` is `ddl` or `all` — a setting plenty of
 * production databases use for audit, which would put a database
 * credential in a log file. So this computes the SCRAM-SHA-256 verifier
 * locally and sends that instead: it is what the server would have
 * stored anyway, and it is useless to anyone reading it back out.
 *
 * It also refuses to run against a database whose roles are not shaped
 * the way the migration left them, because handing out credentials is
 * the wrong moment to discover that `cis_app` can bypass RLS.
 */
import { pbkdf2Sync, createHmac, createHash, randomBytes, timingSafeEqual } from "node:crypto";
import pg from "pg";

const ITERATIONS = 4096; // PostgreSQL 16's own default.
const MIN_LENGTH = 16;
const DEV_PASSWORD = "cis_dev_password";

/**
 * The verifier PostgreSQL stores for a SCRAM-SHA-256 password.
 *
 * Format and derivation are RFC 5802: a random salt, PBKDF2 to a salted
 * password, then two HMACs and a hash over fixed strings.
 */
function scramVerifier(password) {
  const salt = randomBytes(16);
  const salted = pbkdf2Sync(Buffer.from(password, "utf8"), salt, ITERATIONS, 32, "sha256");
  const clientKey = createHmac("sha256", salted).update("Client Key").digest();
  const storedKey = createHash("sha256").update(clientKey).digest();
  const serverKey = createHmac("sha256", salted).update("Server Key").digest();
  return (
    `SCRAM-SHA-256$${ITERATIONS}:${salt.toString("base64")}` +
    `$${storedKey.toString("base64")}:${serverKey.toString("base64")}`
  );
}

function fail(message) {
  console.error(`grant-db-logins: ${message}`);
  process.exit(1);
}

function readSecret(name) {
  const value = process.env[name];
  if (!value) fail(`${name} is not set. It is a deployment secret, not a default.`);
  /*
   * ASCII only, and this is a real constraint rather than caution.
   * PostgreSQL applies SASLprep to a password before deriving the
   * verifier. SASLprep is a no-op for printable ASCII, so a verifier
   * computed here matches; for anything else it is not, and the role
   * would be left with a password that cannot be used to log in. Better
   * to refuse than to hand back a credential that silently does not work.
   */
  if (!/^[\x21-\x7e]+$/.test(value)) {
    fail(`${name} must be printable ASCII with no spaces — see the SASLprep note in this script.`);
  }
  if (value.length < MIN_LENGTH) {
    fail(`${name} is shorter than ${MIN_LENGTH} characters.`);
  }
  if (value === DEV_PASSWORD) {
    fail(`${name} is the development password from scripts/grant-dev-db-logins.sql.`);
  }
  return value;
}

const adminUrl = process.env.ADMIN_DATABASE_URL;
if (!adminUrl) {
  fail(
    "ADMIN_DATABASE_URL is not set. It needs a connection that may ALTER ROLE — " +
      "the owner or a superuser — and is deliberately not DATABASE_URL, which names cis_app.",
  );
}

const secrets = {
  cis_app: readSecret("CIS_APP_PASSWORD"),
  cis_platform: readSecret("CIS_PLATFORM_PASSWORD"),
};

if (
  Buffer.byteLength(secrets.cis_app) === Buffer.byteLength(secrets.cis_platform) &&
  timingSafeEqual(Buffer.from(secrets.cis_app), Buffer.from(secrets.cis_platform))
) {
  fail(
    "CIS_APP_PASSWORD and CIS_PLATFORM_PASSWORD are the same. The whole point of two roles " +
      "is that holding one is not holding the other.",
  );
}

const pool = new pg.Pool({ connectionString: adminUrl });
try {
  const { rows } = await pool.query(
    `SELECT rolname, rolcanlogin, rolsuper, rolbypassrls
       FROM pg_roles WHERE rolname = ANY($1)`,
    [["cis_app", "cis_platform"]],
  );
  const byName = new Map(rows.map((r) => [r.rolname, r]));

  for (const role of ["cis_app", "cis_platform"]) {
    if (!byName.has(role)) {
      fail(`role ${role} does not exist — apply the migrations first.`);
    }
  }

  /*
   * The shape the migration left, re-checked before credentials are
   * handed out. `assertRlsEnforced` refuses to *start* the application
   * on a bypassing role, which catches this later; catching it here says
   * so while someone is still looking at a terminal.
   */
  const app = byName.get("cis_app");
  if (app.rolsuper || app.rolbypassrls) {
    fail(
      "cis_app holds SUPERUSER or BYPASSRLS. Every row-level security policy is advisory for " +
        "it, so granting it a login would hand out a credential that cannot isolate tenants.",
    );
  }
  if (!byName.get("cis_platform").rolbypassrls) {
    fail(
      "cis_platform does not hold BYPASSRLS. The platform console and the all-tenants queue " +
        "sweeps would read nothing and report success.",
    );
  }

  /*
   * Neither role may assume the other. A member of `cis_platform` can
   * `SET ROLE` to it and inherit the bypass, which would make the split
   * decorative.
   */
  const { rows: memberships } = await pool.query(
    `SELECT m.rolname AS member, g.rolname AS granted
       FROM pg_auth_members am
       JOIN pg_roles m ON m.oid = am.member
       JOIN pg_roles g ON g.oid = am.roleid
      WHERE m.rolname = ANY($1) AND g.rolname = ANY($1)`,
    [["cis_app", "cis_platform"]],
  );
  if (memberships.length > 0) {
    const pairs = memberships.map((r) => `${r.member} -> ${r.granted}`).join(", ");
    fail(`one role is a member of the other (${pairs}); it could SET ROLE and inherit the bypass.`);
  }

  for (const role of ["cis_app", "cis_platform"]) {
    // The verifier is an opaque literal, so a parameter is not accepted
    // here — ALTER ROLE takes no parameters. The role names are from the
    // fixed list above and the verifier is base64 and `$`, both of which
    // this builds rather than reads from input.
    await pool.query(`ALTER ROLE ${role} LOGIN PASSWORD '${scramVerifier(secrets[role])}'`);
    console.log(`grant-db-logins: ${role} can now log in (SCRAM-SHA-256 verifier set).`);
  }

  console.log(
    "grant-db-logins: done. Point DATABASE_URL at cis_app and DATABASE_URL_PLATFORM at " +
      "cis_platform; the application refuses to start in production if either is wrong.",
  );
} finally {
  await pool.end().catch(() => {});
}
