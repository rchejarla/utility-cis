"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import type {
  PremiseSummary,
  ReadRouteStopDetail,
  ReadRouteSummary,
  ReadingProgress,
} from "@utility-cis/shared";
import { PageHeader } from "@/components/ui/page-header";
import { AccessDenied } from "@/components/ui/access-denied";
import { RouteSheetButton } from "@/components/read-routes/route-sheet-button";
import { apiClient } from "@/lib/api-client";
import { usePermission } from "@/lib/use-permission";

/**
 * /read-routes/:id — one walk, in order (spec 30, §5.1).
 *
 * **The order is the page.** Everything else on it is in service of
 * being able to read the walk down the screen and change where one
 * address sits in it.
 *
 * Three things the data does not say about itself, and the page has to:
 *
 * - **The sequences are gapped integers**, step 100, so that inserting
 *   an address writes one row instead of renumbering the street. They
 *   are therefore not 1, 2, 3 and must not be shown as though they
 *   were — an operator reading "100, 200, 300" as a count asks where
 *   the other 297 went. The stops are numbered by position here, and
 *   the real sequence is only ever named where a position has to be
 *   chosen, which is the insert control.
 * - **A stop whose account bills on another cycle still belongs.**
 *   `Account.billing_cycle_id` is required and nothing makes it agree
 *   with the route's, so the case is real; §5.1 settles that the stop
 *   still prints, because a stop filtered off a sheet is a meter nobody
 *   visits. It is listed here as a data-quality item — not an error, not
 *   a warning that blocks anything — because deciding whether the
 *   account or the route is on the wrong cycle is somebody's judgement.
 * - **The tray is premises on no route at all**, not premises missing
 *   from this one. A reader visits an address once, so offering one that
 *   is already on another route would invite the double visit ordering
 *   exists to prevent.
 *
 * **A vendor's route is a different page.** An EXTERNAL route exists so
 * an imported read can point at something (§5.4). Its stops live in the
 * vendor's system, there is no sheet to print and nothing to type in —
 * and `GET /unsequenced` *refuses* one outright, so a page that asked
 * anyway would show an error for a route working exactly as designed.
 * Progress still answers, because for an EXTERNAL route it is learned
 * from the reads its code carried, and that is the one thing worth
 * saying about one.
 */

// Local calendar day, not UTC's — see the entry page's `todayIso`.
const today = () => new Date().toLocaleDateString("en-CA");

const addressOf = (p: PremiseSummary) =>
  [p.addressLine1, p.addressLine2].filter(Boolean).join(" ") + `, ${p.city}`;

export default function ReadRouteDetailPage() {
  const params = useParams();
  const id = String(params.id);
  const { canView, canCreate, canEdit } = usePermission("meter_reads");

  const [route, setRoute] = useState<ReadRouteSummary | null>(null);
  const [stops, setStops] = useState<ReadRouteStopDetail[]>([]);
  const [tray, setTray] = useState<PremiseSummary[]>([]);
  const [progress, setProgress] = useState<ReadingProgress | null>(null);
  /*
   * Two states, not one. `traySearch` is what is in the box and
   * `trayNeedle` is what has been asked for — without the gap, every
   * keystroke is a request against a table with a tenant's whole address
   * list in it, and the answers arrive out of order.
   */
  const [traySearch, setTraySearch] = useState("");
  const [trayNeedle, setTrayNeedle] = useState("");
  const [afterSequence, setAfterSequence] = useState<string>("");
  const [sheetDate, setSheetDate] = useState(today);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  /** The route and its stops. Nothing here depends on the origin. */
  const loadRoute = useCallback(async () => {
    try {
      const [loaded, stopList] = await Promise.all([
        apiClient.get<ReadRouteSummary>(`/api/v1/read-routes/${id}`),
        apiClient.get<{ data: ReadRouteStopDetail[] }>(`/api/v1/read-routes/${id}/stops`),
      ]);
      setRoute(loaded);
      setStops(stopList.data);
      setLoadError(null);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "Could not load this route");
    }
  }, [id]);

  useEffect(() => {
    void loadRoute();
  }, [loadRoute]);

  /*
   * Progress is its own fetch, and its failure is reported rather than
   * fatal: an unanswerable count is no reason to withhold the walk,
   * which is what somebody came here for.
   */
  useEffect(() => {
    apiClient
      .get<ReadingProgress>(`/api/v1/read-routes/${id}/progress`)
      .then(setProgress)
      .catch(() => setProgress(null));
  }, [id]);

  const isLocal = route?.origin === "LOCAL";

  useEffect(() => {
    const timer = setTimeout(() => setTrayNeedle(traySearch), 300);
    return () => clearTimeout(timer);
  }, [traySearch]);

  const loadTray = useCallback(async () => {
    // Guarded on the origin, not just hidden: the endpoint refuses an
    // EXTERNAL route with a 400, and asking would report that refusal
    // as though something were wrong.
    if (!isLocal) return;
    try {
      const res = await apiClient.get<{ data: PremiseSummary[] }>(
        `/api/v1/read-routes/${id}/unsequenced`,
        trayNeedle ? { search: trayNeedle, limit: "25" } : { limit: "25" },
      );
      setTray(res.data);
    } catch {
      setTray([]);
    }
  }, [id, isLocal, trayNeedle]);

  useEffect(() => {
    void loadTray();
  }, [loadTray]);

  const offCycle = useMemo(
    () =>
      route
        ? stops.filter((s) =>
            s.accountCycles.some((c) => c.billingCycleId !== route.billingCycleId),
          )
        : [],
    [stops, route],
  );

  async function addStop(premiseId: string) {
    setBusy(true);
    setActionError(null);
    try {
      const after = afterSequence === "" ? undefined : Number(afterSequence);
      await apiClient.post(`/api/v1/read-routes/${id}/stops`, {
        premiseId,
        ...(after === undefined ? {} : { afterSequence: after }),
      });
      await Promise.all([loadRoute(), loadTray()]);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Could not add that stop");
    } finally {
      setBusy(false);
    }
  }

  /*
   * Rename and retire — `PATCH /read-routes/:id`, which had no caller on
   * any screen until 2026-11-27. Retiring is the only way out for a route:
   * there is no DELETE, because its reads point at it. Code and cycle are
   * not offered here — a vendor route's code is what its imports match on,
   * and moving a route to another cycle changes which window every sheet
   * of it means — so each deserves more than an inline field.
   */
  const [nameDraft, setNameDraft] = useState<string | null>(null);
  async function updateRoute(change: { name?: string; active?: boolean }) {
    setBusy(true);
    setActionError(null);
    try {
      const updated = await apiClient.patch<ReadRouteSummary>(`/api/v1/read-routes/${id}`, change);
      // The PATCH answers the route row; the summary's counts are the list's.
      setRoute((prev) => (prev ? { ...prev, ...updated } : prev));
      setNameDraft(null);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Could not update this route");
    } finally {
      setBusy(false);
    }
  }

  async function removeStop(stopId: string) {
    setBusy(true);
    setActionError(null);
    try {
      await apiClient.delete(`/api/v1/read-routes/${id}/stops/${stopId}`);
      await Promise.all([loadRoute(), loadTray()]);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Could not remove that stop");
    } finally {
      setBusy(false);
    }
  }

  if (!canView) return <AccessDenied />;
  if (loadError) {
    return (
      <div style={{ padding: 24, color: "var(--danger)" }} role="alert">
        {loadError}
      </div>
    );
  }
  if (!route) return <div style={{ padding: 24 }}>Loading…</div>;

  return (
    <div>
      <PageHeader
        title={`${route.code} — ${route.name}`}
        subtitle={
          isLocal
            ? `Cycle ${route.cycleCode} · ${route.stopCount.toLocaleString()} ${
                route.stopCount === 1 ? "stop" : "stops"
              }${route.active ? "" : " · retired"}`
            : `Cycle ${route.cycleCode} · named by a vendor's reading system`
        }
        actions={
          isLocal && route.stopCount > 0 ? (
            <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
              <label htmlFor="sheetDate" style={label}>
                For
              </label>
              <input
                id="sheetDate"
                type="date"
                value={sheetDate}
                onChange={(e) => setSheetDate(e.target.value || today())}
                style={control}
              />
              <RouteSheetButton routeId={route.id} routeCode={route.code} onDate={sheetDate} />
              {canCreate && (
                /*
                 * The day travels with the link. The picker beside it
                 * decides which day's sheet prints, and entry opens a
                 * batch for the day in its URL **on mount** — so without
                 * this, numbers read off a 1 June sheet posted with
                 * today's read date, and the only thing that said so was
                 * a header nobody typing looks at.
                 */
                <Link href={`/read-routes/${route.id}/entry?date=${sheetDate}`} style={primaryLink}>
                  Enter readings
                </Link>
              )}
            </div>
          ) : undefined
        }
      />

      {canEdit && (
        <div style={{ ...card, marginBottom: 18 }} data-testid="route-details">
          <div
            style={{
              padding: "12px 18px",
              display: "flex",
              gap: 10,
              alignItems: "center",
              flexWrap: "wrap",
              fontSize: 13,
            }}
          >
            <label htmlFor="routeName" style={{ ...label, display: "inline", marginBottom: 0 }}>
              Name
            </label>
            <input
              id="routeName"
              value={nameDraft ?? route.name}
              onChange={(e) => setNameDraft(e.target.value)}
              style={{ ...control, minWidth: 220 }}
            />
            {nameDraft !== null && nameDraft.trim() !== "" && nameDraft.trim() !== route.name && (
              <button
                onClick={() => void updateRoute({ name: nameDraft.trim() })}
                disabled={busy}
                style={{ ...primaryLink, border: "none", cursor: "pointer", padding: "6px 14px" }}
              >
                Save name
              </button>
            )}
            <span style={{ flex: 1 }} />
            <span style={{ color: "var(--text-muted)" }}>
              {route.active ? "In use" : "Retired — kept for the reads that name it"}
            </span>
            <button
              onClick={() => {
                if (
                  route.active &&
                  !window.confirm(
                    `Retire ${route.code}? It stays on record for the reads that name it, but drops out of use.`,
                  )
                ) {
                  return;
                }
                void updateRoute({ active: !route.active });
              }}
              disabled={busy}
              style={{ ...ghostButton, padding: "6px 12px", fontSize: 12 }}
            >
              {route.active ? "Retire route" : "Put back in use"}
            </button>
          </div>
        </div>
      )}

      {progress && (
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 18 }}>
          <Stat label="Read" value={`${progress.read.toLocaleString()} of ${progress.expected.toLocaleString()}`} />
          <Stat label="Still to read" value={progress.outstanding.toLocaleString()} loud={progress.outstanding > 0} />
          <Stat label="Window" value={`${progress.windowStart.slice(0, 10)} → ${progress.windowEnd.slice(0, 10)}`} />
        </div>
      )}

      {!isLocal && (
        <div style={card}>
          <div style={{ padding: "18px 20px", fontSize: 13, color: "var(--text-secondary)" }}>
            <b style={{ color: "var(--text-primary)" }}>A vendor&apos;s reading system owns this
            route.</b>{" "}
            It appeared here the first time one of their reads named{" "}
            <span style={mono}>{route.code}</span>, so the reads can say which route they came
            off. Which addresses are on it, and in what order, is decided over there — there are
            no stops to keep here, no sheet to print and nothing to type in. The figures above are
            learned from the reads the code has carried.
          </div>
        </div>
      )}

      {actionError && (
        <div
          role="alert"
          style={{
            marginBottom: 14,
            padding: "10px 14px",
            borderRadius: "var(--radius)",
            background: "var(--danger-subtle)",
            border: "1px solid var(--danger)",
            color: "var(--danger)",
            fontSize: 13,
          }}
        >
          {actionError}
        </div>
      )}

      {isLocal && (
        <>
          <section style={{ marginBottom: 20 }}>
            <h2 style={heading}>The walk</h2>
            <div style={card}>
              <table style={table}>
                <thead>
                  <tr style={{ background: "var(--bg-elevated)" }}>
                    <th style={{ ...th, width: 60 }}>#</th>
                    <th style={th}>Address</th>
                    <th style={th}>Billed on</th>
                    {canEdit && <th style={{ ...th, width: 90 }} />}
                  </tr>
                </thead>
                <tbody>
                  {stops.map((stop, index) => (
                    <tr key={stop.id} data-testid="stop-row" style={{ borderTop: "1px solid var(--border-subtle)" }}>
                      {/*
                        * The position, not the sequence. See the note at
                        * the top of this file: the gaps are how an insert
                        * stays one row written.
                        */}
                      <td style={{ ...td, ...mono, color: "var(--text-muted)" }}>{index + 1}</td>
                      <td style={td}>
                        <Link href={`/premises/${stop.premiseId}`} style={{ color: "var(--accent-primary)" }}>
                          {addressOf(stop.premise)}
                        </Link>
                      </td>
                      <td style={{ ...td, fontSize: 12 }}>
                        {stop.accountCycles.length === 0 ? (
                          /*
                            * No live service at the address, so nothing to
                            * read when the reader gets there. It still
                            * prints on the sheet — the sheet reports it
                            * separately rather than dropping it — and it
                            * belongs on screen for the same reason.
                            */
                          <span style={{ color: "var(--warning)" }}>No service here</span>
                        ) : (
                          stop.accountCycles.map((c) => (
                            <span
                              key={c.billingCycleId}
                              style={{
                                ...mono,
                                marginRight: 8,
                                color:
                                  c.billingCycleId === route.billingCycleId
                                    ? "var(--text-secondary)"
                                    : "var(--warning)",
                              }}
                            >
                              {c.cycleCode}
                            </span>
                          ))
                        )}
                      </td>
                      {canEdit && (
                        <td style={{ ...td, textAlign: "right" }}>
                          <button
                            onClick={() => void removeStop(stop.id)}
                            disabled={busy}
                            style={ghostButton}
                          >
                            Remove
                          </button>
                        </td>
                      )}
                    </tr>
                  ))}
                  {stops.length === 0 && (
                    <tr>
                      <td colSpan={canEdit ? 4 : 3} style={emptyCell}>
                        No stops yet. A route with none prints an empty sheet — add addresses from
                        the tray below.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </section>

          {offCycle.length > 0 && (
            <section data-testid="off-cycle-stops" style={{ marginBottom: 20 }}>
              <h2 style={heading}>Stops billed on another cycle</h2>
              <div style={{ ...card, borderColor: "var(--warning)" }}>
                <div style={{ padding: "12px 18px", fontSize: 12, color: "var(--text-secondary)" }}>
                  These addresses are on this walk, and they stay on it — a stop left off a sheet
                  is a meter nobody visits. But the account served at each bills on a different
                  cycle from <span style={mono}>{route.cycleCode}</span>, so its read is due on a
                  different day. Either the account or the route is on the wrong cycle, and which
                  one is a judgement somebody has to make.
                </div>
                <table style={table}>
                  <tbody>
                    {offCycle.map((stop) => (
                      <tr key={stop.id} style={{ borderTop: "1px solid var(--border-subtle)" }}>
                        <td style={td}>{addressOf(stop.premise)}</td>
                        <td style={{ ...td, ...mono, color: "var(--warning)" }}>
                          {stop.accountCycles
                            .filter((c) => c.billingCycleId !== route.billingCycleId)
                            .map((c) => c.cycleCode)
                            .join(", ")}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          {canEdit && (
            <section data-testid="unsequenced-tray">
              <h2 style={heading}>Addresses on no route</h2>
              <div style={card}>
                <div
                  style={{
                    display: "flex",
                    gap: 12,
                    alignItems: "flex-end",
                    padding: "12px 18px",
                    borderBottom: "1px solid var(--border-subtle)",
                    flexWrap: "wrap",
                  }}
                >
                  <div>
                    <label htmlFor="traySearch" style={label}>
                      Find an address
                    </label>
                    <input
                      id="traySearch"
                      value={traySearch}
                      onChange={(e) => setTraySearch(e.target.value)}
                      placeholder="Street, city or ZIP"
                      style={{ ...control, minWidth: 220 }}
                    />
                  </div>
                  <div>
                    <label htmlFor="afterSequence" style={label}>
                      Insert after
                    </label>
                    {/*
                      * The one place a real sequence is named, because a
                      * position has to be chosen and the server places the
                      * stop between that sequence and the next one.
                      */}
                    <select
                      id="afterSequence"
                      value={afterSequence}
                      onChange={(e) => setAfterSequence(e.target.value)}
                      style={control}
                    >
                      <option value="">the end of the walk</option>
                      {stops.map((stop, index) => (
                        <option key={stop.id} value={String(stop.sequence)}>
                          {index + 1}. {addressOf(stop.premise)}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
                <table style={table}>
                  <tbody>
                    {tray.map((premise) => (
                      <tr key={premise.id} style={{ borderTop: "1px solid var(--border-subtle)" }}>
                        <td style={td}>{addressOf(premise)}</td>
                        <td style={{ ...td, fontSize: 12, color: "var(--text-muted)" }}>
                          {premise.premiseType}
                        </td>
                        <td style={{ ...td, textAlign: "right" }}>
                          <button
                            onClick={() => void addStop(premise.id)}
                            disabled={busy}
                            style={ghostButton}
                          >
                            Add
                          </button>
                        </td>
                      </tr>
                    ))}
                    {tray.length === 0 && (
                      <tr>
                        <td colSpan={3} style={emptyCell}>
                          {/*
                            * `trayNeedle`, not `traySearch`: this says
                            * something about the answer on screen, and
                            * the answer is to what was asked, not to
                            * what is half-typed in the box.
                            */}
                          {trayNeedle
                            ? "No unrouted address matches that."
                            : "Every active address is on a route."}
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </section>
          )}
        </>
      )}
    </div>
  );
}

function Stat({ label: text, value, loud }: { label: string; value: string; loud?: boolean }) {
  return (
    <div
      style={{
        background: "var(--bg-card)",
        border: `1px solid ${loud ? "var(--warning)" : "var(--border)"}`,
        borderRadius: "var(--radius)",
        padding: "12px 18px",
        minWidth: 140,
      }}
    >
      <div
        style={{
          fontSize: 10,
          textTransform: "uppercase",
          letterSpacing: "0.06em",
          color: "var(--text-muted)",
          marginBottom: 6,
        }}
      >
        {text}
      </div>
      <div
        style={{
          fontSize: 20,
          fontWeight: 700,
          color: loud ? "var(--warning)" : "var(--text-primary)",
          fontFamily: "'JetBrains Mono', monospace",
        }}
      >
        {value}
      </div>
    </div>
  );
}

const mono = { fontFamily: "'JetBrains Mono', monospace", fontSize: 12 };
const card = {
  background: "var(--bg-card)",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius)",
  overflow: "hidden" as const,
};
const table = { width: "100%", borderCollapse: "collapse" as const, fontSize: 13 };
const th = {
  padding: "10px 14px",
  textAlign: "left" as const,
  fontSize: 10,
  fontWeight: 600 as const,
  textTransform: "uppercase" as const,
  letterSpacing: "0.06em",
  color: "var(--text-muted)",
};
const td = { padding: "10px 14px", color: "var(--text-primary)", verticalAlign: "middle" as const };
const emptyCell = {
  padding: "22px 18px",
  color: "var(--text-muted)",
  textAlign: "center" as const,
  fontSize: 13,
};
const heading = {
  fontSize: 12,
  fontWeight: 600 as const,
  textTransform: "uppercase" as const,
  letterSpacing: "0.06em",
  color: "var(--text-muted)",
  marginBottom: 8,
};
const label = {
  fontSize: 11,
  color: "var(--text-muted)",
  display: "block" as const,
  marginBottom: 4,
};
const control = {
  padding: "6px 10px",
  fontSize: 13,
  background: "var(--bg-deep)",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius)",
  color: "var(--text-primary)",
  fontFamily: "inherit",
  outline: "none",
};
const ghostButton = {
  padding: "4px 10px",
  fontSize: 11,
  fontWeight: 600 as const,
  background: "transparent",
  color: "var(--text-secondary)",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius)",
  cursor: "pointer",
  fontFamily: "inherit",
};
const primaryLink = {
  display: "inline-flex" as const,
  alignItems: "center" as const,
  padding: "8px 16px",
  borderRadius: "var(--radius)",
  background: "var(--accent-primary)",
  color: "#fff",
  fontSize: 13,
  fontWeight: 500 as const,
  textDecoration: "none" as const,
  whiteSpace: "nowrap" as const,
};
