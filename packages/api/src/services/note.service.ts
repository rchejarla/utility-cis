import { prisma } from "../lib/prisma.js";

/**
 * Notes on a record: a dated remark a staff member attaches to
 * something.
 *
 * Polymorphic on `(entityType, entityId)` like `Attachment`, so one
 * table serves every entity rather than a `notes` column appearing on
 * each in turn. `meter.notes` is that column, and it is the reason this
 * exists: it holds one note, has no author, has no date, and the second
 * note overwrites the first.
 *
 * **The body is never edited.** A note records that somebody observed
 * something at a time; an editable note records nothing in particular,
 * because a later reader cannot tell whether what they are reading is
 * what was written. There is no update, and so no `updatedAt`.
 *
 * It can be **withdrawn**, which is the one state change it has, and
 * that is soft. Two reasons, the second being the stronger: the
 * data-model overview's standing rule is soft deletes only, and the
 * purpose of this table is to be a record of what somebody said at a
 * time — erasing the row would make "was there ever a note here"
 * unanswerable, which is exactly what a dispute asks. A withdrawn note
 * is still evidence that it was written and withdrawn, and by whom.
 *
 * **Not an overlay feature**, though spec 28's OVL-T-3 is what forced
 * it: a mirrored record is read-only to staff, and a read-only record
 * with nowhere to write "the customer says this number is wrong" just
 * moves the note onto paper. Recording a conversation is ordinary CIS
 * work, so notes carry no operating-mode gate and no module of their
 * own — a caller is authorized by the host entity's module, which is
 * also what keeps a new module out of all six preset roles for a
 * capability nobody would switch off separately.
 *
 * No audit row. The note *is* the record, it is immutable, and it
 * already carries its author and its time — an `audit_log` entry beside
 * it would duplicate all three and say nothing the note does not.
 */

/** Who is writing. The name is copied onto the row, not joined. */
export interface NoteAuthor {
  id: string;
  name: string;
}

export interface AddNoteInput {
  entityType: string;
  entityId: string;
  body: string;
}

export interface NoteRow {
  id: string;
  entityType: string;
  entityId: string;
  body: string;
  authorId: string;
  authorName: string;
  createdAt: Date;
}

const SELECT = {
  id: true,
  entityType: true,
  entityId: true,
  body: true,
  authorId: true,
  authorName: true,
  createdAt: true,
} as const;

export async function addNote(
  utilityId: string,
  author: NoteAuthor,
  input: AddNoteInput,
): Promise<NoteRow> {
  /*
   * Trimmed here as well as checked in the database. The CHECK is the
   * backstop for any caller that skips this function; trimming is what
   * stops a note being stored with the operator's stray newline on the
   * end of it.
   */
  const body = input.body.trim();
  if (!body) {
    throw Object.assign(new Error("A note cannot be empty"), {
      statusCode: 400,
      code: "NOTE_EMPTY",
    });
  }

  return prisma.note.create({
    data: {
      utilityId,
      entityType: input.entityType,
      entityId: input.entityId,
      body,
      authorId: author.id,
      authorName: author.name,
    },
    select: SELECT,
  });
}

/**
 * One record's notes, newest first — the order a reader wants, since
 * the latest remark is the one that changes what they do next.
 *
 * Not paginated. A record accumulates notes at the speed a human types
 * them, so the whole list is the answer; the day one has hundreds is
 * the day to add a cursor, and `note_subject_idx` already orders them.
 */
export async function listNotes(
  utilityId: string,
  entityType: string,
  entityId: string,
): Promise<NoteRow[]> {
  return prisma.note.findMany({
    // Live notes only. `note_subject_idx` carries the same predicate,
    // so this stays one index scan.
    where: { utilityId, entityType, entityId, deletedAt: null },
    orderBy: { createdAt: "desc" },
    select: SELECT,
  });
}

/**
 * Withdraw a note.
 *
 * Scoped by `(utilityId, entityType, entityId)` as well as by id, so a
 * caller authorized for one record cannot withdraw a note belonging to
 * another by passing its id — the route checks permission against the
 * entity in the path, and this is what makes that check mean something.
 *
 * Idempotent in effect: a note already withdrawn is reported as not
 * found rather than withdrawn twice, which keeps `deletedBy` the person
 * who actually did it.
 */
export async function deleteNote(
  utilityId: string,
  actor: NoteAuthor,
  entityType: string,
  entityId: string,
  noteId: string,
): Promise<void> {
  const { count } = await prisma.note.updateMany({
    where: { id: noteId, utilityId, entityType, entityId, deletedAt: null },
    data: { deletedAt: new Date(), deletedBy: actor.id },
  });
  if (count === 0) {
    throw Object.assign(new Error("No such note on this record"), {
      statusCode: 404,
      code: "NOTE_NOT_FOUND",
    });
  }
}
