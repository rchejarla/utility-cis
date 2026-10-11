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

export function DefaultBillTemplate({ presentation }: { presentation: BillPresentation }) {
  const s = makeStyles(presentation);
  const { issuer, recipient, account, bill, groups, totals, messages, remittance } = presentation;

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
                <Text style={s.cellAmount}>{line.amount}</Text>
              </View>
            ))}
            <View style={s.subtotalRow}>
              <Text style={s.cellLabel}> </Text>
              <Text style={s.cellQty}>Subtotal</Text>
              <Text style={s.cellAmount}>{group.subtotal}</Text>
            </View>
          </View>
        ))}

        <View style={s.totalsBox} wrap={false}>
          <View style={s.totalRow}>
            <Text style={s.muted}>Subtotal</Text>
            <Text>{totals.subtotal}</Text>
          </View>
          <View style={s.totalRow}>
            <Text style={s.muted}>Taxes</Text>
            <Text>{totals.taxes}</Text>
          </View>
          <View style={s.totalRow}>
            <Text style={s.muted}>Credits</Text>
            <Text>{totals.credits}</Text>
          </View>
          <View style={s.grandTotal}>
            <Text>Total due</Text>
            <Text>{totals.total}</Text>
          </View>
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
            <Text>{remittance.amountDue}</Text>
            <Text style={s.label}>Due</Text>
            <Text>{fmtDate(remittance.dueDate)}</Text>
          </View>
        </View>
      </Page>
    </Document>
  );
}
