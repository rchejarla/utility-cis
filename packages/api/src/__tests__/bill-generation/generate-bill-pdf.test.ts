import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { constants, inflateSync } from "node:zlib";
import { generateBillPdf } from "../../bill-generation/generate-bill-pdf.js";
import { Decimal } from "decimal.js";
import type {
  BillPresentation,
  BillPresentationGroup,
} from "../../services/bill-presentation.service.js";

function presentation(
  lineCount: number,
  settlement: BillPresentation["settlement"] = null,
  fees: BillPresentationGroup | null = null,
): BillPresentation {
  return {
    issuer: {
      name: "City of Testville Utilities",
      legalName: "City of Testville, Montana",
      addressLines: ["PO Box 1230", "Testville, MT 59771"],
      phone: "406-555-0100",
      email: "ub@testville.gov",
      website: "https://testville.gov",
    },
    recipient: { name: "Jane Smith", addressLines: ["12 Elm St", "Testville, MT 59771"] },
    account: { number: "A-900", id: "acct-1" },
    bill: {
      number: "B-1001",
      billDate: new Date("2026-03-01"),
      dueDate: new Date("2026-03-31"),
      periodStart: new Date("2026-02-01"),
      periodEnd: new Date("2026-02-28"),
    },
    groups: [
      {
        heading: "Water",
        lines: Array.from({ length: lineCount }, (_, i) => ({
          label: `Charge ${i + 1}`,
          quantity: "1.00",
          amount: "1.00",
        })),
        subtotal: `${lineCount}.00`,
      },
      ...(fees ? [fees] : []),
    ],
    // The same object as the last group above, which is the contract.
    feesGroup: fees ?? null,
    totals: {
      subtotal: `${lineCount}.00`,
      taxes: "0.00",
      credits: "0.00",
      rounding: null,
      fees: fees ? fees.subtotal : null,
      total: fees
        ? new Decimal(lineCount).plus(fees.subtotal).toFixed(2)
        : `${lineCount}.00`,
    },
    settlement,
    messages: [{ label: "Notice", body: "Water restrictions begin June 1." }],
    branding: { logoUrl: null, primaryColor: "#1f2937", fontFamily: "Helvetica" },
    remittance: {
      payTo: "City of Testville, Montana",
      addressLines: ["PO Box 1230", "Testville, MT 59771"],
      // As the service does it: the stub asks for what is left, not what
      // was raised.
      amountDue: settlement ? settlement.amountDue : `${lineCount}.00`,
      dueDate: new Date("2026-03-31"),
    },
  };
}

function pageCount(pdf: Buffer): number {
  return (pdf.toString("latin1").match(/\/Type\s*\/Page[^s]/g) ?? []).length;
}

/**
 * Extracts the text a page actually draws.
 *
 * Two layers have to be undone. Content streams are Flate-compressed,
 * so searching raw bytes only ever finds uncompressed metadata — which
 * is how a weaker version of this test passed while proving nothing
 * about the page. Then react-pdf writes text as TJ arrays of
 * hex-encoded chunks with kerning numbers between them
 * (`[<43> 0 <69> 0 <7479206f6620> 50 ...] TJ`), so a word arrives in
 * pieces and has to be reassembled.
 */
function extractText(pdf: Buffer): string {
  const latin = pdf.toString("latin1");
  let inflated = "";
  /*
   * From each `stream` keyword to the end of the file, not to the next
   * `endstream`. Compressed data is binary and may contain those nine
   * bytes itself, and a boundary regex then cuts the stream short —
   * inflation fails, the old helper fell back to appending the raw
   * compressed bytes, and a document whose text was all present
   * extracted as "". Found by adding a block to the template: the PDF
   * grew by 300 bytes and the extracted text went from 517 characters
   * to none.
   *
   * Z_SYNC_FLUSH takes the first zlib member and ignores whatever
   * follows it, so the rest of the file being appended costs nothing.
   */
  const streamStarts = /stream\r?\n/g;
  let start: RegExpExecArray | null;
  while ((start = streamStarts.exec(latin)) !== null) {
    const from = start.index + start[0].length;
    try {
      inflated += inflateSync(Buffer.from(latin.slice(from), "latin1"), {
        finishFlush: constants.Z_SYNC_FLUSH,
      }).toString("latin1");
    } catch {
      // Not a Flate stream — an embedded font or image. No text in it.
    }
  }

  let text = "";
  const tjArrays = /\[([^\]]*)\]\s*TJ/g;
  const hexChunks = /<([0-9a-fA-F]+)>/g;
  let arr: RegExpExecArray | null;
  while ((arr = tjArrays.exec(inflated)) !== null) {
    hexChunks.lastIndex = 0;
    let chunk: RegExpExecArray | null;
    while ((chunk = hexChunks.exec(arr[1])) !== null) {
      text += Buffer.from(chunk[1], "hex").toString("latin1");
    }
  }

  return text;
}

const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

describe("generateBillPdf", () => {
  it("produces a valid PDF", async () => {
    const pdf = await generateBillPdf(presentation(3));

    expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
    expect(pdf.length).toBeGreaterThan(1000);
  }, 30_000);

  it("draws the issuer, the bill and account numbers, and every charge label", async () => {
    const pdf = await generateBillPdf(presentation(3));
    const text = extractText(pdf);

    for (const needle of [
      "City of Testville Utilities",
      "Jane Smith",
      "B-1001",
      "A-900",
      "Charge 1",
      "Charge 2",
      "Charge 3",
      "Water restrictions begin June 1.",
    ]) {
      expect(text).toContain(needle);
    }
  }, 30_000);

  /**
   * Every amount carries a currency symbol. A bare "110.75" on a bill is
   * ambiguous on paper, and the presentation deliberately carries plain
   * 2dp strings — so if the template stops formatting them, nothing else
   * would notice.
   */
  /**
   * The line a customer looks for first.
   *
   * A bill that has been partly paid used to say nothing about the
   * payment and print "Credits $0.00" — the rate engine's credits for
   * the period, which a payer reads as their money counted at nothing.
   */
  it("itemises payments received, and asks only for what is left", async () => {
    const pdf = await generateBillPdf(
      presentation(3, {
        applied: [
          { date: new Date("2026-02-14"), label: "Payment (check)", amount: "-2.00" },
        ],
        appliedTotal: "-2.00",
        amountDue: "1.00",
      }),
    );
    const text = extractText(pdf);

    // The section heading uses the label style, which uppercases.
    expect(text).toContain("PAYMENTS AND CREDITS RECEIVED");
    expect(text).toContain("Payment (check) 2026-02-14");
    expect(text).toContain("-$2.00");
    // What was raised and what is owed, both stated and distinguishable.
    expect(text).toContain("Total billed$3.00");
    expect(text).toContain("Amount due$1.00");
    expect(text).not.toContain("Total due");
    // And the remittance stub asks for the reduced figure, not the
    // charge — paying the printed stub must not overpay by the amount
    // already received.
    expect(text).toContain("AMOUNT DUE$1.00");
  }, 30_000);

  /*
   * A late fee produces no bill line — lines come from the rate engine
   * and carry a rate component — so without this block the customer
   * owes more than the bill says with nothing explaining the
   * difference. Itemised and dated for the same reason payments are.
   */
  it("prints fees as charge lines, and carries them into the total", async () => {
    const pdf = await generateBillPdf(
      presentation(3, null, {
        heading: "Fees and adjustments",
        lines: [
          { label: "Late payment fee 2026-02-10", quantity: null, amount: "25.00" },
          { label: "Credit adjustment 2026-02-18", quantity: null, amount: "-5.00" },
        ],
        subtotal: "20.00",
      }),
    );
    const text = extractText(pdf);

    // A group heading like any other, among the commodity charges.
    expect(text).toContain("Fees and adjustments");
    expect(text).toContain("Late payment fee 2026-02-10");
    expect(text).toContain("$25.00");
    expect(text).toContain("Credit adjustment 2026-02-18");
    expect(text).toContain("-$5.00");
    // And the page adds up: the group subtotal reaches the total.
    expect(text).toContain("Total due$23.00");
  });

  it("prints no fees row when there are none", async () => {
    const text = extractText(await generateBillPdf(presentation(3)));
    expect(text).not.toContain("Fees and adjustments");
    expect(text).toContain("Total due$3.00");
  });

  it("leaves an unpaid bill exactly as it was, with no zero-credit line", async () => {
    const text = extractText(await generateBillPdf(presentation(3)));

    expect(text).toContain("Total due");
    expect(text).not.toContain("Payments and credits received");
    // The row that used to state $0.00 against a customer's payment.
    expect(text).not.toContain("Credits");
  }, 30_000);

  it("prints every amount with a currency symbol", async () => {
    const pdf = await generateBillPdf(presentation(3));
    const text = extractText(pdf);

    // Line amount, group subtotal, the totals block and the stub.
    expect(text).toContain("$1.00");
    expect(text).toContain("$3.00");
    expect(text).toContain("$0.00");

    // A charge row, read straight out of the concatenated text runs:
    // label, then the bare quantity, then the amount with its symbol.
    // This pins both halves — that amounts are formatted, and that the
    // quantity column is NOT, since a quantity is not money.
    expect(text).toContain("Charge 11.00$1.00");
  }, 30_000);

  it("groups thousands, so a large commercial bill stays readable", async () => {
    const big = presentation(1);
    big.groups[0].lines[0].amount = "1234567.89";
    big.groups[0].subtotal = "1234567.89";
    big.totals.subtotal = "1234567.89";
    big.totals.total = "1234567.89";
    big.remittance.amountDue = "1234567.89";

    const text = extractText(await generateBillPdf(big));

    expect(text).toContain("$1,234,567.89");
  }, 30_000);

  // Review Focus 4 — silent truncation at a page boundary loses charges.
  it("paginates a long bill without losing lines", async () => {
    const many = await generateBillPdf(presentation(120));
    const text = extractText(many);

    expect(pageCount(many)).toBeGreaterThan(1);
    expect(text).toContain("Charge 1");
    expect(text).toContain("Charge 120");
  }, 60_000);

  // Spec §4.5's idempotent-overwrite reasoning depends on this.
  it("is byte-stable across renders of the same presentation", async () => {
    const a = await generateBillPdf(presentation(3));
    const b = await generateBillPdf(presentation(3));

    expect(sha(a)).toBe(sha(b));
  }, 60_000);

  it("renders different bytes when the content differs", async () => {
    const a = await generateBillPdf(presentation(3));
    const b = await generateBillPdf(presentation(4));

    expect(sha(a)).not.toBe(sha(b));
  }, 60_000);
});
