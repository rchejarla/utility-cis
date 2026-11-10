import { Document, Page, View, Text, StyleSheet } from "@react-pdf/renderer";
import { SKIP_REASONS } from "@utility-cis/shared";
import type { RouteSheet } from "./route-sheet.js";

/**
 * The route sheet's layout: what a meter reader carries on the walk.
 *
 * Like the bill template this reads a resolved object and declares
 * structure. It holds no tenant conditionals and talks to no database;
 * the data is built in `route-sheet.ts`, and the call that turns this into
 * bytes lives there too, so React stays out of that file.
 *
 * Fonts: Helvetica, a PDF base font. A font we do not ship throws at
 * render time, and a sheet that will not print is worse than a plain one.
 */

const FONT = "Helvetica";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * "2026-01-15" as "15 Jan 2026". By hand rather than `toLocaleDateString`,
 * whose output depends on the ICU the host Node was built with.
 */
function printedDate(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  return `${d} ${MONTHS[(m ?? 1) - 1]} ${y}`;
}

/**
 * "LOCKED_GATE" as "Locked gate". `SKIP_REASONS` carries codes only, and
 * the legend is derived from it rather than keeping a second list, so the
 * sheet cannot name a code the entry screen does not accept.
 */
function legendLabel(code: string): string {
  const words = code.toLowerCase().replace(/_/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

const s = StyleSheet.create({
  page: { fontFamily: FONT, fontSize: 9, paddingTop: 28, paddingBottom: 64, paddingHorizontal: 28, color: "#111827" },
  title: { fontSize: 14, marginBottom: 2 },
  muted: { color: "#6b7280" },
  headerBlock: { marginBottom: 8 },
  headRow: { flexDirection: "row", borderBottomWidth: 1, borderColor: "#111827", paddingBottom: 3, fontSize: 7 },
  row: { flexDirection: "row", paddingVertical: 4, borderBottomWidth: 0.5, borderColor: "#9ca3af", alignItems: "flex-end" },
  seq: { width: 34 },
  address: { flex: 1, paddingRight: 6 },
  account: { width: 78 },
  meter: { width: 86 },
  last: { width: 78, textAlign: "right", paddingRight: 8 },
  write: { width: 80, borderBottomWidth: 0.5, borderColor: "#111827", height: 12, marginRight: 6 },
  code: { width: 44, borderBottomWidth: 0.5, borderColor: "#111827", height: 12 },
  footer: { position: "absolute", bottom: 20, left: 28, right: 28, borderTopWidth: 0.5, borderColor: "#9ca3af", paddingTop: 4, fontSize: 7 },
  legendRow: { flexDirection: "row", flexWrap: "wrap" },
  legendItem: { marginRight: 10 },
  pageNo: { textAlign: "right", marginTop: 2 },
});

/**
 * How many stops the route has, which is not how many lines print: a
 * multi-register meter is several lines at one stop, and a stop with
 * nothing to read is none. Counting lines alone would understate the route
 * and be the one number a reader could use to notice a stop was missing.
 */
function routeStopCount(sheet: RouteSheet): number {
  return new Set(sheet.stops.map((x) => x.sequence)).size + sheet.stopsWithNothingToRead.length;
}

export function RouteSheetTemplate({ sheet }: { sheet: RouteSheet }) {
  return (
    <Document title={`Route ${sheet.routeCode}`}>
      <Page size="LETTER" style={s.page}>
        <View style={s.headerBlock} fixed>
          <Text style={s.title}>
            Route {sheet.routeCode} - {sheet.routeName}
          </Text>
          <Text style={s.muted}>
            Cycle {sheet.cycleCode}
            {sheet.readsDueOn ? ` | reads due ${printedDate(sheet.readsDueOn)}` : ""} | sheet for{" "}
            {printedDate(sheet.forDate)} | {sheet.stops.length} {sheet.stops.length === 1 ? "line" : "lines"} on{" "}
            {routeStopCount(sheet)} {routeStopCount(sheet) === 1 ? "stop" : "stops"}
          </Text>
        </View>

        <View style={s.headRow} fixed>
          <Text style={s.seq}>SEQ</Text>
          <Text style={s.address}>ADDRESS</Text>
          <Text style={s.account}>ACCOUNT</Text>
          <Text style={s.meter}>METER</Text>
          <Text style={s.last}>LAST READING</Text>
          <Text style={s.write}>READING</Text>
          <Text style={s.code}>CODE</Text>
        </View>

        {sheet.stops.map((stop, i) => (
          <View key={i} style={s.row} wrap={false}>
            <Text style={s.seq}>{stop.sequence}</Text>
            <Text style={s.address}>{stop.address}</Text>
            <Text style={s.account}>{stop.accountNumber}</Text>
            <Text style={s.meter}>
              {stop.meterNumber}
              {stop.registerNumber !== null ? `  reg ${stop.registerNumber}` : ""}
            </Text>
            <Text style={s.last}>
              {stop.lastReading === null
                ? "none"
                : `${stop.lastReading}${stop.lastReadDate ? ` (${printedDate(stop.lastReadDate)})` : ""}`}
            </Text>
            <View style={s.write} />
            <View style={s.code} />
          </View>
        ))}

        {/* Every page, so the codes are in front of the reader wherever the walk has got to. */}
        <View style={s.footer} fixed>
          <View style={s.legendRow}>
            <Text style={s.legendItem}>Could not read? Write the code:</Text>
            {SKIP_REASONS.map((code) => (
              <Text key={code} style={s.legendItem}>
                {code} = {legendLabel(code)}
              </Text>
            ))}
          </View>
          <Text
            style={s.pageNo}
            render={({ pageNumber, totalPages }) => `Page ${pageNumber} of ${totalPages}`}
          />
        </View>
      </Page>
    </Document>
  );
}
