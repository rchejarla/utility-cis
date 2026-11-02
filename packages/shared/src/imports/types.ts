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
  /**
   * Where this kind's wizard lives in the web app — an absolute path
   * ending in `/import`, e.g. `/service-agreements/import`.
   *
   * **Required, so a kind cannot register without a way in.** Adding a
   * kind is one handler file and one line in `handlers/index.ts`, and
   * the wizard route is a page somewhere else entirely; nothing used to
   * connect the two, so a kind could serve its fields, generate its
   * template, accept a POST and still be a URL you had to know. The
   * `/imports` page builds its New-import menu from this, so a seventh
   * kind appears there on registration with no page to edit.
   *
   * It is a client route named in a server contract, which is the
   * narrower of two evils: the alternative is a kind → path map in the
   * web app, which is the thing that gets forgotten. `module` and
   * `permission` beside it exist to drive the client too.
   */
  wizardPath: string;
  /** Canonical fields the wizard exposes in its mapping stage. */
  canonicalFields: CanonicalFieldDef[];
  /**
   * Set when this kind's entity carries custom fields, naming which
   * entity type's schema to read.
   *
   * The tenant's declared fields are appended to `canonicalFields` per
   * request — the registry is static and shared by every tenant, so a
   * handler cannot name them itself. Prefixed `custom:` so a tenant key
   * matching a core column keeps them apart.
   */
  customFieldEntity?:
    | "customer"
    | "account"
    | "premise"
    | "service_agreement"
    | "meter";
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
