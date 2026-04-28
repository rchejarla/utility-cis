/**
 * Explicit registration list for import kind handlers. Importing this
 * file once at API boot triggers each handler module's
 * `registerImportKind(...)` side effect.
 *
 * Adding a new handler:
 *   1. Create `<kind>.ts` in this directory exporting the handler.
 *   2. Import it here for the side effect.
 * The framework itself doesn't need to know — `listKinds()` reflects
 * the current registry.
 */
// Handlers register here as they're written:
import "./meter-read.js";
import "./customer.js";
