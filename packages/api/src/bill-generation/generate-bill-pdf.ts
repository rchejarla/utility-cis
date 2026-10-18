import { lookup } from "node:dns/promises";
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
const LOGO_MAX_REDIRECTS = 3;

/**
 * Resolve a tenant-supplied logo URL, or refuse it.
 *
 * `utilityTheme.logoUrl` is written through `PUT /api/v1/theme` under
 * `theme:EDIT` and validated only as a URL. Fetching it from inside the
 * API makes that field a request this service will make on an
 * attacker's behalf, from the API's own network position — and the
 * bytes come back embedded in a PDF they can then download, so it is a
 * read primitive, not a blind one. `169.254.169.254`, `127.0.0.1`,
 * `metadata.google.internal` and `[::1]` were all accepted before this.
 *
 * Refused: anything but https, a host that resolves to a private,
 * loopback, link-local or otherwise non-public address, and any
 * redirect to one of those. DNS is resolved here and the resulting
 * address is what gets checked, so a public hostname pointing at
 * 127.0.0.1 does not pass.
 *
 * This cannot fully close DNS rebinding — the name is resolved again by
 * `fetch` — and the right long-term answer is to stop fetching tenant
 * URLs and have them upload the logo as an Attachment, which is noted
 * in the runbook as a follow-up.
 */
async function publicImageUrl(raw: string): Promise<string | null> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  // https only. http would be plaintext over whatever network the API
  // sits on, and file:/gopher:/ftp: have no business here at all.
  if (url.protocol !== "https:") return null;

  let addresses: { address: string }[];
  try {
    addresses = await lookup(url.hostname, { all: true });
  } catch {
    return null;
  }
  if (addresses.length === 0) return null;
  // Every answer has to be public: one private address in the set is
  // enough for a round-robin to land somewhere it should not.
  if (!addresses.every((a) => isPublicAddress(a.address))) return null;
  return url.toString();
}

/** Whether an IP literal is outside every range we refuse to fetch from. */
function isPublicAddress(address: string): boolean {
  const v4 = address.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if (a === 0 || a === 10 || a === 127) return false; // this host, private, loopback
    if (a === 169 && b === 254) return false; // link-local, and cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return false; // private
    if (a === 192 && b === 168) return false; // private
    if (a === 100 && b >= 64 && b <= 127) return false; // carrier-grade NAT
    if (a === 192 && b === 0) return false; // IETF protocol assignments
    if (a >= 224) return false; // multicast and reserved
    return true;
  }
  const v6 = address.toLowerCase().replace(/^\[|\]$/g, "");
  if (v6 === "::1" || v6 === "::") return false; // loopback, unspecified
  if (v6.startsWith("fe8") || v6.startsWith("fe9") || v6.startsWith("fea") || v6.startsWith("feb"))
    return false; // link-local
  if (/^f[cd]/.test(v6)) return false; // unique-local
  if (v6.startsWith("ff")) return false; // multicast
  // IPv4-mapped, judged on the v4 part. Two spellings reach here: the
  // dotted one a human types, and the hex one `new URL()` normalises it
  // to — `https://[::ffff:127.0.0.1]/` arrives as `::ffff:7f00:1`, which
  // a dotted-form check alone lets straight through to loopback.
  const mappedDotted = v6.match(/:(\d+\.\d+\.\d+\.\d+)$/);
  if (mappedDotted) return isPublicAddress(mappedDotted[1]);
  const mappedHex = v6.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (mappedHex) {
    const hi = parseInt(mappedHex[1], 16);
    const lo = parseInt(mappedHex[2], 16);
    return isPublicAddress(`${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`);
  }
  return true;
}

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
export async function resolveLogoDataUri(logoUrl: string | null): Promise<string | null> {
  if (!logoUrl) return null;
  try {
    let target = await publicImageUrl(logoUrl);
    if (!target) return null;

    // Redirects are followed by hand so every hop is checked. With
    // `redirect: "follow"`, a logo URL on a perfectly ordinary host can
    // answer 302 to 169.254.169.254 and the check above is bypassed.
    let res: Response | null = null;
    for (let hop = 0; hop <= LOGO_MAX_REDIRECTS; hop += 1) {
      res = await fetch(target, {
        redirect: "manual",
        signal: AbortSignal.timeout(LOGO_TIMEOUT_MS),
      });
      const location = res.status >= 300 && res.status < 400 ? res.headers.get("location") : null;
      if (!location) break;
      await res.body?.cancel();
      const next = await publicImageUrl(new URL(location, target).toString());
      if (!next) return null;
      target = next;
      res = null;
    }
    if (!res || !res.ok) {
      await res?.body?.cancel();
      return null;
    }

    const contentType = (res.headers.get("content-type") ?? "").split(";")[0].trim();
    if (!/^image\/(png|jpe?g)$/i.test(contentType)) {
      await res.body?.cancel();
      return null;
    }

    // Declared length first, then enforced while reading. `arrayBuffer()`
    // buffers the whole body before any cap can reject it, so a hostile
    // 64 MiB response declared as image/png spent 64 MiB of the API's
    // heap and only then failed the 2 MiB check — the cap documented an
    // intention the code did not carry out.
    const declared = Number(res.headers.get("content-length") ?? NaN);
    if (Number.isFinite(declared) && declared > LOGO_MAX_BYTES) {
      await res.body?.cancel();
      return null;
    }
    const bytes = await readCapped(res, LOGO_MAX_BYTES);
    if (!bytes || bytes.byteLength === 0) return null;

    return `data:${contentType};base64,${bytes.toString("base64")}`;
  } catch {
    // A logo is decoration. Nothing about it is worth failing a bill for.
    return null;
  }
}

/**
 * Read at most `cap` bytes, abandoning the response the moment it goes
 * over rather than after it has all arrived.
 */
async function readCapped(res: Response, cap: number): Promise<Buffer | null> {
  const body = res.body;
  if (!body) return null;
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > cap) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c)), total);
}

export async function generateBillPdf(presentation: BillPresentation): Promise<Buffer> {
  const logo = await resolveLogoDataUri(presentation.branding.logoUrl);
  const resolved: BillPresentation = logo === presentation.branding.logoUrl
    ? presentation
    : { ...presentation, branding: { ...presentation.branding, logoUrl: logo } };
  const buffer = await renderToBuffer(DefaultBillTemplate({ presentation: resolved }));
  return stabilizePdf(buffer);
}
