"use client";

import Link from "next/link";
import { READ_TYPES, type ReadType } from "@utility-cis/shared";
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
            fontWeight: 700,
            letterSpacing: "0.04em",
            width: "fit-content",
          }}
        >
          {row.exceptionCode}
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

function HeaderActions() {
  return (
    <div style={{ display: "flex", gap: "8px", marginBottom: "12px", flexWrap: "wrap" }}>
      <Link
        href="/meter-reads/exceptions"
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: "6px",
          padding: "7px 14px",
          borderRadius: "var(--radius)",
          border: "1px solid var(--danger)",
          background: "var(--danger-subtle)",
          color: "var(--danger)",
          fontSize: "12px",
          fontWeight: 600,
          textDecoration: "none",
          fontFamily: "inherit",
        }}
      >
        ⚠ Exception Queue
      </Link>
      {/*
       * Two queues, and they answer different questions. The one above
       * is about a reading that looks wrong — high, zero, a rollover.
       * This one is about interval data that does not cover its day,
       * which no reading can show because the rows were never
       * delivered. Side by side so nobody has to learn that an empty
       * exception queue says nothing about interval coverage.
       */}
      <Link
        href="/meter-reads/interval-coverage"
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: "6px",
          padding: "7px 14px",
          borderRadius: "var(--radius)",
          border: "1px solid var(--border)",
          background: "var(--bg-elevated)",
          color: "var(--text-secondary)",
          fontSize: "12px",
          fontWeight: 600,
          textDecoration: "none",
          fontFamily: "inherit",
        }}
      >
        ⧖ Interval Coverage
      </Link>
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
      headerSlot={<HeaderActions />}
      filters={[
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
