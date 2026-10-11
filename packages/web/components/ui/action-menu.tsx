"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";

/**
 * A dropdown of actions anchored to a button.
 *
 * Exists so a crowded row can keep the one or two acts performed most
 * inline and put the rest a click away. A row of six buttons buries the
 * common one among the rare ones, and the rare ones here are the
 * consequential ones — reversing a charge, writing it off — which should
 * not be the easiest thing to hit by accident.
 *
 * The menu renders through a portal with fixed positioning rather than
 * absolutely inside the trigger's parent. Its first home was a table
 * inside a card with `overflow: auto`, which clips an absolutely
 * positioned child: the menu appeared, then vanished behind the card's
 * edge for the last rows. Measuring the trigger and painting at the top
 * layer is what makes it work in a scroll container.
 *
 * Because the position is measured once on open, any scroll or resize
 * closes it rather than letting it drift away from its row.
 */

export interface ActionMenuItem {
  label: string;
  onSelect: () => void;
  /** Destructive items are tinted, so a careless click is less likely. */
  tone?: "default" | "danger";
  disabled?: boolean;
  title?: string;
}

export function ActionMenu({
  items,
  label = "More",
  "aria-label": ariaLabel,
}: {
  items: ActionMenuItem[];
  label?: string;
  "aria-label"?: string;
}) {
  const menuId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [at, setAt] = useState<{ top: number; left: number } | null>(null);

  const close = useCallback((returnFocus = true) => {
    setAt(null);
    if (returnFocus) triggerRef.current?.focus();
  }, []);

  function open() {
    const r = triggerRef.current?.getBoundingClientRect();
    if (!r) return;
    // Right-aligned to the trigger: these live at the right edge of a
    // row, so a left-aligned menu would hang off the screen.
    setAt({ top: r.bottom + 4, left: r.right });
  }

  useEffect(() => {
    if (!at) return;

    // Focus the first item so the menu is usable from the keyboard the
    // moment it opens.
    const first = menuRef.current?.querySelector<HTMLButtonElement>("button:not([disabled])");
    first?.focus();

    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.stopPropagation();
        close();
        return;
      }
      if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
      e.preventDefault();
      const buttons = Array.from(
        menuRef.current?.querySelectorAll<HTMLButtonElement>("button:not([disabled])") ?? [],
      );
      if (buttons.length === 0) return;
      const i = buttons.indexOf(document.activeElement as HTMLButtonElement);
      const next = e.key === "ArrowDown" ? i + 1 : i - 1;
      buttons[(next + buttons.length) % buttons.length].focus();
    }

    function onPointerDown(e: MouseEvent) {
      const target = e.target as Node;
      if (menuRef.current?.contains(target) || triggerRef.current?.contains(target)) return;
      close(false);
    }

    // A measured position goes stale the moment anything moves.
    const onMove = () => close(false);

    document.addEventListener("keydown", onKey, true);
    document.addEventListener("mousedown", onPointerDown);
    window.addEventListener("scroll", onMove, true);
    window.addEventListener("resize", onMove);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      document.removeEventListener("mousedown", onPointerDown);
      window.removeEventListener("scroll", onMove, true);
      window.removeEventListener("resize", onMove);
    };
  }, [at, close]);

  if (items.length === 0) return null;

  return (
    <>
      <button
        ref={triggerRef}
        onClick={() => (at ? close(false) : open())}
        aria-haspopup="menu"
        aria-expanded={at !== null}
        aria-controls={at ? menuId : undefined}
        aria-label={ariaLabel}
        style={TRIGGER}
      >
        {label}
      </button>

      {at !== null &&
        typeof document !== "undefined" &&
        createPortal(
          <div
            ref={menuRef}
            id={menuId}
            role="menu"
            style={{ ...MENU, top: at.top, left: at.left }}
          >
            {items.map((item) => (
              <button
                key={item.label}
                role="menuitem"
                disabled={item.disabled}
                title={item.title}
                onClick={() => {
                  close(false);
                  item.onSelect();
                }}
                style={{
                  ...ITEM,
                  color: item.tone === "danger" ? "var(--danger)" : "var(--text-primary)",
                  opacity: item.disabled ? 0.5 : 1,
                  cursor: item.disabled ? "default" : "pointer",
                }}
              >
                {item.label}
              </button>
            ))}
          </div>,
          document.body,
        )}
    </>
  );
}

const TRIGGER: React.CSSProperties = {
  padding: "3px 8px",
  fontSize: 10,
  fontWeight: 600,
  background: "var(--bg-elevated)",
  color: "var(--text-secondary)",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius)",
  cursor: "pointer",
  fontFamily: "inherit",
  whiteSpace: "nowrap",
};

const MENU: React.CSSProperties = {
  position: "fixed",
  // Painted from the trigger's right edge leftwards.
  transform: "translateX(-100%)",
  minWidth: 150,
  padding: 4,
  background: "var(--bg-card)",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius)",
  boxShadow: "0 8px 24px rgba(0,0,0,0.28)",
  zIndex: 200,
  display: "flex",
  flexDirection: "column",
};

const ITEM: React.CSSProperties = {
  padding: "7px 10px",
  fontSize: 12,
  textAlign: "left",
  background: "none",
  border: "none",
  borderRadius: 4,
  fontFamily: "inherit",
  whiteSpace: "nowrap",
};
