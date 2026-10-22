import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ToastProvider } from "@/components/ui/toast";
import { apiClient } from "@/lib/api-client";
import { AssignRateScheduleDialog } from "../assign-rate-schedule-dialog";

/**
 * Assigning a rate schedule to a service agreement.
 *
 * Until 2026-10-22 there was no way to do this outside the API, so an
 * agreement created in the UI could never be billed: the Overview
 * panel was read-only and /rate-schedules/:id → Agreements was a
 * placeholder.
 *
 * The server validates only that both rows belong to the tenant — not
 * that the schedule's commodity matches the agreement's, not that the
 * schedule is published, and not that windows for one role don't
 * overlap. The first two are what this dialog carries, because both
 * mistakes are silent until a billing run fails hours later.
 */

const get = apiClient.get as unknown as ReturnType<typeof vi.fn>;
const post = apiClient.post as unknown as ReturnType<typeof vi.fn>;

function schedule(over: Record<string, unknown> = {}) {
  return {
    id: "rs-1",
    name: "Bozeman Water 2025-09",
    code: "BZN-WATER",
    version: 1,
    commodityId: "com-water",
    publishedAt: "2026-01-01T00:00:00.000Z",
    supersededById: null,
    ...over,
  };
}

function assignment(over: Record<string, unknown> = {}) {
  return {
    id: "asg-1",
    rateScheduleId: "rs-1",
    roleCode: "primary",
    effectiveDate: "2025-01-01T00:00:00.000Z",
    expirationDate: null,
    ...over,
  };
}

function renderDialog(schedules: unknown[], props: Record<string, unknown> = {}) {
  get.mockImplementation((url: string) => {
    if (url.startsWith("/api/v1/rate-schedules")) {
      return Promise.resolve({ data: schedules, meta: { total: schedules.length } });
    }
    return Promise.reject(new Error(`unexpected GET ${url}`));
  });
  return render(
    <ToastProvider>
      <AssignRateScheduleDialog
        saId="sa-1"
        commodityId="com-water"
        commodityName="Potable Water"
        defaultEffectiveDate="2025-01-01"
        existing={(props.existing as ReturnType<typeof assignment>[]) ?? []}
        onAssigned={props.onAssigned as () => void ?? vi.fn()}
        onClose={props.onClose as () => void ?? vi.fn()}
      />
    </ToastProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  post.mockResolvedValue({ id: "asg-1" });
});

describe("Assign rate schedule", () => {
  it("asks only for schedules on the agreement's commodity", async () => {
    renderDialog([schedule()]);

    // The server would happily assign an electric tariff to a water
    // agreement, and the bill would then price against the wrong
    // tariff rather than fail. Narrowing the picker is the guard.
    await waitFor(() => expect(get).toHaveBeenCalled());
    const url = String(get.mock.calls[0][0]);
    expect(url).toContain("commodityId=com-water");
  });

  it("marks a draft schedule and says bills will refuse it", async () => {
    renderDialog([schedule({ publishedAt: null })]);

    // Assigning a draft is legal and sometimes intended — assign now,
    // publish later — so it is offered rather than hidden. What must
    // not happen is assigning one without knowing: the failure
    // otherwise surfaces as SCHEDULE_NOT_PUBLISHED in a billing run
    // long afterwards.
    expect(await screen.findByText(/draft/i)).toBeInTheDocument();
    expect(screen.getByText(/until (it is |they are )?published/i)).toBeInTheDocument();
  });

  it("does not warn when every offered schedule is published", async () => {
    renderDialog([schedule()]);

    await waitFor(() => expect(get).toHaveBeenCalled());
    expect(screen.queryByText(/until (it is |they are )?published/i)).toBeNull();
  });

  it("assigns the chosen schedule with a role and an effective date", async () => {
    const onAssigned = vi.fn();
    renderDialog([schedule()], { onAssigned });

    await waitFor(() => expect(get).toHaveBeenCalled());
    await userEvent.click(screen.getByRole("combobox", { name: /schedule/i }));
    await userEvent.click(await screen.findByRole("option", { name: /BZN-WATER/i }));
    await userEvent.click(screen.getByRole("button", { name: /assign/i }));

    await waitFor(() => expect(post).toHaveBeenCalled());
    expect(post).toHaveBeenCalledWith("/api/v1/sa-rate-schedule-assignments", {
      serviceAgreementId: "sa-1",
      rateScheduleId: "rs-1",
      roleCode: "primary",
      effectiveDate: "2025-01-01",
    });
    await waitFor(() => expect(onAssigned).toHaveBeenCalled());
  });

  it("cannot be submitted without choosing a schedule", async () => {
    renderDialog([schedule()]);

    await waitFor(() => expect(get).toHaveBeenCalled());
    await userEvent.click(screen.getByRole("button", { name: /assign/i }));

    expect(post).not.toHaveBeenCalled();
  });

  it("says which schedules this agreement already has", async () => {
    // A commodity often has exactly one schedule, so the single option
    // offered is frequently the one already assigned. Offering it
    // unmarked invites a duplicate.
    renderDialog([schedule()], { existing: [assignment()] });

    await waitFor(() => expect(get).toHaveBeenCalled());
    await userEvent.click(screen.getByRole("combobox", { name: /schedule/i }));
    expect(await screen.findByRole("option", { name: /already assigned/i })).toBeInTheDocument();
  });

  it("warns before adding a second open window for the same role", async () => {
    // Nothing downstream stops this: overlap exclusion for a role is
    // unimplemented, so two open-ended `primary` assignments would both
    // stand and the rate engine would see two schedules for one role.
    //
    // Keyed on the ROLE, not the schedule — two *different* schedules
    // both holding `primary` open-ended is the case that breaks rating,
    // and it is the one a schedule-keyed check would miss.
    renderDialog([schedule()], { existing: [assignment()] });

    await waitFor(() => expect(get).toHaveBeenCalled());

    // Asserted on its own element rather than by text: the option label
    // also says "already assigned", so a text match could pass without
    // this warning existing at all.
    const warning = await screen.findByTestId("role-collision");
    expect(warning).toHaveTextContent(/primary/i);
  });

  it("does not warn when the existing assignment holds a different role", async () => {
    // Role defaults to `primary`; the existing one is a rider, so the
    // two do not collide.
    renderDialog([schedule()], { existing: [assignment({ roleCode: "rider" })] });

    await waitFor(() => expect(get).toHaveBeenCalled());
    expect(screen.queryByTestId("role-collision")).toBeNull();
  });

  it("does not warn when the existing window closed before the new one opens", async () => {
    // Superseding a schedule is exactly "end the old one, start the
    // new", so a window that has already closed is history rather than
    // a collision. The default effective date here is 2025-01-01 and
    // this one ends the day before it.
    renderDialog([schedule()], {
      existing: [
        assignment({
          effectiveDate: "2024-01-01T00:00:00.000Z",
          expirationDate: "2024-12-31T00:00:00.000Z",
        }),
      ],
    });

    await waitFor(() => expect(get).toHaveBeenCalled());
    expect(screen.queryByTestId("role-collision")).toBeNull();
  });

  it("warns when the existing window is still open on the new start date", async () => {
    // Ends 2025-06-30, new one starts 2025-01-01 — six months of
    // overlap in one role, which is the case that breaks rating.
    renderDialog([schedule()], {
      existing: [assignment({ expirationDate: "2025-06-30T00:00:00.000Z" })],
    });

    await waitFor(() => expect(get).toHaveBeenCalled());
    expect(await screen.findByTestId("role-collision")).toHaveTextContent("2025-06-30");
  });

  it("says there is nothing to assign when the commodity has no schedules", async () => {
    renderDialog([]);

    // Distinguishable from "pick one": a tenant whose tariffs were never
    // created needs to be sent to the rate schedules screen, not left
    // staring at an empty list.
    expect(
      await screen.findByText(/no rate schedules .*Potable Water/i),
    ).toBeInTheDocument();
  });
});
