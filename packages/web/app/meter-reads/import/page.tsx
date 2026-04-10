"use client";

import { useState, useRef } from "react";
import Link from "next/link";
import { apiClient } from "@/lib/api-client";
import { usePermission } from "@/lib/use-permission";
import { AccessDenied } from "@/components/ui/access-denied";
import { useToast } from "@/components/ui/toast";

/**
 * Import center — three-stage wizard for bulk meter read ingestion.
 *
 *   [1] UPLOAD      drag-and-drop or paste JSON
 *   [2] PREVIEW     first 10 rows with parsed values
 *   [3] COMMIT      progress + results summary with error report
 *
 * Design intent: feels like a deliberate operational workflow rather
 * than a form. Bold numbered stages on the left rail, dominant content
 * area on the right. Monospace for any data the user has to verify
 * (meter numbers, readings) because trusting the visual match is the
 * core task. Motion is limited to stage transitions and the progress
 * bar — no ornamental animations.
 */

type StageKey = "upload" | "preview" | "commit";

interface ParsedRow {
  meterNumber: string;
  readDatetime: string;
  reading: number;
  readType?: string;
  readSource?: string;
  __error?: string;
}

interface ImportPayload {
  source: string;
  fileName?: string;
  reads: ParsedRow[];
}

interface CommitResult {
  imported: number;
  exceptions: number;
  errors: Array<{ row: number; error: string }>;
}

function parseCsv(text: string): ParsedRow[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length === 0) return [];
  const headers = lines[0].split(",").map((h) => h.trim().toLowerCase());
  const idx = (name: string) => headers.indexOf(name);
  const meterIdx = idx("meter_number") !== -1 ? idx("meter_number") : idx("meter");
  const dateIdx = idx("read_datetime") !== -1 ? idx("read_datetime") : idx("datetime");
  const readingIdx = idx("reading");
  const typeIdx = idx("read_type");
  const sourceIdx = idx("read_source");

  return lines.slice(1).map((line) => {
    const cols = line.split(",").map((c) => c.trim());
    const row: ParsedRow = {
      meterNumber: meterIdx >= 0 ? cols[meterIdx] ?? "" : "",
      readDatetime: dateIdx >= 0 ? cols[dateIdx] ?? "" : "",
      reading: readingIdx >= 0 ? parseFloat(cols[readingIdx] ?? "") : NaN,
      readType: typeIdx >= 0 ? cols[typeIdx] : undefined,
      readSource: sourceIdx >= 0 ? cols[sourceIdx] : undefined,
    };
    if (!row.meterNumber) row.__error = "missing meter_number";
    else if (!row.readDatetime) row.__error = "missing read_datetime";
    else if (Number.isNaN(row.reading)) row.__error = "invalid reading";
    else {
      // normalize date to ISO
      try {
        row.readDatetime = new Date(row.readDatetime).toISOString();
      } catch {
        row.__error = "unparseable date";
      }
    }
    return row;
  });
}

function parseJson(text: string): ParsedRow[] {
  try {
    const data = JSON.parse(text);
    const arr = Array.isArray(data) ? data : Array.isArray(data.reads) ? data.reads : [];
    return arr.map((r: Record<string, unknown>) => ({
      meterNumber: String(r.meterNumber ?? r.meter_number ?? ""),
      readDatetime: String(r.readDatetime ?? r.read_datetime ?? ""),
      reading: Number(r.reading ?? NaN),
      readType: r.readType ? String(r.readType) : undefined,
      readSource: r.readSource ? String(r.readSource) : undefined,
    }));
  } catch {
    return [];
  }
}

export default function ImportCenterPage() {
  const { canView, canCreate } = usePermission("meter_reads");
  const { toast } = useToast();
  const [stage, setStage] = useState<StageKey>("upload");
  const [fileName, setFileName] = useState<string | null>(null);
  const [source, setSource] = useState<string>("MANUAL_UPLOAD");
  const [pastedText, setPastedText] = useState<string>("");
  const [rows, setRows] = useState<ParsedRow[]>([]);
  const [committing, setCommitting] = useState(false);
  const [progress, setProgress] = useState(0);
  const [result, setResult] = useState<CommitResult | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  if (!canView) return <AccessDenied />;

  const handleFile = async (file: File) => {
    const text = await file.text();
    setFileName(file.name);
    const parsed = file.name.endsWith(".json") ? parseJson(text) : parseCsv(text);
    setRows(parsed);
    setStage("preview");
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer.files[0];
    if (file) handleFile(file);
  };

  const handlePaste = () => {
    if (!pastedText.trim()) return;
    const parsed = pastedText.trim().startsWith("[") || pastedText.trim().startsWith("{")
      ? parseJson(pastedText)
      : parseCsv(pastedText);
    setFileName("(pasted)");
    setRows(parsed);
    setStage("preview");
  };

  const commit = async () => {
    if (!canCreate) {
      toast("No permission to import reads", "error");
      return;
    }
    const validRows = rows.filter((r) => !r.__error);
    if (validRows.length === 0) {
      toast("No valid rows to import", "error");
      return;
    }
    setCommitting(true);
    setProgress(0);
    setStage("commit");

    try {
      // Fake progress animation while the backend chews
      const interval = setInterval(() => {
        setProgress((p) => Math.min(p + 7, 90));
      }, 120);

      const payload: ImportPayload = {
        source,
        fileName: fileName ?? undefined,
        reads: validRows.map((r) => ({
          meterNumber: r.meterNumber,
          readDatetime: r.readDatetime,
          reading: r.reading,
          readType: r.readType,
          readSource: r.readSource,
        })),
      };
      // Backend endpoint not yet implemented — the import route is a
      // Phase 2/3 follow-up. Posting to a placeholder endpoint surfaces
      // a clean error and lets us exercise the preview+commit flow
      // end-to-end without fake-success.
      await apiClient.post<CommitResult>("/api/v1/meter-reads/import", payload).catch(async () => {
        // Soft-fallback: report the errors our client-side parser found
        throw new Error(
          "Bulk import endpoint is not yet deployed — the CLI parser surfaced the rows above. " +
            "The backend implementation is a Phase 2 follow-up.",
        );
      });
      clearInterval(interval);
      setProgress(100);
      setResult({
        imported: validRows.length,
        exceptions: 0,
        errors: [],
      });
      toast(`Imported ${validRows.length} reads`, "success");
    } catch (err) {
      setResult({
        imported: 0,
        exceptions: 0,
        errors: [
          {
            row: 0,
            error: err instanceof Error ? err.message : "Import failed",
          },
        ],
      });
    } finally {
      setCommitting(false);
    }
  };

  const reset = () => {
    setStage("upload");
    setFileName(null);
    setPastedText("");
    setRows([]);
    setResult(null);
    setProgress(0);
  };

  const validCount = rows.filter((r) => !r.__error).length;
  const errorCount = rows.length - validCount;

  return (
    <div style={{ maxWidth: "960px" }}>
      <div
        style={{
          marginBottom: "8px",
          fontFamily: "'JetBrains Mono', monospace",
          fontSize: "11px",
          color: "var(--text-muted)",
          letterSpacing: "0.04em",
        }}
      >
        <Link
          href="/meter-reads"
          style={{ color: "var(--text-muted)", textDecoration: "none" }}
        >
          ← /meter-reads
        </Link>
      </div>
      <h1
        style={{
          fontFamily: "'JetBrains Mono', monospace",
          fontSize: "28px",
          fontWeight: 700,
          letterSpacing: "-0.02em",
          margin: "0 0 6px 0",
          color: "var(--text-primary)",
        }}
      >
        IMPORT_CENTER
      </h1>
      <p
        style={{
          fontSize: "13px",
          color: "var(--text-secondary)",
          margin: "0 0 28px 0",
        }}
      >
        Bulk ingest meter reads from AMR, AMI, or manual CSV/JSON.
      </p>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "220px 1fr",
          gap: "24px",
          alignItems: "start",
        }}
      >
        {/* Left rail — numbered stages */}
        <div style={{ position: "sticky", top: "20px" }}>
          {(["upload", "preview", "commit"] as StageKey[]).map((s, i) => {
            const active = s === stage;
            const done =
              (s === "upload" && stage !== "upload") ||
              (s === "preview" && stage === "commit");
            return (
              <div
                key={s}
                style={{
                  display: "flex",
                  alignItems: "flex-start",
                  gap: "14px",
                  padding: "14px 0",
                  borderLeft: active
                    ? "2px solid var(--accent-primary)"
                    : "2px solid var(--border)",
                  paddingLeft: "16px",
                  marginLeft: "8px",
                  opacity: done ? 0.6 : 1,
                }}
              >
                <div
                  style={{
                    width: "28px",
                    height: "28px",
                    borderRadius: "50%",
                    border: `2px solid ${active ? "var(--accent-primary)" : done ? "var(--success)" : "var(--border)"}`,
                    background: done ? "var(--success)" : "transparent",
                    color: done ? "#fff" : active ? "var(--accent-primary)" : "var(--text-muted)",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    fontFamily: "'JetBrains Mono', monospace",
                    fontSize: "12px",
                    fontWeight: 700,
                    flexShrink: 0,
                  }}
                >
                  {done ? "✓" : String(i + 1).padStart(2, "0")}
                </div>
                <div>
                  <div
                    style={{
                      fontFamily: "'JetBrains Mono', monospace",
                      fontSize: "11px",
                      fontWeight: 700,
                      letterSpacing: "0.08em",
                      color: active ? "var(--text-primary)" : "var(--text-muted)",
                    }}
                  >
                    {s.toUpperCase()}
                  </div>
                  <div style={{ fontSize: "11px", color: "var(--text-muted)", marginTop: "2px" }}>
                    {s === "upload" && "Drop a file or paste JSON"}
                    {s === "preview" && "Verify parsed rows before commit"}
                    {s === "commit" && "Run the import and review results"}
                  </div>
                </div>
              </div>
            );
          })}
        </div>

        {/* Right content */}
        <div>
          {stage === "upload" && (
            <div>
              <div style={{ marginBottom: "16px" }}>
                <label
                  style={{
                    display: "block",
                    fontFamily: "'JetBrains Mono', monospace",
                    fontSize: "10px",
                    fontWeight: 700,
                    letterSpacing: "0.08em",
                    color: "var(--text-muted)",
                    marginBottom: "6px",
                  }}
                >
                  SOURCE
                </label>
                <select
                  value={source}
                  onChange={(e) => setSource(e.target.value)}
                  style={{
                    padding: "8px 12px",
                    fontSize: "13px",
                    background: "var(--bg-card)",
                    border: "1px solid var(--border)",
                    borderRadius: "var(--radius)",
                    color: "var(--text-primary)",
                    fontFamily: "inherit",
                    minWidth: "220px",
                  }}
                >
                  <option value="AMR">AMR drive-by</option>
                  <option value="AMI">AMI interval data</option>
                  <option value="MANUAL_UPLOAD">Manual CSV upload</option>
                  <option value="API">API payload</option>
                </select>
              </div>

              <div
                onDragOver={(e) => {
                  e.preventDefault();
                  setDragOver(true);
                }}
                onDragLeave={() => setDragOver(false)}
                onDrop={handleDrop}
                onClick={() => fileInputRef.current?.click()}
                style={{
                  border: `2px dashed ${dragOver ? "var(--accent-primary)" : "var(--border)"}`,
                  borderRadius: "var(--radius)",
                  padding: "48px 24px",
                  textAlign: "center",
                  background: dragOver ? "var(--accent-primary-subtle)" : "var(--bg-card)",
                  cursor: "pointer",
                  transition: "all 0.15s ease",
                }}
              >
                <div style={{ fontSize: "36px", marginBottom: "12px" }}>📁</div>
                <div
                  style={{
                    fontFamily: "'JetBrains Mono', monospace",
                    fontSize: "13px",
                    fontWeight: 600,
                    color: "var(--text-primary)",
                    marginBottom: "4px",
                  }}
                >
                  drop file here or click to browse
                </div>
                <div style={{ fontSize: "11px", color: "var(--text-muted)" }}>
                  Accepts .csv with headers [meter_number, read_datetime, reading, read_type, read_source] or .json
                </div>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".csv,.json,.xml"
                  onChange={(e) => e.target.files?.[0] && handleFile(e.target.files[0])}
                  style={{ display: "none" }}
                />
              </div>

              <div
                style={{
                  marginTop: "16px",
                  padding: "16px",
                  background: "var(--bg-card)",
                  border: "1px solid var(--border)",
                  borderRadius: "var(--radius)",
                }}
              >
                <div
                  style={{
                    fontFamily: "'JetBrains Mono', monospace",
                    fontSize: "10px",
                    fontWeight: 700,
                    letterSpacing: "0.08em",
                    color: "var(--text-muted)",
                    marginBottom: "8px",
                  }}
                >
                  OR PASTE JSON
                </div>
                <textarea
                  value={pastedText}
                  onChange={(e) => setPastedText(e.target.value)}
                  placeholder='[{"meterNumber": "MTR-001", "readDatetime": "2026-04-10T09:00:00Z", "reading": 12345.67}]'
                  rows={6}
                  style={{
                    width: "100%",
                    padding: "10px 12px",
                    background: "var(--bg-deep)",
                    border: "1px solid var(--border)",
                    borderRadius: "4px",
                    color: "var(--text-primary)",
                    fontFamily: "'JetBrains Mono', monospace",
                    fontSize: "12px",
                    resize: "vertical",
                    outline: "none",
                    boxSizing: "border-box",
                  }}
                />
                <button
                  type="button"
                  onClick={handlePaste}
                  disabled={!pastedText.trim()}
                  style={{
                    marginTop: "8px",
                    padding: "6px 14px",
                    background: "var(--accent-primary)",
                    border: "none",
                    borderRadius: "4px",
                    color: "#fff",
                    fontFamily: "'JetBrains Mono', monospace",
                    fontSize: "11px",
                    fontWeight: 700,
                    letterSpacing: "0.04em",
                    cursor: pastedText.trim() ? "pointer" : "not-allowed",
                    opacity: pastedText.trim() ? 1 : 0.5,
                  }}
                >
                  PARSE PASTED
                </button>
              </div>
            </div>
          )}

          {stage === "preview" && (
            <div>
              <div
                style={{
                  display: "flex",
                  alignItems: "baseline",
                  gap: "16px",
                  marginBottom: "14px",
                  flexWrap: "wrap",
                }}
              >
                <span
                  style={{
                    fontFamily: "'JetBrains Mono', monospace",
                    fontSize: "12px",
                    color: "var(--text-secondary)",
                  }}
                >
                  {fileName} — {rows.length} rows parsed
                </span>
                <span
                  style={{
                    fontFamily: "'JetBrains Mono', monospace",
                    fontSize: "11px",
                    color: "var(--success)",
                    fontWeight: 700,
                  }}
                >
                  ✓ {validCount} valid
                </span>
                {errorCount > 0 && (
                  <span
                    style={{
                      fontFamily: "'JetBrains Mono', monospace",
                      fontSize: "11px",
                      color: "var(--danger)",
                      fontWeight: 700,
                    }}
                  >
                    ✗ {errorCount} errors
                  </span>
                )}
              </div>

              <div
                style={{
                  border: "1px solid var(--border)",
                  borderRadius: "var(--radius)",
                  background: "var(--bg-card)",
                  overflow: "hidden",
                }}
              >
                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: "40px 1.5fr 1.5fr 1fr 1fr 1fr 1.5fr",
                    gap: "8px",
                    padding: "10px 16px",
                    borderBottom: "1px solid var(--border)",
                    background: "var(--bg-elevated)",
                    fontFamily: "'JetBrains Mono', monospace",
                    fontSize: "10px",
                    fontWeight: 700,
                    letterSpacing: "0.08em",
                    color: "var(--text-muted)",
                  }}
                >
                  <div>#</div>
                  <div>METER</div>
                  <div>DATETIME</div>
                  <div style={{ textAlign: "right" }}>READING</div>
                  <div>TYPE</div>
                  <div>SOURCE</div>
                  <div>STATUS</div>
                </div>
                {rows.slice(0, 10).map((r, i) => (
                  <div
                    key={i}
                    style={{
                      display: "grid",
                      gridTemplateColumns: "40px 1.5fr 1.5fr 1fr 1fr 1fr 1.5fr",
                      gap: "8px",
                      padding: "8px 16px",
                      borderBottom: "1px solid var(--border-subtle)",
                      fontFamily: "'JetBrains Mono', monospace",
                      fontSize: "11px",
                      color: r.__error ? "var(--danger)" : "var(--text-primary)",
                    }}
                  >
                    <div style={{ color: "var(--text-muted)" }}>{(i + 1).toString().padStart(3, "0")}</div>
                    <div>{r.meterNumber || "—"}</div>
                    <div style={{ fontSize: "10px" }}>{r.readDatetime.slice(0, 19) || "—"}</div>
                    <div style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
                      {Number.isFinite(r.reading) ? r.reading.toFixed(2) : "—"}
                    </div>
                    <div style={{ fontSize: "10px", color: "var(--text-muted)" }}>{r.readType ?? "ACTUAL"}</div>
                    <div style={{ fontSize: "10px", color: "var(--text-muted)" }}>{r.readSource ?? "MANUAL"}</div>
                    <div style={{ fontSize: "10px" }}>
                      {r.__error ? `✗ ${r.__error}` : <span style={{ color: "var(--success)" }}>✓ ready</span>}
                    </div>
                  </div>
                ))}
                {rows.length > 10 && (
                  <div
                    style={{
                      padding: "10px 16px",
                      fontSize: "11px",
                      color: "var(--text-muted)",
                      fontFamily: "'JetBrains Mono', monospace",
                      background: "var(--bg-elevated)",
                    }}
                  >
                    + {rows.length - 10} more rows not shown
                  </div>
                )}
              </div>

              <div style={{ display: "flex", gap: "12px", marginTop: "16px" }}>
                <button
                  type="button"
                  onClick={reset}
                  style={{
                    padding: "10px 20px",
                    background: "transparent",
                    border: "1px solid var(--border)",
                    borderRadius: "4px",
                    color: "var(--text-secondary)",
                    fontFamily: "'JetBrains Mono', monospace",
                    fontSize: "11px",
                    fontWeight: 700,
                    letterSpacing: "0.04em",
                    cursor: "pointer",
                  }}
                >
                  ← BACK
                </button>
                <button
                  type="button"
                  onClick={commit}
                  disabled={validCount === 0 || committing}
                  style={{
                    padding: "10px 24px",
                    background: "var(--accent-primary)",
                    border: "none",
                    borderRadius: "4px",
                    color: "#fff",
                    fontFamily: "'JetBrains Mono', monospace",
                    fontSize: "11px",
                    fontWeight: 700,
                    letterSpacing: "0.04em",
                    cursor: validCount > 0 ? "pointer" : "not-allowed",
                    opacity: validCount > 0 ? 1 : 0.5,
                    marginLeft: "auto",
                  }}
                >
                  COMMIT {validCount} READS →
                </button>
              </div>
            </div>
          )}

          {stage === "commit" && (
            <div>
              <div
                style={{
                  border: "1px solid var(--border)",
                  borderRadius: "var(--radius)",
                  background: "var(--bg-card)",
                  padding: "32px",
                  marginBottom: "16px",
                }}
              >
                <div
                  style={{
                    fontFamily: "'JetBrains Mono', monospace",
                    fontSize: "11px",
                    letterSpacing: "0.08em",
                    color: "var(--text-muted)",
                    marginBottom: "8px",
                  }}
                >
                  {committing ? "IMPORTING..." : result?.errors.length ? "IMPORT FAILED" : "IMPORT COMPLETE"}
                </div>
                <div
                  style={{
                    height: "6px",
                    background: "var(--bg-deep)",
                    borderRadius: "3px",
                    overflow: "hidden",
                    marginBottom: "16px",
                  }}
                >
                  <div
                    style={{
                      height: "100%",
                      width: `${progress}%`,
                      background: result?.errors.length
                        ? "var(--danger)"
                        : "var(--success)",
                      transition: "width 0.2s ease",
                    }}
                  />
                </div>
                {result && (
                  <div
                    style={{
                      display: "grid",
                      gridTemplateColumns: "repeat(3, 1fr)",
                      gap: "12px",
                      marginTop: "20px",
                    }}
                  >
                    <div
                      style={{
                        padding: "16px",
                        background: "var(--bg-elevated)",
                        borderLeft: "3px solid var(--success)",
                      }}
                    >
                      <div
                        style={{
                          fontFamily: "'JetBrains Mono', monospace",
                          fontSize: "10px",
                          fontWeight: 700,
                          letterSpacing: "0.08em",
                          color: "var(--success)",
                        }}
                      >
                        IMPORTED
                      </div>
                      <div style={{ fontSize: "32px", fontWeight: 700 }}>{result.imported}</div>
                    </div>
                    <div
                      style={{
                        padding: "16px",
                        background: "var(--bg-elevated)",
                        borderLeft: "3px solid var(--warning)",
                      }}
                    >
                      <div
                        style={{
                          fontFamily: "'JetBrains Mono', monospace",
                          fontSize: "10px",
                          fontWeight: 700,
                          letterSpacing: "0.08em",
                          color: "var(--warning)",
                        }}
                      >
                        EXCEPTIONS
                      </div>
                      <div style={{ fontSize: "32px", fontWeight: 700 }}>{result.exceptions}</div>
                    </div>
                    <div
                      style={{
                        padding: "16px",
                        background: "var(--bg-elevated)",
                        borderLeft: "3px solid var(--danger)",
                      }}
                    >
                      <div
                        style={{
                          fontFamily: "'JetBrains Mono', monospace",
                          fontSize: "10px",
                          fontWeight: 700,
                          letterSpacing: "0.08em",
                          color: "var(--danger)",
                        }}
                      >
                        ERRORS
                      </div>
                      <div style={{ fontSize: "32px", fontWeight: 700 }}>{result.errors.length}</div>
                    </div>
                  </div>
                )}
                {result?.errors && result.errors.length > 0 && (
                  <div
                    style={{
                      marginTop: "20px",
                      padding: "14px",
                      background: "var(--danger-subtle)",
                      border: "1px solid var(--danger)",
                      borderRadius: "4px",
                      color: "var(--danger)",
                      fontFamily: "'JetBrains Mono', monospace",
                      fontSize: "12px",
                      whiteSpace: "pre-wrap",
                    }}
                  >
                    {result.errors.map((e, i) => (
                      <div key={i}>
                        row {e.row}: {e.error}
                      </div>
                    ))}
                  </div>
                )}
              </div>
              <div style={{ display: "flex", gap: "12px" }}>
                <button
                  type="button"
                  onClick={reset}
                  style={{
                    padding: "10px 20px",
                    background: "var(--accent-primary)",
                    border: "none",
                    borderRadius: "4px",
                    color: "#fff",
                    fontFamily: "'JetBrains Mono', monospace",
                    fontSize: "11px",
                    fontWeight: 700,
                    letterSpacing: "0.04em",
                    cursor: "pointer",
                  }}
                >
                  IMPORT ANOTHER
                </button>
                <Link
                  href="/meter-reads"
                  style={{
                    padding: "10px 20px",
                    background: "transparent",
                    border: "1px solid var(--border)",
                    borderRadius: "4px",
                    color: "var(--text-secondary)",
                    fontFamily: "'JetBrains Mono', monospace",
                    fontSize: "11px",
                    fontWeight: 700,
                    letterSpacing: "0.04em",
                    cursor: "pointer",
                    textDecoration: "none",
                  }}
                >
                  VIEW READS →
                </Link>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
