"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { apiClient } from "@/lib/api-client";
import { usePermission } from "@/lib/use-permission";
import { AccessDenied } from "@/components/ui/access-denied";
import { PageHeader } from "@/components/ui/page-header";
import { StatusBadge } from "@/components/ui/status-badge";
import { DataTable } from "@/components/ui/data-table";
import { sourceLabel } from "@/components/imports/source-label";

interface ImportBatchRow {
  id: string;
  utilityId: string;
  entityKind: string;
  source: string;
  fileName: string | null;
  recordCount: number;
  importedCount: number;
  errorCount: number;
  status: string;
  createdBy: string;
  createdAt: string;
  completedAt: string | null;
}

interface KindMeta {
  kind: string;
  label: string;
  /** Where this kind's wizard lives, declared by the handler. */
  wizardPath?: string;
}

/**
 * How you start an import.
 *
 * This page is reached from the sidebar's "Imports" entry, which is
 * where anyone looks, and it listed history only: the sole affordance
 * was a muted footnote under the table naming `/meter-reads/import`,
 * one of six kinds, leaving the rest as URLs you had to know.
 *
 * The list is the registry's rather than a copy of it — each handler
 * declares its own `wizardPath`, so a seventh kind appears here on
 * registration with nothing to edit on this page. A kind that somehow
 * arrives without one is listed as unavailable instead of rendering a
 * link to nowhere.
 */
function NewImportMenu({ kinds }: { kinds: KindMeta[] }) {
  const [open, setOpen] = useState(false);
  const available = kinds.filter((k) => k.wizardPath);

  if (available.length === 0) return null;

  return (
    <div style={{ position: "relative" }}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: "8px",
          padding: "8px 16px",
          borderRadius: "var(--radius)",
          background: "var(--accent-primary)",
          color: "#fff",
          border: "none",
          fontSize: "13px",
          fontWeight: 600,
          cursor: "pointer",
          fontFamily: "inherit",
        }}
      >
        New import
        <i className="fa-solid fa-chevron-down" style={{ fontSize: "10px" }} aria-hidden />
      </button>

      {open && (
        <>
          {/* Click anywhere else to dismiss. */}
          <div
            onClick={() => setOpen(false)}
            style={{ position: "fixed", inset: 0, zIndex: 10 }}
            aria-hidden
          />
          <div
            role="menu"
            style={{
              position: "absolute",
              right: 0,
              top: "calc(100% + 6px)",
              zIndex: 11,
              minWidth: "220px",
              padding: "6px",
              background: "var(--bg-card)",
              border: "1px solid var(--border)",
              borderRadius: "var(--radius)",
              boxShadow: "0 8px 24px rgba(0,0,0,0.28)",
            }}
          >
            {available.map((k) => (
              <Link
                key={k.kind}
                href={k.wizardPath as string}
                onClick={() => setOpen(false)}
                style={{
                  display: "block",
                  padding: "8px 10px",
                  borderRadius: "6px",
                  fontSize: "13px",
                  color: "var(--text-primary)",
                  textDecoration: "none",
                }}
              >
                {k.label}
              </Link>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

const STATUSES = ["PENDING", "PROCESSING", "COMPLETE", "PARTIAL", "FAILED", "CANCELLED"] as const;

export default function ImportsListPage() {
  const { canView } = usePermission("imports");
  const [imports, setImports] = useState<ImportBatchRow[]>([]);
  const [kinds, setKinds] = useState<KindMeta[]>([]);
  const [filterKind, setFilterKind] = useState<string>("");
  const [filterStatus, setFilterStatus] = useState<string>("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    apiClient.get<KindMeta[]>("/api/v1/imports/kinds").then(setKinds).catch(console.error);
  }, []);

  useEffect(() => {
    setLoading(true);
    const query: Record<string, string> = {};
    if (filterKind) query.kind = filterKind;
    if (filterStatus) query.status = filterStatus;
    apiClient
      .get<{ data: ImportBatchRow[] }>("/api/v1/imports", query)
      .then((res) => setImports(res.data ?? []))
      .catch(console.error)
      .finally(() => setLoading(false));
  }, [filterKind, filterStatus]);

  if (!canView) return <AccessDenied />;

  const kindLabel = (k: string) => kinds.find((x) => x.kind === k)?.label ?? k;

  return (
    <div>
      <PageHeader
        title="Imports"
        subtitle="Cross-kind history of bulk uploads."
        actions={<NewImportMenu kinds={kinds} />}
      />

      <div
        style={{
          display: "flex",
          gap: "12px",
          marginBottom: "16px",
          alignItems: "center",
          flexWrap: "wrap",
        }}
      >
        <select
          value={filterKind}
          onChange={(e) => setFilterKind(e.target.value)}
          style={selectStyle}
        >
          <option value="">All kinds</option>
          {kinds.map((k) => (
            <option key={k.kind} value={k.kind}>
              {k.label}
            </option>
          ))}
        </select>
        <select
          value={filterStatus}
          onChange={(e) => setFilterStatus(e.target.value)}
          style={selectStyle}
        >
          <option value="">All statuses</option>
          {STATUSES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
      </div>

      {loading ? (
        <div style={{ color: "var(--text-muted)", padding: "20px 0" }}>Loading…</div>
      ) : (
        <DataTable
          columns={[
            {
              key: "createdAt",
              header: "Started",
              render: (row: any) => new Date(row.createdAt).toLocaleString(),
            },
            {
              key: "entityKind",
              header: "Kind",
              render: (row: any) => kindLabel(row.entityKind),
            },
            {
              key: "source",
              header: "Source",
              render: (row: any) => sourceLabel(row.source),
            },
            {
              key: "fileName",
              header: "File",
              render: (row: any) => row.fileName ?? "—",
            },
            {
              key: "status",
              header: "Status",
              render: (row: any) => <StatusBadge status={row.status} />,
            },
            { key: "recordCount", header: "Rows" },
            { key: "importedCount", header: "Imported" },
            {
              key: "errorCount",
              header: "Errors",
              render: (row: any) =>
                row.errorCount > 0 ? (
                  <span style={{ color: "var(--danger)", fontWeight: 600 }}>
                    {row.errorCount}
                  </span>
                ) : (
                  "0"
                ),
            },
          ]}
          data={imports as any}
          onRowClick={(row: any) => {
            window.location.href = `/imports/${row.id}`;
          }}
        />
      )}
      {!loading && imports.length === 0 && (
        <div style={{ color: "var(--text-muted)", fontSize: "13px", padding: "20px 0" }}>
          {filterKind || filterStatus
            ? "No imports match the filters."
            : "No imports yet."}
        </div>
      )}

    </div>
  );
}

const selectStyle: React.CSSProperties = {
  padding: "8px 12px",
  fontSize: "13px",
  background: "var(--bg-card)",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius)",
  color: "var(--text-primary)",
  fontFamily: "inherit",
  minWidth: "180px",
};
