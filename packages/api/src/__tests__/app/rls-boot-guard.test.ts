import { describe, it, expect } from "vitest";
import { rlsComplaints, type RlsPosture } from "../../lib/rls-guard.js";

/**
 * Why this database connection does not enforce tenant isolation.
 *
 * Task 9 of `docs/superpowers/plans/2026-10-24-rls-enforcement.md`. The
 * whole plan is undone by one `ALTER ROLE ... SUPERUSER` in a deployment
 * script, and the failure is silent: policies stay in place, queries keep
 * returning rows, and every row of every tenant is one of them. This is
 * the check that turns that into a startup failure.
 *
 * The decision is separated from the query because the query needs a
 * database and the decision needs to be read. `assertRlsEnforced` in
 * `lib/prisma.ts` gathers the posture and acts on this verdict;
 * `rls-enforcement.integration.test.ts` runs the pair against the real
 * roles.
 */

const enforced: RlsPosture = {
  currentUser: "cis_app",
  bypasses: false,
  unforcedPoliciedTables: [],
  platformUrlSet: true,
};

describe("the reasons isolation is not enforced", () => {
  it("finds none when the application connects as a confined role", () => {
    expect(rlsComplaints(enforced)).toEqual([]);
  });

  /*
   * The one the plan exists to prevent. `rolsuper` and `rolbypassrls`
   * are not distinguished here: either one makes every policy on every
   * table advisory, which is the same outcome from the same cause.
   */
  it("names the role when it bypasses every policy", () => {
    const found = rlsComplaints({ ...enforced, currentUser: "cis", bypasses: true });
    expect(found).toHaveLength(1);
    expect(found[0]).toMatch(/cis/);
    expect(found[0]).toMatch(/bypass/i);
  });

  /*
   * The second bypass, and the one easier to reintroduce: a table's
   * owner is exempt from its own policies unless the table FORCEs them.
   * A new table created by a migration and given a policy is in exactly
   * this state until someone remembers the FORCE.
   */
  it("names the tables whose policies their owner can ignore", () => {
    const found = rlsComplaints({
      ...enforced,
      unforcedPoliciedTables: ["account", "bill"],
    });
    expect(found).toHaveLength(1);
    expect(found[0]).toMatch(/account/);
    expect(found[0]).toMatch(/bill/);
  });

  /*
   * Not a bypass — the opposite. With the application confined and no
   * platform URL, the platform pool falls back to the confined role and
   * every cross-tenant read returns nothing while raising no error. The
   * console shows a working page with no tenants on it, which is why
   * this is worth refusing to start over rather than discovering later.
   */
  it("reports a confined role with no platform connection as its own fault", () => {
    const found = rlsComplaints({ ...enforced, platformUrlSet: false });
    expect(found).toHaveLength(1);
    expect(found[0]).toMatch(/DATABASE_URL_PLATFORM/);
  });

  /*
   * And the pairing that is fine: an unset platform URL is correct when
   * the application role is exempt anyway, because the fallback is then
   * a role that can already cross tenants. That deployment has one
   * complaint — the bypass — not two.
   */
  it("does not also complain about the platform connection when the role bypasses", () => {
    const found = rlsComplaints({
      currentUser: "cis",
      bypasses: true,
      unforcedPoliciedTables: [],
      platformUrlSet: false,
    });
    expect(found).toHaveLength(1);
    expect(found[0]).toMatch(/bypass/i);
  });

  it("reports every independent reason at once", () => {
    const found = rlsComplaints({
      currentUser: "cis_app",
      bypasses: false,
      unforcedPoliciedTables: ["account"],
      platformUrlSet: false,
    });
    expect(found).toHaveLength(2);
  });
});
