import { createHash } from "node:crypto";
import { Prisma } from "@utility-cis/shared/src/generated/prisma";
import { billDocumentSettingsSchema, EVENT_TYPES } from "@utility-cis/shared";
import { prisma } from "../lib/prisma.js";
import { config } from "../config.js";
import { writeAuditRow } from "../lib/audit-wrap.js";
import { putObject, getObject } from "../lib/apptor-connect/files-client.js";
import { loadBillPresentation } from "./bill-presentation.service.js";
import { generateBillPdf, DEFAULT_TEMPLATE_KEY } from "../bill-generation/generate-bill-pdf.js";

/**
 * Generating, storing and reading a bill's document.
 *
 * The row holds a pointer, never bytes and never a URL: the object
 * lives in the tenant's own store behind apptor-connect's files plane,
 * and a capability link is minted per access and discarded.
 */

export type BillDocumentErrorCode = "NOT_POSTED" | "STORAGE_NOT_CONFIGURED" | "NOT_GENERATED";

export class BillDocumentError extends Error {
  constructor(
    message: string,
    readonly code: BillDocumentErrorCode,
    readonly missing: string[] = [],
  ) {
    super(message);
    this.name = "BillDocumentError";
  }
}

export interface BillDocumentRow {
  id: string;
  billId: string;
  documentType: "PDF";
  storageIntegration: string;
  storageConnection: string | null;
  objectKey: string;
  byteSize: number;
  sha256: string;
  templateKey: string;
  generatedAt: Date;
  isPaperless: boolean;
}

const PDF = "PDF" as const;

/**
 * Derived, never supplied: no path component comes from user input. The
 * utilityId prefix is defensive — the integration's connection root is
 * already per-tenant, but if a deployment ever points two tenants at
 * one bucket this is what keeps their bills apart.
 */
export function billObjectKey(utilityId: string, billId: string): string {
  return `bills/${utilityId}/${billId}.pdf`;
}

/** `document_type` is a VARCHAR; narrow where the row is built. */
function toRow(row: {
  id: string;
  billId: string;
  documentType: string;
  storageIntegration: string;
  storageConnection: string | null;
  objectKey: string;
  byteSize: number | null;
  sha256: string | null;
  templateKey: string;
  generatedAt: Date;
  isPaperless: boolean;
}): BillDocumentRow {
  if (row.byteSize === null || row.sha256 === null) {
    throw new BillDocumentError(
      `Bill document ${row.id} is claimed but not stored`,
      "NOT_GENERATED",
    );
  }
  return { ...row, documentType: PDF, byteSize: row.byteSize, sha256: row.sha256 };
}

function storageOf(settings: unknown): { integration: string; connection: string | null } {
  const raw =
    settings && typeof settings === "object" && "billDocuments" in settings
      ? (settings as { billDocuments?: unknown }).billDocuments
      : undefined;
  const parsed = billDocumentSettingsSchema.safeParse(raw ?? {});
  // Settings that exist but cannot be read are a different operator
  // problem from settings that were never filled in, and they used to
  // produce the same message: "set the storage integration under
  // Settings", naming a field the settings page shows as already set.
  // Say which field is wrong instead.
  if (!parsed.success) {
    const paths = parsed.error.issues.map((i) => `billDocuments.${i.path.join(".")}`);
    throw new BillDocumentError(
      `This tenant's bill-document settings cannot be read: ${parsed.error.issues
        .map((i) => `${i.path.join(".") || "(root)"} ${i.message}`)
        .join("; ")}`,
      "STORAGE_NOT_CONFIGURED",
      paths,
    );
  }
  const integration = parsed.data.storageIntegration;
  if (!integration) {
    throw new BillDocumentError(
      "No bill-document storage integration is configured for this tenant. Set it under Settings.",
      "STORAGE_NOT_CONFIGURED",
      ["billDocuments.storageIntegration"],
    );
  }
  return { integration, connection: parsed.data.storageConnection || null };
}

/**
 * Generate a bill's PDF, store it, and return the pointer.
 *
 * Order matters and is the reverse of a filesystem design. The row is
 * claimed FIRST, so the unique constraint on (bill_id, document_type)
 * decides which of two concurrent generations OWNS the row.
 *
 * It does not make the upload exclusive, and an earlier version of this
 * comment claimed it did. The loser of that race adopts the winner's
 * claim and uploads too, because an unfinished claim has to stay
 * completable: a row with a null sha256 may equally be the wreckage of a
 * generation that crashed mid-upload, and refusing to touch it would
 * leave a bill permanently undownloadable. Telling those two apart needs
 * a lease, which is not worth building until something demands it.
 *
 * What that costs, stated rather than glossed: two concurrent
 * generations can both upload. They write identical bytes to the same
 * key — today by determinism and a stabilizer, which is why this is
 * tolerable — so the stored object is right either way. The residue is
 * that each writes its own audit row, and that a loser whose upload
 * succeeds while the winner's fails ends up with bytes in the store and
 * no pointer to them. Both are bounded by `force` being an operator
 * action on one bill, not a scheduled fan-out.
 *
 * A row whose byteSize and sha256 are still null is a claim whose
 * upload did not finish: it is completed rather than returned.
 */
export async function generateBillDocument(
  utilityId: string,
  billId: string,
  actorId: string,
  opts: { force?: boolean } = {},
): Promise<BillDocumentRow> {
  const bill = await prisma.bill.findFirst({
    where: { id: billId, utilityId },
    select: { id: true, postedAt: true, account: { select: { paperlessBilling: true } } },
  });
  if (!bill) {
    throw new BillDocumentError(`Bill ${billId} not found`, "NOT_GENERATED");
  }
  if (!bill.postedAt) {
    throw new BillDocumentError(
      "A bill becomes a document once it is posted",
      "NOT_POSTED",
    );
  }

  const existing = await prisma.billDocument.findUnique({
    where: { billId_documentType: { billId, documentType: PDF } },
  });
  if (existing && existing.sha256 !== null && !opts.force) {
    return toRow(existing);
  }

  const config_ = await prisma.tenantConfig.findUnique({ where: { utilityId } });
  const storage = storageOf(config_?.settings);

  // Resolve and generate before claiming, so a bill that cannot be
  // generated leaves no row behind at all.
  const presentation = await loadBillPresentation(utilityId, billId);
  const pdf = await generateBillPdf(presentation);
  const sha256 = createHash("sha256").update(pdf).digest("hex");
  const objectKey = billObjectKey(utilityId, billId);

  // Claimed, not audited. A claim is not a document: nothing can
  // download it, and the upload that would make it real may still fail.
  // The audit row is written once the bytes are stored, so the log never
  // asserts a document that does not exist.
  // Whether THIS call brought the row into being, which is not the same
  // question as whether one existed when we looked. A concurrent
  // generation can claim between the read above and the create below; we
  // then adopt its row, and a row we adopted is not ours to remove.
  let claimedHere = false;
  const claim =
    existing ??
    (await prisma.billDocument
      .create({
        data: {
          utilityId,
          billId,
          documentType: PDF,
          storageIntegration: storage.integration,
          storageConnection: storage.connection,
          objectKey,
          templateKey: DEFAULT_TEMPLATE_KEY,
          isPaperless: bill.account.paperlessBilling,
        },
      })
      .then((row) => {
        claimedHere = true;
        return row;
      })
      .catch(async (err: unknown) => {
        // Lost the race: another generation claimed it first. Only a
        // unique-constraint collision means that; every other write
        // failure is a real one, and re-querying it would dress a broken
        // database up as a race and then rethrow something misleading.
        if (
          !(err instanceof Prisma.PrismaClientKnownRequestError) ||
          err.code !== "P2002"
        ) {
          throw err;
        }
        const won = await prisma.billDocument.findUnique({
          where: { billId_documentType: { billId, documentType: PDF } },
        });
        if (won) return won;
        throw err;
      }));

  if (claim.sha256 !== null && !opts.force) {
    return toRow(claim);
  }

  try {
    await putObject({
      integration: storage.integration,
      connection: storage.connection,
      key: objectKey,
      body: pdf,
      maxBytes: config.BILL_DOCUMENT_MAX_BYTES,
    });
  } catch (err) {
    // A claim with nothing stored is worse than no claim: it would read
    // as a document that cannot be downloaded. Only drop a claim this
    // call created — and because the claim was never audited, dropping
    // it needs no compensating audit row.
    //
    // `claimedHere`, not `!existing`: those differ exactly when a
    // concurrent generation claimed the row between the read and the
    // create. This call then adopted that row, and deleting it on our own
    // upload failure would pull the pointer out from under a generation
    // that may already have stored its bytes — leaving them orphaned and
    // an audit row asserting a document that no longer exists.
    if (claimedHere) {
      await prisma.billDocument.delete({ where: { id: claim.id } }).catch(() => {});
    }
    throw err;
  }

  // One audit row, written when the document becomes real. A first
  // store is the document's creation even though the SQL is an UPDATE —
  // what the log records is the fact, not the statement. A forced
  // regeneration over a stored document is a revision, and carries the
  // replaced hash in its before state so the replacement is traceable.
  //
  // "One" is enforced rather than assumed. Two concurrent generations can
  // both reach this point having uploaded the same bytes to the same key
  // (see the note on the claim above), and both would otherwise write
  // `bill_document.created` for a single document. The first store is
  // therefore a conditional update guarded on `sha256` still being null:
  // exactly one call can make that transition, and the one that loses
  // writes no audit row and returns what the winner stored. The audit row
  // stays in the same transaction as the mutation, which is the whole
  // point of audit-wrap, so this uses `writeAuditRow` directly rather
  // than doing the mutation outside it.
  const wasStored = claim.sha256 !== null;
  const data = {
          byteSize: pdf.length,
          sha256,
          generatedAt: new Date(),
          templateKey: DEFAULT_TEMPLATE_KEY,
          // Refreshed, not just set on the claim. The column is a copy
          // of the account's paperless flag *as of this generation*, so
          // it has to move whenever generatedAt moves — otherwise a
          // regenerated document reports whether the customer was
          // paperless months ago.
          isPaperless: bill.account.paperlessBilling,
          // Where the bytes actually went. `storage` is resolved from the
          // tenant's CURRENT settings and that is what putObject wrote to,
          // but on a forced regeneration the claim is the pre-existing row,
          // still carrying whatever integration it was first stored under.
          // Leaving these unwritten made the row describe a location that
          // does not hold the object: a tenant who changes their storage
          // integration and regenerates got bytes in the new store, a row
          // pointing at the old one, and a permanent 502 on every download
          // with the new bytes orphaned. Verified against a real
          // apptor-connect, which 404s an integration it does not have —
          // the local fake accepted every name, so this could not surface
          // until the contract was exercised for real.
    storageIntegration: storage.integration,
    storageConnection: storage.connection,
    objectKey,
  };

  const stored = await prisma.$transaction(async (tx) => {
    if (wasStored) {
      await tx.billDocument.update({ where: { id: claim.id }, data });
    } else {
      const won = await tx.billDocument.updateMany({
        where: { id: claim.id, sha256: null },
        data,
      });
      if (won.count === 0) return null;
    }
    const row = await tx.billDocument.findUniqueOrThrow({ where: { id: claim.id } });
    await writeAuditRow(
      tx,
      { utilityId, actorId, entityType: "BillDocument" },
      wasStored ? EVENT_TYPES.BILL_DOCUMENT_REVISED : EVENT_TYPES.BILL_DOCUMENT_CREATED,
      row.id,
      wasStored ? claim : null,
      row,
    );
    return row;
  });

  if (stored) return toRow(stored);

  // Lost the first-store transition. The winner wrote the same bytes to
  // the same key, so its row describes this call's work as faithfully as
  // ours would have.
  return toRow(
    await prisma.billDocument.findUniqueOrThrow({ where: { id: claim.id } }),
  );
}

/** The stored document and its bytes, scoped to the tenant. */
export async function readBillDocument(
  utilityId: string,
  billId: string,
): Promise<{ row: BillDocumentRow; bytes: Buffer }> {
  const found = await prisma.billDocument.findFirst({
    where: { billId, documentType: PDF, utilityId },
  });
  if (!found) {
    throw new BillDocumentError(`No document has been generated for bill ${billId}`, "NOT_GENERATED");
  }
  const row = toRow(found);
  const bytes = await getObject({
    integration: row.storageIntegration,
    connection: row.storageConnection,
    key: row.objectKey,
  });
  return { row, bytes };
}
