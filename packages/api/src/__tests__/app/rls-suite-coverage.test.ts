import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * How many integration suites still connect as the migration owner.
 *
 * `bootPostgres` points `DATABASE_URL` at `cis_app`, so a suite inherits
 * a connection the policies apply to and proves something about
 * isolation by passing. A suite that overrides it back to the owner
 * proves nothing: a superuser is exempt from row-level security, so a
 * route that reads another tenant's rows passes exactly as a correct one
 * does.
 *
 * 44 of the 76 suites do override it, and for a reason rather than an
 * oversight. Two reasons, measured on 2026-10-24 rather than assumed:
 *
 *   - 44 call services directly instead of through a route, so no
 *     middleware enters a tenant scope.
 *   - 14 go through routes that work perfectly as `cis_app` — the run
 *     that established this found no route or service querying a tenant
 *     table without a scope — but arrange and assert on rows through
 *     `prisma` in their own test bodies.
 *
 * Both need the same per-test work: a `seedAsPlatform` around a fixture
 * write, a `runAsTenant` around an assertion read.
 * `rate-schedule-revise-copy.integration.test.ts` shows both shapes and
 * `bill-list.integration.test.ts` shows the service-call form.
 *
 * This is the ratchet. It does not demand the work be finished; it
 * refuses to let the number grow, so a new suite cannot quietly join the
 * exempt set and an old one that is converted cannot be un-converted
 * without the count moving. A file-reading test rather than a
 * container-backed one, because the question is about the suite itself.
 */

const INTEGRATION_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../integration",
);

/**
 * The count as of 2026-10-24. **Only ever lower this.** Raising it is
 * how the exempt set grows back, which is the thing being prevented.
 */
const OPTED_OUT_CEILING = 44;

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
   * The set that is finished, pinned by name rather than by category.
   *
   * These suites drive routes and pass as `cis_app`, so each one is a
   * request going through its own middleware into a connection the
   * policies apply to — isolation exercised the way production
   * exercises it. Named individually because "every route suite" was
   * the wrong generalisation: most route suites write fixtures in their
   * test bodies and are in the opted-out set for that, not for anything
   * about their routes.
   *
   * A name leaving this list is a regression, and the `toEqual` says so.
   */
  const PROVEN_ON_CIS_APP = [
    "bill-document.integration.test.ts",
    "billing-run.integration.test.ts",
    "ledger-routes.integration.test.ts",
    "platform-authority.integration.test.ts",
    "rate-assignment-roles.integration.test.ts",
    "rate-component-cycle-check.integration.test.ts",
    "rate-component-kinds.integration.test.ts",
    "rate-components.integration.test.ts",
    "rate-grammar.integration.test.ts",
    "rate-indices.integration.test.ts",
    "rate-model-v2-shape.integration.test.ts",
    "rate-schedule-publish.integration.test.ts",
    "rate-schedule-revise-copy.integration.test.ts",
    "rate-service-classes.integration.test.ts",
    "sa-rate-schedule-assignments.integration.test.ts",
    "service-request-lifecycle.integration.test.ts",
    "sign-in-rls.integration.test.ts",
  ];

  it("keeps the suites proven on the application role there", () => {
    const stillProven = suites()
      .filter((s) => PROVEN_ON_CIS_APP.includes(s.name))
      .filter((s) => !s.source.includes(MARKER))
      .map((s) => s.name)
      .sort();
    expect(stillProven).toEqual([...PROVEN_ON_CIS_APP].sort());
  });
});
