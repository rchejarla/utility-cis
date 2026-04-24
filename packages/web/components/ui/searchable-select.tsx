"use client";

import { useState, useRef, useEffect, useId, useCallback } from "react";

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
  label?: string;
  /**
   * Compact height to align with filter pills in EntityListPage's
   * filter row. Drops the trigger to ~30px so it sits flush next to
   * FilterBar pills. Default (false) keeps the form-friendly 36px.
   */
  compact?: boolean;
}

/**
 * WCAG 2.1 AA accessible searchable combobox.
 * Pattern: WAI-ARIA Authoring Practices "combobox with listbox popup".
 * - role="combobox" on the trigger, aria-expanded, aria-haspopup="listbox",
 *   aria-controls pointing at the listbox
 * - role="listbox" on the options container
 * - role="option" on each option with aria-selected
 * - ArrowDown/Up navigate, Enter/Space select, Escape closes, Home/End jump
 * - Typing in the search input filters + resets active index
 */
export function SearchableSelect({
  options,
  value,
  onChange,
  placeholder = "Select...",
  clearLabel = "Clear",
  label,
  compact = false,
}: SearchableSelectProps) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [activeIndex, setActiveIndex] = useState<number>(-1);
  const reactId = useId();
  const triggerId = `ss-trigger-${reactId}`;
  const listboxId = `ss-listbox-${reactId}`;
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const optionRefs = useRef<(HTMLLIElement | null)[]>([]);

  const selectedOption = options.find((o) => o.value === value);

  const filtered = search
    ? options.filter((o) => o.label.toLowerCase().includes(search.toLowerCase()))
    : options;

  // All activatable items including the "clear" row at index 0.
  const items: Array<{ kind: "clear" } | { kind: "option"; option: Option }> = [
    { kind: "clear" },
    ...filtered.map((o) => ({ kind: "option" as const, option: o })),
  ];

  const close = useCallback(
    (returnFocus = true) => {
      setOpen(false);
      setSearch("");
      setActiveIndex(-1);
      if (returnFocus) {
        triggerRef.current?.focus();
      }
    },
    []
  );

  const selectByIndex = useCallback(
    (i: number) => {
      const item = items[i];
      if (!item) return;
      if (item.kind === "clear") {
        onChange(undefined);
      } else {
        onChange(item.option.value);
      }
      close();
    },
    [items, onChange, close]
  );

  // Close on click outside
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
        setSearch("");
        setActiveIndex(-1);
      }
    }
    if (open) document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [open]);

  // Focus input when opening, and set active index to the currently-selected option.
  useEffect(() => {
    if (open) {
      inputRef.current?.focus();
      const selectedIdx = items.findIndex(
        (it) => it.kind === "option" && it.option.value === value
      );
      setActiveIndex(selectedIdx >= 0 ? selectedIdx : 0);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Keep active option scrolled into view
  useEffect(() => {
    if (activeIndex >= 0 && optionRefs.current[activeIndex]) {
      optionRefs.current[activeIndex]?.scrollIntoView({ block: "nearest" });
    }
  }, [activeIndex]);

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
        setActiveIndex((i) => (i + 1) % items.length);
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
      case " ":
        // Space is allowed to submit only when focus is NOT in the text input,
        // so the user can still type spaces in search.
        if (e.key === " " && e.target === inputRef.current) return;
        e.preventDefault();
        if (activeIndex >= 0) selectByIndex(activeIndex);
        break;
      case "Tab":
        // Tab without shift closes but keeps the focus moving naturally.
        close(false);
        break;
    }
  }

  const activeDescendantId =
    activeIndex >= 0 ? `${listboxId}-opt-${activeIndex}` : undefined;

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
        onClick={() => {
          setOpen((o) => !o);
          setSearch("");
        }}
        onFocus={(e) => {
          e.currentTarget.style.outline = "2px solid var(--accent-primary)";
          e.currentTarget.style.outlineOffset = "2px";
        }}
        onBlur={(e) => {
          e.currentTarget.style.outline = "none";
        }}
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          width: "100%",
          // Match FilterBar's pill dimensions exactly when compact so
          // the owner filter lines up with Type / Status pills in the
          // /premises filter row. Line-height pin prevents the flex
          // button from stretching past the intrinsic text height.
          minHeight: compact ? undefined : "36px",
          padding: compact ? "5px 12px" : "7px 12px",
          lineHeight: compact ? 1.2 : undefined,
          fontSize: compact ? "12px" : "13px",
          fontWeight: compact ? 500 : undefined,
          background: compact ? "var(--bg-card)" : "var(--bg-card)",
          border: value ? "1px solid var(--accent-primary)" : "1px solid var(--border)",
          borderRadius: compact ? "999px" : "var(--radius)",
          color: value ? "var(--text-primary)" : "var(--text-muted)",
          cursor: "pointer",
          fontFamily: "inherit",
          textAlign: "left",
          gap: "8px",
          outline: "none",
        }}
      >
        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {selectedOption ? selectedOption.label : placeholder}
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
              onChange={(e) => {
                setSearch(e.target.value);
                setActiveIndex(1); // First filtered option (after clear)
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
              }}
            />
          </div>

          {/* Options list */}
          <ul
            id={listboxId}
            role="listbox"
            aria-label={label ?? "Options"}
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
                    alignItems: "center",
                    justifyContent: "space-between",
                    padding: "8px 14px",
                    background: active
                      ? "var(--bg-hover)"
                      : isSelected
                      ? "var(--bg-hover)"
                      : "transparent",
                    color: isSelected ? "var(--text-primary)" : "var(--text-secondary)",
                    fontSize: "13px",
                    cursor: "pointer",
                  }}
                >
                  <span
                    style={{
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {opt.label}
                  </span>
                  {isSelected && (
                    <span
                      aria-hidden="true"
                      style={{
                        color: "var(--accent-primary)",
                        fontSize: "12px",
                        flexShrink: 0,
                      }}
                    >
                      ✓
                    </span>
                  )}
                </li>
              );
            })}
            {filtered.length === 0 && (
              <li
                role="presentation"
                style={{
                  padding: "12px 14px",
                  color: "var(--text-muted)",
                  fontSize: "12px",
                  textAlign: "center",
                }}
              >
                No matches
              </li>
            )}
          </ul>
        </div>
      )}
    </div>
  );
}
