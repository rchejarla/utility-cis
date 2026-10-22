"use client";

import { useEffect, useMemo, useState } from "react";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { apiClient } from "@/lib/api-client";
import { useToast } from "@/components/ui/toast";
import { RATE_ASSIGNMENT_ROLE_CODES } from "@utility-cis/shared";

/**
 * Give a service agreement a rate schedule.
 *
 * Until 2026-10-22 this had no UI at all: the agreement's Rate
 * Schedules panel was read-only and `/rate-schedules/:id` → Agreements
 * was a placeholder, so an agreement created in the app could never be
 * billed without a call to the API by hand.
 *
 * `createSAScheduleAssignment` checks only that the agreement and the
 * schedule belong to the caller's tenant. It does not check that their
 * commodities match, that the schedule is published, or that two
 * windows for one role overlap. The first two are carried here because
 * both mistakes are silent at the point of making them and surface
 * much later, in a billing run, as a priced-wrong bill or
 * `SCHEDULE_NOT_PUBLISHED`. The third is genuinely unimplemented
 * (schema note: "Overlap exclusion is deferred to slice 2/3") and this
 * dialog does not pretend otherwise.
 */

interface RateScheduleOption {
  id: string;
  name: string;
  code: string;
  version: number;
  publishedAt: string | null;
  supersededById: string | null;
}

interface AssignRateScheduleDialogProps {
  saId: string;
  /** The agreement's commodity — the picker is narrowed to it. */
  commodityId: string;
  commodityName?: string;
  /** The agreement's start date: the sensible default for a first assignment. */
  defaultEffectiveDate: string;
  onAssigned: () => void;
  onClose: () => void;
}

export function AssignRateScheduleDialog({
  saId,
  commodityId,
  commodityName,
  defaultEffectiveDate,
  onAssigned,
  onClose,
}: AssignRateScheduleDialogProps) {
  const { toast } = useToast();
  const [schedules, setSchedules] = useState<RateScheduleOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [scheduleId, setScheduleId] = useState<string | undefined>();
  const [roleCode, setRoleCode] = useState<string>("primary");
  const [effectiveDate, setEffectiveDate] = useState(defaultEffectiveDate);
  const [expirationDate, setExpirationDate] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    // Narrowed to the commodity, and superseded versions are dropped:
    // a replaced version keeps its publishedAt, so it would otherwise
    // read as a legitimate choice.
    apiClient
      .get<{ data: RateScheduleOption[] }>(
        `/api/v1/rate-schedules?commodityId=${encodeURIComponent(commodityId)}&limit=200`,
      )
      .then((r) => setSchedules((r.data ?? []).filter((s) => !s.supersededById)))
      .catch(() => setSchedules([]))
      .finally(() => setLoading(false));
  }, [commodityId]);

  const options = useMemo(
    () =>
      schedules.map((s) => ({
        value: s.id,
        // The draft marker is in the label because that is the only
        // place a combobox shows while collapsed.
        label: `${s.code} · v${s.version} — ${s.name}${s.publishedAt ? "" : "  [DRAFT]"}`,
      })),
    [schedules],
  );

  const chosen = schedules.find((s) => s.id === scheduleId);
  const anyDraft = schedules.some((s) => !s.publishedAt);

  const submit = async () => {
    if (!scheduleId || !effectiveDate) return;
    setSaving(true);
    try {
      await apiClient.post("/api/v1/sa-rate-schedule-assignments", {
        serviceAgreementId: saId,
        rateScheduleId: scheduleId,
        roleCode,
        effectiveDate,
        ...(expirationDate ? { expirationDate } : {}),
      });
      toast("Rate schedule assigned", "success");
      onAssigned();
    } catch (err) {
      const msg =
        err instanceof Error
          ? err.message.replace(/^API error \d+:\s*/, "")
          : "Could not assign the rate schedule";
      toast(msg, "error");
    } finally {
      setSaving(false);
    }
  };

  const nothingToAssign = !loading && schedules.length === 0;

  return (
    <ConfirmDialog
      title="Assign a rate schedule"
      message={
        nothingToAssign
          ? `There are no rate schedules for ${commodityName ?? "this commodity"}. Create one under Rate Schedules first.`
          : "An agreement can hold several schedules at once — one per role."
      }
      confirmLabel={saving ? "Assigning…" : "Assign"}
      confirmDisabled={saving || nothingToAssign || !scheduleId || !effectiveDate}
      onConfirm={() => void submit()}
      onCancel={onClose}
    >
      {!nothingToAssign && (
        <div style={{ display: "grid", gap: 12 }}>
          <SearchableSelect
            label="Schedule"
            options={options}
            value={scheduleId}
            onChange={setScheduleId}
            placeholder={loading ? "Loading…" : "Choose a rate schedule"}
          />

          {anyDraft && (
            /* Assigning a draft is legal and sometimes intended, so it
               is offered rather than hidden. What must not happen is
               assigning one unknowingly: the consequence appears much
               later as a failed billing run. */
            <p
              style={{
                margin: 0,
                fontSize: 12,
                color: "var(--warning)",
                background: "color-mix(in srgb, var(--warning) 9%, transparent)",
                border: "1px solid color-mix(in srgb, var(--warning) 25%, transparent)",
                borderRadius: "var(--radius)",
                padding: "8px 10px",
              }}
            >
              Schedules marked <b>DRAFT</b> can be assigned, but a bill will refuse to
              price against one until it is published.
            </p>
          )}

          <label style={{ display: "grid", gap: 4, fontSize: 12, color: "var(--text-muted)" }}>
            Role
            <select
              value={roleCode}
              onChange={(e) => setRoleCode(e.target.value)}
              style={{
                padding: "8px 10px",
                borderRadius: "var(--radius)",
                border: "1px solid var(--border)",
                background: "var(--bg-deep)",
                color: "var(--text-primary)",
                fontFamily: "inherit",
                fontSize: 13,
              }}
            >
              {RATE_ASSIGNMENT_ROLE_CODES.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </label>

          <label style={{ display: "grid", gap: 4, fontSize: 12, color: "var(--text-muted)" }}>
            Effective date
            <input
              type="date"
              value={effectiveDate}
              onChange={(e) => setEffectiveDate(e.target.value)}
              style={{
                padding: "8px 10px",
                borderRadius: "var(--radius)",
                border: "1px solid var(--border)",
                background: "var(--bg-deep)",
                color: "var(--text-primary)",
                fontFamily: "inherit",
                fontSize: 13,
              }}
            />
          </label>

          <label style={{ display: "grid", gap: 4, fontSize: 12, color: "var(--text-muted)" }}>
            Ends (optional — leave blank for open-ended)
            <input
              type="date"
              value={expirationDate}
              onChange={(e) => setExpirationDate(e.target.value)}
              style={{
                padding: "8px 10px",
                borderRadius: "var(--radius)",
                border: "1px solid var(--border)",
                background: "var(--bg-deep)",
                color: "var(--text-primary)",
                fontFamily: "inherit",
                fontSize: 13,
              }}
            />
          </label>

          {chosen && !chosen.publishedAt && (
            <p style={{ margin: 0, fontSize: 12, color: "var(--warning)" }}>
              {chosen.code} v{chosen.version} is a draft.
            </p>
          )}
        </div>
      )}
    </ConfirmDialog>
  );
}
