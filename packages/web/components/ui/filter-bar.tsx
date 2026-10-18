"use client";

import { useRef, useState } from "react";

interface FilterOption {
  label: string;
  value: string;
}

interface FilterConfigBase {
  key: string;
  label: string;
  options: FilterOption[];
}

interface SingleFilterConfig extends FilterConfigBase {
  multiple?: false;
  value?: string;
  onChange: (value: string | undefined) => void;
}

interface MultiFilterConfig extends FilterConfigBase {
  multiple: true;
  /** Empty means no filter, the same as `value: undefined` does. */
  values: string[];
  onChange: (values: string[]) => void;
}

/**
 * Multi-select is opt-in so the four pages already using single-select
 * pills are untouched — a filter that accepts one value should not
 * start offering checkboxes because the component learned how.
 */
type FilterConfig = SingleFilterConfig | MultiFilterConfig;

interface FilterBarProps {
  filters: FilterConfig[];
}

/**
 * Above this many options the dropdown gets a search box and starts
 * scrolling. Chosen against the 260px list height below: about eight
 * items fit, so a list that needs scrolling is also a list worth
 * searching. Short filters — Action has three — stay exactly as they
 * were.
 */
const SEARCHABLE_THRESHOLD = 10;

function FilterPill({ filter }: { filter: FilterConfig }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const containerRef = useRef<HTMLDivElement>(null);

  const selected = filter.multiple ? filter.values : filter.value ? [filter.value] : [];
  const isActive = selected.length > 0;

  /**
   * What the pill reads when something is chosen. One selection names
   * itself; several would not fit, and the column is already the one
   * that overflowed, so they are counted instead.
   */
  const activeLabel =
    selected.length === 1
      ? (filter.options.find((o) => o.value === selected[0])?.label ?? selected[0])
      : `${selected.length} selected`;

  const searchable = filter.options.length > SEARCHABLE_THRESHOLD;
  const needle = query.trim().toLowerCase();
  const visibleOptions = needle
    ? filter.options.filter((o) => o.label.toLowerCase().includes(needle))
    : filter.options;

  function close() {
    setOpen(false);
    setQuery("");
  }

  /**
   * Single-select closes on choice; multi-select stays open, because
   * picking three things should not mean opening the menu three times.
   */
  function choose(value: string) {
    if (filter.multiple) {
      const next = filter.values.includes(value)
        ? filter.values.filter((v) => v !== value)
        : [...filter.values, value];
      filter.onChange(next);
      return;
    }
    filter.onChange(value);
    close();
  }

  function clear() {
    if (filter.multiple) filter.onChange([]);
    else filter.onChange(undefined);
    close();
  }

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
          background: isActive ? "var(--accent-primary-subtle)" : "var(--bg-card)",
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
        {isActive && (
          <>
            <span style={{ color: "var(--text-muted)", fontWeight: "400" }}>:</span>
            <span style={{ color: "var(--text-primary)", fontWeight: "600" }}>{activeLabel}</span>
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
            onClick={close}
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
              minWidth: "180px",
              overflow: "hidden",
            }}
          >
            {searchable && (
              <input
                autoFocus
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                // Enter takes the only sensible candidate: the first
                // match. Typing three letters and pressing Enter beats
                // typing three letters and then aiming.
                onKeyDown={(e) => {
                  if (e.key === "Enter" && visibleOptions.length > 0) {
                    choose(visibleOptions[0].value);
                  } else if (e.key === "Escape") {
                    close();
                  }
                }}
                placeholder={`Search ${filter.label.toLowerCase()}…`}
                style={{
                  display: "block",
                  width: "100%",
                  boxSizing: "border-box",
                  padding: "8px 12px",
                  border: "none",
                  borderBottom: "1px solid var(--border)",
                  background: "transparent",
                  color: "var(--text-primary)",
                  fontSize: "12px",
                  fontFamily: "inherit",
                  outline: "none",
                }}
              />
            )}

            {/* "All" stays put rather than scrolling away, and is never
                filtered out — clearing the filter must always be one
                click. */}
            <DropdownItem
              label={`All ${filter.label}`}
              active={!isActive}
              onClick={clear}
            />

            <div style={{ maxHeight: "260px", overflowY: "auto" }}>
              {visibleOptions.map((opt) => (
                <DropdownItem
                  key={opt.value}
                  label={opt.label}
                  active={selected.includes(opt.value)}
                  checkbox={filter.multiple}
                  onClick={() => choose(opt.value)}
                />
              ))}
              {visibleOptions.length === 0 && (
                <div
                  style={{
                    padding: "10px 12px",
                    fontSize: "12px",
                    color: "var(--text-muted)",
                  }}
                >
                  No match
                </div>
              )}
            </div>
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
  checkbox = false,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
  /**
   * Multi-select shows a box on every row, so the menu says up front
   * that more than one can be picked. Single-select keeps the bare tick
   * on the chosen row only, which is what the other four pages have.
   */
  checkbox?: boolean;
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
      <span style={{ display: "inline-flex", alignItems: "center", gap: "8px" }}>
        {checkbox && (
          <span
            aria-hidden
            style={{
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              width: "13px",
              height: "13px",
              flexShrink: 0,
              borderRadius: "3px",
              border: `1px solid ${active ? "var(--accent-primary)" : "var(--border)"}`,
              background: active ? "var(--accent-primary)" : "transparent",
              color: "#ffffff",
              fontSize: "9px",
              lineHeight: 1,
            }}
          >
            {active ? "✓" : ""}
          </span>
        )}
        {label}
      </span>
      {active && !checkbox && (
        <span style={{ color: "var(--accent-primary)", fontSize: "12px" }}>✓</span>
      )}
    </button>
  );
}

export function FilterBar({ filters }: FilterBarProps) {
  // Layout concern — external margins are the consumer's job. Embedding
  // FilterBar alongside other controls (EntityListPage's filter row,
  // /premises' view toggle) required cancelling out an internal margin-
  // bottom that used to live here; dropping it avoids that workaround.
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: "8px",
        flexWrap: "wrap",
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
