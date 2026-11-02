import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { addNote, deleteNote, listNotes } from "../services/note.service.js";

/**
 * Notes on a record.
 *
 * One pair of routes for every entity, keyed by `entityType`, because
 * the table is polymorphic and there is nothing per-entity to say.
 *
 * **Authorized by the host entity's module**, named in the path rather
 * than invented here: reading a customer's notes needs
 * `customers:VIEW`, adding one needs `customers:EDIT`. A dedicated
 * `notes` module was rejected — it would need enabling per tenant and
 * wiring into all six preset roles for a capability nobody would ever
 * switch off separately, and "may this person see this customer" is
 * already answered by the customer module.
 *
 * **No overlay-mode gate**, unlike the entity's own write routes. That
 * is the entire point: spec 28's OVL-T-3 makes a mirrored record
 * read-only, and a read-only record with nowhere to write "the customer
 * says this number is wrong" just moves the note onto paper. Notes are
 * also ordinary CIS work in full mode, so they are not an overlay
 * feature that happens to be always on.
 *
 * No PATCH: a note's body is never edited. DELETE withdraws it —
 * soft, so the record of what was said survives (see
 * `note.service.ts`).
 */

/**
 * The entities that can carry notes, and the module that governs each.
 *
 * An allow-list rather than a free-text `entityType`, because the value
 * decides which permission is checked — an unlisted type would either
 * be unauthorized or, worse, authorized by whatever the caller sent.
 * It is also what stops the table filling with typo'd types that no
 * screen will ever read back.
 */
const NOTE_SUBJECTS: Record<string, { entityType: string; module: string }> = {
  customers: { entityType: "Customer", module: "customers" },
  premises: { entityType: "Premise", module: "premises" },
  meters: { entityType: "Meter", module: "meters" },
  accounts: { entityType: "Account", module: "accounts" },
  "service-agreements": { entityType: "ServiceAgreement", module: "agreements" },
};

const paramsSchema = z.object({ id: z.string().uuid() });
const deleteParamsSchema = z.object({
  id: z.string().uuid(),
  noteId: z.string().uuid(),
});
const bodySchema = z.object({ body: z.string().min(1).max(10_000) });

export async function noteRoutes(app: FastifyInstance) {
  for (const [segment, subject] of Object.entries(NOTE_SUBJECTS)) {
    app.get(
      `/api/v1/${segment}/:id/notes`,
      { config: { module: subject.module, permission: "VIEW" } },
      async (request, reply) => {
        const { id } = paramsSchema.parse(request.params);
        return reply.send(
          await listNotes(request.user.utilityId, subject.entityType, id),
        );
      },
    );

    app.post(
      `/api/v1/${segment}/:id/notes`,
      { config: { module: subject.module, permission: "EDIT" } },
      async (request, reply) => {
        const { id } = paramsSchema.parse(request.params);
        const { body } = bodySchema.parse(request.body);
        const note = await addNote(
          request.user.utilityId,
          { id: request.user.id, name: request.user.name },
          { entityType: subject.entityType, entityId: id, body },
        );
        return reply.status(201).send(note);
      },
    );

    app.delete(
      `/api/v1/${segment}/:id/notes/:noteId`,
      { config: { module: subject.module, permission: "EDIT" } },
      async (request, reply) => {
        const { id, noteId } = deleteParamsSchema.parse(request.params);
        await deleteNote(
          request.user.utilityId,
          { id: request.user.id, name: request.user.name },
          subject.entityType,
          id,
          noteId,
        );
        return reply.status(204).send();
      },
    );
  }
}
