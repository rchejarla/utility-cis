"use client";

import { useState } from "react";
import { authDownload, authFetchFile, handToViewer } from "@/lib/auth-download";
import { useToast } from "@/components/ui/toast";

/**
 * The button that hands a reader the day's sheet.
 *
 * It opens the PDF in the browser's own viewer rather than saving a
 * file, because the next thing anybody does with a route sheet is print
 * it — and from the viewer they still can. Saving is the fallback for a
 * blocked popup, where a file is a worse answer than a viewer but a far
 * better one than nothing. Same shape as `BillPdfButton`, and for the
 * same reasons.
 *
 * **Fetched with the session's bearer token, not linked.** The endpoint
 * is `meter_reads:VIEW` like everything else here, so a plain `<a href>`
 * would arrive unauthenticated and render a 401 inside a PDF viewer.
 *
 * Offered only for a LOCAL route — `buildRouteSheet` refuses a vendor's
 * (400 `ROUTE_IS_EXTERNAL`), because its stops are not kept here and the
 * paper would print empty. The caller decides; this does not render a
 * disabled button for one, since a disabled control invites the question
 * "why" at every row.
 */

interface RouteSheetButtonProps {
  routeId: string;
  routeCode: string;
  /** `YYYY-MM-DD`. The day the reader is walking it. */
  onDate: string;
  /** Lets a row render it small and a page render it as a page action. */
  size?: "row" | "page";
}

export function RouteSheetButton({ routeId, routeCode, onDate, size = "page" }: RouteSheetButtonProps) {
  const { toast } = useToast();
  const [busy, setBusy] = useState(false);

  const path = `/api/v1/read-routes/${routeId}/sheet?onDate=${onDate}`;
  const fileName = `route-${routeCode.replace(/[^A-Za-z0-9._-]/g, "_")}-${onDate}.pdf`;

  async function view(event: React.MouseEvent) {
    /*
     * The list's rows navigate on click, and this button sits in one.
     * Without this, printing a sheet also opens the route's page behind
     * the viewer.
     */
    event.stopPropagation();
    // Opened while the click is still the active gesture — after the
    // await a popup blocker swallows it.
    const tab = window.open("", "_blank");
    setBusy(true);
    try {
      const file = await authFetchFile(path);
      if (tab) handToViewer(tab, file);
      else await authDownload(path, fileName);
    } catch (err) {
      tab?.close();
      toast(err instanceof Error ? err.message : "Could not build the sheet", "error");
    } finally {
      setBusy(false);
    }
  }

  const row: React.CSSProperties = {
    padding: "3px 8px",
    fontSize: 10,
    fontWeight: 600,
    background: "color-mix(in srgb, var(--info) 9%, transparent)",
    color: "var(--info)",
    border: "1px solid color-mix(in srgb, var(--info) 25%, transparent)",
  };
  const page: React.CSSProperties = {
    padding: "8px 16px",
    fontSize: 13,
    fontWeight: 500,
    background: "transparent",
    color: "var(--accent-primary)",
    border: "1px solid var(--accent-primary)",
  };

  return (
    <button
      onClick={(e) => void view(e)}
      disabled={busy}
      title={`Print the sheet for ${routeCode} on ${onDate}`}
      style={{
        ...(size === "row" ? row : page),
        borderRadius: "var(--radius)",
        fontFamily: "inherit",
        whiteSpace: "nowrap",
        cursor: busy ? "default" : "pointer",
        opacity: busy ? 0.6 : 1,
      }}
    >
      {busy ? "…" : "Print sheet"}
    </button>
  );
}
