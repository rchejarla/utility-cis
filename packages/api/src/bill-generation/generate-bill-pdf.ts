import { renderToBuffer } from "@react-pdf/renderer";
import { DefaultBillTemplate } from "../bill-template/default-bill.js";
import { stabilizePdf } from "./stabilize-pdf.js";
import type { BillPresentation } from "../services/bill-presentation.service.js";

/**
 * Generation machinery: turns a template's declarations into bytes.
 *
 * Deliberately separate from ../bill-template. A layout designer would
 * later edit templates; nothing in here should ever need a tenant
 * conditional, because everything per-tenant arrives inside the
 * presentation.
 *
 * The template is invoked as a plain function rather than through
 * `createElement`, because `renderToBuffer` types its argument as the
 * `Document` element itself — a component element wrapping one is not
 * the same type. Calling it hands over exactly what that signature
 * asks for, and keeps React out of this file.
 *
 * **This import is the reason `patches/@react-pdf__hyphenate` exists.**
 * This package is CommonJS and the whole react-pdf stack is ESM-only
 * with no CJS build. Node 22 will `require()` an ESM graph, but it
 * resolves that entire graph under the `require` condition — and
 * `@react-pdf/hyphenate` publishes an `exports` map declaring only
 * `import`, so `@react-pdf/textkit`'s reach for
 * `@react-pdf/hyphenate/en-us` found nothing, even though `lib/en-us.js`
 * is right there. That killed the API at startup, before Fastify
 * listened: one feature's dependency took down every endpoint. The patch
 * adds a `require` condition pointing at the same files.
 *
 * No test caught it, and none could have. Vitest resolves through Vite
 * rather than Node's loader, so generation passed in tests while the
 * server would not boot. Only starting the thing finds this class of
 * bug.
 */

export const DEFAULT_TEMPLATE_KEY = "default-bill-v1";

export async function generateBillPdf(presentation: BillPresentation): Promise<Buffer> {
  const buffer = await renderToBuffer(DefaultBillTemplate({ presentation }));
  return stabilizePdf(buffer);
}
