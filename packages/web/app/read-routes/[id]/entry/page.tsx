"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useParams, useSearchParams } from "next/navigation";
import {
  SKIP_REASONS,
  SKIP_REASON_LABELS,
  type EntryOpenResponse,
  type EntryRowWire,
  type EntrySubmitResultWire,
  type ReadRouteSummary,
  type SkipReason,
} from "@utility-cis/shared";
import { PageHeader } from "@/components/ui/page-header";
import { AccessDenied } from "@/components/ui/access-denied";
import { apiClient } from "@/lib/api-client";
import { usePermission } from "@/lib/use-permission";

/**
 * /read-routes/:id/entry — typing the sheet in (spec 30, §5.7).
 *
 * **The screen is the sheet.** Rows in walking order, one number per
 * line, the last reading and the date of it beside each — because what
 * the typist is doing is comparing, not transcribing, and a column of
 * bare inputs makes them hold the previous number in their head.
 *
 * **Nothing posts until the route is submitted.** Each line is staged
 * server-side the moment it is left (`PATCH …/rows` writes one
 * `import_row`), so closing the tab at stop 40 does not lose 39
 * numbers; and no `meter_read` exists until Post, because a half-typed
 * sheet is not a reading event and a billing run that caught one
 * mid-entry would bill half a route.
 *
 * **A line is not a stop.** A meter with two registers is two lines at
 * one address, and two meters at one address are two more. So nothing
 * in a row is unique text, and each row carries
 * `data-testid="entry-row-<rowIndex>"` — the 1-based index `openEntry`
 * gave it. That attribute is a contract with the Playwright spec; the
 * column order and the labels are not.
 *
 * **The keyboard is the whole interface.** `Enter` stages the line and
 * moves down. A reader calling forty numbers down the phone to a clerk
 * cannot wait for anybody to find a button, and the reason a clerk uses
 * paper instead of a screen is almost always that the screen made them
 * reach for the mouse.
 *
 * **Holding a wild number is provisional, and is a question.** The band
 * is the meter's own recent consumption, computed in the entry service
 * (`services/read-route/reading-band.ts`); `ExceptionThreshold`
 * (Req 93) is unbuilt, so without it a 3× read posts in silence. When
 * Req 93 lands the band comes from there and that file is deleted — this
 * screen keeps working, because all it does is compare a typed number
 * against bounds the server sent. A held row is never a refusal: a
 * filled pool and a burst pipe both produce a true number far outside
 * what the meter has done before, so a confirmed one goes through.
 */

// The operator's own calendar day, not UTC's: `toISOString()` is tomorrow
// for anyone west of Greenwich in the evening, which opened tomorrow's
// batch and dated its reads tomorrow. en-CA formats as YYYY-MM-DD.
const todayIso = () => new Date().toLocaleDateString("en-CA");

/** The key a row is held and errored under. Row ids are stable per batch. */
type ByRow<T> = Record<string, T>;

interface Held {
  /** The number awaiting confirmation. A different one is held afresh. */
  reading: number;
  why: "outside-band" | "below-last";
}

const num = (s: string | null) => (s === null || s === "" ? null : Number(s));
const fmt = (n: number) => n.toLocaleString(undefined, { maximumFractionDigits: 4 });

/** The same map without one row's entry. */
function without<T>(map: ByRow<T>, key: string): ByRow<T> {
  const next = { ...map };
  delete next[key];
  return next;
}

export default function ReadRouteEntryPage() {
  const params = useParams();
  const search = useSearchParams();
  const id = String(params.id);
  const { canView, canCreate } = usePermission("meter_reads");

  /*
   * The day in the URL, so a sheet typed for yesterday is a link
   * somebody can send. Defaults to today — a reader's walk is today's.
   */
  const readDate = search.get("date") || todayIso();

  const [route, setRoute] = useState<ReadRouteSummary | null>(null);
  const [batchId, setBatchId] = useState<string | null>(null);
  const [rows, setRows] = useState<EntryRowWire[]>([]);
  const [typed, setTyped] = useState<ByRow<string>>({});
  const [held, setHeld] = useState<ByRow<Held>>({});
  const [rowError, setRowError] = useState<ByRow<string>>({});
  const [nothingToRead, setNothingToRead] = useState<{ sequence: number; address: string }[]>([]);
  const [result, setResult] = useState<EntrySubmitResultWire | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  /*
   * A failed Post or Correct, which is **not** a failed load: the sheet
   * is on screen and has to stay there. `loadError` replaces the whole
   * page, and used for these it told an operator the post had failed
   * directly after it succeeded — the post and the read-back of each
   * row's outcome are two requests, and only the second one had.
   */
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const inputs = useRef<(HTMLInputElement | null)[]>([]);

  useEffect(() => {
    apiClient
      .get<ReadRouteSummary>(`/api/v1/read-routes/${id}`)
      .then(setRoute)
      .catch((err) =>
        setLoadError(err instanceof Error ? err.message : "Could not load this route"),
      );
  }, [id]);

  const isLocal = route?.origin === "LOCAL";

  /** The staged rows, as they stand. Opening is idempotent per (route, day). */
  const takeRows = useCallback((opened: EntryOpenResponse) => {
    setBatchId(opened.batchId);
    setRows(opened.rows);
    setTyped(Object.fromEntries(opened.rows.map((r) => [r.rowId, r.reading ?? ""])));
    setHeld({});
    setRowError({});
  }, []);

  useEffect(() => {
    // Guarded on the origin rather than merely hidden: `openEntry`
    // refuses an EXTERNAL route (400 ROUTE_IS_EXTERNAL), and asking
    // anyway would show a server error for a route behaving as designed.
    if (!isLocal || !canCreate) return;
    apiClient
      .post<EntryOpenResponse>(`/api/v1/read-routes/${id}/entry`, { readDate })
      .then(takeRows)
      .catch((err) =>
        setLoadError(err instanceof Error ? err.message : "Could not open entry for this route"),
      );
  }, [id, readDate, isLocal, canCreate, takeRows]);

  /*
   * The stops that produce no line, from the sheet's own answer. A sheet
   * with eight lines for nine stops is the silent failure §5.1 forbids,
   * and the typist is who notices the count is wrong — so this screen is
   * where it has to be said, not only on the paper.
   */
  useEffect(() => {
    if (!isLocal) return;
    apiClient
      .get<{ stopsWithNothingToRead: { sequence: number; address: string }[] }>(
        `/api/v1/read-routes/${id}/sheet`,
        { onDate: readDate, format: "json" },
      )
      .then((sheet) => setNothingToRead(sheet.stopsWithNothingToRead ?? []))
      .catch(() => setNothingToRead([]));
  }, [id, readDate, isLocal]);

  const focusRow = (index: number) => {
    // Clamped, not wrapped: Enter on the last row of a sheet means
    // "done", and jumping to the top would overwrite row one next.
    const target = inputs.current[Math.min(index, rows.length - 1)];
    target?.focus();
  };

  const save = useCallback(
    async (
      row: EntryRowWire,
      body: { reading?: number; skipReason?: SkipReason; notes?: string },
    ) => {
      if (!batchId) return false;
      setBusy(true);
      try {
        const saved = await apiClient.patch<EntryRowWire>(
          `/api/v1/read-routes/${id}/entry/${batchId}/rows`,
          { meterId: row.meterId, registerId: row.registerId, ...body },
        );
        setRows((prev) => prev.map((r) => (r.rowId === row.rowId ? saved : r)));
        setTyped((prev) => ({ ...prev, [row.rowId]: saved.reading ?? "" }));
        setRowError((prev) => {
          const next = { ...prev };
          delete next[row.rowId];
          return next;
        });
        return true;
      } catch (err) {
        /*
         * In the row, not in a toast. `saveEntryRow` refuses a reading
         * behind a posted bill with 400 READ_BILLED at the keyboard,
         * which is the moment it can still be corrected — and a banner
         * naming no row is useless on a sheet of forty.
         */
        setRowError((prev) => ({
          ...prev,
          [row.rowId]: err instanceof Error ? err.message : "That row was refused",
        }));
        return false;
      } finally {
        setBusy(false);
      }
    },
    [batchId, id],
  );

  /**
   * `Enter` in a reading field: judge it, stage it, move down.
   *
   * `asTyped` is the held row's own button — a target that is not a
   * keystroke, for the one case where the screen asks a question.
   */
  async function commitReading(row: EntryRowWire, index: number, asTyped = false) {
    const raw = (typed[row.rowId] ?? "").trim();
    if (raw === "") {
      /*
       * An empty field on a row that holds a staged number is a
       * **deletion**, and this is the only gesture for it: there is no
       * blur handler on the input, and the alternative — choose a reason,
       * then choose "—" — writes and unwrites a skip to get there. Left
       * unwritten, the number stayed in `raw_data` and Post posted the
       * reading the operator could see they had deleted.
       *
       * A row that is a *code* has an empty field for that reason, and an
       * empty body clears both, so only a staged reading is cleared here.
       */
      if (row.reading !== null) {
        setHeld((prev) => without(prev, row.rowId));
        if (!(await save(row, {}))) return;
      }
      // Nothing staged and nothing typed is not an edit: move on without
      // a write, so tabbing down a sheet does not stage forty empty rows.
      focusRow(index + 1);
      return;
    }
    const reading = Number(raw);
    if (!Number.isFinite(reading) || reading < 0) {
      setRowError((prev) => ({ ...prev, [row.rowId]: "A reading is a number, zero or more" }));
      return;
    }

    const confirmed = held[row.rowId];
    if (!asTyped && (!confirmed || confirmed.reading !== reading)) {
      const last = num(row.lastReading);
      const band = row.band;
      // A dial that has gone backwards. Checked before the band,
      // because a reading below the last one is a different question —
      // a rollover, a replaced meter, or a digit dropped — and the band
      // has nothing useful to say about it.
      if (last !== null && reading < last) {
        setHeld((prev) => ({ ...prev, [row.rowId]: { reading, why: "below-last" } }));
        return;
      }
      if (band && (reading < Number(band.low) || reading > Number(band.high))) {
        setHeld((prev) => ({ ...prev, [row.rowId]: { reading, why: "outside-band" } }));
        return;
      }
    }

    setHeld((prev) => without(prev, row.rowId));
    // `reading` alone: a row is a number or a code, never both, so
    // typing over a coded row clears the code.
    if (await save(row, { reading })) focusRow(index + 1);
  }

  async function chooseReason(row: EntryRowWire, index: number, reason: string) {
    if (reason === "") {
      await save(row, {});
      return;
    }
    if (await save(row, { skipReason: reason as SkipReason })) focusRow(index + 1);
  }

  async function submit() {
    if (!batchId) return;
    setBusy(true);
    setActionError(null);
    let posted: EntrySubmitResultWire;
    try {
      posted = await apiClient.post<EntrySubmitResultWire>(
        `/api/v1/read-routes/${id}/entry/${batchId}/submit`,
        {},
      );
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Could not post this route");
      setBusy(false);
      return;
    }
    setResult(posted);
    /*
     * Re-opened to read back each row's outcome. Submit answers with
     * counts; which row was refused, and why, is on the rows — and
     * `openEntry` is idempotent, so asking for the sheet again is how a
     * posted one is read.
     *
     * Its own try: the readings are posted by now, so a failure here is
     * a failure to *read*, and reporting it as a failed post would be
     * the one answer that is certainly wrong.
     */
    try {
      takeRows(
        await apiClient.post<EntryOpenResponse>(`/api/v1/read-routes/${id}/entry`, { readDate }),
      );
    } catch (err) {
      setActionError(
        `The route posted, but reading each row's outcome back failed${
          err instanceof Error ? ` (${err.message})` : ""
        }. Reload the page to see which rows were refused.`,
      );
    } finally {
      setBusy(false);
    }
  }

  async function correct() {
    setBusy(true);
    setActionError(null);
    try {
      const reopened = await apiClient.post<EntryOpenResponse>(
        `/api/v1/read-routes/${id}/entry/reopen`,
        { readDate },
      );
      takeRows(reopened);
      setResult(null);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Could not reopen this sheet");
    } finally {
      setBusy(false);
    }
  }

  const entered = useMemo(
    () => rows.filter((r) => (r.reading ?? "") !== "" || r.skipReason !== null).length,
    [rows],
  );
  const blank = rows.length - entered;
  const refusedRows = rows.filter((r) => r.status === "ERROR");

  if (!canView) return <AccessDenied />;
  if (loadError) {
    return (
      <div style={{ padding: 24 }}>
        <div role="alert" style={alert}>
          {loadError}
        </div>
        <Link href={`/read-routes/${id}`} style={{ color: "var(--accent-primary)", fontSize: 13 }}>
          Back to the route
        </Link>
      </div>
    );
  }
  if (!route) return <div style={{ padding: 24 }}>Loading…</div>;

  if (!isLocal) {
    return (
      <div>
        <PageHeader title={`${route.code} — ${route.name}`} subtitle="Entry" />
        <div style={card}>
          <div style={{ padding: "18px 20px", fontSize: 13, color: "var(--text-secondary)" }}>
            There is <b style={{ color: "var(--text-primary)" }}>nothing to enter</b> for this
            route. A vendor&apos;s reading system owns it: the readings arrive as an import naming{" "}
            <span style={mono}>{route.code}</span>, and the stops are decided over there.{" "}
            <Link href={`/read-routes/${id}`} style={{ color: "var(--accent-primary)" }}>
              Back to the route
            </Link>
            .
          </div>
        </div>
      </div>
    );
  }

  if (!canCreate) {
    return (
      <div>
        <PageHeader title={`${route.code} — ${route.name}`} subtitle="Entry" />
        <div style={card}>
          <div style={{ padding: "18px 20px", fontSize: 13, color: "var(--text-secondary)" }}>
            Typing a sheet in needs the <b>create</b> permission on meter reads. You can still read
            the route and print its sheet.
          </div>
        </div>
      </div>
    );
  }

  return (
    <div>
      <PageHeader
        title={`${route.code} — ${route.name}`}
        subtitle={`Readings for ${readDate} · cycle ${route.cycleCode}`}
        actions={
          <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
            <span style={{ fontSize: 12, color: "var(--text-muted)" }}>
              {entered} of {rows.length} entered
            </span>
            {!result && rows.length > 0 && (
              <button onClick={() => void submit()} disabled={busy} style={primaryButton}>
                Post the route
              </button>
            )}
            {result && refusedRows.length > 0 && (
              <button onClick={() => void correct()} disabled={busy} style={primaryButton}>
                Correct the refused rows
              </button>
            )}
          </div>
        }
      />

      {actionError && (
        <div
          role="alert"
          style={{ ...alert, display: "flex", alignItems: "center", gap: 12 }}
        >
          <span style={{ flex: 1 }}>{actionError}</span>
          <button onClick={() => setActionError(null)} style={quietButton}>
            Dismiss
          </button>
        </div>
      )}

      {result && (
        <div
          style={{
            ...card,
            marginBottom: 16,
            borderColor: result.errorCount > 0 ? "var(--warning)" : "var(--success)",
          }}
        >
          <div style={{ padding: "14px 18px", fontSize: 13 }}>
            <b>
              {result.importedCount} {result.importedCount === 1 ? "reading" : "readings"} posted
            </b>
            {result.skipsRecorded > 0 && (
              <>
                {" · "}
                {result.skipsRecorded} {result.skipsRecorded === 1 ? "skip" : "skips"} recorded
              </>
            )}
            {result.errorCount > 0 && (
              <span style={{ color: "var(--warning)" }}>
                {" · "}
                {result.errorCount} refused
              </span>
            )}
            {result.notEntered > 0 && (
              <span style={{ color: "var(--text-muted)" }}>
                {" · "}
                {result.notEntered} left out, nothing entered
              </span>
            )}
            {result.alreadySubmitted && (
              <div style={{ marginTop: 6, fontSize: 12, color: "var(--text-muted)" }}>
                This sheet had already been posted; nothing was written again.
              </div>
            )}
          </div>
        </div>
      )}

      {!result && blank > 0 && rows.length > 0 && (
        <div style={{ ...noteBar, marginBottom: 14 }}>
          {blank} {blank === 1 ? "row has" : "rows have"} nothing entered. Posting now leaves{" "}
          {blank === 1 ? "it" : "them"} out — a row with neither a reading nor a reason is not a
          reading event, and not a skip either.
        </div>
      )}

      {nothingToRead.length > 0 && (
        <div style={{ ...noteBar, marginBottom: 14 }}>
          <b>{nothingToRead.length}</b>{" "}
          {nothingToRead.length === 1 ? "stop on this route has" : "stops on this route have"}{" "}
          nothing to read on {readDate}, so {nothingToRead.length === 1 ? "it does" : "they do"} not
          appear below:{" "}
          {nothingToRead.map((s) => s.address).join("; ")}. Either the meter is interval-read, or
          its service closed — worth checking before the walk.
        </div>
      )}

      {/*
        * A grid, not a table.
        *
        * A row has to be able to grow — to carry the reason it is being
        * held, or the refusal the server gave it — and that message
        * belongs **inside** the row it is about: a banner naming no row
        * is useless on a sheet of forty, and a message in a `<tr>` of
        * its own is a different element from the row, which is exactly
        * the distinction that makes it hard to find again. The columns
        * are fixed widths, so the numbers still line up down the page,
        * which is the only thing the table was buying.
        */}
      <div style={card}>
        <div style={{ ...gridRow, background: "var(--bg-elevated)" }}>
          <div style={th}>#</div>
          <div style={th}>Address</div>
          <div style={th}>Meter</div>
          <div style={th}>Last read</div>
          <div style={th}>Reading</div>
          <div style={th}>Why not</div>
        </div>
        {rows.map((row, index) => {
          const hold = held[row.rowId];
          const error = rowError[row.rowId] ?? (row.status === "ERROR" ? row.errorMessage : null);
          const last = num(row.lastReading);
          /*
           * A row that posted is a fact, not a field. A reopened sheet is
           * PENDING as a batch while most of its rows are already
           * written, and `processBatch` reprocesses the PENDING rows and
           * nothing else — so an edit here would be accepted, never
           * posted, and would leave the row disagreeing with the read
           * that exists. The server refuses it (409 `ENTRY_ROW_POSTED`);
           * this is so nobody types into it to find that out.
           */
          const settled = row.status === "IMPORTED" || row.status === "SKIPPED";
          return (
            <div
              key={row.rowId}
              data-testid={`entry-row-${row.rowIndex}`}
              style={{
                borderTop: "1px solid var(--border-subtle)",
                background: hold
                  ? "color-mix(in srgb, var(--warning) 8%, transparent)"
                  : error
                    ? "color-mix(in srgb, var(--danger) 7%, transparent)"
                    : undefined,
              }}
            >
              <div style={gridRow}>
                <div style={{ ...td, ...mono, color: "var(--text-muted)" }}>{row.rowIndex}</div>
                <div style={td}>
                  <div>{row.address}</div>
                  <div style={{ ...mono, fontSize: 11, color: "var(--text-muted)" }}>
                    {row.accountNumber}
                  </div>
                </div>
                <div style={{ ...td, ...mono }}>
                  {row.meterNumber}
                  {row.registerNumber && (
                    <span style={{ color: "var(--text-muted)" }}> reg {row.registerNumber}</span>
                  )}
                </div>
                <div style={td}>
                  {last === null ? (
                    /*
                     * A blank here reads as "not loaded". Never read is a
                     * fact about the meter — a new service — and a
                     * different morning's work from one somebody stopped
                     * reaching.
                     */
                    <span style={{ fontSize: 12, color: "var(--text-muted)" }}>Never read</span>
                  ) : (
                    <>
                      <div style={mono}>{fmt(last)}</div>
                      <div style={{ fontSize: 11, color: "var(--text-muted)" }}>
                        {row.lastReadDate}
                      </div>
                    </>
                  )}
                </div>
                <div style={td}>
                  <input
                    ref={(el) => {
                      inputs.current[index] = el;
                    }}
                    type="number"
                    step="any"
                    min="0"
                    inputMode="decimal"
                    aria-label={`Reading for ${row.meterNumber}${
                      row.registerNumber ? ` register ${row.registerNumber}` : ""
                    }`}
                    value={typed[row.rowId] ?? ""}
                    disabled={settled}
                    onChange={(e) => setTyped((prev) => ({ ...prev, [row.rowId]: e.target.value }))}
                    onKeyDown={(e) => {
                      if (e.key !== "Enter") return;
                      e.preventDefault();
                      /*
                       * Key-repeat is never a confirmation. A held row is
                       * the one case where Enter does **not** advance, so
                       * it is also the one case where a key left down
                       * keeps firing into the same field — and the second
                       * keydown would answer "that looks wrong" with the
                       * wild number, without anybody reading the question.
                       */
                      if (e.repeat) return;
                      void commitReading(row, index);
                    }}
                    style={{
                      ...control,
                      width: "100%",
                      ...mono,
                      fontSize: 14,
                      borderColor: hold ? "var(--warning)" : "var(--border)",
                      opacity: settled ? 0.6 : 1,
                    }}
                  />
                  {settled && (
                    <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 3 }}>
                      {row.status === "IMPORTED" ? "Posted" : "Skip recorded"}
                    </div>
                  )}
                </div>
                <div style={td}>
                  <select
                    aria-label={`Why ${row.meterNumber} was not read`}
                    value={row.skipReason ?? ""}
                    disabled={settled}
                    onChange={(e) => void chooseReason(row, index, e.target.value)}
                    style={{ ...control, width: "100%", opacity: settled ? 0.6 : 1 }}
                  >
                    <option value="">—</option>
                    {SKIP_REASONS.map((reason) => (
                      <option key={reason} value={reason}>
                        {SKIP_REASON_LABELS[reason]}
                      </option>
                    ))}
                  </select>
                  {row.skipReason && (
                    /*
                      * Offered only once a reason is chosen. Forty
                      * always-visible note fields are forty controls
                      * nobody uses, and the reading field has to stay the
                      * only number on the row.
                      */
                    <input
                      placeholder="Note (optional)"
                      defaultValue={row.notes ?? ""}
                      onKeyDown={(e) => {
                        if (e.key !== "Enter") return;
                        e.preventDefault();
                        void save(row, {
                          skipReason: row.skipReason as SkipReason,
                          notes: e.currentTarget.value,
                        });
                      }}
                      onBlur={(e) => {
                        if ((e.target.value ?? "") === (row.notes ?? "")) return;
                        void save(row, {
                          skipReason: row.skipReason as SkipReason,
                          notes: e.target.value,
                        });
                      }}
                      style={{ ...control, width: "100%", marginTop: 4, fontSize: 12 }}
                    />
                  )}
                </div>
              </div>

              {(hold || error) && (
                <div data-testid={`held-row-${row.rowIndex}`} style={heldBar(!!error)}>
                  {hold?.why === "below-last" && last !== null && (
                    <>
                      {fmt(hold.reading)} is <b>below the last reading</b> of {fmt(last)}. A dial
                      does not go backwards on its own — check for a rollover, a replaced meter or
                      a dropped digit. Press <b>Enter</b> again to enter it as typed.
                    </>
                  )}
                  {hold?.why === "outside-band" && row.band && last !== null && (
                    <>
                      <b>That looks wrong.</b> {fmt(hold.reading)} is{" "}
                      <b>{fmt(hold.reading - last)}</b> of use since {row.lastReadDate}. This meter
                      typically uses about <b>{fmt(Number(row.band.typical))}</b>
                      {" — "}its recent reads ran <b>{fmt(Number(row.band.typicalLow))}</b> to{" "}
                      <b>{fmt(Number(row.band.typicalHigh))}</b>. Press <b>Enter</b> again to enter
                      it as typed.
                    </>
                  )}
                  {/*
                    * A target that is not a keystroke, for the one case
                    * where the screen asks a question rather than taking
                    * dictation. `Enter` again still works — the keyboard
                    * is the whole interface for entry — but a confirmation
                    * that shares its gesture with "next row" is worth
                    * offering twice.
                    */}
                  {hold && (
                    <button
                      onClick={() => void commitReading(row, index, true)}
                      disabled={busy}
                      style={quietButton}
                    >
                      Enter it as typed
                    </button>
                  )}
                  {error && <span style={{ color: "var(--danger)" }}>{error}</span>}
                </div>
              )}
            </div>
          );
        })}
        {rows.length === 0 && (
          <div style={emptyCell}>
            This route has no readable meter on {readDate}. Check its stops, and that the meters
            there are manual or drive-by — an interval meter is never on a sheet.
          </div>
        )}
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
/**
 * The sheet's columns. Fixed widths so the readings line up down the
 * page — a column of numbers that wanders is unreadable at speed — with
 * the address taking whatever is left.
 */
const gridRow = {
  display: "grid",
  gridTemplateColumns: "48px minmax(160px, 1fr) 150px 120px 150px 230px",
  alignItems: "center" as const,
  fontSize: 13,
};
const th = {
  padding: "10px 12px",
  textAlign: "left" as const,
  fontSize: 10,
  fontWeight: 600 as const,
  textTransform: "uppercase" as const,
  letterSpacing: "0.06em",
  color: "var(--text-muted)",
};
const td = { padding: "8px 12px", color: "var(--text-primary)", verticalAlign: "middle" as const };
const emptyCell = {
  padding: "22px 18px",
  color: "var(--text-muted)",
  textAlign: "center" as const,
  fontSize: 13,
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
  boxSizing: "border-box" as const,
};
const primaryButton = {
  padding: "8px 16px",
  borderRadius: "var(--radius)",
  background: "var(--accent-primary)",
  color: "#fff",
  fontSize: 13,
  fontWeight: 500 as const,
  border: "none",
  cursor: "pointer",
  fontFamily: "inherit",
  whiteSpace: "nowrap" as const,
};
const quietButton = {
  marginLeft: 8,
  padding: "4px 10px",
  borderRadius: "var(--radius)",
  background: "transparent",
  border: "1px solid var(--border)",
  color: "var(--text-primary)",
  fontSize: 12,
  cursor: "pointer",
  fontFamily: "inherit",
  whiteSpace: "nowrap" as const,
};
const alert = {
  marginBottom: 14,
  padding: "10px 14px",
  borderRadius: "var(--radius)",
  background: "var(--danger-subtle)",
  border: "1px solid var(--danger)",
  color: "var(--danger)",
  fontSize: 13,
};
const noteBar = {
  padding: "10px 14px",
  borderRadius: "var(--radius)",
  background: "color-mix(in srgb, var(--warning) 8%, transparent)",
  border: "1px solid color-mix(in srgb, var(--warning) 30%, transparent)",
  color: "var(--text-secondary)",
  fontSize: 12,
};
const heldBar = (isError: boolean) => ({
  marginTop: 8,
  padding: "10px 14px",
  borderRadius: "var(--radius)",
  background: `color-mix(in srgb, var(--${isError ? "danger" : "warning"}) 8%, transparent)`,
  border: `1px solid color-mix(in srgb, var(--${isError ? "danger" : "warning"}) 30%, transparent)`,
  color: "var(--text-secondary)",
  fontSize: 12,
});
