"use client";

import { useState } from "react";
import Link from "next/link";
import {
  EXCEPTION_CODE_LABELS,
  READ_TYPES,
  type ExceptionCode,
  type ReadType,
} from "@utility-cis/shared";
import { EntityListPage } from "@/components/ui/entity-list-page";
import type { Column } from "@/components/ui/data-table";

interface MeterRead {
  id: string;
  readDate: string;
  readDatetime: string;
  reading: string;
  priorReading: string;
  consumption: string;
  readType: string;
  readSource: string;
  exceptionCode?: string | null;
  isFrozen: boolean;
  meter?: { meterNumber: string; commodityId: string };
  /** The read's own unit — a register's, where one is named. */
  uom?: { code: string; name: string } | null;
  serviceAgreement?: { agreementNumber: string };
}

/**
 * Built from the shared list, so a pill cannot offer a value the API
 * refuses. It offered `AMI` until 2026-11-06, which no read has ever
 * carried: `AMI` is a *source*, and this filter is on `read_type`.
 *
 * The labels are a `Record`, which is the point of doing it this way —
 * a fifth read type added to the shared list fails to compile here
 * until it has a label, instead of quietly going missing from the
 * filter.
 */
const READ_TYPE_LABELS: Record<ReadType, string> = {
  ACTUAL: "Actual",
  ESTIMATED: "Estimated",
  CORRECTED: "Corrected",
  FINAL: "Final",
};

const READ_TYPE_OPTIONS = READ_TYPES.map((value) => ({
  label: READ_TYPE_LABELS[value],
  value,
}));

/**
 * The last twelve months, newest first, as the API's `YYYY-MM`.
 *
 * Twelve because that is how far back the reads a biller still argues
 * about go, and because a longer list would want a search box to find
 * a month in — which is a worse control than a date range, and the
 * date range is still there on the API for anything older.
 *
 * Built at module load, which is right for a dev-server-lifetime list
 * of months: this is a Client Component, so it is evaluated in the
 * browser when the page loads, not baked into a build.
 */
const READ_MONTH_OPTIONS = Array.from({ length: 12 }, (_, i) => {
  const d = new Date();
  const month = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - i, 1));
  const value = `${month.getUTCFullYear()}-${String(month.getUTCMonth() + 1).padStart(2, "0")}`;
  return {
    value,
    label: month.toLocaleDateString(undefined, {
      month: "short",
      year: "numeric",
      timeZone: "UTC",
    }),
  };
});

const READ_SOURCE_OPTIONS = [
  { label: "Manual", value: "MANUAL" },
  { label: "AMR", value: "AMR" },
  { label: "AMI", value: "AMI" },
  { label: "Customer self-read", value: "CUSTOMER_SELF" },
  { label: "System", value: "SYSTEM" },
];

const fmtNumber = (v: string | number) => {
  const n = Number(v);
  return Number.isFinite(n) ? n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 4 }) : "—";
};

const readTypeStyle = (type: string): { bg: string; fg: string } => {
  switch (type) {
    case "ACTUAL":
      return { bg: "var(--success-subtle)", fg: "var(--success)" };
    case "ESTIMATED":
      return { bg: "var(--warning-subtle)", fg: "var(--warning)" };
    case "CORRECTED":
      return { bg: "var(--info-subtle)", fg: "var(--info)" };
    case "FINAL":
      return { bg: "var(--accent-tertiary-subtle)", fg: "var(--accent-tertiary)" };
    default:
      return { bg: "var(--bg-elevated)", fg: "var(--text-secondary)" };
  }
};

const columns: Column<MeterRead>[] = [
  {
    key: "meterNumber",
    header: "Meter",
    render: (row) => (
      <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: "12px", fontWeight: 600 }}>
        {row.meter?.meterNumber ?? "—"}
      </span>
    ),
  },
  {
    key: "readDate",
    header: "Read Date",
    render: (row) => (
      <span style={{ fontSize: "12px" }}>{row.readDate?.slice(0, 10) ?? "—"}</span>
    ),
  },
  {
    key: "reading",
    header: "Reading",
    render: (row) => (
      <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: "12px", fontVariantNumeric: "tabular-nums" }}>
        {fmtNumber(row.reading)}
      </span>
    ),
  },
  {
    // One column for both numbers beside it, since a reading and the
    // consumption derived from it are always in the same unit. Said
    // once rather than twice.
    key: "uom",
    header: "UOM",
    render: (row) => (
      <span style={{ fontSize: "11px", color: "var(--text-muted)" }}>
        {row.uom?.code ?? "—"}
      </span>
    ),
  },
  {
    key: "consumption",
    header: "Consumption",
    render: (row) => (
      <span
        style={{
          fontFamily: "'JetBrains Mono', monospace",
          fontSize: "12px",
          fontWeight: 600,
          fontVariantNumeric: "tabular-nums",
        }}
      >
        {fmtNumber(row.consumption)}
      </span>
    ),
  },
  {
    key: "readType",
    header: "Type",
    render: (row) => {
      const s = readTypeStyle(row.readType);
      return (
        <span
          style={{
            display: "inline-flex",
            padding: "2px 8px",
            borderRadius: "999px",
            background: s.bg,
            color: s.fg,
            border: `1px solid ${s.fg}`,
            fontSize: "11px",
            fontWeight: 600,
            width: "fit-content",
            justifySelf: "start",
          }}
        >
          {row.readType}
        </span>
      );
    },
  },
  {
    key: "readSource",
    header: "Source",
    render: (row) => (
      <span style={{ fontSize: "11px", color: "var(--text-muted)", letterSpacing: "0.04em" }}>
        {row.readSource}
      </span>
    ),
  },
  {
    key: "exception",
    header: "Exception",
    render: (row) =>
      row.exceptionCode ? (
        <span
          style={{
            display: "inline-flex",
            padding: "2px 8px",
            borderRadius: "4px",
            background: "var(--danger-subtle)",
            color: "var(--danger)",
            border: "1px solid var(--danger)",
            fontSize: "10px",
            fontWeight: 600,
            width: "fit-content",
            whiteSpace: "nowrap",
          }}
          /*
           * The code on hover: the label is for reading, and the
           * constant is what the API says and what somebody greps for.
           */
          title={row.exceptionCode}
        >
          {EXCEPTION_CODE_LABELS[row.exceptionCode as ExceptionCode] ?? row.exceptionCode}
        </span>
      ) : (
        <span style={{ color: "var(--text-muted)" }}>—</span>
      ),
  },
  {
    key: "isFrozen",
    header: "",
    render: (row) =>
      row.isFrozen ? (
        <span
          title="Frozen — already billed, cannot be edited"
          style={{ fontSize: "11px", color: "var(--text-muted)" }}
        >
          ❄
        </span>
      ) : null,
  },
];

/**
 * The other three views of this data, behind one control.
 *
 * They were three always-visible buttons in a row of their own above
 * the filters — a third band of chrome on a screen whose job is the
 * table. One menu, at the right of the filter row.
 *
 * **Links, and visibly not a filter pill.** Everything else in that row
 * narrows the table; these three leave it. A control that reads as
 * "filter to the exception queue" would be the same mistake as the
 * "All Exceptions" item it sits next to, so each destination is an
 * anchor carrying an arrow, and the trigger says "Show me" rather than
 * naming a dimension.
 */
const DESTINATIONS = [
  {
    href: "/meter-reads/exceptions",
    label: "Exception Queue",
    hint: "Readings that look wrong — high, zero, reversed, rolled over",
  },
  {
    href: "/meter-reads/interval-coverage",
    label: "Interval Coverage",
    /*
     * Spelled out because the two queues are easily confused: this one
     * is about interval rows that were never delivered, which no
     * reading can show, so an empty exception queue says nothing about
     * it.
     */
    hint: "Days an interval meter's data does not cover",
  },
  {
    href: "/meter-reads/progress",
    label: "Reading Progress",
    hint: "How much of a cycle is still unread",
  },
];

function ShowMeMenu() {
  const [open, setOpen] = useState(false);
  return (
    <div style={{ position: "relative" }}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: "6px",
          padding: "7px 14px",
          borderRadius: "var(--radius)",
          border: "1px solid var(--border)",
          background: "var(--bg-card)",
          color: "var(--text-secondary)",
          fontSize: "12px",
          fontWeight: 500,
          cursor: "pointer",
          fontFamily: "inherit",
          whiteSpace: "nowrap",
        }}
      >
        <span>Show me</span>
        <span style={{ fontSize: "10px", opacity: 0.6 }}>{open ? "▲" : "▼"}</span>
      </button>

      {open && (
        <>
          {/* Click-away, as FilterBar's own dropdown does it. */}
          <div
            style={{ position: "fixed", inset: 0, zIndex: 49 }}
            onClick={() => setOpen(false)}
          />
          <div
            style={{
              position: "absolute",
              top: "calc(100% + 4px)",
              right: 0,
              zIndex: 50,
              minWidth: 280,
              background: "var(--bg-card)",
              border: "1px solid var(--border)",
              borderRadius: "var(--radius)",
              boxShadow: "0 8px 24px rgba(0,0,0,0.28)",
              overflow: "hidden",
            }}
          >
            {DESTINATIONS.map((d) => (
              <Link
                key={d.href}
                href={d.href}
                onClick={() => setOpen(false)}
                style={{
                  display: "block",
                  padding: "10px 14px",
                  textDecoration: "none",
                  color: "var(--text-primary)",
                  borderBottom: "1px solid var(--border-subtle)",
                }}
              >
                <div style={{ fontSize: 13, fontWeight: 500 }}>{d.label} →</div>
                <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 2 }}>
                  {d.hint}
                </div>
              </Link>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

export default function MeterReadsPage() {
  return (
    <EntityListPage<MeterRead>
      title="Meter Reads"
      subject="reads"
      module="meter_reads"
      endpoint="/api/v1/meter-reads"
      getDetailHref={(row) => `/meter-reads/${row.id}`}
      columns={columns}
      newAction={{ label: "+ New Read", href: "/meter-reads/new" }}
      importHref="/meter-reads/import"
      emptyState={{
        headline: "No meter reads recorded",
        description:
          "Reads are the timestamped consumption values that drive billing. Capture them manually, import a CSV, or wait for an AMI feed to populate the log.",
      }}
      filtersRightSlot={<ShowMeMenu />}
      /*
       * Search, because at ten thousand meters this screen was twenty
       * rows of whatever arrived most recently out of six figures a
       * year, and nothing on it could name the meter you wanted. The
       * two numbers it matches are the two its own columns show.
       */
      search={{
        paramKey: "search",
        placeholder: "Meter or agreement number…",
        variant: "compact",
      }}
      filters={[
        /*
         * Route first, then month: a reader walks a route, the route is
         * the cycle, and "is route 1 in yet" is the question this
         * screen exists to answer for whoever is about to bill. Every
         * other filter here slices by *kind*, which narrows nothing
         * when a cycle's reads all arrive in the same three days.
         */
        {
          key: "billingCycleId",
          label: "Cycle",
          allLabel: "All Reads",
          optionsEndpoint: "/api/v1/billing-cycles",
          mapOption: (row) => ({
            value: String(row.id),
            label: `${String(row.cycleCode)} — ${String(row.name)}`,
          }),
        },
        {
          key: "readMonth",
          label: "Month",
          allLabel: "All Reads",
          options: READ_MONTH_OPTIONS,
        },
        { key: "readType", label: "Type", options: READ_TYPE_OPTIONS },
        { key: "readSource", label: "Source", options: READ_SOURCE_OPTIONS },
        {
          /*
           * The clear item is "All Reads", not "All Exceptions" — that read
           * as *every flagged read*, a third subset, rather than as
           * "do not filter on this". A filter whose label is a
           * condition cannot borrow its own label for the word that
           * means the absence of it.
           */
          key: "hasException",
          label: "Exceptions",
          allLabel: "All Reads",
          options: [
            { label: "With exception", value: "true" },
            { label: "No exception", value: "false" },
          ],
        },
        {
          // "All Billed" had the same fault as "All Exceptions".
          key: "isFrozen",
          label: "Billed",
          allLabel: "All Reads",
          options: [
            { label: "Frozen (billed)", value: "true" },
            { label: "Unbilled", value: "false" },
          ],
        },
      ]}
    />
  );
}
