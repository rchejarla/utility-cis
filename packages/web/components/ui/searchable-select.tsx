"use client";

import { useState, useRef, useEffect } from "react";

interface Option {
  label: string;
  value: string;
}

interface SearchableSelectProps {
  options: Option[];
  value?: string;
  onChange: (value: string | undefined) => void;
  placeholder?: string;
  clearLabel?: string;
}

export function SearchableSelect({
  options,
  value,
  onChange,
  placeholder = "Select...",
  clearLabel = "Clear",
}: SearchableSelectProps) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const selectedOption = options.find((o) => o.value === value);

  const filtered = search
    ? options.filter((o) => o.label.toLowerCase().includes(search.toLowerCase()))
    : options;

  // Close on click outside
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
        setSearch("");
      }
    }
    if (open) document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [open]);

  // Focus input when opening
  useEffect(() => {
    if (open && inputRef.current) inputRef.current.focus();
  }, [open]);

  return (
    <div ref={containerRef} style={{ position: "relative" }}>
      <button
        onClick={() => { setOpen(!open); setSearch(""); }}
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          width: "100%",
          padding: "7px 12px",
          fontSize: "13px",
          background: "var(--bg-card)",
          border: value ? "1px solid var(--accent-primary)" : "1px solid var(--border)",
          borderRadius: "var(--radius)",
          color: value ? "var(--text-primary)" : "var(--text-muted)",
          cursor: "pointer",
          fontFamily: "inherit",
          textAlign: "left",
          gap: "8px",
        }}
      >
        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {selectedOption ? selectedOption.label : placeholder}
        </span>
        <span style={{ fontSize: "10px", opacity: 0.6, flexShrink: 0 }}>{open ? "▲" : "▼"}</span>
      </button>

      {open && (
        <div
          style={{
            position: "absolute",
            top: "calc(100% + 4px)",
            left: 0,
            right: 0,
            zIndex: 50,
            background: "var(--bg-elevated)",
            border: "1px solid var(--border)",
            borderRadius: "var(--radius)",
            boxShadow: "0 8px 24px rgba(0,0,0,0.4)",
            maxHeight: "280px",
            display: "flex",
            flexDirection: "column",
            overflow: "hidden",
          }}
        >
          {/* Search input */}
          <div style={{ padding: "8px", borderBottom: "1px solid var(--border)" }}>
            <input
              ref={inputRef}
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Type to search..."
              style={{
                width: "100%",
                padding: "6px 10px",
                fontSize: "13px",
                background: "var(--bg-deep)",
                border: "1px solid var(--border)",
                borderRadius: "6px",
                color: "var(--text-primary)",
                fontFamily: "inherit",
                outline: "none",
              }}
            />
          </div>

          {/* Options */}
          <div style={{ overflowY: "auto", flex: 1 }}>
            {/* Clear option */}
            <button
              onClick={() => { onChange(undefined); setOpen(false); setSearch(""); }}
              style={{
                display: "flex",
                alignItems: "center",
                width: "100%",
                padding: "8px 14px",
                background: !value ? "var(--bg-hover)" : "transparent",
                border: "none",
                color: "var(--text-muted)",
                fontSize: "13px",
                fontStyle: "italic",
                cursor: "pointer",
                textAlign: "left",
                fontFamily: "inherit",
              }}
            >
              {clearLabel}
            </button>

            {filtered.length === 0 && (
              <div style={{ padding: "12px 14px", color: "var(--text-muted)", fontSize: "12px", textAlign: "center" }}>
                No matches
              </div>
            )}

            {filtered.map((opt) => (
              <button
                key={opt.value}
                onClick={() => { onChange(opt.value); setOpen(false); setSearch(""); }}
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  width: "100%",
                  padding: "8px 14px",
                  background: value === opt.value ? "var(--bg-hover)" : "transparent",
                  border: "none",
                  color: value === opt.value ? "var(--text-primary)" : "var(--text-secondary)",
                  fontSize: "13px",
                  cursor: "pointer",
                  textAlign: "left",
                  fontFamily: "inherit",
                }}
                onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = "var(--bg-hover)"; }}
                onMouseLeave={(e) => {
                  if (value !== opt.value) (e.currentTarget as HTMLElement).style.background = "transparent";
                }}
              >
                <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{opt.label}</span>
                {value === opt.value && <span style={{ color: "var(--accent-primary)", fontSize: "12px", flexShrink: 0 }}>✓</span>}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
