import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { inflateSync } from "node:zlib";
import { generateBillPdf } from "../../bill-generation/generate-bill-pdf.js";
import type { BillPresentation } from "../../services/bill-presentation.service.js";

function presentation(
  lineCount: number,
  settlement: BillPresentation["settlement"] = null,
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
    ],
    totals: {
      subtotal: `${lineCount}.00`,
      taxes: "0.00",
      credits: "0.00",
      rounding: null,
      total: `${lineCount}.00`,
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
  const streams = /stream\r?\n([\s\S]*?)\r?\nendstream/g;
  let inflated = "";
  let stream: RegExpExecArray | null;
  while ((stream = streams.exec(latin)) !== null) {
    try {
      inflated += inflateSync(Buffer.from(stream[1], "latin1")).toString("latin1");
    } catch {
      inflated += stream[1];
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
