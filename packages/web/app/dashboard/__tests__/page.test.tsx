import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { apiClient } from "@/lib/api-client";
import * as permModule from "@/lib/use-permission";
import DashboardPage from "../page";

/**
 * The landing screen, and which of its widgets each person gets.
 *
 * What the page itself must never do is depend on a permission: every
 * staff member lands here, so the gate belongs to each widget. The setup
 * check-list needs `settings`, which is what its endpoint requires — and
 * for anyone without it the page has to say so rather than render an
 * empty document that reads as a failed load.
 */

const get = apiClient.get as unknown as ReturnType<typeof vi.fn>;

const CHECKS = [
  {
    key: "commodity",
    label: "At least one commodity",
    ok: false,
    detail: "none defined",
    blocks: "Nothing can be metered, agreed or priced.",
  },
  {
    key: "billingCycle",
    label: "At least one billing cycle",
    ok: true,
    detail: "R01",
    blocks: "No billing run can be started.",
  },
];

beforeEach(() => {
  vi.restoreAllMocks();
  get.mockReset();
});

describe("the dashboard", () => {
  it("shows the setup check-list, open, while something is outstanding", async () => {
    get.mockResolvedValue({ ready: false, checks: CHECKS });

    render(<DashboardPage />);

    expect(await screen.findByText(/not ready to operate/i)).toBeInTheDocument();
    // Open on arrival: here it is a to-do list, not a status.
    expect(await screen.findByText("At least one commodity")).toBeInTheDocument();
    expect(get).toHaveBeenCalledWith("/api/v1/readiness");
  });

  it("links each outstanding item to the screen that fixes it", async () => {
    get.mockResolvedValue({ ready: false, checks: CHECKS });

    render(<DashboardPage />);

    const link = await screen.findByRole("link", { name: /add a commodity/i });
    expect(link).toHaveAttribute("href", "/commodities");
  });

  it("closes the panel once the tenant is ready", async () => {
    get.mockResolvedValue({
      ready: true,
      checks: CHECKS.map((c) => ({ ...c, ok: true })),
    });

    render(<DashboardPage />);

    expect(await screen.findByText(/ready to operate/i)).toBeInTheDocument();
    expect(screen.queryByText("At least one commodity")).not.toBeInTheDocument();
  });

  it("says what it is for, and asks for nothing, when the viewer cannot see settings", async () => {
    vi.spyOn(permModule, "usePermission").mockReturnValue({
      canView: false,
      canCreate: false,
      canEdit: false,
      canDelete: false,
    });

    render(<DashboardPage />);

    expect(screen.getByText(/nothing to show here yet/i)).toBeInTheDocument();
    // The endpoint would refuse them, so it is never asked.
    expect(get).not.toHaveBeenCalled();
  });

  it("admits a failed load rather than claiming there is nothing to show", async () => {
    get.mockRejectedValue(new Error("API error 500"));

    render(<DashboardPage />);

    await waitFor(() =>
      expect(screen.getByText(/could not be loaded/i)).toBeInTheDocument(),
    );
    expect(screen.queryByText(/nothing to show here yet/i)).not.toBeInTheDocument();
  });
});
