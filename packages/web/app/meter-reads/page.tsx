"use client";

import Link from "next/link";
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
  serviceAgreement?: { agreementNumber: string };
}

const READ_TYPE_OPTIONS = [
  { label: "Actual", value: "ACTUAL" },
  { label: "Estimated", value: "ESTIMATED" },
  { label: "Corrected", value: "CORRECTED" },
  { label: "Final", value: "FINAL" },
  { label: "AMI", value: "AMI" },
];

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
    case "AMI":
      return { bg: "var(--accent-primary-subtle)", fg: "var(--accent-primary)" };
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
      <Link
        href="/meter-reads/import"
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: "6px",
          padding: "7px 14px",
          borderRadius: "var(--radius)",
          border: "1px solid var(--border)",
          background: "var(--bg-card)",
          color: "var(--text-primary)",
          fontSize: "12px",
          fontWeight: 500,
          textDecoration: "none",
          fontFamily: "inherit",
        }}
      >
        ↑ Import Reads
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
      headerSlot={<HeaderActions />}
      filters={[
        { key: "readType", label: "Type", options: READ_TYPE_OPTIONS },
        { key: "readSource", label: "Source", options: READ_SOURCE_OPTIONS },
        {
          key: "hasException",
          label: "Exceptions",
          options: [
            { label: "With exception", value: "true" },
            { label: "No exception", value: "false" },
          ],
        },
        {
          key: "isFrozen",
          label: "Billed",
          options: [
            { label: "Frozen (billed)", value: "true" },
            { label: "Unbilled", value: "false" },
          ],
        },
      ]}
    />
  );
}
