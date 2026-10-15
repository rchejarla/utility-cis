/**
 * What a bill's status looks like, wherever a bill is listed.
 *
 * Extracted from the bills page because the account's Bills tab showed
 * the same bills with no status at all, and the obvious way to give it
 * one — ask the two money columns in the browser — is precisely the bug
 * this ladder was fixed to stop. `overdue` and `partPaid` are decided by
 * the API (`BillSettlement` in bill.service.ts) so a row and the
 * `state=` filter cannot disagree; a second copy of the reasoning here
 * would be a second chance to drift.
 */
import type React from "react";

/** The fields the pill reads, and nothing else a list might carry. */
export interface BillStatusFields {
  postedAt: string | null;
  dueDate: string;
  overdue: boolean;
  partPaid: boolean;
  charge: { entryId: string; openAmount: string; reversed: boolean } | null;
}

function fmtDate(iso: string): string {
  const [y, m, d] = iso.slice(0, 10).split("-");
  return `${m}/${d}/${y}`;
}

export function Pill({
  children,
  tone,
  title,
}: {
  children: React.ReactNode;
  tone: string;
  title?: string;
}) {
  return (
    <span
      title={title}
      style={{
        display: "inline-block",
        padding: "2px 8px",
        fontSize: 10,
        fontWeight: 700,
        textTransform: "uppercase",
        letterSpacing: "0.05em",
        color: tone,
        // `tone` is a `var(--…)` reference, and `var(--danger)18` is not
        // that colour at 0x18 alpha: var() substitutes a whole token, so
        // both of these declarations were dropped and every status pill
        // rendered as bare coloured text with no chip behind it.
        background: `color-mix(in srgb, ${tone} 9%, transparent)`,
        border: `1px solid color-mix(in srgb, ${tone} 25%, transparent)`,
        borderRadius: 999,
        whiteSpace: "nowrap",
      }}
    >
      {children}
    </span>
  );
}

/**
 * Settled-ness, not just issuance. "Posted" was the only thing this said
 * once a bill was owed, so a fully paid bill looked identical to an
 * unpaid one.
 */
export function BillStatusPill({ bill }: { bill: BillStatusFields }) {
  if (bill.charge?.reversed) {
    return (
      <Pill tone="var(--text-muted)" title="The charge was reversed, so it no longer stands">
        Reversed
      </Pill>
    );
  }
  if (bill.charge && Number(bill.charge.openAmount) === 0) {
    return (
      <Pill tone="var(--success)" title="Nothing is owed on this bill">
        Paid
      </Pill>
    );
  }
  if (bill.postedAt && !bill.charge) {
    // Posted, but it raised no charge: a bill whose total rounds to 0.00
    // posts without a debit, so there is nothing to owe. This used to
    // fall all the way through to "Outstanding" and sit there
    // permanently on a bill that was settled the moment it posted.
    return (
      <Pill tone="var(--success)" title="Posted with nothing to charge">
        Paid
      </Pill>
    );
  }
  if (bill.charge && bill.overdue) {
    return (
      <Pill tone="var(--danger)" title={`Was due ${fmtDate(bill.dueDate)}`}>
        Overdue
      </Pill>
    );
  }
  if (bill.charge && bill.partPaid) {
    return (
      <Pill tone="var(--warning)" title="Part of this bill has been paid">
        Part paid
      </Pill>
    );
  }
  if (bill.postedAt) {
    return (
      <Pill tone="var(--info)" title={`Posted ${fmtDate(bill.postedAt)} — still owed in full`}>
        Outstanding
      </Pill>
    );
  }
  return (
    <Pill
      tone="var(--warning)"
      title="Calculated but not yet owed — it has not moved the account balance"
    >
      Not posted
    </Pill>
  );
}
