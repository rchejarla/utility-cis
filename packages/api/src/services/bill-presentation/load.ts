import { Decimal } from "decimal.js";
import { prisma } from "../../lib/prisma.js";
import { selectBillMessages } from "../bill-message.service.js";
import { chargeGroups } from "./charges.js";
import {
  BillPresentationError,
  type BillPresentation,
  type BillPresentationStatement,
  type BillPresentationTotals,
} from "./document.js";
import { loadFeesGroup } from "./fees.js";
import { money } from "./format.js";
import { resolveIssuer } from "./issuer.js";
import { resolveRecipient } from "./recipient.js";
import { loadAppliedCredits, settlementOf } from "./settlement.js";

/**
 * Resolves one `Bill` into render-ready content.
 *
 * The parts each answer their own question — who it is from, who it is
 * for, what was rated, what was charged beside it, what has been paid —
 * and this assembles them and does the arithmetic that needs all of
 * them at once.
 */

const DEFAULT_BRANDING = {
  logoUrl: null as string | null,
  primaryColor: "#1f2937",
  fontFamily: "Inter",
};

/**
 * Which messages print, chosen at the bill date rather than today.
 *
 * `Account.accountType` holds an `AccountTypeDef` *code*, not its id, so
 * it has to be resolved. A code matching no definition targets nothing
 * rather than failing the render: an unmatched type is a configuration
 * gap, not a reason to withhold a bill.
 *
 * The tenant's own row wins over the global default of the same code.
 * Both can exist — `account_type_def` is unique on (utility_id, code),
 * and a tenant overrides a shipped type by adding its own row with the
 * same code, which is how every type-def list resolves it. Without the
 * ordering this was a `findFirst` over both with no preference, so which
 * one came back was whatever Postgres happened to return: harmless while
 * no tenant has overridden anything, and wrong the moment one does, on
 * the code path that decides what a customer's bill says. `nulls:
 * "last"` is what expresses the preference — descending alone would put
 * NULL first in Postgres.
 */
async function loadMessages(
  utilityId: string,
  accountType: string,
  commodityIds: string[],
  onDate: Date,
): Promise<Array<{ label: string; body: string }>> {
  const typeDef = await prisma.accountTypeDef.findFirst({
    where: { code: accountType, OR: [{ utilityId }, { utilityId: null }] },
    orderBy: { utilityId: { sort: "desc", nulls: "last" } },
    select: { id: true },
  });
  const messages = await selectBillMessages(utilityId, {
    accountTypeDefId: typeDef?.id ?? null,
    commodityIds,
    onDate,
  });
  return messages.map((m) => ({ label: m.label, body: m.body }));
}

async function loadBranding(utilityId: string): Promise<BillPresentation["branding"]> {
  const theme = await prisma.utilityTheme.findUnique({ where: { utilityId } });
  const colors = (theme?.colors ?? {}) as Record<string, unknown>;
  const typography = (theme?.typography ?? {}) as Record<string, unknown>;
  return {
    logoUrl: theme?.logoUrl ?? DEFAULT_BRANDING.logoUrl,
    primaryColor:
      typeof colors.primary === "string" ? colors.primary : DEFAULT_BRANDING.primaryColor,
    fontFamily:
      typeof typography.fontFamily === "string"
        ? typography.fontFamily
        : DEFAULT_BRANDING.fontFamily,
  };
}

/**
 * The totals box, built from the printed group subtotals rather than the
 * stored 4dp columns.
 *
 * The per-group rule — sum the already-rounded lines, because the
 * customer can add those up — was applied to the groups and then
 * contradicted here, where `subtotal` rounded `bill.subtotal`. Two lines
 * of 16.1050 print as 16.11 and 16.11 under a group subtotal of 32.22,
 * while `bill.subtotal` of 32.2100 rounds to 32.21: one page stating
 * both, and the customer holding it can see that it does not add up.
 * Every fixture on that branch happened to be exact to cents, so nothing
 * caught it.
 *
 * `ratedTotal` stays tied to `bill.total` — that is what the rating
 * engine computed and what the bill's own `BILL_CHARGE` raised — and the
 * rounding line reconciles against it alone. The **printed** total adds
 * the fees group, because a line item the customer cannot add into the
 * total is not a line item. So the printed total no longer equals
 * `bill.total` whenever a fee is on the page, and that is deliberate:
 * the two numbers answer different questions, and the stub has to ask
 * for what the account owes. When the two rounding orders differ, the
 * cent between them is shown as its own line rather than hidden in a
 * total that does not follow from the lines above it. A bill whose
 * figures visibly reconcile, rounding included, is worth more than one
 * that silently absorbs the difference.
 */
/**
 * Where the account stood when the bill was issued, from the snapshot.
 *
 * Null unless all three columns are present — a CHECK requires them
 * together, so one missing means the bill predates the snapshot.
 */
function statementOf(bill: {
  previousBalance?: Decimal | null;
  paymentsSince?: Decimal | null;
  pastDueAmount?: Decimal | null;
}): BillPresentationStatement | null {
  // Nullish rather than strictly null: the column is nullable, and a row
  // that did not select it is absent rather than null. Either way there
  // is no snapshot, and the one thing this must not do is invent one.
  if (
    bill.previousBalance == null ||
    bill.paymentsSince == null ||
    bill.pastDueAmount == null
  ) {
    return null;
  }
  return {
    previousBalance: money(bill.previousBalance),
    paymentsSince: money(bill.paymentsSince),
    balanceForward: money(bill.previousBalance.minus(bill.paymentsSince)),
    pastDue: money(bill.pastDueAmount),
  };
}

function totalsOf(
  bill: { subtotal: Decimal; taxes: Decimal; credits: Decimal; total: Decimal },
  ratedSubtotals: string[],
  feesSubtotal: string | null,
  statement: BillPresentationStatement | null,
): { totals: BillPresentationTotals; total: Decimal } {
  const printedSubtotal = ratedSubtotals.reduce(
    (acc, subtotal) => acc.plus(new Decimal(subtotal)),
    new Decimal(0),
  );
  const taxes = new Decimal(money(bill.taxes));
  const credits = new Decimal(money(bill.credits));
  const ratedTotal = new Decimal(money(bill.total));
  const rounding = ratedTotal.minus(printedSubtotal.plus(taxes).minus(credits));
  const fees = new Decimal(feesSubtotal ?? 0);
  /*
   * Current charges **plus past due**, which is the standard rule and
   * which the balance carried forward is what supplies. Without it the
   * total was short by the previous bill's unpaid remainder: entries
   * holding a `bill_id` are filtered out of the fees window — correctly,
   * a bill's own charge *is* that bill — and nothing put it back.
   *
   * `balanceForward` and the fees group do not overlap. One is the
   * account up to the previous bill's date, the other the activity after
   * it, and `paymentsSince` is netted into the first while the fees
   * group excludes `PAYMENT` so the window's credits are partitioned
   * rather than counted twice.
   *
   * A bill with no snapshot keeps the total it printed before, because
   * the figures behind the new one are not recoverable.
   */
  const carried = statement ? new Decimal(statement.balanceForward) : new Decimal(0);
  const total = carried.plus(ratedTotal).plus(fees);

  return {
    total,
    totals: {
      subtotal: printedSubtotal.toFixed(2),
      taxes: taxes.toFixed(2),
      credits: credits.toFixed(2),
      rounding: rounding.isZero() ? null : rounding.toFixed(2),
      fees: fees.isZero() ? null : fees.toFixed(2),
      total: total.toFixed(2),
    },
  };
}

export async function loadBillPresentation(
  utilityId: string,
  billId: string,
): Promise<BillPresentation> {
  const bill = await prisma.bill.findFirst({
    where: { id: billId, utilityId },
    include: {
      account: {
        include: {
          customer: true,
          // Ordered, because the bill prints exactly one of these and
          // took whichever the database happened to return first. An
          // account with two addresses therefore printed an arbitrary
          // one, and could print a different one on a regeneration —
          // which also breaks the byte-stability that makes `sha256`
          // meaningful as "has this document changed?".
          //
          // Primary first; failing that the oldest, since an account
          // whose only address is not flagged primary still has to be
          // billable. `id` is the final tiebreak so the answer cannot
          // depend on row order.
          billingAddresses: {
            orderBy: [{ isPrimary: "desc" }, { createdAt: "asc" }, { id: "asc" }],
            take: 1,
          },
        },
      },
      segments: {
        include: {
          serviceAgreement: { include: { commodity: true } },
          lines: { orderBy: { sortOrder: "asc" } },
        },
      },
    },
  });

  if (!bill) {
    throw new BillPresentationError(`Bill ${billId} not found`, "NO_CHARGES");
  }

  const { issuer, payTo } = await resolveIssuer(utilityId);
  const recipient = resolveRecipient(bill.account);
  const groups = chargeGroups(bill.segments);

  const applied = await loadAppliedCredits(utilityId, bill.id, bill.billDate);
  const feeGroup = await loadFeesGroup(
    utilityId,
    bill.accountId,
    bill.billDate,
    applied.map((credit) => credit.creditId),
  );

  const statement = statementOf(bill);
  const { totals, total } = totalsOf(
    bill,
    groups.map((group) => group.subtotal),
    feeGroup?.subtotal ?? null,
    statement,
  );
  // After the totals, so the rounding line reconciles the rated charges
  // against `bill.total` without a fee in the way.
  if (feeGroup) groups.push(feeGroup);

  const commodityIds = [
    ...new Set(
      bill.segments
        .map((segment) => segment.serviceAgreement?.commodity?.id)
        .filter((id): id is string => Boolean(id)),
    ),
  ];
  const messages = await loadMessages(
    utilityId,
    bill.account.accountType,
    commodityIds,
    bill.billDate,
  );
  const branding = await loadBranding(utilityId);
  const settlement = settlementOf(applied, total);

  return {
    issuer,
    recipient,
    account: { number: bill.account.accountNumber, id: bill.account.id },
    bill: {
      number: bill.billNumber,
      billDate: bill.billDate,
      dueDate: bill.dueDate,
      periodStart: bill.periodStart,
      periodEnd: bill.periodEnd,
    },
    groups,
    feesGroup: feeGroup,
    statement,
    totals,
    settlement,
    messages,
    branding,
    remittance: {
      payTo,
      addressLines: issuer.addressLines,
      // The stub asks for what is left, not what was raised — the same
      // rule the totals box follows about rounding: a bill must not ask
      // for a number the account does not owe. Paying the printed stub
      // on a part-paid bill would otherwise overpay by exactly the
      // amount already received.
      amountDue: settlement ? settlement.amountDue : totals.total,
      dueDate: bill.dueDate,
    },
  };
}
