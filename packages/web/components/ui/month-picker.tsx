"use client";

import { useState, useRef, useEffect } from "react";

interface MonthPickerProps {
  value: string; // YYYY-MM
  onChange: (value: string) => void;
  placeholder?: string;
  triggerStyle?: React.CSSProperties;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function formatDisplay(val: string): string {
  if (!val) return "";
  const [y, m] = val.split("-").map(Number);
  return `${MONTHS[m - 1]} ${y}`;
}

export function MonthPicker({
  value,
  onChange,
  placeholder = "Select month...",
  triggerStyle,
}: MonthPickerProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const today = new Date();
  const initial = value ? { y: Number(value.split("-")[0]), m: Number(value.split("-")[1]) - 1 } : { y: today.getFullYear(), m: today.getMonth() };
  const [viewYear, setViewYear] = useState(initial.y);

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    if (open) document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [open]);

  useEffect(() => {
    if (open && value) {
      setViewYear(Number(value.split("-")[0]));
    }
  }, [open]);

  const selectMonth = (monthIdx: number) => {
    const m = String(monthIdx + 1).padStart(2, "0");
    onChange(`${viewYear}-${m}`);
    setOpen(false);
  };

  const isSelected = (monthIdx: number) => {
    if (!value) return false;
    const m = String(monthIdx + 1).padStart(2, "0");
    return value === `${viewYear}-${m}`;
  };

  const isCurrent = (monthIdx: number) => {
    return viewYear === today.getFullYear() && monthIdx === today.getMonth();
  };

  return (
    <div ref={ref} style={{ position: "relative" }}>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          width: "100%",
          padding: "6px 10px",
          fontSize: "13px",
          background: "var(--bg-deep)",
          border: "1px solid var(--border)",
          borderRadius: "var(--radius, 10px)",
          cursor: "pointer",
          fontFamily: "inherit",
          textAlign: "left",
          ...triggerStyle,
          color: value ? "var(--text-primary)" : "var(--text-muted)",
        }}
      >
        <span>{value ? formatDisplay(value) : placeholder}</span>
        <span style={{ fontSize: "12px", opacity: 0.5 }}>📅</span>
      </button>

      {open && (
        <div
          style={{
            position: "absolute",
            top: "calc(100% + 4px)",
            left: 0,
            zIndex: 60,
            background: "var(--bg-elevated)",
            border: "1px solid var(--border)",
            borderRadius: "var(--radius, 10px)",
            boxShadow: "0 8px 24px rgba(0,0,0,0.4)",
            padding: "12px",
            width: "260px",
          }}
        >
          {/* Year navigation */}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              marginBottom: "12px",
            }}
          >
            <button
              type="button"
              onClick={() => setViewYear(viewYear - 1)}
              style={{
                background: "none",
                border: "none",
                color: "var(--text-secondary)",
                cursor: "pointer",
                fontSize: "14px",
                padding: "4px 8px",
              }}
            >
              ‹
            </button>
            <span
              style={{
                fontSize: "13px",
                fontWeight: 600,
                color: "var(--text-primary)",
              }}
            >
              {viewYear}
            </span>
            <button
              type="button"
              onClick={() => setViewYear(viewYear + 1)}
              style={{
                background: "none",
                border: "none",
                color: "var(--text-secondary)",
                cursor: "pointer",
                fontSize: "14px",
                padding: "4px 8px",
              }}
            >
              ›
            </button>
          </div>

          {/* Month grid — 4 columns × 3 rows */}
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(4, 1fr)",
              gap: "4px",
            }}
          >
            {MONTHS.map((label, idx) => {
              const selected = isSelected(idx);
              const current = isCurrent(idx);
              return (
                <button
                  key={label}
                  type="button"
                  onClick={() => selectMonth(idx)}
                  style={{
                    padding: "8px 4px",
                    fontSize: "12px",
                    fontWeight: selected ? 600 : 400,
                    background: selected ? "var(--accent-primary)" : "transparent",
                    color: selected
                      ? "#fff"
                      : current
                        ? "var(--accent-primary)"
                        : "var(--text-secondary)",
                    border: current && !selected
                      ? "1px solid var(--accent-primary)"
                      : "1px solid transparent",
                    borderRadius: "6px",
                    cursor: "pointer",
                    fontFamily: "inherit",
                    transition: "all 0.1s ease",
                    textAlign: "center",
                  }}
                  onMouseEnter={(e) => {
                    if (!selected)
                      (e.currentTarget as HTMLElement).style.background = "var(--bg-hover)";
                  }}
                  onMouseLeave={(e) => {
                    if (!selected)
                      (e.currentTarget as HTMLElement).style.background = "transparent";
                  }}
                >
                  {label}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
