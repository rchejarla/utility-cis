import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ToastProvider } from "@/components/ui/toast";
import { apiClient } from "@/lib/api-client";
import AutomationSettingsPage from "../page";

/**
 * The interval-coverage sweep's own two knobs.
 *
 * They have existed end to end since 6942a90 — a Zod schema with
 * defaults, validation in the patch path, and a `scheduler_config` jsonb
 * column to live in — and **no control anywhere**. The page even sent
 * `settings` along with every scheduler patch; the object was simply
 * always empty, so the only way to change either value was SQL. That is
 * the same orphan-field shape `settings-coverage.test.ts` was written
 * for, one level down from the fields it checks.
 *
 * Both are per tenant because backfill speed is a property of the
 * head-end and the network, not of this software: a tight cellular
 * network wants two days of grace, a flaky mesh wants seven, and one
 * fixed number would cry wolf for the first and be useless for the
 * second.
 */

const get = apiClient.get as unknown as ReturnType<typeof vi.fn>;
const patch = apiClient.patch as unknown as ReturnType<typeof vi.fn>;

function config(sweep: Record<string, unknown> = {}) {
  return {
    timezone: "America/Denver",
    notificationQuietStart: "21:00",
    notificationQuietEnd: "08:00",
    schedulerAuditRetentionDays: 90,
    autoPostBills: false,
    schedulers: [
      {
        key: "intervalCoverage",
        enabled: true,
        runHourLocal: 3,
        lastRunAt: null,
        settings: {},
        ...sweep,
      },
    ],
  };
}

function renderPage() {
  return render(
    <ToastProvider>
      <AutomationSettingsPage />
    </ToastProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("the interval-coverage sweep's settings", () => {
  it("shows the shipped defaults when the tenant has never saved them", async () => {
    get.mockResolvedValue(config());
    renderPage();

    // 48 hours and 7 days, from `intervalCoverageSettingsSchema` —
    // not zeroes, which is what an empty jsonb would render as if the
    // page read the column instead of the schema's defaults.
    expect(await screen.findByLabelText(/grace hours/i)).toHaveValue(48);
    expect(screen.getByLabelText(/lookback days/i)).toHaveValue(7);
  });

  it("shows what a tenant did save", async () => {
    get.mockResolvedValue(config({ settings: { graceHours: 12, lookbackDays: 30 } }));
    renderPage();

    expect(await screen.findByLabelText(/grace hours/i)).toHaveValue(12);
    expect(screen.getByLabelText(/lookback days/i)).toHaveValue(30);
  });

  it("sends both knobs when one of them changes", async () => {
    get.mockResolvedValue(config());
    patch.mockResolvedValue(config({ settings: { graceHours: 72, lookbackDays: 7 } }));
    renderPage();

    const grace = await screen.findByLabelText(/grace hours/i);
    await userEvent.clear(grace);
    await userEvent.type(grace, "72");
    await userEvent.click(screen.getByRole("button", { name: /save changes/i }));

    /*
     * Both, not just the one that moved: `settings` is a jsonb column
     * replaced wholesale and the schema is `.strict()` with defaults, so
     * a patch carrying only `graceHours` would be valid and would reset
     * `lookbackDays` to 7 behind the operator's back.
     */
    await waitFor(() => expect(patch).toHaveBeenCalled());
    const body = patch.mock.calls[0][1] as {
      schedulers: Array<{ key: string; settings: Record<string, number> }>;
    };
    const sweep = body.schedulers.find((s) => s.key === "intervalCoverage");
    expect(sweep?.settings).toEqual({ graceHours: 72, lookbackDays: 7 });
  });

  it("leaves the knobs alone when the sweep is off", async () => {
    get.mockResolvedValue(config({ enabled: false }));
    renderPage();

    // Disabled, like the run hour beside them: a grace period for a job
    // that never runs is a value nothing reads.
    expect(await screen.findByLabelText(/grace hours/i)).toBeDisabled();
    expect(screen.getByLabelText(/lookback days/i)).toBeDisabled();
  });
});
