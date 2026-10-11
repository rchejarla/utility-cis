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
  const [at, setAt] = useState<{ top: number; left: number; above: boolean } | null>(null);

  const close = useCallback((returnFocus = true) => {
    setAt(null);
    if (returnFocus) triggerRef.current?.focus({ preventScroll: true });
  }, []);

  function open() {
    const el = triggerRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();

    /*
     * Divided by the effective zoom, and that is the whole reason this
     * menu works.
     *
     * `globals.css` sets `html { zoom: 1.25 }` as the interface-scale
     * knob. `getBoundingClientRect()` reports visual pixels — the zoom
     * already applied — but this menu is portaled to `document.body`,
     * outside that zoomed subtree, where a fixed element's `left` and
     * `top` are resolved in zoomed CSS pixels and multiplied by 1.25
     * again. Feeding the measurement straight back therefore placed the
     * menu 1.25x too far right and down: far enough right to leave the
     * viewport entirely, which looks exactly like a button that does
     * nothing. It was in the DOM, visible, opaque and 212px tall, at
     * left: 2087 on a 1900px-wide screen.
     *
     * No test could have caught it. jsdom does no layout, so every rect
     * is zero and the arithmetic is invisible.
     */
    const zoom = el.currentCSSZoom ?? 1;

    // Flipped above the trigger when there is not room below, so the
    // menu is never painted off the bottom of the viewport. Compared in
    // visual pixels, which is what both the rect and innerHeight are in.
    const needed = (items.length * ITEM_HEIGHT + MENU_PADDING) * zoom;
    const above = r.bottom + needed > window.innerHeight && r.top > needed;

    // Right-aligned to the trigger: these live at the right edge of a
    // row, so a left-aligned menu would hang off the screen.
    setAt({
      top: (above ? r.top - 4 : r.bottom + 4) / zoom,
      left: r.right / zoom,
      above,
    });
  }

  useEffect(() => {
    if (!at) return;

    // `preventScroll` is load-bearing, not a nicety. Without it the
    // browser scrolls an ancestor to bring the focused item into view,
    // the scroll handler below sees that scroll, and the menu closes in
    // the same frame it opened — which looks exactly like a dead button.
    // jsdom implements neither focus-scrolling nor scroll events, so no
    // test can catch this; only clicking it can.
    const first = menuRef.current?.querySelector<HTMLButtonElement>("button:not([disabled])");
    first?.focus({ preventScroll: true });

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

    // Deliberately NOT closing on scroll or resize.
    //
    // It did, so that a position measured once could not drift away from
    // its row. That cost more than it bought: a capture-phase scroll
    // listener on window hears every scrolling element in the document,
    // and anything that scrolled for any reason — including the browser
    // revealing a focused element — shut the menu in the frame it
    // opened. The symptom is a button that does nothing, and no test can
    // see it, because jsdom raises no scroll events at all.
    //
    // Drifting is the lesser fault: the menu closes on any item, on an
    // outside click and on Escape, so it is never open for long.
    document.addEventListener("keydown", onKey, true);
    document.addEventListener("mousedown", onPointerDown);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      document.removeEventListener("mousedown", onPointerDown);
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
            style={{
              ...MENU,
              top: at.top,
              left: at.left,
              // Painted from the trigger's right edge leftwards, and
              // upwards when it had to flip above.
              transform: at.above ? "translate(-100%, -100%)" : "translateX(-100%)",
            }}
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

/** Used to decide whether the menu fits below the trigger. */
const ITEM_HEIGHT = 32;
const MENU_PADDING = 8;

const MENU: React.CSSProperties = {
  position: "fixed",
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
