/**
 * Bill presentation — one `Bill` resolved into render-ready content.
 *
 * The output holds no Prisma types and no Decimals: it is the single
 * resolved form that the PDF renderer, the print-vendor export and the
 * e-bill HTML all read (`docs/specs/09-billing.md` names those three
 * document types). Resolving once is also what makes a bill
 * reproducible — the same presentation renders the same document.
 *
 * This file is the module's public face and nothing else. The work moved
 * into `bill-presentation/` when the single file reached 652 lines: the
 * document's shape, who the bill is from, who it is for, what was rated,
 * what was charged beside it, what has been paid and how a number is
 * printed are things that change for different reasons, and the
 * directory qualifies each name so none of them repeats "bill
 * presentation" in its own.
 *
 * It is a re-export, not a redesign — the file already had these seams
 * as comment banners, and the split follows them rather than claiming
 * better ones. Callers import from here unchanged.
 */

export type {
  BillPresentation,
  BillPresentationGroup,
  BillPresentationIssuer,
  BillPresentationLine,
  BillPresentationSettlement,
  BillPresentationTotals,
  BillPresentationErrorCode,
} from "./bill-presentation/document.js";
export { BillPresentationError } from "./bill-presentation/document.js";
export { loadBillPresentation } from "./bill-presentation/load.js";
