import { createHash } from "node:crypto";
import { billDocumentSettingsSchema } from "@utility-cis/shared";
import { prisma } from "../lib/prisma.js";
import { config } from "../config.js";
import { auditUpdate } from "../lib/audit-wrap.js";
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
  const integration = parsed.success ? parsed.data.storageIntegration : undefined;
  if (!integration) {
    throw new BillDocumentError(
      "No bill-document storage integration is configured for this tenant. Set it under Settings.",
      "STORAGE_NOT_CONFIGURED",
      ["billDocuments.storageIntegration"],
    );
  }
  const connection = parsed.success ? parsed.data.storageConnection || null : null;
  return { integration, connection };
}

/**
 * Generate a bill's PDF, store it, and return the pointer.
 *
 * Order matters and is the reverse of a filesystem design. The row is
 * claimed FIRST, so the unique constraint on (bill_id, document_type)
 * decides which of two concurrent generations proceeds and the loser never
 * uploads at all. That keeps correctness independent of whether two
 * generations produce identical bytes — they do today, and a stabilizer
 * keeps it that way, but a design that breaks when the generator changes
 * is a design waiting to break.
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
      .catch(async (err: unknown) => {
        // Lost the race: another generation claimed it first.
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
    if (!existing) {
      await prisma.billDocument.delete({ where: { id: claim.id } }).catch(() => {});
    }
    throw err;
  }

  // One audit row, written when the document becomes real. A first
  // store is the document's creation even though the SQL is an UPDATE —
  // what the log records is the fact, not the statement. A forced
  // regeneration over a stored document is a revision, and carries the
  // replaced hash in its before state so the replacement is traceable.
  const wasStored = claim.sha256 !== null;
  const stored = await auditUpdate(
    { utilityId, actorId, entityType: "BillDocument" },
    wasStored ? "bill_document.revised" : "bill_document.created",
    wasStored ? claim : null,
    (tx) =>
      tx.billDocument.update({
        where: { id: claim.id },
        data: { byteSize: pdf.length, sha256, generatedAt: new Date(), templateKey: DEFAULT_TEMPLATE_KEY },
      }),
  );

  return toRow(stored);
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
