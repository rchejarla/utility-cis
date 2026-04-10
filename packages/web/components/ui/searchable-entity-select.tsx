"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { apiClient } from "@/lib/api-client";

/**
 * Async-search entity picker for large list endpoints. Used anywhere a
 * plain dropdown would try to preload thousands of rows.
 *
 * The component owns:
 *   - the options list (fetched from the endpoint via `apiClient.get`)
 *   - the loading state
 *   - the currently-resolved label for the selected value
 *   - debounced search against the backend
 *
 * It does NOT attempt to hydrate a pre-existing `value` by id — these
 * forms all start empty, so the label is only known after the user has
 * interacted at least once. If we ever wire this into an edit form,
 * add a `hydrateSelected` callback that takes an id and returns a label.
 *
 * Accessibility follows the same WAI-ARIA "combobox with listbox popup"
 * pattern as SearchableSelect: role="combobox" on the trigger,
 * role="listbox"/"option" on the menu, arrow/enter/escape navigation.
 */

export interface SearchableEntitySelectProps<T> {
  value: string | undefined;
  /**
   * Called when the user picks an option (or clears).
   * The second argument is the full fetched row, available whenever
   * the user selected something (undefined on clear, or if the row
   * isn't in the currently-loaded page of results). Callers that need
   * the row — e.g. to show a context panel with details like UOM or
   * last read — can capture it directly without issuing an extra GET.
   */
  onChange: (value: string | undefined, row?: T) => void;
  /**
   * List endpoint to query. Will be called with `?search=<query>` plus
   * whatever `extraParams` are provided. Response is either `{data: T[]}`
   * or `T[]`.
   */
  endpoint: string;
  /**
   * Turn a backend row into an option. `sublabel` is rendered on a
   * second line under the main label for disambiguation.
   */
  mapOption: (row: T) => { value: string; label: string; sublabel?: string };
  /**
   * Extra query params included in every fetch (e.g. `{ status: "ACTIVE" }`
   * to filter only active rows, or `{ premiseId: "..." }` for cascades).
   * Changing these clears the cache and re-fetches.
   */
  extraParams?: Record<string, string>;
  /** Name of the thing being picked, for placeholder + aria-label. */
  placeholder?: string;
  clearLabel?: string;
  label?: string;
  /** Debounce milliseconds for search keystrokes. Default 200. */
  debounceMs?: number;
  /** Disable the control entirely. */
  disabled?: boolean;
  /** Max results to fetch per query. Default 20. */
  limit?: number;
}

interface Option {
  value: string;
  label: string;
  sublabel?: string;
}

/**
 * Option paired with the raw row it was mapped from, so we can return
 * the full row via onChange when the user picks it. We keep a separate
 * option-level state for rendering (label/sublabel only) and a row
 * lookup keyed on value for onChange callbacks.
 */

export function SearchableEntitySelect<T>({
  value,
  onChange,
  endpoint,
  mapOption,
  extraParams,
  placeholder = "Search...",
  clearLabel = "Clear",
  label,
  debounceMs = 200,
  disabled = false,
  limit = 20,
}: SearchableEntitySelectProps<T>) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [options, setOptions] = useState<Option[]>([]);
  const [loading, setLoading] = useState(false);
  const [activeIndex, setActiveIndex] = useState<number>(-1);
  const [knownLabels, setKnownLabels] = useState<Record<string, Option>>({});
  // Full fetched rows keyed by their id, so onChange can hand the
  // selected row back to the parent without re-fetching.
  const [knownRows, setKnownRows] = useState<Record<string, T>>({});

  const reactId = useId();
  const triggerId = `ses-trigger-${reactId}`;
  const listboxId = `ses-listbox-${reactId}`;
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const optionRefs = useRef<(HTMLLIElement | null)[]>([]);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Serialize extraParams so we can use it as an effect dep without
  // constantly re-fetching from object identity changes.
  const paramsKey = JSON.stringify(extraParams ?? {});

  const fetchOptions = useCallback(
    async (query: string) => {
      setLoading(true);
      try {
        const params: Record<string, string> = {
          limit: String(limit),
          ...(extraParams ?? {}),
        };
        if (query) params.search = query;
        const res = await apiClient.get<
          { data: T[] } | T[]
        >(endpoint, params);
        const rows = Array.isArray(res) ? res : res.data ?? [];
        const mapped = rows.map(mapOption);
        setOptions(mapped);
        // Remember labels so the trigger can render the selected one
        // without needing an extra fetch-by-id call, and keep the full
        // row around so onChange can hand it back to the parent.
        setKnownLabels((prev) => {
          const next = { ...prev };
          for (const opt of mapped) next[opt.value] = opt;
          return next;
        });
        setKnownRows((prev) => {
          const next = { ...prev };
          rows.forEach((row, i) => {
            const opt = mapped[i];
            if (opt) next[opt.value] = row;
          });
          return next;
        });
      } catch (err) {
        console.error(`SearchableEntitySelect fetch failed for ${endpoint}`, err);
        setOptions([]);
      } finally {
        setLoading(false);
      }
      // eslint-disable-next-line react-hooks/exhaustive-deps
    },
    [endpoint, paramsKey, limit, mapOption],
  );

  // Fetch when the menu opens, when the search text changes, or when
  // extraParams change while the menu is open.
  useEffect(() => {
    if (!open) return;
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      fetchOptions(search);
    }, debounceMs);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [open, search, paramsKey, debounceMs, fetchOptions]);

  // Close the menu whenever extraParams change, since a cascade switch
  // (e.g., premise changed upstream) usually means the old selection
  // may no longer be valid. The parent is responsible for clearing
  // `value` if that happens; we just collapse the UI.
  useEffect(() => {
    setOpen(false);
    setSearch("");
    setOptions([]);
  }, [paramsKey]);

  // Click outside closes
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

  // Focus input on open and reset active index
  useEffect(() => {
    if (open) {
      requestAnimationFrame(() => inputRef.current?.focus());
      setActiveIndex(options.length > 0 ? 1 : 0);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Scroll the active option into view. Guarded because jsdom (the
  // test environment) does not implement Element.scrollIntoView.
  useEffect(() => {
    const el = activeIndex >= 0 ? optionRefs.current[activeIndex] : null;
    if (el && typeof el.scrollIntoView === "function") {
      el.scrollIntoView({ block: "nearest" });
    }
  }, [activeIndex]);

  const close = useCallback((returnFocus = true) => {
    setOpen(false);
    setSearch("");
    setActiveIndex(-1);
    if (returnFocus) triggerRef.current?.focus();
  }, []);

  // Items includes a "clear" row at index 0, then the fetched options.
  const items: Array<{ kind: "clear" } | { kind: "option"; option: Option }> = useMemo(
    () => [{ kind: "clear" as const }, ...options.map((o) => ({ kind: "option" as const, option: o }))],
    [options],
  );

  const selectByIndex = useCallback(
    (i: number) => {
      const item = items[i];
      if (!item) return;
      if (item.kind === "clear") {
        onChange(undefined);
      } else {
        const row = knownRows[item.option.value];
        onChange(item.option.value, row);
      }
      close();
    },
    [items, onChange, close, knownRows],
  );

  function handleKeyDown(e: React.KeyboardEvent) {
    if (!open) {
      if (e.key === "ArrowDown" || e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        setOpen(true);
      }
      return;
    }
    switch (e.key) {
      case "Escape":
        e.preventDefault();
        close();
        break;
      case "ArrowDown":
        e.preventDefault();
        setActiveIndex((i) => (i + 1) % Math.max(1, items.length));
        break;
      case "ArrowUp":
        e.preventDefault();
        setActiveIndex((i) => (i <= 0 ? items.length - 1 : i - 1));
        break;
      case "Home":
        e.preventDefault();
        setActiveIndex(0);
        break;
      case "End":
        e.preventDefault();
        setActiveIndex(items.length - 1);
        break;
      case "Enter":
        e.preventDefault();
        if (activeIndex >= 0) selectByIndex(activeIndex);
        break;
      case "Tab":
        close(false);
        break;
    }
  }

  const selectedOption = value ? knownLabels[value] : undefined;
  const activeDescendantId = activeIndex >= 0 ? `${listboxId}-opt-${activeIndex}` : undefined;

  return (
    <div ref={containerRef} style={{ position: "relative" }} onKeyDown={handleKeyDown}>
      <button
        ref={triggerRef}
        id={triggerId}
        type="button"
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listboxId : undefined}
        aria-label={label}
        aria-activedescendant={open ? activeDescendantId : undefined}
        disabled={disabled}
        onClick={() => !disabled && setOpen((o) => !o)}
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          width: "100%",
          minHeight: "36px",
          padding: "7px 12px",
          fontSize: "13px",
          background: "var(--bg-card)",
          border: value ? "1px solid var(--accent-primary)" : "1px solid var(--border)",
          borderRadius: "var(--radius)",
          color: value ? "var(--text-primary)" : "var(--text-muted)",
          cursor: disabled ? "not-allowed" : "pointer",
          opacity: disabled ? 0.5 : 1,
          fontFamily: "inherit",
          textAlign: "left",
          gap: "8px",
          outline: "none",
        }}
      >
        <span
          style={{
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            flex: 1,
          }}
        >
          {selectedOption ? (
            <>
              {selectedOption.label}
              {selectedOption.sublabel && (
                <span style={{ fontSize: "11px", color: "var(--text-muted)", marginLeft: 8 }}>
                  {selectedOption.sublabel}
                </span>
              )}
            </>
          ) : value ? (
            // We have a value but no label resolved yet — show the id
            // so the user knows something is selected.
            <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 11 }}>{value}</span>
          ) : (
            placeholder
          )}
        </span>
        <span aria-hidden="true" style={{ fontSize: "10px", opacity: 0.6, flexShrink: 0 }}>
          {open ? "▲" : "▼"}
        </span>
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
            maxHeight: "340px",
            display: "flex",
            flexDirection: "column",
            overflow: "hidden",
          }}
        >
          <div style={{ padding: "8px", borderBottom: "1px solid var(--border)" }}>
            <input
              ref={inputRef}
              type="text"
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setActiveIndex(1);
              }}
              placeholder="Type to search..."
              aria-label={`Search ${label ?? "options"}`}
              aria-autocomplete="list"
              aria-controls={listboxId}
              aria-activedescendant={activeDescendantId}
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
                boxSizing: "border-box",
              }}
            />
          </div>
          <ul
            id={listboxId}
            role="listbox"
            aria-label={label ?? "Options"}
            aria-busy={loading}
            style={{
              overflowY: "auto",
              flex: 1,
              margin: 0,
              padding: 0,
              listStyle: "none",
            }}
          >
            {items.map((it, i) => {
              const active = i === activeIndex;
              if (it.kind === "clear") {
                const isSelected = !value;
                return (
                  <li
                    key="__clear"
                    id={`${listboxId}-opt-${i}`}
                    ref={(el) => {
                      optionRefs.current[i] = el;
                    }}
                    role="option"
                    aria-selected={isSelected}
                    onClick={() => selectByIndex(i)}
                    onMouseEnter={() => setActiveIndex(i)}
                    style={{
                      padding: "8px 14px",
                      background: active ? "var(--bg-hover)" : "transparent",
                      color: "var(--text-muted)",
                      fontSize: "13px",
                      fontStyle: "italic",
                      cursor: "pointer",
                    }}
                  >
                    {clearLabel}
                  </li>
                );
              }
              const opt = it.option;
              const isSelected = value === opt.value;
              return (
                <li
                  key={opt.value}
                  id={`${listboxId}-opt-${i}`}
                  ref={(el) => {
                    optionRefs.current[i] = el;
                  }}
                  role="option"
                  aria-selected={isSelected}
                  onClick={() => selectByIndex(i)}
                  onMouseEnter={() => setActiveIndex(i)}
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    gap: "2px",
                    padding: "8px 14px",
                    background:
                      active || isSelected ? "var(--bg-hover)" : "transparent",
                    color: isSelected ? "var(--text-primary)" : "var(--text-secondary)",
                    fontSize: "13px",
                    cursor: "pointer",
                    borderLeft: isSelected
                      ? "2px solid var(--accent-primary)"
                      : "2px solid transparent",
                  }}
                >
                  <span
                    style={{
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                      fontWeight: isSelected ? 600 : 500,
                    }}
                  >
                    {opt.label}
                  </span>
                  {opt.sublabel && (
                    <span
                      style={{
                        fontSize: "11px",
                        color: "var(--text-muted)",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {opt.sublabel}
                    </span>
                  )}
                </li>
              );
            })}
            {loading && (
              <li
                role="presentation"
                style={{
                  padding: "12px 14px",
                  color: "var(--text-muted)",
                  fontSize: "12px",
                  textAlign: "center",
                  fontFamily: "'JetBrains Mono', monospace",
                }}
              >
                searching...
              </li>
            )}
            {!loading && options.length === 0 && (
              <li
                role="presentation"
                style={{
                  padding: "12px 14px",
                  color: "var(--text-muted)",
                  fontSize: "12px",
                  textAlign: "center",
                }}
              >
                {search ? `No matches for "${search}"` : "No results"}
              </li>
            )}
          </ul>
        </div>
      )}
    </div>
  );
}
