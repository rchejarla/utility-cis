import { Document, Page, View, Text, StyleSheet, Image } from "@react-pdf/renderer";
import type { BillPresentation } from "../services/bill-presentation.service.js";

/**
 * The default bill layout.
 *
 * This file is the *template*: it reads a resolved BillPresentation and
 * declares structure. It holds no tenant conditionals and talks to no
 * database — everything that varies per tenant arrives inside the
 * presentation. The machinery that turns these declarations into bytes
 * lives in ../bill-generation, deliberately apart, because a layout
 * designer would later edit templates and never machinery.
 *
 * Fonts: a built-in PDF base font rather than a vendored family. A bill
 * is a financial document that must render, and a tenant theme naming a
 * web font we do not ship would otherwise throw at render time. The
 * theme's font choice is honoured only when it names a standard font.
 */

const STANDARD_FONTS = new Set(["Helvetica", "Times-Roman", "Courier"]);

function safeFont(requested: string): string {
  return STANDARD_FONTS.has(requested) ? requested : "Helvetica";
}

const fmtDate = (d: Date) => d.toISOString().slice(0, 10);

function makeStyles(presentation: BillPresentation) {
  const font = safeFont(presentation.branding.fontFamily);
  const accent = presentation.branding.primaryColor;
  return StyleSheet.create({
    page: { fontFamily: font, fontSize: 9, paddingTop: 28, paddingBottom: 36, paddingHorizontal: 32, color: "#111827" },
    header: { flexDirection: "row", justifyContent: "space-between", marginBottom: 16 },
    issuerName: { fontSize: 13, color: accent, marginBottom: 2 },
    muted: { color: "#6b7280" },
    block: { maxWidth: 240 },
    label: { fontSize: 7, color: "#6b7280", textTransform: "uppercase", marginBottom: 2 },
    metaRow: { flexDirection: "row", justifyContent: "space-between", borderTopWidth: 1, borderBottomWidth: 1, borderColor: "#e5e7eb", paddingVertical: 6, marginBottom: 14 },
    groupHeading: { fontSize: 10, color: accent, marginTop: 10, marginBottom: 4 },
    row: { flexDirection: "row", paddingVertical: 2.5, borderBottomWidth: 0.5, borderColor: "#f3f4f6" },
    cellLabel: { flex: 1 },
    cellQty: { width: 70, textAlign: "right" },
    cellAmount: { width: 80, textAlign: "right" },
    subtotalRow: { flexDirection: "row", paddingTop: 4 },
    totalsBox: { marginTop: 16, alignSelf: "flex-end", width: 240 },
    totalRow: { flexDirection: "row", justifyContent: "space-between", paddingVertical: 2 },
    grandTotal: { flexDirection: "row", justifyContent: "space-between", paddingTop: 5, marginTop: 3, borderTopWidth: 1, borderColor: "#111827" },
    messages: { marginTop: 18, paddingTop: 8, borderTopWidth: 0.5, borderColor: "#e5e7eb" },
    stub: { marginTop: 22, paddingTop: 10, borderTopWidth: 1, borderStyle: "dashed", borderColor: "#9ca3af", flexDirection: "row", justifyContent: "space-between" },
    logo: { width: 90, height: 34, objectFit: "contain" },
  });
}

/**
 * An amount as it is printed: currency symbol, and thousands separated.
 *
 * Formatting lives here rather than in `BillPresentation`, which carries
 * plain 2dp strings. The presentation is the bill's content; how an
 * amount looks on paper is this template's business, and a tenant
 * printing in another currency would change the template rather than the
 * resolver.
 *
 * Grouping is applied by hand instead of `toLocaleString`, because the
 * Node the API runs on may carry a trimmed ICU and the grouping
 * character would then vary by host — which would break byte-stability.
 */
function printed(amount: string): string {
  const negative = amount.startsWith("-");
  const [whole, fraction = "00"] = amount.replace("-", "").split(".");
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${negative ? "-" : ""}$${grouped}.${fraction}`;
}

export function DefaultBillTemplate({ presentation }: { presentation: BillPresentation }) {
  const s = makeStyles(presentation);
  const { issuer, recipient, account, bill, groups, totals, settlement, messages, remittance } =
    presentation;

  return (
    <Document title={`Bill ${bill.number}`} author={issuer.name}>
      <Page size="LETTER" style={s.page}>
        {/* Repeated on every page so a continuation sheet is identifiable. */}
        <View style={s.header} fixed>
          <View style={s.block}>
            <Text style={s.issuerName}>{issuer.name}</Text>
            {issuer.addressLines.map((line, i) => (
              <Text key={i} style={s.muted}>{line}</Text>
            ))}
            {issuer.phone ? <Text style={s.muted}>{issuer.phone}</Text> : null}
            {issuer.website ? <Text style={s.muted}>{issuer.website}</Text> : null}
          </View>
          <View style={s.block}>
            {presentation.branding.logoUrl ? (
              <Image style={s.logo} src={presentation.branding.logoUrl} />
            ) : null}
            <Text style={s.label}>Billed to</Text>
            <Text>{recipient.name}</Text>
            {recipient.addressLines.map((line, i) => (
              <Text key={i} style={s.muted}>{line}</Text>
            ))}
          </View>
        </View>

        <View style={s.metaRow}>
          <View>
            <Text style={s.label}>Bill number</Text>
            <Text>{bill.number}</Text>
          </View>
          <View>
            <Text style={s.label}>Account</Text>
            <Text>{account.number}</Text>
          </View>
          <View>
            <Text style={s.label}>Service period</Text>
            <Text>{`${fmtDate(bill.periodStart)} – ${fmtDate(bill.periodEnd)}`}</Text>
          </View>
          <View>
            <Text style={s.label}>Bill date</Text>
            <Text>{fmtDate(bill.billDate)}</Text>
          </View>
          <View>
            <Text style={s.label}>Due date</Text>
            <Text>{fmtDate(bill.dueDate)}</Text>
          </View>
        </View>

        {groups.map((group, gi) => (
          <View key={gi}>
            <Text style={s.groupHeading}>{group.heading}</Text>
            <View style={s.row}>
              <Text style={[s.cellLabel, s.label]}>Charge</Text>
              <Text style={[s.cellQty, s.label]}>Quantity</Text>
              <Text style={[s.cellAmount, s.label]}>Amount</Text>
            </View>
            {group.lines.map((line, li) => (
              <View key={li} style={s.row} wrap={false}>
                <Text style={s.cellLabel}>{line.label}</Text>
                <Text style={s.cellQty}>{line.quantity ?? ""}</Text>
                <Text style={s.cellAmount}>{printed(line.amount)}</Text>
              </View>
            ))}
            <View style={s.subtotalRow}>
              <Text style={s.cellLabel}> </Text>
              <Text style={s.cellQty}>Subtotal</Text>
              <Text style={s.cellAmount}>{printed(group.subtotal)}</Text>
            </View>
          </View>
        ))}

        <View style={s.totalsBox} wrap={false}>
          <View style={s.totalRow}>
            <Text style={s.muted}>Subtotal</Text>
            <Text>{printed(totals.subtotal)}</Text>
          </View>
          <View style={s.totalRow}>
            <Text style={s.muted}>Taxes</Text>
            <Text>{printed(totals.taxes)}</Text>
          </View>
          {/*
            Named for what it is. This is the credits the rate engine
            computed while pricing the period — not the account's credit
            position, and never a payment. Printed unconditionally as
            "Credits $0.00" it answered a question nobody asked in the
            affirmative-negative: a customer who had paid read it as
            their money being counted at zero. Suppressed when zero, the
            way Rounding already is.
          */}
          {Number(totals.credits) === 0 ? null : (
            <View style={s.totalRow}>
              <Text style={s.muted}>Credits this period</Text>
              <Text>{printed(totals.credits)}</Text>
            </View>
          )}
          {/*
            Only when the per-line and whole-bill rounding disagree, so a
            customer adding up the lines above arrives at Total due
            exactly. Absent from almost every bill.
          */}
          {totals.rounding ? (
            <View style={s.totalRow}>
              <Text style={s.muted}>Rounding</Text>
              <Text>{printed(totals.rounding)}</Text>
            </View>
          ) : null}
          <View style={s.grandTotal}>
            <Text>{settlement ? "Total billed" : "Total due"}</Text>
            <Text>{printed(totals.total)}</Text>
          </View>
          {/*
            Payments and credits already applied to this bill, itemised
            with the date they took effect, then what is actually left to
            pay. Only on a bill that has some: an unpaid bill prints
            exactly as it did before, with "Total due" as its last word.

            Itemised rather than summarised because the line a customer
            looks for is their own payment, on its own date — "Payment
            (check) 2026-10-03  -$55.38" is what ends the phone call,
            where a single net figure starts one.
          */}
          {settlement ? (
            <>
              <Text style={[s.label, { marginTop: 6 }]}>Payments and credits received</Text>
              {settlement.applied.map((item, ai) => (
                <View key={ai} style={s.totalRow}>
                  <Text style={s.muted}>
                    {item.label} {fmtDate(item.date)}
                  </Text>
                  <Text>{printed(item.amount)}</Text>
                </View>
              ))}
              <View style={s.grandTotal}>
                <Text>Amount due</Text>
                <Text>{printed(settlement.amountDue)}</Text>
              </View>
            </>
          ) : null}
        </View>

        {messages.length > 0 ? (
          <View style={s.messages}>
            {messages.map((m, mi) => (
              <Text key={mi} style={{ marginBottom: 3 }}>{m.body}</Text>
            ))}
          </View>
        ) : null}

        <View style={s.stub} wrap={false}>
          <View>
            <Text style={s.label}>Return with payment to</Text>
            <Text>{remittance.payTo}</Text>
            {remittance.addressLines.map((line, i) => (
              <Text key={i} style={s.muted}>{line}</Text>
            ))}
          </View>
          <View>
            <Text style={s.label}>Account</Text>
            <Text>{account.number}</Text>
            <Text style={s.label}>Amount due</Text>
            <Text>{printed(remittance.amountDue)}</Text>
            <Text style={s.label}>Due</Text>
            <Text>{fmtDate(remittance.dueDate)}</Text>
          </View>
        </View>
      </Page>
    </Document>
  );
}
