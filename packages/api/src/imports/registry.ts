import type { ImportKindHandler } from "./types.js";

/**
 * Module-load registry of import kinds. Handlers in
 * `imports/handlers/*.ts` self-register at import time; the routes
 * dispatch through `getKindHandler(kind)`.
 *
 * Why explicit module-load registration (vs. auto-discovery via
 * filesystem scanning): keeps the dependency graph honest. The set of
 * registered kinds is exactly the set imported by
 * `imports/handlers/index.ts`, so reading that file tells you what
 * the framework knows about. No build-time magic required.
 */

// Registry entries are stored opaquely — TRow and TBatch type
// parameters are erased once a handler is registered. The framework
// passes `unknown` through both slots; runtime correctness comes from
// each handler being self-consistent (its parseRow output matches its
// processRow input).
type AnyHandler = ImportKindHandler<unknown, unknown>;

const handlers = new Map<string, AnyHandler>();

export function registerImportKind<TRow, TBatch>(
  handler: ImportKindHandler<TRow, TBatch>,
): void {
  if (handlers.has(handler.kind)) {
    throw new Error(`Import kind "${handler.kind}" is already registered`);
  }
  handlers.set(handler.kind, handler as AnyHandler);
}

export function getKindHandler(kind: string): AnyHandler {
  const handler = handlers.get(kind);
  if (!handler) {
    throw Object.assign(new Error(`Unknown import kind "${kind}"`), {
      statusCode: 400,
      code: "UNKNOWN_IMPORT_KIND",
    });
  }
  return handler;
}

/** Returns the metadata-only view, safe to ship to the wizard. */
export function listKinds(): Array<{
  kind: string;
  label: string;
  module: string;
  permission: "CREATE" | "EDIT";
  canonicalFields: AnyHandler["canonicalFields"];
  templateRows: AnyHandler["templateRows"];
}> {
  return [...handlers.values()].map((h) => ({
    kind: h.kind,
    label: h.label,
    module: h.module,
    permission: h.permission,
    canonicalFields: h.canonicalFields,
    templateRows: h.templateRows,
  }));
}

/** For tests — clears registrations between cases when needed. */
export function _clearRegistryForTests(): void {
  handlers.clear();
}
