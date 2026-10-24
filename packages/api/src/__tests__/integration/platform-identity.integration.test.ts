import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { bootPostgres, seedAsPlatform } from "./_effective-dating-fixtures.js";

/**
 * A user that belongs to no tenant.
 *
 * Q2 of the tenancy design note, answered 2026-10-18: the platform
 * actor's identity is a `CisUser` with a null `utility_id` — "not a
 * tenant's user" is exactly what a platform actor is, and it needs no
 * second user model. apptorID is the destination for every identity,
 * which is a larger decision than this actor should force on its own.
 *
 * Against a real database because what is being tested is constraints.
 * The interesting half is not that a null row is admitted but that it is
 * still constrained: Postgres treats nulls as distinct, so
 * `@@unique([utilityId, email])` stops constraining the moment
 * `utility_id` is NULL, and two platform actors could otherwise share an
 * address. The partial unique indexes are the only thing refusing that.
 */

let pgContainer: StartedPostgreSqlContainer;
let prismaImports: typeof import("../../lib/prisma.js");

const TENANT = "00000000-0000-4000-8000-0000000000a1";

beforeAll(async () => {
  const booted = await bootPostgres({ utilities: [TENANT] });
  pgContainer = booted.container;
  prismaImports = await import("../../lib/prisma.js");
}, 180_000);

afterAll(async () => {
  // `$disconnect` does not dispose a pool the application owns — that
  // is the driver-adapter contract — so the pools are ended here.
  // Without it the container stops while connections are live and
  // Postgres reports 57P01 as an unhandled error after a green run.
  await prismaImports?.prisma.$disconnect().catch(() => {});
  await prismaImports?.pool.end().catch(() => {});
  await pgContainer?.stop().catch(() => {});
});

beforeEach(() =>
  seedAsPlatform(async () => {
  const { prisma } = prismaImports;
  await prisma.userRole.deleteMany({});
  await prisma.cisUser.deleteMany({});
}),
);

describe("a CisUser with no utility", () => {
  it("admits a user that belongs to no tenant", () =>
    seedAsPlatform(async () => {      /* Fixture rows and read-backs under the fixture authority; the
       * scoped wrappers re-enter their own tenant scope. */
      const { prisma } = prismaImports;

      const actor = await prisma.cisUser.create({
        data: { utilityId: null, email: "platform@example.gov", name: "Platform Operator" },
      });

      expect(actor.utilityId).toBeNull();
  
    }));

  it("refuses a second platform user with the same email", () =>
    seedAsPlatform(async () => {      /* Fixture rows and read-backs under the fixture authority; the
       * scoped wrappers re-enter their own tenant scope. */
      const { prisma } = prismaImports;
      await prisma.cisUser.create({
        data: { utilityId: null, email: "dupe@example.gov", name: "First" },
      });

      await expect(
        prisma.cisUser.create({
          data: { utilityId: null, email: "dupe@example.gov", name: "Second" },
        }),
      ).rejects.toMatchObject({ code: "P2002" });
  
    }));

  it("refuses a second platform user with the same external_id", () =>
    seedAsPlatform(async () => {      /* Fixture rows and read-backs under the fixture authority; the
       * scoped wrappers re-enter their own tenant scope. */
      const { prisma } = prismaImports;
      // apptorID is where every identity is headed, so external_id is the
      // claim that will carry it. Duplicates there are the same bug.
      await prisma.cisUser.create({
        data: { utilityId: null, email: "a@example.gov", name: "A", externalId: "idp-1" },
      });

      await expect(
        prisma.cisUser.create({
          data: { utilityId: null, email: "b@example.gov", name: "B", externalId: "idp-1" },
        }),
      ).rejects.toMatchObject({ code: "P2002" });
  
    }));

  it("still admits one platform user per distinct email", () =>
    seedAsPlatform(async () => {      /* Fixture rows and read-backs under the fixture authority; the
       * scoped wrappers re-enter their own tenant scope. */
      const { prisma } = prismaImports;
      await prisma.cisUser.create({ data: { utilityId: null, email: "one@example.gov", name: "One" } });
      await prisma.cisUser.create({ data: { utilityId: null, email: "two@example.gov", name: "Two" } });

      expect(await prisma.cisUser.count({ where: { utilityId: null } })).toBe(2);
  
    }));

  it("leaves several platform users with no external_id alone", () =>
    seedAsPlatform(async () => {      /* Fixture rows and read-backs under the fixture authority; the
       * scoped wrappers re-enter their own tenant scope. */
      const { prisma } = prismaImports;
      // The external_id index is partial on NOT NULL as well as on the
      // tenant, because nothing has an apptorID subject yet and a unique
      // index over NULLs would admit exactly one platform user in total.
      await prisma.cisUser.create({ data: { utilityId: null, email: "x@example.gov", name: "X" } });
      await prisma.cisUser.create({ data: { utilityId: null, email: "y@example.gov", name: "Y" } });

      expect(await prisma.cisUser.count({ where: { utilityId: null, externalId: null } })).toBe(2);
  
    }));

  it("still refuses two users sharing one email inside a tenant", () =>
    seedAsPlatform(async () => {      /* Fixture rows and read-backs under the fixture authority; the
       * scoped wrappers re-enter their own tenant scope. */
      const { prisma } = prismaImports;
      // The composite unique has to survive the column going nullable.
      await prisma.cisUser.create({
        data: { utilityId: TENANT, email: "staff@example.gov", name: "A" },
      });

      await expect(
        prisma.cisUser.create({
          data: { utilityId: TENANT, email: "staff@example.gov", name: "B" },
        }),
      ).rejects.toMatchObject({ code: "P2002" });
  
    }));

  it("lets a tenant user and a platform user share an email", () =>
    seedAsPlatform(async () => {      /* Fixture rows and read-backs under the fixture authority; the
       * scoped wrappers re-enter their own tenant scope. */
      const { prisma } = prismaImports;
      // Deliberate: the same person may operate the platform and hold an
      // account with a tenant, and the two identities are separate rows
      // with separate authority. Nothing collapses them.
      await prisma.cisUser.create({
        data: { utilityId: TENANT, email: "both@example.gov", name: "Tenant Side" },
      });
      const platform = await prisma.cisUser.create({
        data: { utilityId: null, email: "both@example.gov", name: "Platform Side" },
      });

      expect(platform.utilityId).toBeNull();
  
    }));
});
