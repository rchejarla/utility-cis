"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { apiClient } from "@/lib/api-client";
import { usePermission } from "@/lib/use-permission";
import { AccessDenied } from "@/components/ui/access-denied";
import { PageHeader } from "@/components/ui/page-header";
import { StatusBadge } from "@/components/ui/status-badge";
import { DataTable } from "@/components/ui/data-table";

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
      <PageHeader title="Imports" subtitle="Cross-kind history of bulk uploads." />

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
            { key: "source", header: "Source" },
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

      <div style={{ marginTop: "16px", fontSize: "12px", color: "var(--text-muted)" }}>
        Start a new import from the entity-specific page (e.g.,{" "}
        <Link href="/meter-reads/import" style={{ color: "var(--accent-primary)" }}>
          /meter-reads/import
        </Link>
        ).
      </div>
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
