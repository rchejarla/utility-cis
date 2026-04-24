"use client";

import { useMemo, useState, type ReactNode } from "react";

export interface AccordionItem {
  id: string;
  title: ReactNode;
  /** Muted text shown next to the title (e.g. a human-readable label). */
  subtitle?: ReactNode;
  /** Right-aligned hint shown on the collapsed header (e.g. "4/4 priorities"). */
  summary?: ReactNode;
  /** Body rendered when the item is expanded. */
  content: ReactNode;
}

interface AccordionProps {
  items: AccordionItem[];
  /**
   * IDs of items to open initially. When omitted, the first item opens
   * so the page isn't blank on load. Pass [] for all collapsed.
   */
  defaultOpen?: string[];
}

/**
 * Independently-expandable accordion for pages that group a list of
 * similar configurations (SLAs per request type, commodities with
 * their UOMs, custom fields per entity, etc.). Each header stays
 * visible so the overview stays scannable; clicking a header toggles
 * just that row. Keyboard-accessible through native <button>
 * semantics + aria-expanded.
 */
export function Accordion({ items, defaultOpen }: AccordionProps) {
  const initial = useMemo(() => {
    if (defaultOpen !== undefined) return new Set(defaultOpen);
    return new Set(items[0] ? [items[0].id] : []);
    // Deliberately only run on mount — subsequent renders with new
    // `items` should preserve whatever the user has opened.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const [open, setOpen] = useState<Set<string>>(initial);

  function toggle(id: string) {
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      {items.map((item) => {
        const isOpen = open.has(item.id);
        return (
          <div
            key={item.id}
            style={{
              background: "var(--bg-card)",
              border: "1px solid var(--border)",
              borderRadius: 10,
              overflow: "hidden",
            }}
          >
            <button
              type="button"
              onClick={() => toggle(item.id)}
              aria-expanded={isOpen}
              aria-controls={`accordion-body-${item.id}`}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 12,
                width: "100%",
                padding: "12px 16px",
                background: "transparent",
                border: "none",
                cursor: "pointer",
                fontFamily: "inherit",
                color: "var(--text-primary)",
                textAlign: "left",
              }}
            >
              <ChevronIcon open={isOpen} />
              <span style={{ fontWeight: 600, fontSize: 13 }}>{item.title}</span>
              {item.subtitle && (
                <span style={{ color: "var(--text-muted)", fontSize: 13 }}>
                  {item.subtitle}
                </span>
              )}
              <span style={{ flex: 1 }} />
              {item.summary && (
                <span style={{ color: "var(--text-muted)", fontSize: 12 }}>
                  {item.summary}
                </span>
              )}
            </button>
            {isOpen && (
              <div
                id={`accordion-body-${item.id}`}
                style={{
                  borderTop: "1px solid var(--border)",
                }}
              >
                {item.content}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function ChevronIcon({ open }: { open: boolean }) {
  return (
    <svg
      width={12}
      height={12}
      viewBox="0 0 12 12"
      style={{
        flexShrink: 0,
        transform: open ? "rotate(90deg)" : "rotate(0deg)",
        transition: "transform 0.12s ease",
        color: "var(--text-muted)",
      }}
      aria-hidden
    >
      <path
        d="M4 2 L8 6 L4 10"
        stroke="currentColor"
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
    </svg>
  );
}
