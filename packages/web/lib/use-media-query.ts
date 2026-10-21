"use client";
import { useState, useEffect } from "react";

export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(false);

  useEffect(() => {
    const media = window.matchMedia(query);
    setMatches(media.matches);
    const listener = (e: MediaQueryListEvent) => setMatches(e.matches);
    media.addEventListener("change", listener);
    return () => media.removeEventListener("change", listener);
  }, [query]);

  return matches;
}

/**
 * The layout widths, multiplied by the `--app-zoom` on `:root`.
 *
 * `zoom` scales what it renders but does not change what a media query
 * sees, so a 1000px window under `zoom: 1.25` offers 800px of usable
 * width while `matchMedia` still reads 1000. Breakpoints written for the
 * unzoomed width therefore fire a quarter too late — the sidebar stayed
 * expanded, and tables kept every column, on a window that already
 * looked like a phone.
 *
 *   PHONE_MAX   768 * 1.25 - 1
 *   TABLET_MAX 1200 * 1.25 - 1
 *
 * The same two numbers are in the `.col-hide-*` rules in globals.css,
 * because a media query cannot read a custom property and so cannot
 * derive them. If the zoom changes, both move together or the sidebar
 * starts collapsing at a different width than the tables drop columns.
 */
const PHONE_MAX = 959;
const TABLET_MAX = 1499;

export function useBreakpoint() {
  const isMobile = useMediaQuery(`(max-width: ${PHONE_MAX}px)`);
  const isTablet = useMediaQuery(
    `(min-width: ${PHONE_MAX + 1}px) and (max-width: ${TABLET_MAX}px)`,
  );
  const isDesktop = useMediaQuery(`(min-width: ${TABLET_MAX + 1}px)`);
  return { isMobile, isTablet, isDesktop };
}
