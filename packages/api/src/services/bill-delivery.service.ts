import { prisma } from "../lib/prisma.js";
import { sendNotification } from "./notification.service.js";

/**
 * Sending a posted bill to the customer it is addressed to.
 *
 * Bozeman #132, and the last step of bill production: a bill could be
 * rated, posted, rendered to a stored PDF and downloaded by staff or by
 * the customer, and nothing had ever sent one.
 *
 * Delivery is a `Notification`, not a table of its own. That row already
 * records what a delivery record has to — channel, the address it went
 * to, status, the provider and its message id, attempts, when it was
 * sent, and the error if it was not — with a queue draining it, retries,
 * quiet hours and per-tenant templates on top. Writing a second table
 * would restate eight columns and a worker to gain nothing. What was
 * missing was the link, which is now `notification.bill_id`.
 *
 * So this module owns the question "may this bill be sent, and to
 * whom", and hands the sending itself to machinery that already exists.
 * It deliberately does not reach a mail provider: `notification.service`
 * dispatches through its provider abstraction, which is a console stub
 * in development until the apptor-connect `sendgrid` connector is
 * wired. A bill queued here is a bill queued for whatever that provider
 * turns out to be.
 */

/** The event a tenant's template is keyed on. */
export const BILL_READY_EVENT = "billing.bill_ready";

export interface BillDeliveryRow {
  id: string;
  channel: string;
  status: string;
  recipientEmail: string | null;
  attempts: number;
  sentAt: Date | null;
  error: string | null;
  createdAt: Date;
}

/** The facts that decide whether a bill may be sent. */
export interface DeliverabilityFacts {
  billNumber: string;
  accountNumber: string;
  posted: boolean;
  /** The bill's own reason, or the account's standing rule. */
  holdReason: string | null;
  hasDocument: boolean;
  hasEmail: boolean;
}

export interface DeliveryBlocker {
  code: string;
  statusCode: number;
  message: string;
}

/**
 * Why this bill cannot be sent, or null if nothing is in the way.
 *
 * One definition, used twice: `deliverBill` throws by it, and the bill
 * list labels rows with it. Two copies of this order would drift, and a
 * list that says "ready" over a button that refuses is worse than a
 * list that says nothing — this codebase has paid for that mistake
 * several times over.
 *
 * The order is the order an operator can act in: posting precedes
 * everything, a hold is a decision somebody made and outranks a missing
 * file, and an address is only worth mentioning once there is something
 * to send.
 */
export function whyNotDeliverable(f: DeliverabilityFacts): DeliveryBlocker | null {
  if (!f.posted) {
    return {
      code: "BILL_NOT_POSTED",
      statusCode: 409,
      message:
        `Bill ${f.billNumber} has not been posted. A bill that is not posted is a calculation — ` +
        "nobody owes it yet, so there is nothing to send. Post it first.",
    };
  }
  if (f.holdReason) {
    return {
      code: "BILL_ON_HOLD",
      statusCode: 409,
      message: `Bill ${f.billNumber} is on hold: ${f.holdReason}. Release it before sending.`,
    };
  }
  if (!f.hasDocument) {
    return {
      code: "NO_BILL_DOCUMENT",
      statusCode: 409,
      message: `Bill ${f.billNumber} has no rendered document to send. Generate the PDF first.`,
    };
  }
  if (!f.hasEmail) {
    return {
      code: "NO_EMAIL_ADDRESS",
      statusCode: 422,
      message: `${f.accountNumber}'s customer has no email address. Add one, or send this bill by post.`,
    };
  }
  return null;
}

function refuse(code: string, statusCode: number, message: string): never {
  throw Object.assign(new Error(message), { statusCode, code });
}

/**
 * Queue one bill for delivery.
 *
 * Returns the notification id. Resending is allowed and makes a second
 * row: a utility resends a bill routinely — the customer deleted it, the
 * address was wrong, a CSR is asked for it on the phone — and each
 * attempt is its own fact. What is refused is a *second queue entry
 * while one is still in flight*, which would send the same bill twice
 * for one click.
 */
export async function deliverBill(utilityId: string, billId: string): Promise<string> {
  const bill = await prisma.bill.findFirst({
    where: { id: billId, utilityId },
    select: {
      id: true,
      billNumber: true,
      accountId: true,
      postedAt: true,
      holdReason: true,
      account: {
        select: {
          accountNumber: true,
          billingHoldReason: true,
          customerId: true,
          customer: { select: { id: true, email: true } },
        },
      },
      documents: { select: { id: true }, take: 1 },
    },
  });
  if (!bill) {
    refuse("BILL_NOT_FOUND", 404, `Bill ${billId} not found`);
  }

  const customer = bill.account.customer;
  if (!customer) {
    refuse(
      "NO_CUSTOMER",
      409,
      `Account ${bill.account.accountNumber} has no customer to send to.`,
    );
  }

  /*
   * Every reason a bill may not go, in one place — see
   * `whyNotDeliverable`. The list labels its rows with the same
   * function, so what an operator reads and what this refuses cannot
   * disagree.
   */
  const blocked = whyNotDeliverable({
    billNumber: bill.billNumber,
    accountNumber: bill.account.accountNumber,
    posted: bill.postedAt !== null,
    holdReason: bill.holdReason ?? bill.account.billingHoldReason,
    hasDocument: bill.documents.length > 0,
    hasEmail: !!customer.email,
  });
  if (blocked) refuse(blocked.code, blocked.statusCode, blocked.message);

  const inFlight = await prisma.notification.findFirst({
    where: { utilityId, billId: bill.id, status: { in: ["PENDING", "SENDING"] } },
    select: { id: true },
  });
  if (inFlight) {
    refuse(
      "DELIVERY_IN_FLIGHT",
      409,
      `Bill ${bill.billNumber} is already queued for delivery. Wait for that attempt to finish before sending again.`,
    );
  }

  const notificationId = await sendNotification(utilityId, {
    eventType: BILL_READY_EVENT,
    channel: "EMAIL",
    recipientId: customer.id,
    billId: bill.id,
    context: {
      accountId: bill.accountId,
      billNumber: bill.billNumber,
    },
  });

  /*
   * `sendNotification` answers null when the tenant has no active
   * template for the event, and logs it. For a scheduled notice that is
   * the right quiet outcome; for a person pressing Send on one bill it
   * is not — they would be told it worked and nothing would arrive.
   */
  if (!notificationId) {
    refuse(
      "NO_ACTIVE_TEMPLATE",
      422,
      `This tenant has no active '${BILL_READY_EVENT}' notification template, so there is nothing to send. ` +
        "Add one under Settings → Notification Templates.",
    );
  }

  return notificationId;
}

/** Every attempt to deliver a bill, newest first. */
export async function listBillDeliveries(
  utilityId: string,
  billId: string,
): Promise<BillDeliveryRow[]> {
  const rows = await prisma.notification.findMany({
    where: { utilityId, billId },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      channel: true,
      status: true,
      recipientEmail: true,
      attempts: true,
      sentAt: true,
      error: true,
      createdAt: true,
    },
  });
  return rows;
}
