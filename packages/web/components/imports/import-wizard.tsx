"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { parseCsvText, type CanonicalFieldDef, type ParsedCsv } from "@utility-cis/shared";
import { apiClient, API_URL, getAuthToken } from "@/lib/api-client";
import { useToast } from "@/components/ui/toast";

/**
 * Generic four-stage import wizard parameterised by `kind`. Mounted
 * by entity-specific pages (e.g. /meter-reads/import → kind="meter_read").
 *
 * Stages:
 *   [1] Upload — drop a CSV. Source dropdown.
 *   [2] Mapping — per-source-header dropdown of canonical fields.
 *       Auto-detects on entry using handler aliases + localStorage
 *       memory (keyed by header signature).
 *   [3] Preview — first 10 mapped rows with valid/error counts.
 *   [4] Commit — multipart POST; renders result + link to detail page.
 *
 * Server is the parser of record. The wizard's preview parses locally
 * (papaparse) only to drive the mapping UI; the commit step uploads
 * the original bytes and the server re-parses for actual ingestion.
 * Same papaparse on both sides keeps preview and ingest in sync.
 */

type StageKey = "upload" | "mapping" | "preview" | "commit";

type CanonicalChoice = string; // canonical-field name OR "ignore"

interface KindMeta {
  kind: string;
  label: string;
  canonicalFields: CanonicalFieldDef[];
}

type CommitResult =
  | (CommitSyncResult & { async: false })
  | { async: true; batchId: string; recordCount: number; attachmentId: string };

interface CommitSyncResult {
  batchId: string;
  status: string;
  recordCount: number;
  importedCount: number;
  errorCount: number;
  errors: Array<{ rowIndex: number; errorCode: string; errorMessage: string }>;
  attachmentId: string;
}

export interface ImportWizardProps {
  kind: string;
}

// ─── Helpers ────────────────────────────────────────────────────────

function autodetectMapping(
  headers: string[],
  fields: CanonicalFieldDef[],
): Record<string, CanonicalChoice> {
  const result: Record<string, CanonicalChoice> = {};
  const taken = new Set<string>();

  // Compile alias regexes once.
  const fieldRegexes = fields.map((f) => ({
    name: f.name,
    regexes: (f.aliases ?? []).map((src) => new RegExp(src, "i")),
  }));

  for (const header of headers) {
    const normalized = header.toLowerCase().replace(/[\s_-]+/g, "");
    let chosen: CanonicalChoice = "ignore";

    // Exact match against the canonical field name first.
    const exact = fields.find((f) => f.name.toLowerCase() === normalized);
    if (exact && !taken.has(exact.name)) {
      chosen = exact.name;
    } else {
      for (const { name, regexes } of fieldRegexes) {
        if (taken.has(name)) continue;
        if (regexes.some((rx) => rx.test(normalized))) {
          chosen = name;
          break;
        }
      }
    }

    if (chosen !== "ignore") taken.add(chosen);
    result[header] = chosen;
  }

  return result;
}

function headerSignature(headers: string[]): string {
  // Stable across reorderings of the same set.
  return [...headers].map((h) => h.trim().toLowerCase()).sort().join("|");
}

function loadMappingFromStorage(
  kind: string,
  headers: string[],
): Record<string, CanonicalChoice> | null {
  if (typeof window === "undefined") return null;
  const key = `import-mapping:${kind}:${headerSignature(headers)}`;
  const stored = window.localStorage.getItem(key);
  if (!stored) return null;
  try {
    return JSON.parse(stored) as Record<string, CanonicalChoice>;
  } catch {
    return null;
  }
}

function saveMappingToStorage(
  kind: string,
  headers: string[],
  mapping: Record<string, CanonicalChoice>,
): void {
  if (typeof window === "undefined") return;
  const key = `import-mapping:${kind}:${headerSignature(headers)}`;
  window.localStorage.setItem(key, JSON.stringify(mapping));
}

function validateMapping(
  mapping: Record<string, CanonicalChoice>,
  fields: CanonicalFieldDef[],
): string | null {
  const counts = new Map<string, number>();
  for (const v of Object.values(mapping)) {
    if (v !== "ignore") counts.set(v, (counts.get(v) ?? 0) + 1);
  }
  for (const f of fields) {
    if (f.required && (counts.get(f.name) ?? 0) === 0) {
      return `Required field "${f.label}" is not mapped to any source column.`;
    }
    if ((counts.get(f.name) ?? 0) > 1) {
      return `Canonical field "${f.label}" is mapped to multiple source columns; pick one.`;
    }
  }
  return null;
}

function applyMapping(
  rows: Record<string, string>[],
  mapping: Record<string, CanonicalChoice>,
): Record<string, string>[] {
  return rows.map((src) => {
    const out: Record<string, string> = {};
    for (const [header, canonical] of Object.entries(mapping)) {
      if (canonical && canonical !== "ignore") {
        out[canonical] = src[header] ?? "";
      }
    }
    return out;
  });
}

// ─── Component ──────────────────────────────────────────────────────

export function ImportWizard({ kind }: ImportWizardProps) {
  const { toast } = useToast();
  const [stage, setStage] = useState<StageKey>("upload");
  const [meta, setMeta] = useState<KindMeta | null>(null);
  const [metaError, setMetaError] = useState<string | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [parsed, setParsed] = useState<ParsedCsv | null>(null);
  const [source, setSource] = useState<"AMR" | "AMI" | "MANUAL_UPLOAD" | "API">(
    "MANUAL_UPLOAD",
  );
  const [mapping, setMapping] = useState<Record<string, CanonicalChoice>>({});
  const [committing, setCommitting] = useState(false);
  const [result, setResult] = useState<CommitResult | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Fetch the kind's metadata (canonical fields) on mount.
  useEffect(() => {
    let cancelled = false;
    apiClient
      .get<KindMeta>(`/api/v1/imports/kinds/${kind}/fields`)
      .then((m) => {
        if (!cancelled) setMeta(m);
      })
      .catch((err) => {
        if (!cancelled) setMetaError(err?.message ?? "Failed to load kind metadata");
      });
    return () => {
      cancelled = true;
    };
  }, [kind]);

  const mappedRows = useMemo(() => {
    if (!parsed) return [];
    return applyMapping(parsed.rows, mapping);
  }, [parsed, mapping]);

  const validateMappedRow = (row: Record<string, string>): string | null => {
    if (!meta) return null;
    for (const f of meta.canonicalFields) {
      if (f.required && !row[f.name]) {
        return `missing ${f.name}`;
      }
    }
    return null;
  };

  const previewCounts = useMemo(() => {
    let valid = 0;
    let errors = 0;
    for (const r of mappedRows) {
      if (validateMappedRow(r)) errors++;
      else valid++;
    }
    return { valid, errors };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mappedRows]);

  const handleFile = async (f: File) => {
    if (!meta) return;
    const text = await f.text();
    const p = parseCsvText(text);
    if (p.headers.length === 0) {
      toast("File has no header row.", "error");
      return;
    }
    setFile(f);
    setParsed(p);

    // Recall stored mapping if present, else auto-detect.
    const stored = loadMappingFromStorage(kind, p.headers);
    setMapping(stored ?? autodetectMapping(p.headers, meta.canonicalFields));
    setStage("mapping");
  };

  const handleContinueFromMapping = () => {
    if (!meta) return;
    const err = validateMapping(mapping, meta.canonicalFields);
    if (err) {
      toast(err, "error");
      return;
    }
    if (parsed) saveMappingToStorage(kind, parsed.headers, mapping);
    setStage("preview");
  };

  const handleCommit = async () => {
    if (!meta || !file || !parsed) return;
    setCommitting(true);
    try {
      const formData = new FormData();
      formData.append("file", file, file.name);
      formData.append("kind", kind);
      formData.append("source", source);
      formData.append("fileName", file.name);
      formData.append("mapping", JSON.stringify(mapping));

      // Multipart upload bypasses the JSON apiClient wrapper, but we
      // still need the same auth header it would send. `getAuthToken`
      // handles localStorage + NextAuth fallback the same way the
      // wrapper does.
      const token = await getAuthToken();
      const response = await fetch(`${API_URL}/api/v1/imports`, {
        method: "POST",
        headers: token ? { Authorization: `Bearer ${token}` } : undefined,
        body: formData,
      });

      if (!response.ok) {
        const errBody = await response.json().catch(() => ({}));
        const msg = errBody?.error?.message ?? `Import failed (${response.status})`;
        throw new Error(msg);
      }

      const data = (await response.json()) as CommitResult;
      setResult(data);
      setStage("commit");
      if (data.async) {
        toast(
          "Import running in the background — we'll notify you when it's done.",
          "info",
        );
      } else if (data.status === "COMPLETE") {
        toast(
          `${data.importedCount} of ${data.recordCount} rows imported`,
          "success",
        );
      } else if (data.status === "PARTIAL") {
        toast(
          `${data.importedCount} of ${data.recordCount} rows imported, ${data.errorCount} errored`,
          "info",
        );
      } else {
        toast(
          `Import failed — ${data.errorCount} of ${data.recordCount} rows errored`,
          "error",
        );
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Import failed";
      toast(msg, "error");
    } finally {
      setCommitting(false);
    }
  };

  const reset = () => {
    setStage("upload");
    setFile(null);
    setParsed(null);
    setMapping({});
    setResult(null);
  };

  // ─── Render ──────────────────────────────────────────────────────

  if (metaError) {
    return (
      <div style={{ color: "var(--danger)", padding: "20px 0" }}>
        Failed to load kind metadata: {metaError}
      </div>
    );
  }

  if (!meta) {
    return <div style={{ color: "var(--text-muted)", padding: "20px 0" }}>Loading…</div>;
  }

  return (
    <div style={{ maxWidth: "960px" }}>
      <h1
        style={{
          fontSize: "22px",
          fontWeight: 600,
          margin: "0 0 4px 0",
          color: "var(--text-primary)",
        }}
      >
        Import {meta.label}
      </h1>
      <div
        aria-hidden
        style={{
          height: "2px",
          width: "32px",
          borderRadius: "2px",
          background: "var(--accent-gradient)",
          margin: "0 0 6px",
        }}
      />
      <p style={{ fontSize: "14px", color: "var(--text-secondary)", margin: "0 0 24px 0" }}>
        Upload a CSV, map your headers to our fields, preview, and commit.
      </p>

      {/* Stage indicator */}
      <Stages current={stage} />

      <div style={{ marginTop: "20px" }}>
        {stage === "upload" && (
          <UploadStage
            kind={kind}
            source={source}
            setSource={setSource}
            dragOver={dragOver}
            setDragOver={setDragOver}
            fileInputRef={fileInputRef}
            onFile={handleFile}
          />
        )}

        {stage === "mapping" && parsed && (
          <MappingStage
            fields={meta.canonicalFields}
            headers={parsed.headers}
            sampleRows={parsed.rows.slice(0, 5)}
            mapping={mapping}
            setMapping={setMapping}
            onBack={() => setStage("upload")}
            onContinue={handleContinueFromMapping}
          />
        )}

        {stage === "preview" && parsed && (
          <PreviewStage
            fields={meta.canonicalFields}
            mappedRows={mappedRows}
            counts={previewCounts}
            committing={committing}
            onBack={() => setStage("mapping")}
            onCommit={handleCommit}
          />
        )}

        {stage === "commit" && result && (
          result.async
            ? <AsyncCommitStage batchId={result.batchId} recordCount={result.recordCount} onReset={reset} />
            : <CommitStage result={result} onReset={reset} />
        )}
      </div>
    </div>
  );
}

// ─── Stage indicator ────────────────────────────────────────────────

function Stages({ current }: { current: StageKey }) {
  const all: { key: StageKey; label: string }[] = [
    { key: "upload", label: "Upload" },
    { key: "mapping", label: "Map fields" },
    { key: "preview", label: "Preview" },
    { key: "commit", label: "Commit" },
  ];
  const idx = all.findIndex((s) => s.key === current);
  return (
    <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
      {all.map((s, i) => {
        const done = i < idx;
        const active = i === idx;
        return (
          <div key={s.key} style={{ display: "flex", alignItems: "center", gap: "8px" }}>
            <div
              style={{
                width: "24px",
                height: "24px",
                borderRadius: "50%",
                border: `2px solid ${active ? "var(--accent-primary)" : done ? "var(--success)" : "var(--border)"}`,
                background: done ? "var(--success)" : "transparent",
                color: done ? "#fff" : active ? "var(--accent-primary)" : "var(--text-muted)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontSize: "11px",
                fontWeight: 700,
              }}
            >
              {done ? "✓" : i + 1}
            </div>
            <span
              style={{
                fontSize: "12px",
                color: active ? "var(--text-primary)" : "var(--text-muted)",
                fontWeight: active ? 600 : 400,
              }}
            >
              {s.label}
            </span>
            {i < all.length - 1 && (
              <div
                style={{
                  width: "24px",
                  height: "1px",
                  background: "var(--border)",
                  marginRight: "4px",
                }}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}

// ─── Upload stage ───────────────────────────────────────────────────

function UploadStage({
  kind,
  source,
  setSource,
  dragOver,
  setDragOver,
  fileInputRef,
  onFile,
}: {
  kind: string;
  source: string;
  setSource: (s: "AMR" | "AMI" | "MANUAL_UPLOAD" | "API") => void;
  dragOver: boolean;
  setDragOver: (b: boolean) => void;
  fileInputRef: React.RefObject<HTMLInputElement | null>;
  onFile: (f: File) => void;
}) {
  return (
    <div>
      <div style={{ marginBottom: "16px" }}>
        <label style={labelStyle}>Source</label>
        <select
          value={source}
          onChange={(e) =>
            setSource(e.target.value as "AMR" | "AMI" | "MANUAL_UPLOAD" | "API")
          }
          style={selectStyle}
        >
          <option value="MANUAL_UPLOAD">Manual CSV upload</option>
          <option value="AMR">AMR drive-by</option>
          <option value="AMI">AMI interval data</option>
          <option value="API">API payload</option>
        </select>
      </div>

      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          const f = e.dataTransfer.files[0];
          if (f) onFile(f);
        }}
        onClick={() => fileInputRef.current?.click()}
        style={{
          border: `2px dashed ${dragOver ? "var(--accent-primary)" : "var(--border)"}`,
          borderRadius: "var(--radius)",
          padding: "48px 24px",
          textAlign: "center",
          background: dragOver ? "var(--bg-elevated)" : "var(--bg-card)",
          cursor: "pointer",
          transition: "all 0.15s ease",
        }}
      >
        <div style={{ fontSize: "36px", marginBottom: "12px" }}>📁</div>
        <div style={{ fontSize: "14px", fontWeight: 500, color: "var(--text-primary)", marginBottom: "4px" }}>
          Drop a CSV here or click to browse
        </div>
        <div style={{ fontSize: "12px", color: "var(--text-muted)" }}>
          Headers can be in any order. You'll map them to our fields next.
        </div>
        <input
          ref={fileInputRef}
          type="file"
          accept=".csv,.txt"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) onFile(f);
          }}
          style={{ display: "none" }}
        />
      </div>

      <div
        style={{
          marginTop: "12px",
          fontSize: "12px",
          color: "var(--text-muted)",
          display: "flex",
          alignItems: "center",
          gap: "6px",
        }}
      >
        Need the column layout?
        <a
          href={`${API_URL}/api/v1/imports/kinds/${kind}/template.csv`}
          download
          onClick={(e) => e.stopPropagation()}
          style={{
            color: "var(--accent-primary)",
            textDecoration: "underline",
            textUnderlineOffset: "2px",
          }}
        >
          Download CSV template
        </a>
      </div>
    </div>
  );
}

// ─── Mapping stage ──────────────────────────────────────────────────

function MappingStage({
  fields,
  headers,
  sampleRows,
  mapping,
  setMapping,
  onBack,
  onContinue,
}: {
  fields: CanonicalFieldDef[];
  headers: string[];
  sampleRows: Record<string, string>[];
  mapping: Record<string, string>;
  setMapping: (m: Record<string, string>) => void;
  onBack: () => void;
  onContinue: () => void;
}) {
  return (
    <div>
      <div style={{ fontSize: "13px", color: "var(--text-secondary)", marginBottom: "16px" }}>
        Match each column from your file to one of our fields. Fields marked{" "}
        <span style={{ color: "var(--danger)" }}>*</span> are required.
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
            gridTemplateColumns: "1fr 1fr 1.2fr",
            gap: "12px",
            padding: "10px 16px",
            background: "var(--bg-elevated)",
            borderBottom: "1px solid var(--border)",
            fontSize: "11px",
            fontWeight: 600,
            color: "var(--text-muted)",
            textTransform: "uppercase",
            letterSpacing: "0.05em",
          }}
        >
          <div>Your column</div>
          <div>Maps to</div>
          <div>Sample values</div>
        </div>
        {headers.map((header) => (
          <div
            key={header}
            style={{
              display: "grid",
              gridTemplateColumns: "1fr 1fr 1.2fr",
              gap: "12px",
              padding: "10px 16px",
              borderBottom: "1px solid var(--border-subtle)",
              alignItems: "center",
              fontSize: "13px",
            }}
          >
            <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: "12px" }}>
              {header}
            </div>
            <div>
              <select
                value={mapping[header] ?? "ignore"}
                onChange={(e) => setMapping({ ...mapping, [header]: e.target.value })}
                style={{ ...selectStyle, minWidth: 0, width: "100%" }}
              >
                <option value="ignore">— Ignore —</option>
                {fields.map((f) => (
                  <option key={f.name} value={f.name}>
                    {f.label}
                    {f.required ? " *" : ""}
                  </option>
                ))}
              </select>
            </div>
            <div
              style={{
                color: "var(--text-muted)",
                fontFamily: "'JetBrains Mono', monospace",
                fontSize: "11px",
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {sampleRows
                .map((r) => r[header])
                .filter((v) => v !== undefined && v !== "")
                .slice(0, 3)
                .join(", ") || "—"}
            </div>
          </div>
        ))}
      </div>

      <div style={{ display: "flex", gap: "8px", marginTop: "16px" }}>
        <button onClick={onBack} style={secondaryButton}>
          ← Back
        </button>
        <button onClick={onContinue} style={{ ...primaryButton, marginLeft: "auto" }}>
          Continue →
        </button>
      </div>
    </div>
  );
}

// ─── Preview stage ──────────────────────────────────────────────────

function PreviewStage({
  fields,
  mappedRows,
  counts,
  committing,
  onBack,
  onCommit,
}: {
  fields: CanonicalFieldDef[];
  mappedRows: Record<string, string>[];
  counts: { valid: number; errors: number };
  committing: boolean;
  onBack: () => void;
  onCommit: () => void;
}) {
  const previewable = fields.filter(
    (f) => f.required || mappedRows.some((r) => r[f.name]),
  );

  return (
    <div>
      <div
        style={{
          display: "flex",
          gap: "16px",
          marginBottom: "16px",
          fontSize: "12px",
          alignItems: "center",
          fontFamily: "'JetBrains Mono', monospace",
        }}
      >
        <span style={{ color: "var(--text-secondary)" }}>
          {mappedRows.length} rows parsed
        </span>
        <span style={{ color: "var(--success)", fontWeight: 600 }}>
          ✓ {counts.valid} valid
        </span>
        {counts.errors > 0 && (
          <span style={{ color: "var(--danger)", fontWeight: 600 }}>
            ✗ {counts.errors} client-side issues
          </span>
        )}
      </div>

      <div
        style={{
          border: "1px solid var(--border)",
          borderRadius: "var(--radius)",
          background: "var(--bg-card)",
          overflow: "auto",
        }}
      >
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "12px" }}>
          <thead>
            <tr style={{ background: "var(--bg-elevated)" }}>
              <th style={thStyle}>#</th>
              {previewable.map((f) => (
                <th key={f.name} style={thStyle}>
                  {f.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {mappedRows.slice(0, 10).map((r, i) => (
              <tr key={i}>
                <td style={tdStyle}>{i + 1}</td>
                {previewable.map((f) => (
                  <td
                    key={f.name}
                    style={{
                      ...tdStyle,
                      color: f.required && !r[f.name] ? "var(--danger)" : "var(--text-primary)",
                    }}
                  >
                    {r[f.name] || (f.required ? "(missing)" : "—")}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        {mappedRows.length > 10 && (
          <div style={{ padding: "8px 16px", fontSize: "11px", color: "var(--text-muted)" }}>
            + {mappedRows.length - 10} more rows
          </div>
        )}
      </div>

      <div style={{ display: "flex", gap: "8px", marginTop: "16px" }}>
        <button onClick={onBack} style={secondaryButton}>
          ← Back
        </button>
        <button
          onClick={onCommit}
          disabled={committing || counts.valid === 0}
          style={{
            ...primaryButton,
            marginLeft: "auto",
            opacity: committing || counts.valid === 0 ? 0.6 : 1,
            cursor: committing || counts.valid === 0 ? "not-allowed" : "pointer",
          }}
        >
          {committing ? "Importing…" : `Commit ${mappedRows.length} rows →`}
        </button>
      </div>
    </div>
  );
}

// ─── Commit stage ───────────────────────────────────────────────────

function CommitStage({
  result,
  onReset,
}: {
  result: CommitSyncResult;
  onReset: () => void;
}) {
  const isComplete = result.status === "COMPLETE";
  const isPartial = result.status === "PARTIAL";
  const isFailed = result.status === "FAILED";
  const heading = isComplete
    ? "Import complete"
    : isPartial
      ? "Partial import"
      : isFailed
        ? "Import failed"
        : `Status: ${result.status}`;
  const accent = isComplete
    ? "var(--success)"
    : isPartial
      ? "var(--warning)"
      : "var(--danger)";

  return (
    <div>
      <div
        style={{
          padding: "20px 24px",
          border: "1px solid var(--border)",
          borderRadius: "var(--radius)",
          background: "var(--bg-card)",
          marginBottom: "16px",
        }}
      >
        <div
          style={{
            fontSize: "13px",
            fontWeight: 600,
            color: accent,
            marginBottom: "12px",
            textTransform: "uppercase",
            letterSpacing: "0.05em",
          }}
        >
          {heading}
        </div>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(3, 1fr)",
            gap: "12px",
          }}
        >
          <Stat label="Rows" value={result.recordCount} accent="var(--text-muted)" />
          <Stat label="Imported" value={result.importedCount} accent="var(--success)" />
          <Stat label="Errors" value={result.errorCount} accent="var(--danger)" />
        </div>
      </div>

      {result.errors.length > 0 && (
        <div
          style={{
            border: "1px solid var(--danger)",
            borderRadius: "var(--radius)",
            background: "var(--bg-card)",
            padding: "16px",
            marginBottom: "16px",
            maxHeight: "240px",
            overflow: "auto",
          }}
        >
          <div style={{ fontSize: "12px", fontWeight: 600, color: "var(--danger)", marginBottom: "8px" }}>
            First {Math.min(result.errors.length, 20)} errors
          </div>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "11px", fontFamily: "'JetBrains Mono', monospace" }}>
            <tbody>
              {result.errors.slice(0, 20).map((e, i) => (
                <tr key={i}>
                  <td style={{ padding: "2px 8px", color: "var(--text-muted)" }}>row {e.rowIndex}</td>
                  <td style={{ padding: "2px 8px", color: "var(--danger)", fontWeight: 600 }}>{e.errorCode}</td>
                  <td style={{ padding: "2px 8px" }}>{e.errorMessage}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div style={{ display: "flex", gap: "8px" }}>
        <button onClick={onReset} style={primaryButton}>
          Import another
        </button>
        <Link
          href={`/imports/${result.batchId}`}
          style={{ ...secondaryButton, textDecoration: "none", marginLeft: "auto" }}
        >
          View import details →
        </Link>
      </div>
    </div>
  );
}

// ─── Async commit stage ─────────────────────────────────────────────

function AsyncCommitStage({
  batchId,
  recordCount,
  onReset,
}: {
  batchId: string;
  recordCount: number;
  onReset: () => void;
}) {
  const [batch, setBatch] = useState<{
    status: string;
    importedCount: number;
    errorCount: number;
  } | null>(null);

  useEffect(() => {
    let cancelled = false;
    let timeoutId: ReturnType<typeof setTimeout> | null = null;

    async function poll() {
      try {
        const data = await apiClient.get<{
          batch: { status: string; importedCount: number; errorCount: number };
        }>(`/api/v1/imports/${batchId}`);
        if (cancelled) return;
        setBatch(data.batch);
        const terminal = ["COMPLETE", "PARTIAL", "FAILED", "CANCELLED"];
        if (!terminal.includes(data.batch.status)) {
          timeoutId = setTimeout(poll, 2000);
        }
      } catch {
        if (!cancelled) timeoutId = setTimeout(poll, 5000);
      }
    }
    poll();
    return () => {
      cancelled = true;
      if (timeoutId) clearTimeout(timeoutId);
    };
  }, [batchId]);

  const processed = (batch?.importedCount ?? 0) + (batch?.errorCount ?? 0);
  const pct = recordCount === 0 ? 0 : Math.round((processed / recordCount) * 100);
  const terminal = batch && ["COMPLETE", "PARTIAL", "FAILED", "CANCELLED"].includes(batch.status);

  return (
    <div>
      <div
        style={{
          padding: "20px 24px",
          border: "1px solid var(--border)",
          borderRadius: "var(--radius)",
          background: "var(--bg-card)",
          marginBottom: "16px",
        }}
      >
        <div
          style={{
            fontSize: "13px",
            fontWeight: 600,
            color: terminal ? "var(--text-primary)" : "var(--accent-primary)",
            marginBottom: "12px",
            textTransform: "uppercase",
            letterSpacing: "0.05em",
          }}
        >
          {terminal ? `Status: ${batch!.status}` : "Importing in the background…"}
        </div>
        <div
          style={{
            height: "8px",
            background: "var(--bg-elevated)",
            borderRadius: "4px",
            overflow: "hidden",
            marginBottom: "12px",
          }}
        >
          <div
            style={{
              width: `${pct}%`,
              height: "100%",
              background: "var(--accent-gradient)",
              transition: "width 0.3s ease",
            }}
          />
        </div>
        <div style={{ fontSize: "12px", color: "var(--text-muted)" }}>
          {processed.toLocaleString()} / {recordCount.toLocaleString()} rows processed
          {batch
            ? ` · ${batch.importedCount.toLocaleString()} imported · ${batch.errorCount.toLocaleString()} errors`
            : ""}
        </div>
      </div>
      <div style={{ display: "flex", gap: "8px" }}>
        <button onClick={onReset} style={primaryButton}>
          Import another
        </button>
        <Link
          href={`/imports/${batchId}`}
          style={{ ...secondaryButton, textDecoration: "none", marginLeft: "auto" }}
        >
          View import details →
        </Link>
      </div>
    </div>
  );
}

function Stat({ label, value, accent }: { label: string; value: number; accent: string }) {
  return (
    <div style={{ borderLeft: `3px solid ${accent}`, padding: "8px 12px" }}>
      <div style={{ fontSize: "10px", fontWeight: 600, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.05em" }}>
        {label}
      </div>
      <div style={{ fontSize: "24px", fontWeight: 700, color: "var(--text-primary)" }}>
        {value.toLocaleString()}
      </div>
    </div>
  );
}

// ─── Shared styles ──────────────────────────────────────────────────

const labelStyle: React.CSSProperties = {
  display: "block",
  fontSize: "11px",
  fontWeight: 600,
  color: "var(--text-muted)",
  marginBottom: "6px",
  textTransform: "uppercase",
  letterSpacing: "0.05em",
};

const selectStyle: React.CSSProperties = {
  padding: "8px 12px",
  fontSize: "13px",
  background: "var(--bg-card)",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius)",
  color: "var(--text-primary)",
  fontFamily: "inherit",
  minWidth: "220px",
};

const primaryButton: React.CSSProperties = {
  padding: "8px 16px",
  fontSize: "13px",
  fontWeight: 500,
  background: "var(--accent-primary)",
  color: "#fff",
  border: "none",
  borderRadius: "var(--radius)",
  cursor: "pointer",
  fontFamily: "inherit",
};

const secondaryButton: React.CSSProperties = {
  padding: "8px 16px",
  fontSize: "13px",
  fontWeight: 500,
  background: "transparent",
  color: "var(--text-secondary)",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius)",
  cursor: "pointer",
  fontFamily: "inherit",
};

const thStyle: React.CSSProperties = {
  padding: "8px 12px",
  textAlign: "left",
  fontSize: "10px",
  fontWeight: 600,
  color: "var(--text-muted)",
  textTransform: "uppercase",
  letterSpacing: "0.05em",
  borderBottom: "1px solid var(--border)",
};

const tdStyle: React.CSSProperties = {
  padding: "6px 12px",
  borderBottom: "1px solid var(--border-subtle)",
};
