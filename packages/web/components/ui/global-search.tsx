"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import { apiClient } from "@/lib/api-client";

/**
 * Global full-text search overlay. Keyboard shortcut: Cmd/Ctrl+K to
 * open, Esc to close, arrow keys to navigate, Enter to select. Results
 * are grouped by kind with clear hierarchy — the label line is the
 * primary match (customer name, meter number, address line 1, account
 * number), the sublabel line is disambiguation context. Ranked by the
 * Postgres ts_rank function server-side.
 *
 * Design intent: this is a power-user tool. Terminal-style header,
 * monospace kind labels, no ornamental animation. The single place
 * everything is searchable from, so it gets to be dense and fast
 * rather than friendly and visual.
 */

interface SearchHit {
  kind: "customer" | "premise" | "account" | "meter";
  id: string;
  label: string;
  sublabel?: string;
  rank: number;
}

const KIND_META: Record<SearchHit["kind"], { label: string; accent: string; href: (id: string) => string }> = {
  customer: {
    label: "CUST",
    accent: "var(--info)",
    href: (id) => `/customers/${id}`,
  },
  premise: {
    label: "PREM",
    accent: "var(--success)",
    href: (id) => `/premises/${id}`,
  },
  account: {
    label: "ACCT",
    accent: "var(--warning)",
    href: (id) => `/accounts/${id}`,
  },
  meter: {
    label: "METR",
    accent: "var(--accent-tertiary)",
    href: (id) => `/meters/${id}`,
  },
};

export function GlobalSearch() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [loading, setLoading] = useState(false);
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const close = useCallback(() => {
    setOpen(false);
    setQuery("");
    setHits([]);
    setCursor(0);
  }, []);

  // Global shortcut listener — cmd+k / ctrl+k
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const isMac = navigator.platform.toUpperCase().includes("MAC");
      const mod = isMac ? e.metaKey : e.ctrlKey;
      if (mod && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((o) => !o);
      } else if (e.key === "Escape" && open) {
        close();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open, close]);

  // Focus input on open
  useEffect(() => {
    if (open) {
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  // Debounced search fetch
  useEffect(() => {
    if (!open) return;
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (!query.trim()) {
      setHits([]);
      return;
    }
    debounceRef.current = setTimeout(async () => {
      setLoading(true);
      try {
        const res = await apiClient.get<{ data: SearchHit[] }>("/api/v1/search", {
          q: query,
          limit: "15",
        });
        setHits(res.data ?? []);
        setCursor(0);
      } catch (err) {
        console.error("Search failed", err);
        setHits([]);
      } finally {
        setLoading(false);
      }
    }, 180);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [query, open]);

  // Arrow key navigation within the results
  const handleKey = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setCursor((c) => Math.min(c + 1, Math.max(0, hits.length - 1)));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setCursor((c) => Math.max(0, c - 1));
    } else if (e.key === "Enter" && hits[cursor]) {
      e.preventDefault();
      const hit = hits[cursor];
      router.push(KIND_META[hit.kind].href(hit.id));
      close();
    }
  };

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        title="Search (Cmd+K)"
        style={{
          display: "flex",
          alignItems: "center",
          gap: "10px",
          background: "var(--bg-card)",
          border: "1px solid var(--border)",
          borderRadius: "var(--radius)",
          padding: "6px 12px",
          width: "240px",
          cursor: "text",
          color: "var(--text-muted)",
          fontFamily: "inherit",
          fontSize: "13px",
        }}
      >
        <span style={{ opacity: 0.7 }}>🔍</span>
        <span style={{ flex: 1, textAlign: "left" }}>Search...</span>
        <kbd
          style={{
            fontFamily: "'JetBrains Mono', monospace",
            fontSize: "10px",
            padding: "2px 6px",
            borderRadius: "3px",
            background: "var(--bg-elevated)",
            border: "1px solid var(--border)",
            color: "var(--text-muted)",
          }}
        >
          ⌘K
        </kbd>
      </button>
    );
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Global search"
      onClick={close}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 100,
        background: "rgba(0,0,0,0.5)",
        backdropFilter: "blur(4px)",
        display: "flex",
        alignItems: "flex-start",
        justifyContent: "center",
        paddingTop: "12vh",
        animation: "fadeIn 0.12s ease-out",
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: "min(640px, 90vw)",
          background: "var(--bg-card)",
          border: "1px solid var(--border)",
          borderRadius: "var(--radius)",
          boxShadow: "0 32px 80px rgba(0,0,0,0.5)",
          overflow: "hidden",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: "12px",
            padding: "14px 18px",
            borderBottom: "1px solid var(--border)",
          }}
        >
          <span
            style={{
              fontFamily: "'JetBrains Mono', monospace",
              fontSize: "11px",
              fontWeight: 700,
              letterSpacing: "0.08em",
              color: "var(--text-muted)",
            }}
          >
            $
          </span>
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKey}
            placeholder="search customers, premises, accounts, meters..."
            style={{
              flex: 1,
              background: "transparent",
              border: "none",
              outline: "none",
              color: "var(--text-primary)",
              fontSize: "16px",
              fontFamily: "'JetBrains Mono', monospace",
              letterSpacing: "-0.01em",
            }}
          />
          <kbd
            style={{
              fontFamily: "'JetBrains Mono', monospace",
              fontSize: "10px",
              padding: "3px 8px",
              borderRadius: "3px",
              background: "var(--bg-elevated)",
              border: "1px solid var(--border)",
              color: "var(--text-muted)",
            }}
          >
            ESC
          </kbd>
        </div>

        <div
          style={{
            maxHeight: "420px",
            overflowY: "auto",
            padding: hits.length === 0 && !loading ? "32px" : "4px 0",
          }}
        >
          {loading && (
            <div
              style={{
                padding: "16px 18px",
                fontFamily: "'JetBrains Mono', monospace",
                fontSize: "11px",
                color: "var(--text-muted)",
              }}
            >
              searching...
            </div>
          )}
          {!loading && hits.length === 0 && query.trim() && (
            <div
              style={{
                textAlign: "center",
                fontFamily: "'JetBrains Mono', monospace",
                fontSize: "12px",
                color: "var(--text-muted)",
              }}
            >
              // no matches for &quot;{query}&quot;
            </div>
          )}
          {!loading && hits.length === 0 && !query.trim() && (
            <div
              style={{
                textAlign: "center",
                fontFamily: "'JetBrains Mono', monospace",
                fontSize: "12px",
                color: "var(--text-muted)",
                lineHeight: 1.7,
              }}
            >
              type to search
              <br />
              <span style={{ fontSize: "11px", opacity: 0.6 }}>
                customers · premises · accounts · meters
              </span>
            </div>
          )}
          {hits.map((hit, i) => {
            const meta = KIND_META[hit.kind];
            const active = i === cursor;
            return (
              <button
                key={`${hit.kind}-${hit.id}`}
                type="button"
                onMouseEnter={() => setCursor(i)}
                onClick={() => {
                  router.push(meta.href(hit.id));
                  close();
                }}
                style={{
                  display: "grid",
                  gridTemplateColumns: "56px 1fr auto",
                  gap: "14px",
                  width: "100%",
                  padding: "10px 18px",
                  background: active ? "var(--accent-primary-subtle)" : "transparent",
                  border: "none",
                  borderLeft: active ? "3px solid var(--accent-primary)" : "3px solid transparent",
                  textAlign: "left",
                  cursor: "pointer",
                  alignItems: "center",
                  fontFamily: "inherit",
                  color: "inherit",
                }}
              >
                <span
                  style={{
                    fontFamily: "'JetBrains Mono', monospace",
                    fontSize: "10px",
                    fontWeight: 700,
                    letterSpacing: "0.06em",
                    color: meta.accent,
                    padding: "2px 6px",
                    border: `1px solid ${meta.accent}`,
                    borderRadius: "3px",
                    textAlign: "center",
                  }}
                >
                  {meta.label}
                </span>
                <span style={{ display: "flex", flexDirection: "column", gap: "2px", minWidth: 0 }}>
                  <span
                    style={{
                      fontSize: "13px",
                      fontWeight: 600,
                      color: "var(--text-primary)",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {hit.label}
                  </span>
                  {hit.sublabel && (
                    <span
                      style={{
                        fontSize: "11px",
                        color: "var(--text-muted)",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {hit.sublabel}
                    </span>
                  )}
                </span>
                <span
                  style={{
                    fontFamily: "'JetBrains Mono', monospace",
                    fontSize: "10px",
                    color: "var(--text-muted)",
                  }}
                >
                  ↵
                </span>
              </button>
            );
          })}
        </div>
        <div
          style={{
            display: "flex",
            gap: "16px",
            padding: "8px 18px",
            borderTop: "1px solid var(--border)",
            fontFamily: "'JetBrains Mono', monospace",
            fontSize: "10px",
            color: "var(--text-muted)",
            background: "var(--bg-elevated)",
          }}
        >
          <span>
            <kbd style={{ padding: "1px 5px", border: "1px solid var(--border)", borderRadius: "2px" }}>↑↓</kbd> navigate
          </span>
          <span>
            <kbd style={{ padding: "1px 5px", border: "1px solid var(--border)", borderRadius: "2px" }}>↵</kbd> open
          </span>
          <span>
            <kbd style={{ padding: "1px 5px", border: "1px solid var(--border)", borderRadius: "2px" }}>esc</kbd> close
          </span>
        </div>
      </div>
      <style jsx>{`
        @keyframes fadeIn {
          from { opacity: 0; }
          to { opacity: 1; }
        }
      `}</style>
    </div>
  );
}
