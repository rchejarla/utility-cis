import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import {
  bootPostgres,
  seedAsPlatform,
  TENANT_A,
  TENANT_B,
} from "./_effective-dating-fixtures.js";
import { runAsTenant } from "../../lib/tenant-context.js";

/**
 * Whether a row in one tenant can point at a row in another.
 *
 * Row-level security cannot answer this, and not by oversight: its
 * policies filter which rows a query *reads*, and a foreign key is not a
 * read. PostgreSQL's referential-integrity checks run as the table owner
 * and are exempt from RLS, so `service_agreement.account_id ->
 * account(id)` is satisfied by an account the acting tenant cannot see.
 *
 * Nothing in this product wants a cross-tenant relationship. The two
 * rows of every one of these 64 foreign keys are meant to belong to the
 * same tenant, and until now nothing said so — the key named the id and
 * not the tenant. Four things could write a mismatched pair: a route
 * taking an id from a request body (`POST /notifications/send` did
 * exactly that), an ordinary bug passing the wrong id between services,
 * anything running on `cis_platform`, which bypasses RLS by design, and
 * a seed or script run as the owner.
 *
 * The damage is quiet rather than loud. The child carries its own
 * tenant, so that tenant's reads show it normally and the joined parent
 * simply comes back empty — the data looks broken, not leaked. It
 * becomes a leak on any platform-authority read that joins the two,
 * because `cis_platform` sees both sides.
 *
 * The fix is to put `utility_id` in the key, so the database checks both
 * columns together. These cases are what say it works.
 */

let pgContainer: StartedPostgreSqlContainer;
let prismaImports: typeof import("../../lib/prisma.js");

const ids = {
  cycleA: "",
  accountA: "",
  accountB: "",
  commodityA: "",
  commodityB: "",
};

beforeAll(async () => {
  const booted = await bootPostgres({ utilities: [TENANT_A, TENANT_B] });
  pgContainer = booted.container;
  prismaImports = await import("../../lib/prisma.js");

  await seedAsPlatform(async () => {
    const { prisma } = prismaImports;
    for (const [tenant, key] of [[TENANT_A, "A"], [TENANT_B, "B"]] as const) {
      const cycle = await prisma.billingCycle.create({
        data: {
          utilityId: tenant,
          name: `Cycle ${key}`,
          cycleCode: `C-${key}`,
          readDayOfMonth: 1,
          billDayOfMonth: 15,
          frequency: "MONTHLY",
        },
      });
      const account = await prisma.account.create({
        data: {
          utilityId: tenant,
          accountNumber: `XT-${key}-001`,
          accountType: "RESIDENTIAL",
          status: "ACTIVE",
          billingCycleId: cycle.id,
        },
      });
      const commodity = await prisma.commodity.create({
        data: { utilityId: tenant, code: `WATER-${key}`, name: "Water" },
      });
      if (key === "A") {
        ids.cycleA = cycle.id;
        ids.accountA = account.id;
        ids.commodityA = commodity.id;
      } else {
        ids.accountB = account.id;
        ids.commodityB = commodity.id;
      }
    }
  });
}, 240_000);

afterAll(async () => {
  await prismaImports?.prisma.$disconnect().catch(() => {});
  await prismaImports?.pool.end().catch(() => {});
  await pgContainer?.stop().catch(() => {});
});

describe("a foreign key between two tenant-scoped tables", () => {
  /*
   * The control. Tenant A's own account is a legitimate parent, and this
   * must keep working — a composite key that refused it would have
   * broken every write in the product rather than fixed anything.
   */
  it("accepts a parent in the acting tenant", async () => {
    const { prisma } = prismaImports;
    const sa = await runAsTenant(TENANT_A, async () =>
      prisma.serviceAgreement.create({
        data: {
          utilityId: TENANT_A,
          agreementNumber: "XT-SAME-TENANT",
          accountId: ids.accountA,
          commodityId: ids.commodityA,
          startDate: new Date("2026-01-01"),
        },
      }),
    );
    expect(sa.accountId).toBe(ids.accountA);
  });

  /*
   * The defect. Tenant A writes an agreement whose account belongs to
   * tenant B — an account A cannot read. The row carries
   * `utility_id = A`, so the policy's WITH CHECK is satisfied; only the
   * foreign key is in a position to refuse it, and a single-column key
   * has no opinion about the tenant.
   */
  it("refuses a parent in another tenant", async () => {
    const { prisma } = prismaImports;
    await expect(
      runAsTenant(TENANT_A, async () =>
        prisma.serviceAgreement.create({
          data: {
            utilityId: TENANT_A,
            agreementNumber: "XT-OTHER-TENANT",
            accountId: ids.accountB,
            commodityId: ids.commodityA,
            startDate: new Date("2026-01-01"),
          },
        }),
      ),
    ).rejects.toThrow(/foreign key/i);
  });

  /*
   * And on the authority that bypasses RLS, which is where this matters
   * most: `cis_platform` can see both tenants' rows, so nothing above
   * the database stops it pairing them. A key that carries the tenant
   * refuses it regardless of who is asking, which is the whole reason
   * for preferring a constraint over a predicate.
   */
  it("refuses a cross-tenant pair even under platform authority", async () => {
    const { prisma } = prismaImports;
    await expect(
      seedAsPlatform(async () =>
        prisma.serviceAgreement.create({
          data: {
            utilityId: TENANT_A,
            agreementNumber: "XT-PLATFORM",
            accountId: ids.accountB,
            commodityId: ids.commodityA,
            startDate: new Date("2026-01-01"),
          },
        }),
      ),
    ).rejects.toThrow(/foreign key/i);
  });
});
