/**
 * What a billing-run preview reports about accounts it cannot, or
 * should not, bill cleanly.
 *
 * **In `shared` because both sides need the same answer.** The API
 * builds these in `services/billing-run/planning.ts` and the web renders
 * them in `components/billing-runs/run-format.ts`, which kept its own
 * hand-written copy of both interfaces — including the union of codes.
 * A code added on one side and not the other type-checks on both and
 * renders as nothing: `describeBlocker` would fall through its switch
 * and the operator would see an empty row where a reason should be.
 *
 * The *wording* stays in the web, where it belongs — these are the
 * shapes, not the sentences.
 */

/**
 * A reason some of the eligible accounts cannot be billed, and what to
 * fix. Grouped by cause rather than listed per account: one publish or
 * one assignment usually clears the whole group.
 */
export interface RunBlocker {
  code:
    | "NO_ACTIVE_ASSIGNMENTS"
    | "SCHEDULE_NOT_PUBLISHED"
    /*
     * Both TOU codes are blockers rather than warnings on an observable
     * test: does a bill come out? The `tou_period` quantity source
     * raises when a period it prices has no bucket, so these two stop
     * rating and the account genuinely cannot be billed (spec 26,
     * TOU-BIL-1).
     */
    | "TOU_PERIOD_NOT_REPORTED"
    | "TOU_NO_READS";
  accountCount: number;
  /** The thing to go and fix — schedule codes, or the agreements. */
  detail: string;
  /** A few account numbers, so the group is recognisable. */
  sampleAccounts: string[];
}

/**
 * Something wrong with an account that **will still be billed**.
 *
 * A separate list from `RunBlocker` because the instruction is
 * different, and mixing them would make the preview's headline lie: it
 * reads "N of M cannot be billed yet", and these all can be. They will
 * simply be billed **wrongly**, in ways nothing about the resulting bill
 * reveals — a TOU calendar mismatch bills against hours the meter was
 * not counting by and every figure reconciles.
 *
 * Same shape as a blocker, grouped by cause for the same reason: one
 * fix usually clears the whole group.
 */
export interface RunWarning {
  code: "TOU_CALENDAR_MISMATCH" | "TOU_CALENDAR_UNKNOWN" | "TOU_REGISTERS_UNRECONCILED";
  accountCount: number;
  detail: string;
  sampleAccounts: string[];
}
