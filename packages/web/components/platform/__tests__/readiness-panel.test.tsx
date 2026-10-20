import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ReadinessPanel } from "@/components/platform/readiness-panel";

/**
 * The panel that answers what the stats only implied.
 *
 * "32 modules, 6 roles" reads like readiness, and a freshly provisioned
 * tenant showing those numbers cannot bill anything — it has no
 * commodity, no unit of measure, no billing cycle, no published tariff
 * and no issuer identity.
 *
 * It opens on request rather than on arrival. Most visits to this page
 * are not about readiness, and a panel that is always open states its
 * case whether or not anyone asked; one line with a tick or a count
 * answers the question at a glance and the detail is a click away. What
 * is tested here is that collapsing hides nothing an operator needs to
 * know *that* something is wrong — only the particulars.
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

const toggle = () => screen.getByRole("button", { name: /ready to operate/i });

describe("ReadinessPanel", () => {
  it("starts closed, saying it is not ready and how many steps are left", () => {
    render(
      <ReadinessPanel
        readiness={panel([check(), check({ key: "billingCycle", ok: true })])}
      />,
    );

    expect(screen.getByText(/not ready to operate/i)).toBeInTheDocument();
    expect(screen.getByText(/1 of 2 outstanding/i)).toBeInTheDocument();
    expect(toggle()).toHaveAttribute("aria-expanded", "false");
    // Closed means closed: no check's particulars, met or unmet.
    expect(screen.queryByText("At least one commodity")).not.toBeInTheDocument();
  });

  it("says it is ready when everything is met, without being opened", () => {
    render(<ReadinessPanel readiness={panel([check({ ok: true }), check({ key: "x", ok: true })])} />);

    expect(screen.getByText("Ready to operate.")).toBeInTheDocument();
    expect(screen.getByText(/all 2 checks met/i)).toBeInTheDocument();
    expect(screen.queryByText("At least one commodity")).not.toBeInTheDocument();
  });

  it("opens on click and shows what an unmet check prevents", async () => {
    // `blocks` is the half an operator cannot infer from the label, so
    // opening has to produce it and not just the label.
    render(<ReadinessPanel readiness={panel([check()])} />);

    await userEvent.click(toggle());

    expect(toggle()).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("At least one commodity")).toBeInTheDocument();
    expect(screen.getByText("Nothing can be metered, agreed or priced.")).toBeInTheDocument();
    expect(screen.getByText(/none defined/)).toBeInTheDocument();
  });

  it("shows the met checks too once open, as the evidence for the count", async () => {
    render(
      <ReadinessPanel
        readiness={panel([
          check(),
          check({ key: "issuerIdentity", label: "Issuer identity on its bills", ok: true, detail: "complete" }),
        ])}
      />,
    );

    await userEvent.click(toggle());

    expect(screen.getByText("Issuer identity on its bills")).toBeInTheDocument();
  });

  it("puts every unmet check before any met one", async () => {
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

    await userEvent.click(toggle());

    const body = document.body.textContent ?? "";
    expect(body.indexOf("Unmet second")).toBeLessThan(body.indexOf("Met first"));
  });

  it("closes again, so it does not stay open for the rest of the visit", async () => {
    render(<ReadinessPanel readiness={panel([check()])} />);

    await userEvent.click(toggle());
    await userEvent.click(toggle());

    expect(toggle()).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("At least one commodity")).not.toBeInTheDocument();
  });
});
