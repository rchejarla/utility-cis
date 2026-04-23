"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { PageHeader } from "@/components/ui/page-header";
import { FormField } from "@/components/ui/form-field";
import { AccessDenied } from "@/components/ui/access-denied";
import { SearchableEntitySelect } from "@/components/ui/searchable-entity-select";
import { formInputStyle } from "@/components/ui/entity-form-page";
import { apiClient } from "@/lib/api-client";
import { usePermission } from "@/lib/use-permission";
import { useToast } from "@/components/ui/toast";

/**
 * Record a meter read. Intentionally hand-rolled instead of using the
 * EntityFormPage shell because the premise→meter cascade, async entity
 * picker, automatic service-agreement resolution, and immediate
 * post-selection validation are outside the shell's declarative
 * field-spec contract.
 *
 * UX contract:
 *  1. Premise picker → scopes the meter picker to that premise only
 *  2. Meter picker → on selection, the page fetches meter detail +
 *     last read in parallel and shows a CONTEXT PANEL with meter
 *     number, commodity, UOM (so the operator knows what units to
 *     enter), multiplier, active agreement number, and last read value.
 *  3. If the meter has NO active service-agreement assignment, a red
 *     warning replaces the context panel and disables submit. The
 *     operator learns immediately that this read can't be recorded
 *     instead of finding out after filling the whole form.
 *  4. Reading input label shows the UOM code: "Reading (KWH)".
 *  5. Service agreement is never shown or asked for — the backend
 *     resolves it from meter+date via ServiceAgreementMeter.
 */

interface PremiseRow {
  id: string;
  addressLine1: string;
  city: string;
  state: string;
  zip: string;
}

interface MeterRow {
  id: string;
  meterNumber: string;
  commodity?: { name: string };
  uom?: { code: string; name: string };
}

interface MeterRegister {
  id: string;
  registerNumber: number;
  description: string | null;
  multiplier: string;
  uom?: { code: string; name: string };
}

interface MeterDetail {
  id: string;
  meterNumber: string;
  multiplier: string;
  commodity?: { name: string };
  uom?: { code: string; name: string };
  serviceAgreementMeters?: Array<{
    serviceAgreement: {
      id: string;
      agreementNumber: string;
      status: string;
    };
  }>;
  registers?: MeterRegister[];
}

const SKIP_REASONS = [
  { value: "OUT_OF_SERVICE", label: "Out of service" },
  { value: "INACCESSIBLE", label: "Inaccessible" },
  { value: "DEFECTIVE", label: "Defective" },
];

interface MeterReadRow {
  id: string;
  reading: string;
  readDate: string;
  readType: string;
}

const READ_TYPES = [
  { value: "ACTUAL", label: "Actual" },
  { value: "ESTIMATED", label: "Estimated" },
  { value: "FINAL", label: "Final" },
];

const READ_SOURCES = [
  { value: "MANUAL", label: "Manual entry" },
  { value: "AMR", label: "AMR drive-by" },
  { value: "CUSTOMER_SELF", label: "Customer self-read" },
];

const fmtNumber = (v: string | number | undefined) => {
  if (v === undefined) return "—";
  const n = Number(v);
  return Number.isFinite(n)
    ? n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 4 })
    : "—";
};

export default function NewMeterReadPage() {
  const router = useRouter();
  const { canView, canCreate } = usePermission("meter_reads");
  const { toast } = useToast();

  const today = new Date().toISOString().slice(0, 10);
  const [premiseId, setPremiseId] = useState<string | undefined>(undefined);
  const [meterId, setMeterId] = useState<string | undefined>(undefined);
  const [meterDetail, setMeterDetail] = useState<MeterDetail | null>(null);
  const [lastRead, setLastRead] = useState<MeterReadRow | null>(null);
  const [contextLoading, setContextLoading] = useState(false);
  const [readDate, setReadDate] = useState(today);
  const [reading, setReading] = useState("");
  // Per-register state keyed by registerId. Used only when the meter has
  // 2+ active registers; single-register meters keep the `reading` field.
  const [registerReadings, setRegisterReadings] = useState<
    Record<string, { reading: string; skip: boolean; skipReason: string }>
  >({});
  const [readType, setReadType] = useState("ACTUAL");
  const [readSource, setReadSource] = useState("MANUAL");
  const [notes, setNotes] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Fetch meter detail + last read whenever a meter is picked.
  useEffect(() => {
    if (!meterId) {
      setMeterDetail(null);
      setLastRead(null);
      return;
    }
    let cancelled = false;
    setContextLoading(true);
    Promise.all([
      apiClient.get<MeterDetail>(`/api/v1/meters/${meterId}`),
      apiClient
        .get<{ data: MeterReadRow[] }>(`/api/v1/meters/${meterId}/reads`, {
          limit: "1",
        })
        .catch(() => ({ data: [] })),
    ])
      .then(([detail, readsRes]) => {
        if (cancelled) return;
        setMeterDetail(detail);
        setLastRead(readsRes.data?.[0] ?? null);
        // Seed per-register state (empty) for multi-register meters.
        if (detail.registers && detail.registers.length >= 2) {
          const seed: Record<string, { reading: string; skip: boolean; skipReason: string }> = {};
          for (const r of detail.registers) {
            seed[r.id] = { reading: "", skip: false, skipReason: "OUT_OF_SERVICE" };
          }
          setRegisterReadings(seed);
        } else {
          setRegisterReadings({});
        }
      })
      .catch((err) => {
        if (cancelled) return;
        console.error("Failed to load meter context", err);
        setMeterDetail(null);
        setLastRead(null);
      })
      .finally(() => {
        if (!cancelled) setContextLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [meterId]);

  if (!canView) return <AccessDenied />;

  // Derive whether the selected meter can actually accept a read:
  // it must have at least one active (non-removed) service agreement
  // assignment. Backend makes the same check more precisely against
  // the read date, but we can block the UI early based on "is there
  // ANY active assignment at all."
  const activeAssignment = meterDetail?.serviceAgreementMeters?.find(
    (sam) =>
      sam.serviceAgreement.status === "ACTIVE" ||
      sam.serviceAgreement.status === "PENDING",
  );
  const canRecord = Boolean(meterDetail && activeAssignment);
  const unitLabel = meterDetail?.uom?.code ?? "";
  const isMultiRegister = (meterDetail?.registers?.length ?? 0) >= 2;

  // For multi-register meters, submit is only enabled when every active
  // register is either read (non-empty number) or explicitly skipped.
  const multiRegisterReady = isMultiRegister
    ? (meterDetail?.registers ?? []).every((r) => {
        const entry = registerReadings[r.id];
        if (!entry) return false;
        if (entry.skip) return true;
        const n = parseFloat(entry.reading);
        return Number.isFinite(n) && n >= 0;
      })
    : true;
  const multiRegisterReadyCount = isMultiRegister
    ? (meterDetail?.registers ?? []).filter((r) => {
        const e = registerReadings[r.id];
        return e && (e.skip || parseFloat(e.reading) >= 0);
      }).length
    : 0;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canCreate) {
      toast("No permission to create meter reads", "error");
      return;
    }
    if (!meterId || !canRecord) {
      setError("Select a meter that has an active service agreement");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      let body: Record<string, unknown>;
      if (isMultiRegister) {
        const readings: Array<{ registerId: string; reading: number; exceptionNotes?: string }> = [];
        const skips: Array<{ registerId: string; skipReason: string; notes?: string }> = [];
        for (const r of meterDetail!.registers ?? []) {
          const entry = registerReadings[r.id];
          if (!entry) continue;
          if (entry.skip) {
            skips.push({
              registerId: r.id,
              skipReason: entry.skipReason,
              ...(notes ? { notes } : {}),
            });
          } else {
            readings.push({
              registerId: r.id,
              reading: parseFloat(entry.reading),
            });
          }
        }
        body = {
          meterId,
          readDate,
          readDatetime: new Date(readDate).toISOString(),
          readings,
          skips,
          readType,
          readSource,
        };
      } else {
        body = {
          meterId,
          readDate,
          readDatetime: new Date(readDate).toISOString(),
          reading: parseFloat(reading),
          readType,
          readSource,
        };
        if (notes) body.exceptionNotes = notes;
      }
      // NOTE: serviceAgreementId is intentionally omitted — the API
      // resolves it from meter + date via ServiceAgreementMeter.
      await apiClient.post("/api/v1/meter-reads", body);
      toast("Meter read recorded", "success");
      router.push("/meter-reads");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to record read");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div style={{ maxWidth: "640px" }}>
      <PageHeader
        title="Record Meter Read"
        subtitle="Enter a manual read — service agreement is resolved automatically from the meter assignment"
      />

      <form onSubmit={handleSubmit}>
        <div
          style={{
            background: "var(--bg-card)",
            border: "1px solid var(--border)",
            borderRadius: "var(--radius)",
            padding: "24px",
            display: "flex",
            flexDirection: "column",
            gap: "20px",
          }}
        >
          <FormField
            label="Premise"
            required
            hint="Type an address to search — the meter picker narrows to this premise"
          >
            <SearchableEntitySelect<PremiseRow>
              value={premiseId}
              onChange={(id) => {
                setPremiseId(id);
                // Clearing premise also clears any stale meter selection
                // since the meters shown are premise-scoped.
                setMeterId(undefined);
              }}
              endpoint="/api/v1/premises"
              placeholder="Select a premise..."
              label="Premise"
              mapOption={(p) => ({
                value: String(p.id),
                label: String(p.addressLine1),
                sublabel: `${p.city}, ${p.state} ${p.zip}`,
              })}
            />
          </FormField>

          <FormField
            label="Meter"
            required
            hint={
              premiseId
                ? "Only meters at the selected premise are shown"
                : "Select a premise first"
            }
          >
            <SearchableEntitySelect<MeterRow>
              value={meterId}
              onChange={(id) => setMeterId(id)}
              endpoint="/api/v1/meters"
              placeholder={premiseId ? "Select a meter..." : "Pick a premise first"}
              label="Meter"
              disabled={!premiseId}
              extraParams={
                premiseId ? { premiseId, status: "ACTIVE" } : undefined
              }
              mapOption={(m) => ({
                value: String(m.id),
                label: String(m.meterNumber),
                sublabel: m.commodity?.name
                  ? `${m.commodity.name}${m.uom?.code ? ` · ${m.uom.code}` : ""}`
                  : m.uom?.code,
              })}
            />
          </FormField>

          {/* Context panel — surfaces UOM + last-read info as soon as
              a meter is picked, and blocks submit if the meter has no
              active service agreement. This is the ergonomic core of
              the form: the operator should never have to submit to
              discover the meter they picked can't accept reads. */}
          {meterId && contextLoading && (
            <div
              style={{
                padding: "14px",
                background: "var(--bg-elevated)",
                border: "1px solid var(--border)",
                borderRadius: "var(--radius)",
                fontFamily: "'JetBrains Mono', monospace",
                fontSize: "11px",
                color: "var(--text-muted)",
              }}
            >
              loading meter context...
            </div>
          )}
          {meterId && !contextLoading && meterDetail && canRecord && (
            <div
              style={{
                padding: "16px",
                background: "var(--bg-elevated)",
                border: "1px solid var(--border)",
                borderLeft: "3px solid var(--success)",
                borderRadius: "var(--radius)",
                display: "grid",
                gridTemplateColumns: "1fr 1fr",
                gap: "12px 24px",
                fontSize: "12px",
              }}
            >
              <div>
                <div
                  style={{
                    fontFamily: "'JetBrains Mono', monospace",
                    fontSize: "10px",
                    fontWeight: 700,
                    letterSpacing: "0.08em",
                    color: "var(--text-muted)",
                    marginBottom: "4px",
                  }}
                >
                  METER
                </div>
                <div
                  style={{
                    fontFamily: "'JetBrains Mono', monospace",
                    fontWeight: 600,
                    color: "var(--text-primary)",
                  }}
                >
                  {meterDetail.meterNumber}
                </div>
              </div>
              <div>
                <div
                  style={{
                    fontFamily: "'JetBrains Mono', monospace",
                    fontSize: "10px",
                    fontWeight: 700,
                    letterSpacing: "0.08em",
                    color: "var(--text-muted)",
                    marginBottom: "4px",
                  }}
                >
                  COMMODITY / UNIT
                </div>
                <div style={{ color: "var(--text-primary)" }}>
                  {meterDetail.commodity?.name ?? "—"}
                  {meterDetail.uom && (
                    <span style={{ color: "var(--text-muted)", marginLeft: 6 }}>
                      · {meterDetail.uom.name} ({meterDetail.uom.code})
                    </span>
                  )}
                </div>
              </div>
              <div>
                <div
                  style={{
                    fontFamily: "'JetBrains Mono', monospace",
                    fontSize: "10px",
                    fontWeight: 700,
                    letterSpacing: "0.08em",
                    color: "var(--text-muted)",
                    marginBottom: "4px",
                  }}
                >
                  AGREEMENT
                </div>
                <div
                  style={{
                    fontFamily: "'JetBrains Mono', monospace",
                    color: "var(--text-primary)",
                  }}
                >
                  {activeAssignment?.serviceAgreement.agreementNumber ?? "—"}
                  <span
                    style={{
                      color: "var(--success)",
                      marginLeft: 6,
                      fontSize: "10px",
                      fontWeight: 700,
                    }}
                  >
                    ✓ {activeAssignment?.serviceAgreement.status}
                  </span>
                </div>
              </div>
              <div>
                <div
                  style={{
                    fontFamily: "'JetBrains Mono', monospace",
                    fontSize: "10px",
                    fontWeight: 700,
                    letterSpacing: "0.08em",
                    color: "var(--text-muted)",
                    marginBottom: "4px",
                  }}
                >
                  LAST READ
                </div>
                <div
                  style={{
                    fontFamily: "'JetBrains Mono', monospace",
                    color: "var(--text-primary)",
                    fontVariantNumeric: "tabular-nums",
                  }}
                >
                  {lastRead ? (
                    <>
                      {fmtNumber(lastRead.reading)}
                      <span style={{ color: "var(--text-muted)", marginLeft: 6 }}>
                        on {lastRead.readDate.slice(0, 10)}
                      </span>
                    </>
                  ) : (
                    <span style={{ color: "var(--text-muted)" }}>no prior reads</span>
                  )}
                </div>
              </div>
              {Number(meterDetail.multiplier) !== 1 && (
                <div style={{ gridColumn: "1 / -1" }}>
                  <div
                    style={{
                      fontSize: "11px",
                      color: "var(--text-muted)",
                      fontFamily: "'JetBrains Mono', monospace",
                    }}
                  >
                    multiplier: {meterDetail.multiplier} — consumption will be
                    (new − prior) × {meterDetail.multiplier}
                  </div>
                </div>
              )}
            </div>
          )}
          {meterId && !contextLoading && meterDetail && !canRecord && (
            <div
              role="alert"
              style={{
                padding: "16px",
                background: "var(--danger-subtle)",
                border: "1px solid var(--danger)",
                borderRadius: "var(--radius)",
                color: "var(--danger)",
              }}
            >
              <div
                style={{
                  fontFamily: "'JetBrains Mono', monospace",
                  fontSize: "11px",
                  fontWeight: 700,
                  letterSpacing: "0.08em",
                  marginBottom: "6px",
                }}
              >
                ⚠ METER NOT ASSIGNED
              </div>
              <div style={{ fontSize: "13px", lineHeight: 1.5 }}>
                Meter <strong>{meterDetail.meterNumber}</strong> has no active
                service agreement. A read cannot be recorded until the meter is
                assigned to an agreement. Assign it from the meter detail page
                (Agreements tab) or create the agreement first, then come back
                to record this read.
              </div>
            </div>
          )}

          <div style={{ display: "grid", gridTemplateColumns: isMultiRegister ? "1fr" : "1fr 1fr", gap: "12px" }}>
            <FormField label="Read Date" required>
              <input
                type="date"
                value={readDate}
                onChange={(e) => setReadDate(e.target.value)}
                style={formInputStyle}
                required
              />
            </FormField>
            {!isMultiRegister && (
              <FormField
                label={unitLabel ? `Reading (${unitLabel})` : "Reading"}
                required
                hint={
                  lastRead
                    ? `Prior: ${fmtNumber(lastRead.reading)}${unitLabel ? ` ${unitLabel}` : ""}`
                    : undefined
                }
              >
                <input
                  type="number"
                  step="any"
                  min="0"
                  value={reading}
                  onChange={(e) => setReading(e.target.value)}
                  placeholder="12345.67"
                  style={{
                    ...formInputStyle,
                    fontFamily: "'JetBrains Mono', monospace",
                    fontVariantNumeric: "tabular-nums",
                  }}
                  required
                  disabled={!canRecord}
                />
              </FormField>
            )}
          </div>

          {/* Multi-register read table. Appears only when the meter has
              2+ active registers. Each row takes an independent reading
              (in that register's UoM) or an explicit skip with reason.
              Submit is disabled until every register is covered. */}
          {isMultiRegister && canRecord && meterDetail?.registers && (
            <div
              style={{
                border: "1px solid var(--border)",
                borderRadius: "var(--radius)",
                overflow: "hidden",
              }}
            >
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "60px 1fr 80px 1fr 160px",
                  gap: "8px",
                  padding: "8px 12px",
                  background: "var(--bg-elevated)",
                  borderBottom: "1px solid var(--border)",
                  fontFamily: "'JetBrains Mono', monospace",
                  fontSize: "10px",
                  fontWeight: 700,
                  letterSpacing: "0.08em",
                  color: "var(--text-muted)",
                  textTransform: "uppercase",
                }}
              >
                <div>#</div>
                <div>Description</div>
                <div>UoM</div>
                <div>Reading</div>
                <div>Skip</div>
              </div>
              {meterDetail.registers.map((r) => {
                const entry = registerReadings[r.id] ?? { reading: "", skip: false, skipReason: "OUT_OF_SERVICE" };
                return (
                  <div
                    key={r.id}
                    style={{
                      display: "grid",
                      gridTemplateColumns: "60px 1fr 80px 1fr 160px",
                      gap: "8px",
                      padding: "10px 12px",
                      alignItems: "center",
                      borderBottom: "1px solid var(--border-subtle)",
                      fontSize: "13px",
                    }}
                  >
                    <div style={{ fontFamily: "'JetBrains Mono', monospace", fontWeight: 600 }}>
                      R{r.registerNumber}
                    </div>
                    <div style={{ color: "var(--text-primary)" }}>
                      {r.description ?? <span style={{ color: "var(--text-muted)" }}>—</span>}
                    </div>
                    <div style={{ fontFamily: "'JetBrains Mono', monospace", color: "var(--text-muted)" }}>
                      {r.uom?.code ?? "—"}
                    </div>
                    <input
                      type="number"
                      step="any"
                      min="0"
                      value={entry.reading}
                      onChange={(e) =>
                        setRegisterReadings((prev) => ({
                          ...prev,
                          [r.id]: { ...entry, reading: e.target.value, skip: false },
                        }))
                      }
                      placeholder={entry.skip ? "(skipped)" : "12345.67"}
                      disabled={entry.skip}
                      style={{
                        ...formInputStyle,
                        padding: "6px 10px",
                        fontFamily: "'JetBrains Mono', monospace",
                        fontVariantNumeric: "tabular-nums",
                        opacity: entry.skip ? 0.5 : 1,
                      }}
                    />
                    <div style={{ display: "flex", gap: "6px", alignItems: "center" }}>
                      <label
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: "4px",
                          fontSize: "12px",
                          color: "var(--text-secondary)",
                          cursor: "pointer",
                          userSelect: "none",
                        }}
                      >
                        <input
                          type="checkbox"
                          checked={entry.skip}
                          onChange={(e) =>
                            setRegisterReadings((prev) => ({
                              ...prev,
                              [r.id]: {
                                ...entry,
                                skip: e.target.checked,
                                reading: e.target.checked ? "" : entry.reading,
                              },
                            }))
                          }
                        />
                        skip
                      </label>
                      {entry.skip && (
                        <select
                          value={entry.skipReason}
                          onChange={(e) =>
                            setRegisterReadings((prev) => ({
                              ...prev,
                              [r.id]: { ...entry, skipReason: e.target.value },
                            }))
                          }
                          style={{ ...formInputStyle, padding: "4px 8px", fontSize: "12px", flex: 1 }}
                        >
                          {SKIP_REASONS.map((s) => (
                            <option key={s.value} value={s.value}>
                              {s.label}
                            </option>
                          ))}
                        </select>
                      )}
                    </div>
                  </div>
                );
              })}
              <div
                style={{
                  padding: "8px 12px",
                  background: "var(--bg-elevated)",
                  borderTop: "1px solid var(--border)",
                  display: "flex",
                  justifyContent: "space-between",
                  fontFamily: "'JetBrains Mono', monospace",
                  fontSize: "11px",
                  color: multiRegisterReady ? "var(--success)" : "var(--text-muted)",
                }}
              >
                <span>
                  {multiRegisterReadyCount} of {meterDetail.registers.length} registers ready
                </span>
                <span>
                  {multiRegisterReady ? "✓ ready to submit" : "every register must be read or skipped"}
                </span>
              </div>
            </div>
          )}

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "12px" }}>
            <FormField label="Read Type" required>
              <select
                value={readType}
                onChange={(e) => setReadType(e.target.value)}
                style={formInputStyle}
                disabled={!canRecord}
              >
                {READ_TYPES.map((t) => (
                  <option key={t.value} value={t.value}>
                    {t.label}
                  </option>
                ))}
              </select>
            </FormField>
            <FormField label="Source" required>
              <select
                value={readSource}
                onChange={(e) => setReadSource(e.target.value)}
                style={formInputStyle}
                disabled={!canRecord}
              >
                {READ_SOURCES.map((s) => (
                  <option key={s.value} value={s.value}>
                    {s.label}
                  </option>
                ))}
              </select>
            </FormField>
          </div>

          <FormField label="Notes">
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={3}
              placeholder="Optional notes from the field reader..."
              style={{ ...formInputStyle, minHeight: "72px", resize: "vertical" }}
              disabled={!canRecord}
            />
          </FormField>

          {error && (
            <div
              role="alert"
              style={{
                padding: "10px 14px",
                borderRadius: "var(--radius)",
                background: "var(--danger-subtle)",
                border: "1px solid var(--danger)",
                color: "var(--danger)",
                fontSize: "13px",
              }}
            >
              {error}
            </div>
          )}

          <div style={{ display: "flex", gap: "10px", justifyContent: "flex-end" }}>
            <button
              type="button"
              onClick={() => router.push("/meter-reads")}
              style={{
                padding: "8px 20px",
                borderRadius: "var(--radius)",
                border: "1px solid var(--border)",
                background: "transparent",
                color: "var(--text-secondary)",
                fontSize: "13px",
                cursor: "pointer",
                fontFamily: "inherit",
              }}
            >
              Cancel
            </button>
            {(() => {
              const blocked = submitting || !canRecord || (isMultiRegister ? !multiRegisterReady : !reading);
              return (
                <button
                  type="submit"
                  disabled={blocked}
                  style={{
                    padding: "8px 20px",
                    borderRadius: "var(--radius)",
                    border: "none",
                    background: "var(--accent-primary)",
                    color: "#fff",
                    fontSize: "13px",
                    fontWeight: 500,
                    cursor: submitting ? "not-allowed" : "pointer",
                    opacity: blocked ? 0.5 : 1,
                    fontFamily: "inherit",
                  }}
                >
                  {submitting ? "Recording..." : "Record Read"}
                </button>
              );
            })()}
          </div>
        </div>
      </form>
    </div>
  );
}
