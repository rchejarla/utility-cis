import type { FastifyInstance, FastifyReply } from "fastify";
import { prisma } from "../lib/prisma.js";
import { parseIdParam } from "../lib/route-schemas.js";
import { ApptorConnectError } from "../lib/apptor-connect/files-client.js";
import { BillPresentationError } from "../services/bill-presentation.service.js";
import {
  BillDocumentError,
  renderBillDocument,
  readBillDocument,
} from "../services/bill-document.service.js";

/**
 * Rendering and downloading a bill's PDF.
 *
 * The bytes always stream through this API. A link minted by
 * apptor-connect is a bearer credential that needs no login, so it never
 * reaches a browser and never appears in a response or a log —
 * authorization stays with our own RBAC.
 *
 * A forced re-render is its own endpoint rather than `?force=true`,
 * because it needs different authority (`accounts:APPROVE`, not `VIEW`)
 * and route config is the one place this codebase enforces permissions.
 * A single endpoint switching on a query flag would mean hand-rolling a
 * second permission check inside a handler.
 */

/** 422 — the tenant's data cannot make a bill. 409 — not a bill yet. */
const STATUS_BY_CODE: Record<string, number> = {
  ISSUER_INCOMPLETE: 422,
  RECIPIENT_INCOMPLETE: 422,
  NO_CHARGES: 422,
  STORAGE_NOT_CONFIGURED: 422,
  NOT_POSTED: 409,
  NOT_RENDERED: 404,
};

/**
 * Mapped here rather than in the global error handler, which sends only
 * a code and a message: a 422 that does not name the missing fields
 * leaves an operator with nothing to act on.
 */
function sendDocumentError(reply: FastifyReply, err: unknown): FastifyReply {
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
 * A bill number reaches a `Content-Disposition` header, so it is reduced
 * to characters that cannot close the quoted string or start a new
 * header line. Our own numbering never produces anything else; this is
 * what keeps a hand-edited number from becoming a header injection.
 */
function filenameFor(billNumber: string): string {
  return `bill-${billNumber.replace(/[^A-Za-z0-9._-]/g, "_")}.pdf`;
}

async function streamDocument(
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
    return sendDocumentError(reply, err);
  }
}

function notFound(reply: FastifyReply, billId: string): FastifyReply {
  return reply
    .status(404)
    .send({ error: { code: "NOT_FOUND", message: `Bill ${billId} not found` } });
}

export async function billDocumentRoutes(app: FastifyInstance) {
  app.post(
    "/api/v1/bills/:id/document",
    { config: { module: "accounts", permission: "VIEW" } },
    async (request, reply) => {
      const { utilityId, id: actorId } = request.user;
      const billId = parseIdParam(request.params);
      try {
        return reply.send(await renderBillDocument(utilityId, billId, actorId));
      } catch (err) {
        return sendDocumentError(reply, err);
      }
    },
  );

  /**
   * Replaces the stored document in place. It does not change what is
   * owed — nothing about the bill's amounts is re-rated — which is why
   * it carries approval authority rather than being a second Generate.
   */
  app.post(
    "/api/v1/bills/:id/document/re-render",
    { config: { module: "accounts", permission: "APPROVE" } },
    async (request, reply) => {
      const { utilityId, id: actorId } = request.user;
      const billId = parseIdParam(request.params);
      try {
        return reply.send(await renderBillDocument(utilityId, billId, actorId, { force: true }));
      } catch (err) {
        return sendDocumentError(reply, err);
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
      return streamDocument(reply, utilityId, billId, bill.billNumber);
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
      return streamDocument(reply, utilityId, billId, bill.billNumber);
    },
  );
}
