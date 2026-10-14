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
 *
 * It is also why the repo declares `engines.node >= 22.12` and pins
 * `.nvmrc`: `require()` of an ESM graph is what the patch relies on, and
 * that only exists from 22.12. On an older Node this import fails and
 * takes every endpoint with it, so the floor is a boot requirement for
 * the whole API rather than a preference of this one feature.
 */

export const DEFAULT_TEMPLATE_KEY = "default-bill-v1";

/**
 * How long a tenant's logo gets to arrive, and how big it may be.
 *
 * Both exist because the logo is the one piece of a bill fetched from
 * somewhere we do not control, and it is fetched while a request waits.
 */
const LOGO_TIMEOUT_MS = 3_000;
const LOGO_MAX_BYTES = 2 * 1024 * 1024;

/**
 * Fetch the tenant's logo and inline it, or print the bill without one.
 *
 * `<Image src={url}>` has react-pdf fetch the url itself, mid-render,
 * with no timeout and nothing to catch: an unreachable or slow logo
 * turned every generation for that tenant into a thrown error that is
 * neither BillDocumentError nor ApptorConnectError, so the route
 * rethrew it and the operator got a 500 with no indication that the
 * cause was a logo. A tenant could take their own billing down by
 * saving a bad URL in Settings.
 *
 * Fetching it here instead means a failure is a bill without a logo. The
 * content type is checked because react-pdf handles PNG and JPEG only —
 * an SVG or WebP logo threw from inside the renderer for the same
 * reason, just later.
 *
 * What this does not fix: the bytes of a bill still depend on a remote
 * resource, so a logo that changes (or times out once) changes the
 * sha256 of a regenerated document. Caching the resolved logo per tenant
 * is the answer to that, and it needs somewhere to put it.
 */
async function inlineLogo(logoUrl: string | null): Promise<string | null> {
  if (!logoUrl) return null;
  try {
    const res = await fetch(logoUrl, { signal: AbortSignal.timeout(LOGO_TIMEOUT_MS) });
    if (!res.ok) {
      await res.body?.cancel();
      return null;
    }
    const contentType = (res.headers.get("content-type") ?? "").split(";")[0].trim();
    if (!/^image\/(png|jpe?g)$/i.test(contentType)) {
      await res.body?.cancel();
      return null;
    }
    const bytes = Buffer.from(await res.arrayBuffer());
    if (bytes.byteLength === 0 || bytes.byteLength > LOGO_MAX_BYTES) return null;
    return `data:${contentType};base64,${bytes.toString("base64")}`;
  } catch {
    // A logo is decoration. Nothing about it is worth failing a bill for.
    return null;
  }
}

export async function generateBillPdf(presentation: BillPresentation): Promise<Buffer> {
  const logo = await inlineLogo(presentation.branding.logoUrl);
  const resolved: BillPresentation = logo === presentation.branding.logoUrl
    ? presentation
    : { ...presentation, branding: { ...presentation.branding, logoUrl: logo } };
  const buffer = await renderToBuffer(DefaultBillTemplate({ presentation: resolved }));
  return stabilizePdf(buffer);
}
