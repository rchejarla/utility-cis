/**
 * Cross-package types for the bulk-import framework (spec 22).
 *
 * Two halves:
 *   - `CanonicalFieldDef` + `ImportKindHandlerMeta` describe what
 *     the wizard needs to know about a kind (mappable fields, label,
 *     permission). These ride between the API and the web client.
 *   - The actual `ImportKindHandler` interface (with parseRow +
 *     processRow methods) lives in the API package because it
 *     references Prisma's transaction client. Shared types stay
 *     framework-agnostic so the web bundle stays slim.
 */

export interface CanonicalFieldDef {
  /** Stable identifier the wizard maps source headers onto. */
  name: string;
  /** Human label rendered in the dropdown. */
  label: string;
  /** Required canonical fields must each be mapped exactly once. */
  required: boolean;
  /** Helper text under the dropdown. */
  description?: string;
  /** Sample value used in the template.csv generated for the kind. */
  example?: string;
  /**
   * Regex aliases used by auto-detect. Each string is compiled as a
   * case-insensitive regex against the lowercased + space-stripped
   * source header. First match wins; matched canonicals can't be
   * matched twice in the same auto-detect pass.
   */
  aliases?: string[];
}

export interface ImportKindHandlerMeta {
  /** Stable kind identifier. Used in URLs and DB rows. */
  kind: string;
  /** Human label for the wizard chrome and the imports list page. */
  label: string;
  /** Tenant module the kind sits in (drives module-enabled gate). */
  module: string;
  /** Permission required on `module` to create an import of this kind. */
  permission: "CREATE" | "EDIT";
  /** Canonical fields the wizard exposes in its mapping stage. */
  canonicalFields: CanonicalFieldDef[];
  /**
   * Sample rows (objects keyed by canonical-field name) used by
   * `/api/v1/imports/kinds/:kind/template.csv` to render the template.
   * Two or three rows is plenty.
   */
  templateRows: Record<string, string>[];
}

/** Per-row outcome reported by the handler's `processRow`. */
export type RowResult =
  | { ok: true; entityId?: string }
  | { ok: false; code: string; message: string };

/** Per-row outcome from `parseRow` — either a typed row, or a structured error. */
export type ParseRowResult<TRow> =
  | { ok: true; row: TRow }
  | { ok: false; code: string; message: string };
