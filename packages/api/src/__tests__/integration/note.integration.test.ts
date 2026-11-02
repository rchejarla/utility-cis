import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import {
  bootPostgres,
  resetDb,
  makeTenantFixture,
  TENANT_A,
  TENANT_B,
  type TenantFixture,
  ensurePrincipal,
  truncateTables,
  seedAsPlatform,
  endAdminPool,
} from "./_effective-dating-fixtures.js";
import { runAsTenant } from "../../lib/tenant-context.js";

/**
 * Notes on a record.
 *
 * A dated remark a staff member attaches to something, polymorphic on
 * (entityType, entityId) like `Attachment`. Spec 28's OVL-T-3 forced
 * it — a mirrored record is read-only to staff, and a read-only record
 * with nowhere to write "the customer says this number is wrong" just
 * moves the note onto paper — but it is **not** an overlay feature and
 * carries no mode gate. Recording a conversation is ordinary CIS work.
 *
 * Two properties are worth a database to prove rather than a mock. The
 * table is **append-only**, which is a claim about what the service
 * exposes and what the schema allows; and it is tenant-isolated by
 * policy rather than by a `where` clause, which only a real `cis_app`
 * connection can demonstrate.
 */

let pgContainer: StartedPostgreSqlContainer;
let prismaImports: typeof import("../../lib/prisma.js");
let svc: typeof import("../../services/note.service.js");
let fixA: TenantFixture;
let fixB: TenantFixture;

const ACTOR = {
  id: "00000000-0000-4000-8000-aaaa00000001",
  name: "Jane CSR",
};

beforeAll(async () => {
  const booted = await bootPostgres({ utilities: [TENANT_A, TENANT_B] });
  pgContainer = booted.container;
  prismaImports = await import("../../lib/prisma.js");
  svc = await import("../../services/note.service.js");
}, 180_000);

afterAll(async () => {
  // `$disconnect` does not dispose a pool the application owns — that is
  // the driver-adapter contract — and `bootPostgres({ utilities })`
  // opens the admin pool to declare them. All three have to be closed
  // before the container stops, or Postgres reports 57P01 as an
  // unhandled error after an otherwise green run, which exits 1.
  await prismaImports?.prisma.$disconnect().catch(() => {});
  await prismaImports?.pool.end().catch(() => {});
  await endAdminPool();
  await pgContainer?.stop().catch(() => {});
});

beforeEach(() =>
  seedAsPlatform(async () => {
    const { prisma } = prismaImports;
    await resetDb();
    await truncateTables("note");
    await ensurePrincipal(prisma, TENANT_A);
    fixA = await makeTenantFixture(prisma, TENANT_A);
    fixB = await makeTenantFixture(prisma, TENANT_B, { suffix: "b1" });
  }),
);

const addNote = (utilityId: string, body: string, entityId?: string) =>
  runAsTenant(utilityId, async () =>
    svc.addNote(utilityId, ACTOR, {
      entityType: "Customer",
      entityId: entityId ?? fixA.accountId,
      body,
    }),
  );

const listNotes = (utilityId: string, entityId?: string) =>
  runAsTenant(utilityId, async () =>
    svc.listNotes(utilityId, "Customer", entityId ?? fixA.accountId),
  );

describe("adding a note", () => {
  it("records the body, the author and when", () =>
    seedAsPlatform(async () => {
      const note = await addNote(TENANT_A, "Owner called about the leak at the kerb.");
      expect(note).toMatchObject({
        body: "Owner called about the leak at the kerb.",
        authorId: ACTOR.id,
        authorName: ACTOR.name,
        entityType: "Customer",
      });
      expect(note.createdAt).toBeInstanceOf(Date);
    }), 120_000);

  it("copies the author's name rather than joining it", () =>
    seedAsPlatform(async () => {
      /*
       * A note outlives the staff member who wrote it: a leaver's row
       * may be deactivated or purged, and "who said this" has to
       * survive that. So the name is a column, not a join.
       */
      const { prisma } = prismaImports;
      const note = await addNote(TENANT_A, "Spoke to the tenant.");
      const row = await prisma.note.findUniqueOrThrow({ where: { id: note.id } });
      expect(row.authorName).toBe("Jane CSR");
    }), 120_000);

  it("refuses an empty note, at the database if nowhere else", () =>
    seedAsPlatform(async () => {
      // There is a CHECK on the trimmed length, so whitespace does not
      // pass even if a caller skips the service.
      await expect(addNote(TENANT_A, "   ")).rejects.toBeTruthy();
      expect(await listNotes(TENANT_A)).toHaveLength(0);
    }), 120_000);

  it("keeps every note rather than replacing the last", () =>
    seedAsPlatform(async () => {
      // The failure mode of a `notes` column on the entity, which is
      // what `meter.notes` is and why this table exists.
      await addNote(TENANT_A, "First call.");
      await addNote(TENANT_A, "Second call, owner unavailable.");
      const notes = await listNotes(TENANT_A);
      expect(notes.map((n) => n.body)).toEqual([
        "Second call, owner unavailable.",
        "First call.",
      ]);
    }), 120_000);
});

describe("reading notes", () => {
  it("returns newest first, which is the order a reader wants", () =>
    seedAsPlatform(async () => {
      await addNote(TENANT_A, "Older");
      await addNote(TENANT_A, "Newer");
      const notes = await listNotes(TENANT_A);
      expect(notes[0].body).toBe("Newer");
    }), 120_000);

  it("keeps one record's notes off another's", () =>
    seedAsPlatform(async () => {
      await addNote(TENANT_A, "About the account", fixA.accountId);
      await addNote(TENANT_A, "About the premise", fixA.premiseId);
      expect((await listNotes(TENANT_A, fixA.accountId)).map((n) => n.body)).toEqual([
        "About the account",
      ]);
      expect((await listNotes(TENANT_A, fixA.premiseId)).map((n) => n.body)).toEqual([
        "About the premise",
      ]);
    }), 120_000);

  it("is isolated by policy, not by a where clause", () =>
    seedAsPlatform(async () => {
      /*
       * Both tenants have a note on an id that exists in each. Reading
       * as tenant A must not see B's, and the proof has to be a real
       * `cis_app` connection — a mocked Prisma has no row-level
       * security, which is how the worker's metrics bug hid for days.
       */
      await addNote(TENANT_A, "A's note", fixA.accountId);
      await addNote(TENANT_B, "B's note", fixB.accountId);

      expect((await listNotes(TENANT_A, fixA.accountId)).map((n) => n.body)).toEqual([
        "A's note",
      ]);
      // A asking for B's subject id gets nothing, even though the row
      // exists: the policy filters before the id does.
      expect(await listNotes(TENANT_A, fixB.accountId)).toEqual([]);
    }), 120_000);
});

describe("the append-only shape", () => {
  it("exposes no way to change or remove a note", () =>
    seedAsPlatform(async () => {
      /*
       * A note records that somebody observed something at a time, and
       * an editable note records nothing in particular — a later reader
       * cannot tell whether what they are reading is what was written.
       * A mistake is corrected by adding another note, as in a paper
       * file.
       *
       * Asserted on the service's surface because that is the contract
       * a caller has; the schema has no `updatedAt` to describe a
       * second state either.
       */
      const surface = Object.keys(svc);
      expect(surface).toContain("addNote");
      expect(surface).toContain("listNotes");
      expect(surface.some((k) => /update|edit|delete|remove/i.test(k))).toBe(false);
    }), 60_000);
});
