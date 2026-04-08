"use client";

import { useRef, useState } from "react";

interface FilterOption {
  label: string;
  value: string;
}

interface FilterConfig {
  key: string;
  label: string;
  options: FilterOption[];
  value?: string;
  onChange: (value: string | undefined) => void;
}

interface FilterBarProps {
  filters: FilterConfig[];
}

function FilterPill({ filter }: { filter: FilterConfig }) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const activeOption = filter.options.find((o) => o.value === filter.value);
  const isActive = filter.value !== undefined;

  return (
    <div ref={containerRef} style={{ position: "relative" }}>
      <button
        onClick={() => setOpen((v) => !v)}
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: "6px",
          padding: "5px 12px",
          borderRadius: "999px",
          border: isActive
            ? "1px solid var(--accent-primary)"
            : "1px solid var(--border)",
          background: isActive ? "rgba(59,130,246,0.12)" : "var(--bg-card)",
          color: isActive ? "var(--accent-primary)" : "var(--text-secondary)",
          fontSize: "12px",
          fontWeight: "500",
          cursor: "pointer",
          whiteSpace: "nowrap",
          transition: "all 0.15s ease",
          fontFamily: "inherit",
        }}
      >
        <span>{filter.label}</span>
        {activeOption && (
          <>
            <span style={{ color: "var(--text-muted)", fontWeight: "400" }}>:</span>
            <span style={{ color: "var(--text-primary)", fontWeight: "600" }}>
              {activeOption.label}
            </span>
          </>
        )}
        <span style={{ fontSize: "10px", opacity: 0.6 }}>{open ? "▲" : "▼"}</span>
      </button>

      {open && (
        <>
          {/* Backdrop to close on click-away */}
          <div
            style={{
              position: "fixed",
              inset: 0,
              zIndex: 49,
            }}
            onClick={() => setOpen(false)}
          />

          <div
            style={{
              position: "absolute",
              top: "calc(100% + 6px)",
              left: 0,
              zIndex: 50,
              background: "var(--bg-elevated)",
              border: "1px solid var(--border)",
              borderRadius: "var(--radius)",
              boxShadow: "0 8px 24px rgba(0,0,0,0.4)",
              minWidth: "160px",
              overflow: "hidden",
            }}
          >
            {/* "All" option */}
            <DropdownItem
              label={`All ${filter.label}`}
              active={!isActive}
              onClick={() => {
                filter.onChange(undefined);
                setOpen(false);
              }}
            />
            {filter.options.map((opt) => (
              <DropdownItem
                key={opt.value}
                label={opt.label}
                active={filter.value === opt.value}
                onClick={() => {
                  filter.onChange(opt.value);
                  setOpen(false);
                }}
              />
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function DropdownItem({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        width: "100%",
        padding: "8px 14px",
        background: active ? "var(--bg-hover)" : "transparent",
        border: "none",
        color: active ? "var(--text-primary)" : "var(--text-secondary)",
        fontSize: "13px",
        cursor: "pointer",
        textAlign: "left",
        fontFamily: "inherit",
        transition: "background 0.1s ease",
      }}
      onMouseEnter={(e) =>
        !active && ((e.currentTarget as HTMLButtonElement).style.background = "var(--bg-hover)")
      }
      onMouseLeave={(e) =>
        !active && ((e.currentTarget as HTMLButtonElement).style.background = "transparent")
      }
    >
      {label}
      {active && <span style={{ color: "var(--accent-primary)", fontSize: "12px" }}>✓</span>}
    </button>
  );
}

export function FilterBar({ filters }: FilterBarProps) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: "8px",
        flexWrap: "wrap",
        marginBottom: "16px",
      }}
    >
      <span
        style={{
          fontSize: "12px",
          color: "var(--text-muted)",
          fontWeight: "500",
          marginRight: "4px",
        }}
      >
        Filter:
      </span>
      {filters.map((filter) => (
        <FilterPill key={filter.key} filter={filter} />
      ))}
    </div>
  );
}
