import { describe, it, expect } from "vitest";
import { describeOutcome, type MoveOutOutcome } from "../outcome";

/**
 * What a move-out tells the operator.
 *
 * Two things move money and the customer rings about both: the deposit
 * going back and the final bill going out. The final bill only started
 * existing on 2026-11-08 (spec 09 rule 9) — before that a move-out
 * silently billed nothing — so the sentence that reports it is the
 * whole point of these cases.
 */

const base: MoveOutOutcome = { depositReturn: null, finalBill: null, closingBalance: null };

describe("what a move-out says", () => {
  it("says nothing extra when nothing extra happened", () => {
    expect(describeOutcome(base)).toEqual({ text: "Move-out complete.", tone: "success" });
  });

  it("names the final bill, because that is the number the customer asks about", () => {
    const said = describeOutcome({
      ...base,
      finalBill: { billId: "b-1", total: "64.20", error: null },
      closingBalance: "64.20",
    });

    expect(said.text).toContain("Final bill of $64.20 issued.");
    expect(said.text).toContain("still owes $64.20");
    expect(said.tone).toBe("success");
  });

  /*
   * The service stopped; only the bill failed. Saying "Move-out
   * complete" would be true of the service and wrong about the
   * account, which is sitting at `FINAL` waiting for somebody.
   */
  it("does not call it complete when the final bill failed", () => {
    const said = describeOutcome({
      ...base,
      finalBill: {
        billId: null,
        total: null,
        error: "Cannot bill against unpublished rate schedule(s): RES-W v3.",
      },
    });

    expect(said.text).toMatch(/^Service stopped\./);
    expect(said.text).toContain("unpublished rate schedule");
    expect(said.text).toContain("held at Final");
    expect(said.tone).toBe("error");
  });

  /*
   * `stillOwed` is measured where the refund is written, which is
   * before the final bill exists. Quoting it beside a bill just raised
   * would tell the operator the customer owes nothing while a bill for
   * $64.20 was going in the post.
   */
  it("quotes the balance after the final bill, not the one from before it", () => {
    const said = describeOutcome({
      depositReturn: { refunded: "500.00", stillOwed: "0.00" },
      finalBill: { billId: "b-1", total: "64.20", error: null },
      closingBalance: "64.20",
    });

    expect(said.text).toContain("Deposit of $500.00 returned.");
    expect(said.text).toContain("This account still owes $64.20.");
    expect(said.text).not.toContain("$0.00");
  });

  it("says a deposit was asked for and none was held, rather than staying quiet", () => {
    const said = describeOutcome({
      ...base,
      depositReturn: { refunded: "0.00", stillOwed: "0.00" },
    });

    expect(said.text).toContain("No deposit was held");
  });

  it("leaves the balance out when nothing is owed", () => {
    const said = describeOutcome({
      ...base,
      depositReturn: { refunded: "500.00", stillOwed: "0.00" },
    });

    expect(said.text).toBe("Move-out complete. Deposit of $500.00 returned.");
  });
});
