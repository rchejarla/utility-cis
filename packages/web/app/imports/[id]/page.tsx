"use client";

import { useEffect, useState, use } from "react";
import Link from "next/link";
import { apiClient, API_URL } from "@/lib/api-client";
import { usePermission } from "@/lib/use-permission";
import { AccessDenied } from "@/components/ui/access-denied";
import { PageHeader } from "@/components/ui/page-header";
import { StatusBadge } from "@/components/ui/status-badge";
import { Tabs } from "@/components/ui/tabs";
import { DataTable } from "@/components/ui/data-table";
import { useToast } from "@/components/ui/toast";
import { sourceLabel } from "@/components/imports/source-label";

/**
 * Browser <a href download> sends the GET request without our
 * Authorization header, so the API rejects with 401. Fetch the file
 * with auth, materialise as a Blob URL, then trigger the download
 * via a synthesised anchor click. Same pattern the AttachmentsTab
 * uses; lifted into a helper here because we hit it from three
 * places on this page (original file, errors CSV, summary CSV).
 */
async function authDownload(url: string, suggestedFileName: string): Promise<void> {
  const headers = await apiClient.getAuthHeadersOnly();
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`Download failed (${res.status})`);
  const blob = await res.blob();
  const blobUrl = window.URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = blobUrl;
  a.download = suggestedFileName;
  a.click();
  window.URL.revokeObjectURL(blobUrl);
}

interface ImportBatch {
  id: string;
  entityKind: string;
  source: string;
  fileName: string | null;
  recordCount: number;
  importedCount: number;
  errorCount: number;
  status: string;
  mapping: Record<string, string> | null;
  createdBy: string;
  createdAt: string;
  completedAt: string | null;
}

interface ImportRow {
  id: string;
  rowIndex: number;
  rawData: Record<string, string>;
  status: string;
  resultEntityId: string | null;
  errorCode: string | null;
  errorMessage: string | null;
}

interface AttachmentMeta {
  id: string;
  fileName: string;
  fileSize: number;
  fileType: string;
}

interface DetailResponse {
  batch: ImportBatch;
  attachment: AttachmentMeta | null;
}

interface ErrorSummaryEntry {
  errorCode: string;
  count: number;
}

export default function ImportDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const { canView } = usePermission("imports");
  const { toast } = useToast();
  const [detail, setDetail] = useState<DetailResponse | null>(null);
  const [activeTab, setActiveTab] = useState("summary");
  const [rows, setRows] = useState<ImportRow[]>([]);
  const [errorSummary, setErrorSummary] = useState<ErrorSummaryEntry[]>([]);
  const [rowFilter, setRowFilter] = useState<string>("");

  const refresh = async () => {
    try {
      const [d, es] = await Promise.all([
        apiClient.get<DetailResponse>(`/api/v1/imports/${id}`),
        apiClient.get<ErrorSummaryEntry[]>(`/api/v1/imports/${id}/error-summary`),
      ]);
      setDetail(d);
      setErrorSummary(es);
    } catch (err) {
      console.error(err);
    }
  };

  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  // Poll while batch is in a non-terminal state.
  useEffect(() => {
    if (!detail) return;
    const inFlight = ["PENDING", "PROCESSING"].includes(detail.batch.status);
    if (!inFlight) return;
    const t = setInterval(refresh, 5000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detail?.batch.status]);

  const handleCancel = async () => {
    try {
      await apiClient.post(`/api/v1/imports/${id}/cancel`, {});
      toast(
        "Cancellation requested. The import will stop after the current batch of rows.",
        "info",
      );
      await refresh();
    } catch (err) {
      toast(err instanceof Error ? err.message : "Cancel failed", "error");
    }
  };

  const handleRetry = async () => {
    try {
      await apiClient.post(`/api/v1/imports/${id}/retry`, {});
      toast("Retry enqueued. The import is re-running.", "info");
      await refresh();
    } catch (err) {
      toast(err instanceof Error ? err.message : "Retry failed", "error");
    }
  };

  useEffect(() => {
    if (activeTab !== "rows" && activeTab !== "errors") return;
    const query: Record<string, string> = {};
    if (activeTab === "errors") query.status = "ERROR";
    else if (rowFilter) query.status = rowFilter;
    apiClient
      .get<{ data: ImportRow[] }>(`/api/v1/imports/${id}/rows`, query)
      .then((res) => setRows(res.data ?? []))
      .catch(console.error);
  }, [activeTab, id, rowFilter]);

  if (!canView) return <AccessDenied />;
  if (!detail) {
    return <div style={{ color: "var(--text-muted)", padding: "20px 0" }}>Loading…</div>;
  }

  const { batch, attachment } = detail;

  return (
    <div>
      <PageHeader
        title={`Import ${batch.id.slice(0, 8)}`}
        subtitle={`${batch.entityKind} · ${sourceLabel(batch.source)} · ${batch.fileName ?? "—"}`}
        actions={
          <div style={{ display: "flex", gap: "8px" }}>
            {batch.status === "PROCESSING" && (
              <button
                onClick={handleCancel}
                style={{
                  padding: "7px 16px",
                  background: "transparent",
                  border: "1px solid var(--warning)",
                  borderRadius: "var(--radius)",
                  color: "var(--warning)",
                  fontSize: "12px",
                  fontWeight: 500,
                  cursor: "pointer",
                  fontFamily: "inherit",
                }}
              >
                Cancel
              </button>
            )}
            {["FAILED", "PARTIAL", "CANCELLED"].includes(batch.status) && (
              <button
                onClick={handleRetry}
                style={{
                  padding: "7px 16px",
                  background: "var(--accent-primary)",
                  border: "1px solid var(--accent-primary)",
                  borderRadius: "var(--radius)",
                  color: "#fff",
                  fontSize: "12px",
                  fontWeight: 500,
                  cursor: "pointer",
                  fontFamily: "inherit",
                }}
              >
                Retry
              </button>
            )}
            {attachment && (
              <button
                onClick={async () => {
                  try {
                    await authDownload(
                      `${API_URL}/api/v1/attachments/${attachment.id}/download`,
                      attachment.fileName,
                    );
                  } catch (err) {
                    toast(err instanceof Error ? err.message : "Download failed", "error");
                  }
                }}
                style={{
                  padding: "7px 16px",
                  background: "transparent",
                  border: "1px solid var(--accent-primary)",
                  borderRadius: "var(--radius)",
                  color: "var(--accent-primary)",
                  fontSize: "12px",
                  fontWeight: 500,
                  cursor: "pointer",
                  fontFamily: "inherit",
                }}
              >
                Download original file
              </button>
            )}
          </div>
        }
      />

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(4, 1fr)",
          gap: "12px",
          marginBottom: "20px",
        }}
      >
        <Stat label="Status" value={<StatusBadge status={batch.status} />} />
        <Stat label="Rows" value={batch.recordCount.toLocaleString()} />
        <Stat label="Imported" value={batch.importedCount.toLocaleString()} accent="var(--success)" />
        <Stat
          label="Errors"
          value={batch.errorCount.toLocaleString()}
          accent={batch.errorCount > 0 ? "var(--danger)" : undefined}
        />
      </div>

      <Tabs
        tabs={[
          { key: "summary", label: "Summary" },
          { key: "rows", label: "Rows" },
          { key: "errors", label: `Errors (${batch.errorCount})` },
        ]}
        activeTab={activeTab}
        onTabChange={setActiveTab}
      >
        {activeTab === "summary" && (
          <div style={{ display: "flex", flexDirection: "column", gap: "20px" }}>
            <Section title="Timing">
              <KV k="Started" v={new Date(batch.createdAt).toLocaleString()} />
              <KV k="Completed" v={batch.completedAt ? new Date(batch.completedAt).toLocaleString() : "—"} />
            </Section>

            {errorSummary.length > 0 && (
              <Section title="Error breakdown">
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "13px" }}>
                  <tbody>
                    {errorSummary.map((e) => (
                      <tr key={e.errorCode}>
                        <td style={{ padding: "6px 12px", fontFamily: "'JetBrains Mono', monospace", color: "var(--danger)", fontWeight: 600 }}>
                          {e.errorCode}
                        </td>
                        <td style={{ padding: "6px 12px", textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
                          {e.count.toLocaleString()}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <button
                  onClick={async () => {
                    try {
                      await authDownload(
                        `${API_URL}/api/v1/imports/${id}/errors.csv`,
                        `import-${id}-errors.csv`,
                      );
                    } catch (err) {
                      toast(err instanceof Error ? err.message : "Download failed", "error");
                    }
                  }}
                  style={{
                    display: "inline-block",
                    marginTop: "12px",
                    padding: 0,
                    background: "none",
                    border: "none",
                    fontSize: "12px",
                    color: "var(--accent-primary)",
                    textDecoration: "underline",
                    cursor: "pointer",
                    fontFamily: "inherit",
                  }}
                >
                  Download errors CSV
                </button>
              </Section>
            )}

            {batch.mapping && (
              <Section title="Mapping used">
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "12px", fontFamily: "'JetBrains Mono', monospace" }}>
                  <tbody>
                    {Object.entries(batch.mapping).map(([k, v]) => (
                      <tr key={k}>
                        <td style={{ padding: "4px 12px", color: "var(--text-muted)" }}>{k}</td>
                        <td style={{ padding: "4px 12px" }}>→</td>
                        <td style={{ padding: "4px 12px" }}>{v as string}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </Section>
            )}
          </div>
        )}

        {activeTab === "rows" && (
          <div>
            <div style={{ marginBottom: "12px" }}>
              <select
                value={rowFilter}
                onChange={(e) => setRowFilter(e.target.value)}
                style={selectStyle}
              >
                <option value="">All statuses</option>
                <option value="PENDING">PENDING</option>
                <option value="IMPORTED">IMPORTED</option>
                <option value="ERROR">ERROR</option>
                <option value="SKIPPED">SKIPPED</option>
              </select>
            </div>
            <DataTable
              columns={[
                { key: "rowIndex", header: "Row" },
                {
                  key: "status",
                  header: "Status",
                  render: (row: any) => <StatusBadge status={row.status} />,
                },
                {
                  key: "rawData",
                  header: "Source values",
                  wrap: true,
                  render: (row: any) => (
                    <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: "11px", color: "var(--text-muted)" }}>
                      {Object.entries(row.rawData ?? {})
                        .slice(0, 3)
                        .map(([k, v]) => `${k}=${v}`)
                        .join(", ")}
                    </span>
                  ),
                },
                {
                  key: "errorCode",
                  header: "Error",
                  render: (row: any) =>
                    row.errorCode ? (
                      <span style={{ color: "var(--danger)" }}>{row.errorCode}</span>
                    ) : (
                      "—"
                    ),
                },
              ]}
              data={rows as any}
            />
          </div>
        )}

        {activeTab === "errors" && (
          <div>
            <DataTable
              columns={[
                { key: "rowIndex", header: "Row" },
                {
                  key: "errorCode",
                  header: "Code",
                  render: (row: any) => (
                    <span
                      style={{
                        color: "var(--danger)",
                        fontFamily: "'JetBrains Mono', monospace",
                        fontWeight: 600,
                      }}
                    >
                      {row.errorCode ?? "UNKNOWN"}
                    </span>
                  ),
                },
                { key: "errorMessage", header: "Message", wrap: true },
                {
                  key: "rawData",
                  header: "Source values",
                  wrap: true,
                  render: (row: any) => (
                    <span
                      style={{
                        fontFamily: "'JetBrains Mono', monospace",
                        fontSize: "11px",
                        color: "var(--text-muted)",
                      }}
                    >
                      {Object.entries(row.rawData ?? {})
                        .slice(0, 3)
                        .map(([k, v]) => `${k}=${v}`)
                        .join(", ")}
                    </span>
                  ),
                },
              ]}
              data={rows as any}
            />
            {rows.length > 0 && (
              <button
                onClick={async () => {
                  try {
                    await authDownload(
                      `${API_URL}/api/v1/imports/${id}/errors.csv`,
                      `import-${id}-errors.csv`,
                    );
                  } catch (err) {
                    toast(err instanceof Error ? err.message : "Download failed", "error");
                  }
                }}
                style={{
                  display: "inline-block",
                  marginTop: "12px",
                  padding: 0,
                  background: "none",
                  border: "none",
                  fontSize: "12px",
                  color: "var(--accent-primary)",
                  textDecoration: "underline",
                  cursor: "pointer",
                  fontFamily: "inherit",
                }}
              >
                Download all errors as CSV
              </button>
            )}
          </div>
        )}
      </Tabs>

      <div style={{ marginTop: "16px" }}>
        <Link href="/imports" style={{ color: "var(--accent-primary)", fontSize: "13px" }}>
          ← Back to all imports
        </Link>
      </div>
    </div>
  );
}

function Stat({
  label,
  value,
  accent,
}: {
  label: string;
  value: string | React.ReactNode;
  accent?: string;
}) {
  return (
    <div
      style={{
        background: "var(--bg-card)",
        border: "1px solid var(--border)",
        borderLeft: `3px solid ${accent ?? "var(--accent-primary)"}`,
        borderRadius: "var(--radius)",
        padding: "12px 16px",
      }}
    >
      <div
        style={{
          fontSize: "10px",
          fontWeight: 600,
          color: "var(--text-muted)",
          textTransform: "uppercase",
          letterSpacing: "0.05em",
          marginBottom: "4px",
        }}
      >
        {label}
      </div>
      <div style={{ fontSize: "20px", fontWeight: 700, color: "var(--text-primary)" }}>
        {value}
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div
      style={{
        background: "var(--bg-card)",
        border: "1px solid var(--border)",
        borderRadius: "var(--radius)",
        padding: "16px 20px",
      }}
    >
      <h3
        style={{
          fontSize: "12px",
          fontWeight: 600,
          color: "var(--text-muted)",
          margin: "0 0 12px 0",
          textTransform: "uppercase",
          letterSpacing: "0.05em",
        }}
      >
        {title}
      </h3>
      {children}
    </div>
  );
}

function KV({ k, v }: { k: string; v: string }) {
  return (
    <div style={{ display: "flex", gap: "16px", fontSize: "13px", padding: "4px 0" }}>
      <div style={{ width: "120px", color: "var(--text-muted)" }}>{k}</div>
      <div>{v}</div>
    </div>
  );
}

const selectStyle: React.CSSProperties = {
  padding: "6px 10px",
  fontSize: "13px",
  background: "var(--bg-card)",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius)",
  color: "var(--text-primary)",
  fontFamily: "inherit",
};
