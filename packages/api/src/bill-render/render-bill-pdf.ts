import { renderToBuffer } from "@react-pdf/renderer";
import { DefaultBillTemplate } from "../bill-template/default-bill.js";
import { stabilizePdf } from "./stabilize-pdf.js";
import type { BillPresentation } from "../services/bill-presentation.service.js";

/**
 * Rendering machinery: turns a template's declarations into bytes.
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
 */

export const DEFAULT_TEMPLATE_KEY = "default-bill-v1";

export async function renderBillPdf(presentation: BillPresentation): Promise<Buffer> {
  const buffer = await renderToBuffer(DefaultBillTemplate({ presentation }));
  return stabilizePdf(buffer);
}
