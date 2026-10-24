import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Whether any integration suite still connects as the migration owner.
 *
 * `bootPostgres` points `DATABASE_URL` at `cis_app`, so a suite inherits
 * a connection the policies apply to and proves something about
 * isolation by passing. A suite that overrides it back to the owner
 * proves nothing: a superuser is exempt from row-level security, so a
 * route reading another tenant's rows passes exactly as a correct one
 * does.
 *
 * **As of 2026-10-24 none of the 76 do.** This started as a ratchet over
 * 58 exempt suites and ended at zero, so what it guards now is the
 * absence: a new suite cannot quietly opt out, and a converted one
 * cannot be un-converted, without a line here moving.
 *
 * What this does NOT claim is that every suite passes — it reads the
 * files, not a test run. It says each one is pointed at a role the
 * policies bind to, which is the precondition for its result to mean
 * anything.
 */

const INTEGRATION_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../integration",
);

/**
 * **Zero, and only ever zero.** Raising it is how the exempt set grows
 * back, which is the thing being prevented. A suite that genuinely needs
 * the owner connection — `rls-enforcement`, which reaches each role by
 * `SET LOCAL ROLE` and so must be able to assume one — belongs in
 * `DRIVES_ROLES_DELIBERATELY` below, where it is named and explained,
 * not here as a number.
 */
const OPTED_OUT_CEILING = 0;

const MARKER = "RLS-OPT-OUT";

function suites(): { name: string; source: string }[] {
  return readdirSync(INTEGRATION_DIR)
    .filter((f) => f.endsWith(".integration.test.ts"))
    .map((name) => ({
      name,
      source: readFileSync(path.join(INTEGRATION_DIR, name), "utf8"),
    }));
}

/** A suite that points `DATABASE_URL` at anything after booting. */
function overridesConnection(source: string): boolean {
  return /process\.env\.DATABASE_URL\s*=/.test(source);
}

describe("which integration suites run as a role RLS applies to", () => {
  it("never grows the set that connects as the owner", () => {
    const optedOut = suites().filter((s) => s.source.includes(MARKER));
    expect(optedOut.length).toBeLessThanOrEqual(OPTED_OUT_CEILING);
  });

  /*
   * The marker is what makes the override visible. An override without
   * one is the failure this catches: a suite that quietly connects as
   * the owner looks, from the outside, exactly like one that proves
   * isolation.
   *
   * The six suites that drive the roles deliberately are allowed — they
   * set `DATABASE_URL` to exercise a role on purpose, which is the
   * opposite of opting out, and each says so where it does it.
   */
  const DRIVES_ROLES_DELIBERATELY = new Set([
    "tenant-context.integration.test.ts",
    "rls-enforcement.integration.test.ts",
    "rls-boot-guard.integration.test.ts",
    "worker-tenancy-rls.integration.test.ts",
    "bill-document.integration.test.ts",
    "billing-run.integration.test.ts",
    "ledger-adjustment.integration.test.ts",
    "ledger-allocation.integration.test.ts",
    "ledger-autopost.integration.test.ts",
    "ledger-fee.integration.test.ts",
    "ledger-list.integration.test.ts",
    "ledger-payment.integration.test.ts",
    "ledger-posting.integration.test.ts",
    "ledger-reason.integration.test.ts",
    "ledger-reconciliation.integration.test.ts",
    "ledger-reversal.integration.test.ts",
    "ledger-routes.integration.test.ts",
    "ledger-shape.integration.test.ts",
    "platform-authority.integration.test.ts",
    "sign-in-rls.integration.test.ts",
  ]);

  it("lets no suite override the connection without saying so", () => {
    const silent = suites()
      .filter((s) => !DRIVES_ROLES_DELIBERATELY.has(s.name))
      .filter((s) => overridesConnection(s.source) && !s.source.includes(MARKER))
      .map((s) => s.name);
    expect(silent).toEqual([]);
  });

  /*
   * The six that set `DATABASE_URL` on purpose are allowed, and each
   * says so where it does it. `rls-enforcement` connects as the owner
   * because only a superuser may assume a role it is not a member of —
   * `cis_app` cannot become `cis_platform`, which is the confinement
   * being tested. The other five point the connection at a specific role
   * to exercise it, which is the opposite of opting out.
   */
  it("lets only the declared role-drivers name a role", () => {
    // A subset rather than an equality: `rls-boot-guard` is in the
    // declared set but assigns the environment through `Object.assign`
    // in its own helper, so it does not match the direct-assignment
    // check. The invariant that matters is that nothing outside the
    // declared set touches the connection at all.
    const outsiders = suites()
      .filter((s) => overridesConnection(s.source))
      .filter((s) => !DRIVES_ROLES_DELIBERATELY.has(s.name))
      .map((s) => s.name);
    expect(outsiders).toEqual([]);
  });
});
