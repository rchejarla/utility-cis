"use client";

import { useState, useRef, useEffect } from "react";

interface DatePickerProps {
  value: string; // YYYY-MM-DD
  onChange: (value: string) => void;
  placeholder?: string;
  /**
   * Override the default trigger-button style so the picker blends
   * into surrounding inputs. The defaults match the customer detail
   * page's --bg-deep inline-edit inputs. Pass a different style here
   * when embedding the picker inside a form shell that uses a
   * different background (e.g. EntityFormPage uses --bg-elevated).
   */
  triggerStyle?: React.CSSProperties;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DAYS = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];

function daysInMonth(year: number, month: number): number {
  return new Date(year, month + 1, 0).getDate();
}

function formatDisplay(dateStr: string): string {
  if (!dateStr) return "";
  const [y, m, d] = dateStr.split("-").map(Number);
  return `${MONTHS[m - 1]} ${d}, ${y}`;
}

export function DatePicker({ value, onChange, placeholder = "Select date...", triggerStyle }: DatePickerProps) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  // Calendar state
  const today = new Date();
  const initial = value ? new Date(value + "T00:00:00") : today;
  const [viewYear, setViewYear] = useState(initial.getFullYear());
  const [viewMonth, setViewMonth] = useState(initial.getMonth());

  // Close on click outside
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    if (open) document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [open]);

  // Reset view to selected date when opening
  useEffect(() => {
    if (open && value) {
      const d = new Date(value + "T00:00:00");
      setViewYear(d.getFullYear());
      setViewMonth(d.getMonth());
    }
  }, [open]);

  const firstDayOfMonth = new Date(viewYear, viewMonth, 1).getDay();
  const totalDays = daysInMonth(viewYear, viewMonth);

  const prevMonth = () => {
    if (viewMonth === 0) { setViewMonth(11); setViewYear(viewYear - 1); }
    else setViewMonth(viewMonth - 1);
  };

  const nextMonth = () => {
    if (viewMonth === 11) { setViewMonth(0); setViewYear(viewYear + 1); }
    else setViewMonth(viewMonth + 1);
  };

  const selectDate = (day: number) => {
    const m = String(viewMonth + 1).padStart(2, "0");
    const d = String(day).padStart(2, "0");
    onChange(`${viewYear}-${m}-${d}`);
    setOpen(false);
  };

  const isSelected = (day: number) => {
    if (!value) return false;
    const m = String(viewMonth + 1).padStart(2, "0");
    const d = String(day).padStart(2, "0");
    return value === `${viewYear}-${m}-${d}`;
  };

  const isToday = (day: number) => {
    return viewYear === today.getFullYear() && viewMonth === today.getMonth() && day === today.getDate();
  };

  return (
    <div ref={containerRef} style={{ position: "relative" }}>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        style={{
          // Defaults first; caller overrides (e.g. background,
          // padding) come last via triggerStyle spread. The color
          // depends on whether a value is set, so apply it after
          // the spread so callers don't accidentally reset it.
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
            width: "280px",
          }}
        >
          {/* Header: month/year navigation */}
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "10px" }}>
            <button
              type="button"
              onClick={prevMonth}
              style={{ background: "none", border: "none", color: "var(--text-secondary)", cursor: "pointer", fontSize: "14px", padding: "4px 8px" }}
            >
              ‹
            </button>
            <span style={{ fontSize: "13px", fontWeight: 600, color: "var(--text-primary)" }}>
              {MONTHS[viewMonth]} {viewYear}
            </span>
            <button
              type="button"
              onClick={nextMonth}
              style={{ background: "none", border: "none", color: "var(--text-secondary)", cursor: "pointer", fontSize: "14px", padding: "4px 8px" }}
            >
              ›
            </button>
          </div>

          {/* Day headers */}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: "2px", marginBottom: "4px" }}>
            {DAYS.map((d) => (
              <div
                key={d}
                style={{
                  textAlign: "center",
                  fontSize: "10px",
                  fontWeight: 600,
                  color: "var(--text-muted)",
                  padding: "4px 0",
                  textTransform: "uppercase",
                  letterSpacing: "0.05em",
                }}
              >
                {d}
              </div>
            ))}
          </div>

          {/* Day grid */}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: "2px" }}>
            {/* Empty cells for days before the 1st */}
            {Array.from({ length: firstDayOfMonth }).map((_, i) => (
              <div key={`empty-${i}`} />
            ))}

            {/* Day buttons */}
            {Array.from({ length: totalDays }).map((_, i) => {
              const day = i + 1;
              const selected = isSelected(day);
              const todayMark = isToday(day);

              return (
                <button
                  key={day}
                  type="button"
                  onClick={() => selectDate(day)}
                  style={{
                    padding: "6px 0",
                    fontSize: "12px",
                    fontWeight: selected ? 600 : 400,
                    background: selected
                      ? "var(--accent-primary)"
                      : "transparent",
                    color: selected
                      ? "#fff"
                      : todayMark
                        ? "var(--accent-primary)"
                        : "var(--text-secondary)",
                    border: todayMark && !selected ? "1px solid var(--accent-primary)" : "1px solid transparent",
                    borderRadius: "6px",
                    cursor: "pointer",
                    fontFamily: "inherit",
                    transition: "all 0.1s ease",
                    textAlign: "center",
                  }}
                  onMouseEnter={(e) => {
                    if (!selected) (e.currentTarget as HTMLElement).style.background = "var(--bg-hover)";
                  }}
                  onMouseLeave={(e) => {
                    if (!selected) (e.currentTarget as HTMLElement).style.background = "transparent";
                  }}
                >
                  {day}
                </button>
              );
            })}
          </div>

          {/* Footer: Today + Clear */}
          <div style={{ display: "flex", justifyContent: "space-between", marginTop: "10px", paddingTop: "8px", borderTop: "1px solid var(--border)" }}>
            <button
              type="button"
              onClick={() => {
                const t = today;
                const m = String(t.getMonth() + 1).padStart(2, "0");
                const d = String(t.getDate()).padStart(2, "0");
                onChange(`${t.getFullYear()}-${m}-${d}`);
                setOpen(false);
              }}
              style={{ background: "none", border: "none", color: "var(--accent-primary)", fontSize: "12px", cursor: "pointer", fontFamily: "inherit" }}
            >
              Today
            </button>
            {value && (
              <button
                type="button"
                onClick={() => { onChange(""); setOpen(false); }}
                style={{ background: "none", border: "none", color: "var(--text-muted)", fontSize: "12px", cursor: "pointer", fontFamily: "inherit" }}
              >
                Clear
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
