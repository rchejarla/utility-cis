import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ReadinessPanel } from "../page";

/**
 * The panel that answers what the stats only implied.
 *
 * "32 modules, 6 roles" reads like readiness, and a freshly provisioned
 * tenant showing those numbers cannot bill anything — it has no
 * commodity, no unit of measure, no billing cycle, no published tariff
 * and no issuer identity. So the one thing this panel must never do is
 * look reassuring while checks are outstanding.
 *
 * The API decides what a check is and whether it is met; this renders
 * that answer. What is tested here is the rendering decisions: unmet
 * first and in full, met collapsed, and `blocks` shown — because an
 * operator who cannot see what a missing step prevents has to guess.
 */

const check = (over: Partial<Parameters<typeof ReadinessPanel>[0]["readiness"]["checks"][number]> = {}) => ({
  key: "commodity",
  label: "At least one commodity",
  ok: false,
  detail: "none defined",
  blocks: "Nothing can be metered, agreed or priced.",
  ...over,
});

function panel(checks: ReturnType<typeof check>[]) {
  return { ready: checks.every((c) => c.ok), checks };
}

describe("ReadinessPanel", () => {
  it("says it is not ready, and how many steps are left", () => {
    render(
      <ReadinessPanel
        readiness={panel([check(), check({ key: "billingCycle", ok: true })])}
      />,
    );

    expect(screen.getByText(/not ready to operate/i)).toBeInTheDocument();
    expect(screen.getByText(/1 of 2 outstanding/i)).toBeInTheDocument();
  });

  it("shows what an unmet check prevents, not just that it is unmet", () => {
    // The half an operator cannot infer from the label.
    render(<ReadinessPanel readiness={panel([check()])} />);

    expect(screen.getByText("Nothing can be metered, agreed or priced.")).toBeInTheDocument();
    expect(screen.getByText(/none defined/)).toBeInTheDocument();
  });

  it("hides met checks behind a count until asked", async () => {
    render(
      <ReadinessPanel
        readiness={panel([
          check(),
          check({ key: "issuerIdentity", label: "Issuer identity on its bills", ok: true, detail: "complete" }),
        ])}
      />,
    );

    expect(screen.queryByText("Issuer identity on its bills")).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /show 1 met/i }));

    expect(screen.getByText("Issuer identity on its bills")).toBeInTheDocument();
  });

  it("says it is ready, and lists the checks, when everything is met", () => {
    // No toggle to hide anything behind: a ready tenant's panel is the
    // evidence for the claim.
    render(
      <ReadinessPanel
        readiness={panel([check({ ok: true, detail: "Water" }), check({ key: "x", label: "Units", ok: true })])}
      />,
    );

    expect(screen.getByText(/ready to operate/i)).toBeInTheDocument();
    expect(screen.getByText(/all 2 checks met/i)).toBeInTheDocument();
    expect(screen.getByText("At least one commodity")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /met/i })).not.toBeInTheDocument();
  });

  it("puts every unmet check before any met one", () => {
    // Ordering, not filtering: the API returns them in its own order and
    // the operator reads the outstanding ones first.
    render(
      <ReadinessPanel
        readiness={panel([
          check({ key: "a", label: "Met first", ok: true }),
          check({ key: "b", label: "Unmet second" }),
        ])}
      />,
    );

    const body = document.body.textContent ?? "";
    expect(body.indexOf("Unmet second")).toBeGreaterThan(-1);
    expect(body.indexOf("Met first")).toBe(-1); // collapsed
  });
});
