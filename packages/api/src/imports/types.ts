import type { Prisma } from "@utility-cis/shared/src/generated/prisma";
import type {
  CanonicalFieldDef,
  ImportKindHandlerMeta,
  ParseRowResult,
  RowResult,
} from "@utility-cis/shared";

/**
 * Prisma transaction client type — every kind handler must do its
 * writes through `ctx.tx` so the framework can wrap each row in its
 * own transaction. Captured as a derived type rather than typed
 * literally so it stays in sync with whichever Prisma version we run.
 */
export type ImportTx = Omit<
  Prisma.TransactionClient,
  "$connect" | "$disconnect" | "$on" | "$transaction" | "$use" | "$extends"
>;

export interface HandlerContext {
  utilityId: string;
  actorId: string;
  actorName: string;
  tx: ImportTx;
}

/**
 * Each entity that wants bulk import implements one of these and
 * registers it via `registerImportKind` at API boot. The framework
 * handles file storage, parsing, mapping, per-row dispatch, error
 * reporting, status tracking, and audit; the handler only owns the
 * per-row business logic.
 */
export interface ImportKindHandler<TRow = unknown, TBatch = void>
  extends ImportKindHandlerMeta {
  /**
   * Convert a raw row (object keyed by canonical-field name; values
   * are strings as parsed by papaparse) into the typed shape
   * `processRow` accepts. Pre-validation and normalisation live here.
   * Returning `{ ok: false }` records the row as ERROR and skips
   * `processRow` for it.
   */
  parseRow: (raw: Record<string, string>) => ParseRowResult<TRow>;

  /**
   * Optional pre-pass invoked once per batch before any row is
   * processed. Useful for caching expensive lookups (e.g., a meter-
   * number → meter map) so per-row dispatch is O(1). The returned
   * value is threaded back through every `processRow` call as the
   * `batch` argument. Source identifies which `ImportBatchSource`
   * the operator chose so handlers can derive defaults (e.g.,
   * meter-read's batch-source → read-source mapping). Defaults to
   * `void` when omitted.
   */
  prepareBatch?: (
    ctx: Omit<HandlerContext, "tx"> & {
      source: "AMR" | "AMI" | "MANUAL_UPLOAD" | "API";
    },
    rows: TRow[],
  ) => Promise<TBatch>;

  /**
   * Process one parsed row. Runs inside the framework-supplied tx.
   * `batch` is whatever `prepareBatch` returned (or `undefined` if
   * the handler doesn't define one). Throwing here surfaces as
   * `{ ok: false, code: "UNHANDLED" }`; handlers should prefer the
   * typed return so the error code on the row is meaningful.
   */
  processRow: (ctx: HandlerContext, row: TRow, batch: TBatch) => Promise<RowResult>;
}

export type { CanonicalFieldDef, ImportKindHandlerMeta, RowResult, ParseRowResult };
