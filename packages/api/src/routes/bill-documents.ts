import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { parseIdParam } from "../lib/route-schemas.js";
import { ApptorConnectError } from "../lib/apptor-connect/files-client.js";
import { BillPresentationError } from "../services/bill-presentation.service.js";
import {
  BillDocumentError,
  generateBillDocument,
  readBillDocument,
  type BillDocumentRow,
} from "../services/bill-document.service.js";

/**
 * Generating and downloading a bill's PDF.
 *
 * The bytes always stream through this API. A link minted by
 * apptor-connect is a bearer credential that needs no login, so it never
 * reaches a browser and never appears in a response or a log —
 * authorization stays with our own RBAC.
 *
 * Producing a document is `accounts:EDIT` and reading one is
 * `accounts:VIEW`, because the first writes — a row, and an object in
 * the tenant's store — and the second does not. A regeneration shares the
 * write's authority rather than needing a higher one: output is
 * byte-stable, so replacing a document cannot change what it says, and
 * it cannot change what is owed. Gating it above `Post`, which makes a
 * bill owed on `EDIT`, would rank a byte-identical rewrite above the act
 * that creates the debt.
 *
 * It was briefly `accounts:APPROVE`, inherited from when "reprint" meant
 * issuing a corrected bill. That meaning is gone, and no preset role
 * grants `APPROVE` on `accounts` — only `service_suspensions` uses it —
 * so the gate made the endpoint unreachable by every seeded role,
 * including System Admin. The CSR on a call is exactly who needs to
 * reprint a bill, and a CSR holds `accounts:EDIT`.
 */

/** Only `force=true` forces; anything else leaves the call idempotent. */
const forceQuerySchema = z
  .object({ force: z.enum(["true", "false"]).optional() })
  .partial()
  .passthrough();

/** 422 — the tenant's data cannot make a bill. 409 — not a bill yet. */
const STATUS_BY_CODE: Record<string, number> = {
  ISSUER_INCOMPLETE: 422,
  RECIPIENT_INCOMPLETE: 422,
  NO_CHARGES: 422,
  STORAGE_NOT_CONFIGURED: 422,
  // Same family as the two above: the deployment is configured such that
  // this bill cannot be produced. Not a 413 back at the caller, who sent
  // nothing of the sort.
  DOCUMENT_TOO_LARGE: 422,
  NOT_POSTED: 409,
  NOT_GENERATED: 404,
};

/**
 * Mapped here rather than in the global error handler, which sends only
 * a code and a message: a 422 that does not name the missing fields
 * leaves an operator with nothing to act on.
 */
function sendDocumentError(
  request: FastifyRequest,
  reply: FastifyReply,
  err: unknown,
): FastifyReply {
  if (err instanceof BillDocumentError || err instanceof BillPresentationError) {
    return reply.status(STATUS_BY_CODE[err.code] ?? 500).send({
      error: {
        code: err.code,
        message: err.message,
        ...(err.missing.length > 0 ? { missing: err.missing } : {}),
      },
    });
  }
  if (err instanceof ApptorConnectError) {
    // Logged here because this is the last place the error exists: the
    // 502 below carries only the integration name, and because this
    // handler replies rather than rethrowing, the error never reaches
    // the global error handler either. Without this the `cause` that
    // distinguishes ECONNREFUSED from a DNS or TLS failure — and the
    // status, and which key was being read — was collected and then
    // dropped on the floor. Pino serialises `cause` under `err`.
    request.log.error(
      { err, integration: err.integration, status: err.status },
      "bill document storage failed",
    );
    // The integration name is what an operator needs to find the
    // misconfiguration. The minted link is never part of this.
    return reply.status(502).send({
      error: {
        code: "STORAGE_UNAVAILABLE",
        message: `The bill document store rejected the request (integration "${err.integration}")`,
        integration: err.integration,
      },
    });
  }
  throw err;
}

/**
 * What a caller is told about a document it just generated.
 *
 * Deliberately not the row. The row names where the bytes live —
 * `storageIntegration`, `storageConnection`, `objectKey` — and which
 * object store a tenant's bills sit in is not the client's business:
 * that is the same reasoning that keeps a minted capability link out of
 * every response. A cross-layer audit found the full row going to the
 * browser while neither caller read a single field of it.
 *
 * `sha256` and `byteSize` stay because they describe the bytes the
 * caller just caused to exist, and a client that wants to verify what
 * it downloads has nothing else to compare against.
 */
function producedDocument(row: BillDocumentRow) {
  return {
    billId: row.billId,
    documentType: row.documentType,
    byteSize: row.byteSize,
    sha256: row.sha256,
    generatedAt: row.generatedAt,
  };
}

/**
 * A bill number reaches a `Content-Disposition` header, so it is reduced
 * to characters that cannot close the quoted string or start a new
 * header line. Our own numbering never produces anything else; this is
 * what keeps a hand-edited number from becoming a header injection.
 */
function filenameFor(billNumber: string): string {
  return `bill-${billNumber.replace(/[^A-Za-z0-9._-]/g, "_")}.pdf`;
}

async function streamDocument(
  request: FastifyRequest,
  reply: FastifyReply,
  utilityId: string,
  billId: string,
  billNumber: string,
): Promise<FastifyReply> {
  try {
    const { bytes } = await readBillDocument(utilityId, billId);
    return reply
      .header("Content-Type", "application/pdf")
      .header("Content-Disposition", `attachment; filename="${filenameFor(billNumber)}"`)
      .send(bytes);
  } catch (err) {
    return sendDocumentError(request, reply, err);
  }
}

function notFound(reply: FastifyReply, billId: string): FastifyReply {
  return reply
    .status(404)
    .send({ error: { code: "NOT_FOUND", message: `Bill ${billId} not found` } });
}

export async function billDocumentRoutes(app: FastifyInstance) {
  /**
   * Idempotent without `force`: a bill whose document is already stored
   * returns the existing pointer without generating or re-uploading,
   * so a caller that cannot tell whether one exists can simply ask.
   * `?force=true` replaces it in place.
   */
  app.post(
    "/api/v1/bills/:id/document",
    { config: { module: "accounts", permission: "EDIT" } },
    async (request, reply) => {
      const { utilityId, id: actorId, name: actorName } = request.user;
      const billId = parseIdParam(request.params);
      const { force } = forceQuerySchema.parse(request.query);
      try {
        return reply.send(
          producedDocument(
            await generateBillDocument(utilityId, billId, actorId, actorName, {
              force: force === "true",
            }),
          ),
        );
      } catch (err) {
        return sendDocumentError(request, reply, err);
      }
    },
  );

  app.get(
    "/api/v1/bills/:id/document",
    { config: { module: "accounts", permission: "VIEW" } },
    async (request, reply) => {
      const { utilityId } = request.user;
      const billId = parseIdParam(request.params);
      const bill = await prisma.bill.findFirst({
        where: { id: billId, utilityId },
        select: { billNumber: true },
      });
      if (!bill) return notFound(reply, billId);
      return streamDocument(request, reply, utilityId, billId, bill.billNumber);
    },
  );

  /**
   * The customer's own copy. Scoped through the account's customerId,
   * and a bill belonging to someone else answers exactly as one that
   * does not exist — otherwise the 403/404 split would confirm which
   * bill ids are real.
   */
  app.get(
    "/portal/api/bills/:id/document",
    { config: { module: "portal_billing", permission: "VIEW" } },
    async (request, reply) => {
      const { utilityId, customerId } = request.user;
      if (!customerId) {
        return reply.status(403).send({
          error: {
            code: "FORBIDDEN",
            message: "Portal endpoints require a customer-scoped token",
          },
        });
      }
      const billId = parseIdParam(request.params);
      const bill = await prisma.bill.findFirst({
        where: { id: billId, utilityId, account: { customerId } },
        select: { billNumber: true },
      });
      if (!bill) return notFound(reply, billId);
      return streamDocument(request, reply, utilityId, billId, bill.billNumber);
    },
  );
}
