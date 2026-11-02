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
 * **Append-only.** There is no update and no delete, which is why this
 * module exports two functions and not four. A note records that
 * somebody observed something at a time; an editable note records
 * nothing in particular, because a later reader cannot tell whether
 * what they are reading is what was written. A mistake is corrected by
 * adding another note, which is how a paper file works and for the same
 * reason.
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
    where: { utilityId, entityType, entityId },
    orderBy: { createdAt: "desc" },
    select: SELECT,
  });
}
