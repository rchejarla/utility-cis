import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import type { FastifyInstance } from "fastify";
import {
  bootPostgres,
  resetDb,
  makeTenantFixture,
  TENANT_A,
  type TenantFixture,
  ensurePrincipal,
  truncateTables,
  seedAsPlatform,
  endAdminPool,
} from "./_effective-dating-fixtures.js";

/**
 * A bulk-loaded premise arrives with the tenant's own facts on it.
 *
 * The premise handler mapped thirteen core columns and no custom
 * fields, so an imported premise had `customFields = {}`. That is not
 * cosmetic: **stormwater is priced from `premise:attr:eru_count`**, a
 * premise custom field, so a migrated tenant's stormwater had nothing
 * to rate on and every ERU count had to be typed in by hand — at
 * exactly the moment somebody has a file of ten thousand premises.
 *
 * Custom fields are declared per tenant in `custom_field_schema`, so
 * the static handler list cannot name them; they are appended to the
 * kind's canonical fields per request, prefixed `custom:`. This file
 * exercises that against a real schema row, because the part that can
 * silently break is agreement between three places — what the fields
 * endpoint offers, what the POST's mapping validation accepts, and
 * what the handler stores.
 */

vi.mock("../../lib/queues.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/queues.js")>()),
  enqueueSafely: vi.fn(async () => "test-job-id"),
}));

let pgContainer: StartedPostgreSqlContainer;
let prismaImports: typeof import("../../lib/prisma.js");
let appImports: typeof import("../../app.js");
let app: FastifyInstance;
let fixA: TenantFixture;

const ENABLED_MODULES = ["imports", "premises"];

function makeToken(utilityId: string, actorId = "00000000-0000-4000-8000-aaaa00000001") {
  const header = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({
      sub: actorId,
      utility_id: utilityId,
      email: "tester@example.com",
      name: "Tester",
      role: "admin",
    }),
  ).toString("base64url");
  return `${header}.${payload}.fake-signature`;
}

const headers = () => ({ authorization: `Bearer ${makeToken(TENANT_A)}` });

function buildMultipart(
  parts: Array<
    | { name: string; value: string }
    | { name: string; filename: string; contentType: string; body: string | Buffer }
  >,
): { body: Buffer; contentType: string } {
  const boundary = `----premise-cf-test-${Math.random().toString(36).slice(2)}`;
  const segments: Buffer[] = [];
  for (const part of parts) {
    segments.push(Buffer.from(`--${boundary}\r\n`));
    if ("filename" in part) {
      segments.push(
        Buffer.from(
          `Content-Disposition: form-data; name="${part.name}"; filename="${part.filename}"\r\n`,
        ),
      );
      segments.push(Buffer.from(`Content-Type: ${part.contentType}\r\n\r\n`));
      segments.push(typeof part.body === "string" ? Buffer.from(part.body) : part.body);
      segments.push(Buffer.from("\r\n"));
    } else {
      segments.push(Buffer.from(`Content-Disposition: form-data; name="${part.name}"\r\n\r\n`));
      segments.push(Buffer.from(part.value));
      segments.push(Buffer.from("\r\n"));
    }
  }
  segments.push(Buffer.from(`--${boundary}--\r\n`));
  return { body: Buffer.concat(segments), contentType: `multipart/form-data; boundary=${boundary}` };
}

/** The tenant's declared stormwater facts. */
const FIELDS = [
  {
    key: "eru_count",
    label: "ERU count",
    type: "number",
    required: false,
    searchable: false,
    order: 1,
    deprecated: false,
  },
  {
    key: "has_stormwater_infra",
    label: "Has stormwater infrastructure",
    type: "boolean",
    required: false,
    searchable: false,
    order: 2,
    deprecated: false,
  },
  {
    key: "basin",
    label: "Drainage basin",
    type: "enum",
    required: false,
    searchable: false,
    order: 3,
    deprecated: false,
    enumOptions: [
      { value: "north", label: "North" },
      { value: "south", label: "South" },
    ],
  },
];

const HEADER = "address1,city,state,zip,premise_type,eru,infra,basin\n";
const MAPPING = {
  address1: "addressLine1",
  city: "city",
  state: "state",
  zip: "zip",
  premise_type: "premiseType",
  eru: "custom:eru_count",
  infra: "custom:has_stormwater_infra",
  basin: "custom:basin",
};

async function postCsv(csv: string, mapping: Record<string, string> = MAPPING) {
  const { body, contentType } = buildMultipart([
    { name: "kind", value: "premise" },
    { name: "source", value: "MANUAL_UPLOAD" },
    { name: "fileName", value: "premises.csv" },
    { name: "mapping", value: JSON.stringify(mapping) },
    { name: "file", filename: "premises.csv", contentType: "text/csv", body: csv },
  ]);
  return app.inject({
    method: "POST",
    url: "/api/v1/imports",
    headers: { ...headers(), "content-type": contentType },
    payload: body,
  });
}

beforeAll(async () => {
  const booted = await bootPostgres({ utilities: [TENANT_A] });
  pgContainer = booted.container;
  prismaImports = await import("../../lib/prisma.js");
  appImports = await import("../../app.js");
  app = await appImports.buildApp();
  await app.ready();
}, 180_000);

afterAll(async () => {
  await app?.close().catch(() => {});
  await prismaImports?.prisma.$disconnect().catch(() => {});
  await prismaImports?.pool.end().catch(() => {});
  await endAdminPool();
  await pgContainer?.stop().catch(() => {});
});

beforeEach(() =>
  seedAsPlatform(async () => {
    const { prisma } = prismaImports;
    await resetDb();
    await truncateTables("import_row, import_batch, attachment, custom_field_schema");
    await ensurePrincipal(prisma, TENANT_A);
    fixA = await makeTenantFixture(prisma, TENANT_A);

    for (const moduleKey of ENABLED_MODULES) {
      await prisma.utilityModule.create({ data: { utilityId: fixA.utilityId, moduleKey } });
    }

    await prisma.customFieldSchema.create({
      data: { utilityId: fixA.utilityId, entityType: "premise", fields: FIELDS },
    });

    const rbac = await import("../../services/rbac.service.js");
    await rbac.invalidateTenantModulesCache(fixA.utilityId);
  }),
);

describe("GET /imports/kinds/premise/fields — the tenant's own columns", () => {
  it("offers each declared field, prefixed, with the tenant's label", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/imports/kinds/premise/fields",
      headers: headers(),
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as {
      canonicalFields: Array<{ name: string; label: string }>;
    };
    const names = body.canonicalFields.map((f) => f.name);

    // Core columns are still there, and the custom ones are appended.
    expect(names).toContain("addressLine1");
    expect(names).toContain("custom:eru_count");
    expect(names).toContain("custom:has_stormwater_infra");
    expect(names).toContain("custom:basin");

    const eru = body.canonicalFields.find((f) => f.name === "custom:eru_count");
    expect(eru?.label).toBe("ERU count");
  });

  it("offers no custom columns to a tenant that has declared none", () =>
    seedAsPlatform(async () => {
      const { prisma } = prismaImports;
      await prisma.customFieldSchema.deleteMany({ where: { utilityId: fixA.utilityId } });

      const res = await app.inject({
        method: "GET",
        url: "/api/v1/imports/kinds/premise/fields",
        headers: headers(),
      });
      const body = JSON.parse(res.body) as { canonicalFields: Array<{ name: string }> };
      expect(body.canonicalFields.some((f) => f.name.startsWith("custom:"))).toBe(false);
    }), 60_000);
});

describe("POST /api/v1/imports — a re-sent premise export (OVL-IN-5)", () => {
  const LK_HEADER = `legacy_id,address1,city,state,zip,premise_type,eru
`;
  const LK_MAPPING = {
    legacy_id: "legacyKey",
    address1: "addressLine1",
    city: "city",
    state: "state",
    zip: "zip",
    premise_type: "premiseType",
    eru: "custom:eru_count",
  };

  it("corrects the address and the ERU count in place, rather than duplicating", () =>
    seedAsPlatform(async () => {
      /*
       * The address is the thing most likely to be corrected between
       * cycles, which is why it is not part of the premise's identity —
       * a premise has no immutable business key, so the legacy id is
       * the only handle, and correcting an address is half the point of
       * re-importing.
       */
      const { prisma } = prismaImports;

      const first = JSON.parse(
        (await postCsv(LK_HEADER + `LEG-P1,100 Rain St,Testville,TS,00001,RESIDENTIAL,2
`, LK_MAPPING)).body,
      );
      expect(first.importedCount).toBe(1);

      const second = JSON.parse(
        (await postCsv(LK_HEADER + `LEG-P1,100 Rainfall Street,Testville,TS,00001,RESIDENTIAL,4.5
`, LK_MAPPING)).body,
      );
      expect(second.errorCount).toBe(0);
      expect(second.importedCount).toBe(1);

      const rows = await prisma.premise.findMany({
        where: { utilityId: fixA.utilityId, legacyKey: "LEG-P1" },
      });
      expect(rows).toHaveLength(1);
      expect(rows[0].addressLine1).toBe("100 Rainfall Street");
      // The tenant's own fact follows the correction too — stormwater
      // is priced off this number.
      expect(rows[0].customFields).toEqual({ eru_count: 4.5 });
    }), 120_000);
});

describe("POST /api/v1/imports — premise custom fields", () => {
  it("stores the tenant's facts on the imported premise, typed", () =>
    seedAsPlatform(async () => {
      const { prisma } = prismaImports;

      const csv =
        HEADER +
        "100 Rain St,Testville,TS,00001,RESIDENTIAL,3.5,true,north\n" +
        // The one that would have been silently wrong: a coercing
        // validator reads "false" as true, because every non-empty
        // string is truthy.
        "200 Rain St,Testville,TS,00001,RESIDENTIAL,1,false,south\n" +
        // Blank cells are absence, not values.
        "300 Rain St,Testville,TS,00001,RESIDENTIAL,,,\n";

      const res = await postCsv(csv);
      expect(res.statusCode).toBe(200);
      const result = JSON.parse(res.body);
      expect(result.errorCount).toBe(0);
      expect(result.importedCount).toBe(3);

      const premises = await prisma.premise.findMany({
        where: { utilityId: fixA.utilityId, addressLine1: { endsWith: "Rain St" } },
        orderBy: { addressLine1: "asc" },
      });
      expect(premises).toHaveLength(3);

      expect(premises[0].customFields).toEqual({
        eru_count: 3.5,
        has_stormwater_infra: true,
        basin: "north",
      });
      expect(premises[1].customFields).toEqual({
        eru_count: 1,
        has_stormwater_infra: false,
        basin: "south",
      });
      expect(premises[2].customFields).toEqual({});
    }), 120_000);

  it("rejects a value the tenant's schema does not allow, as a row error", () =>
    seedAsPlatform(async () => {
      const { prisma } = prismaImports;

      const csv =
        HEADER +
        "400 Rain St,Testville,TS,00001,RESIDENTIAL,3,true,east\n" +
        "500 Rain St,Testville,TS,00001,RESIDENTIAL,plenty,true,north\n" +
        "600 Rain St,Testville,TS,00001,RESIDENTIAL,2,perhaps,north\n";

      const result = JSON.parse((await postCsv(csv)).body);
      expect(result.importedCount).toBe(0);
      expect(result.errors.map((e: { errorCode: string }) => e.errorCode)).toEqual([
        "INVALID_CUSTOM_FIELD",
        "INVALID_CUSTOM_FIELD",
        "INVALID_CUSTOM_FIELD",
      ]);
      // The message names the field, because a row carries several.
      expect(result.errors[0].errorMessage).toContain("basin");

      expect(
        await prisma.premise.count({
          where: { utilityId: fixA.utilityId, addressLine1: { endsWith: "Rain St" } },
        }),
      ).toBe(0);
    }), 120_000);

  it("refuses a mapping onto a custom field the tenant has not declared", () =>
    seedAsPlatform(async () => {
      // The mapping surface the POST validates has to be the same list
      // the fields endpoint offered; an undeclared key is not in it.
      const csv = "address1,city,state,zip,premise_type,made_up\n" +
        "700 Rain St,Testville,TS,00001,RESIDENTIAL,7\n";
      const res = await postCsv(csv, {
        address1: "addressLine1",
        city: "city",
        state: "state",
        zip: "zip",
        premise_type: "premiseType",
        made_up: "custom:not_declared",
      });
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).error.code).toBe("INVALID_MAPPING");
    }), 120_000);
});
