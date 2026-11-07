import { z } from "zod";

/**
 * The interval-coverage queue — what a nightly sweep found wrong with an
 * interval meter's data, and what somebody decided about it (spec 26,
 * TOU-GAP-1).
 *
 * **Why these lists live here.** `kind` and `status` are VARCHAR columns
 * with CHECK constraints rather than Postgres enums, which is right for
 * a vocabulary that grows — but it means nothing generates them, and the
 * column's type is wider than what it may hold. Writing them down in the
 * migration and again inside the API left the screen that lists these
 * rows to invent its own copy for its filter pills, which is how this
 * repo ended up with three pills that had never matched a row.
 */

/**
 * Why a meter's intervals cannot be billed as they stand.
 *
 * The first three are failures to **tile** the window — it is not
 * covered, or part of it is covered twice. The fourth is a property of a
 * row that exists: the meter reported no value for it, which tiling
 * cannot see because the interval is there and covers its minutes.
 */
export const DATA_EXCEPTION_KINDS = ["gap", "overlap", "overrun", "missing_reading"] as const;

export const dataExceptionKindEnum = z.enum(DATA_EXCEPTION_KINDS);

/**
 * What has been decided about one.
 *
 * - `open` — found, and nobody has decided anything yet.
 * - `accepted` — "bill the month as it stands". The pre-run check reads
 *   this and stops blocking exactly these minutes, which is the whole
 *   point of the status and the reason accepting is a privileged act.
 * - `estimated` — a value was supplied for the missing minutes. Set by
 *   the estimator, which is not built; the status exists because the
 *   sweep must already know not to re-open such a row.
 * - `resolved` — the data arrived. **The sweep's to set, never a
 *   person's:** it means the hole is gone, and a human saying so while
 *   it is still there would silently undercharge. A row that stops
 *   mattering for any other reason is `accepted`.
 */
export const DATA_EXCEPTION_STATUSES = ["open", "accepted", "estimated", "resolved"] as const;

export const dataExceptionStatusEnum = z.enum(DATA_EXCEPTION_STATUSES);

export const meterDataExceptionSortFields = [
  "windowStart",
  "detectedAt",
  "minutesAffected",
] as const;

/**
 * Listing the queue.
 *
 * Every filter is optional and none defaults, which is the convention
 * the other list queries here follow: a default filter is one the caller
 * never asked for and cannot turn off, and "everything, including what
 * the sweep has resolved" is a real question — it is how a meter that
 * fails every month becomes visible. The screen defaults its own status
 * pill to `open`, which is where the work is.
 */
export const meterDataExceptionQuerySchema = z
  .object({
    page: z.coerce.number().int().positive().default(1),
    limit: z.coerce.number().int().positive().max(500).default(20),
    sort: z.enum(meterDataExceptionSortFields).default("windowStart"),
    order: z.enum(["asc", "desc"]).default("desc"),
    status: dataExceptionStatusEnum.optional(),
    kind: dataExceptionKindEnum.optional(),
    meterId: z.string().uuid().optional(),
    /** Windows starting on or after this date, and before `toDate`. */
    fromDate: z.string().date().optional(),
    toDate: z.string().date().optional(),
  })
  .strict();

export type DataExceptionKind = z.infer<typeof dataExceptionKindEnum>;
export type DataExceptionStatus = z.infer<typeof dataExceptionStatusEnum>;
export type MeterDataExceptionQuery = z.infer<typeof meterDataExceptionQuerySchema>;

/**
 * One row of the queue, as the API returns it — timestamps as ISO
 * strings, and the meter nested the way the route includes it rather
 * than flattened, so this describes the response instead of describing
 * a response somebody would have to build.
 */
export interface MeterDataExceptionDto {
  id: string;
  meterId: string;
  windowStart: string;
  windowEnd: string;
  kind: DataExceptionKind;
  minutesAffected: number;
  detail: string;
  status: DataExceptionStatus;
  detectedAt: string;
  /** When it stopped being `open` — not when the data arrived. */
  resolvedAt: string | null;
  meter: { id: string; meterNumber: string };
}
