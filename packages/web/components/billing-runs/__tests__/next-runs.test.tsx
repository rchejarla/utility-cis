import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { NextRuns } from "../next-runs";
import type { BillingSchedule } from "../next-runs";

/**
 * "Is it going to happen?" on the Billing Runs screen (SCH-BILL-12).
 *
 * The table below this panel is a history: it says what ran. Nothing on
 * the screen said what *will* run, which is the question an operator has
 * on the 8th — and the most valuable thing it can say is that nothing
 * will, because nobody switched automation on. Billing is the one
 * scheduler that defaults to off, so that is not a hypothetical state.
 */

function schedule(over: Partial<BillingSchedule> = {}): BillingSchedule {
  return {
    enabled: true,
    timezone: "America/Denver",
    runHourLocal: 3,
    cycles: [
      {
        billingCycleId: "c1",
        cycleCode: "R01",
        cycleName: "Residential",
        nextRunAt: "2026-11-10T10:00:00.000Z",
        reason: "scheduled",
        windowEnd: "2026-11-10",
        alreadyRun: false,
      },
    ],
    ...over,
  };
}

describe("the next scheduled run per cycle", () => {
  it("leads with the fact that nothing is scheduled when automation is off", () => {
    /*
     * The one answer this panel exists to give. Billing defaults to off
     * (SCHEDULER_DEFINITIONS), so a tenant billing by hand sees this —
     * and a list of dates beside "off" would be a list of dates nothing
     * will act on.
     */
    render(<NextRuns schedule={schedule({ enabled: false })} />);

    expect(screen.getByText(/nothing will start a billing run/i)).toBeInTheDocument();
    // Where to change it, since the panel is otherwise a dead end.
    expect(screen.getByRole("link", { name: /automation/i })).toHaveAttribute(
      "href",
      "/settings/automation",
    );
  });

  it("names the date in the tenant's own zone, not the reader's", () => {
    /*
     * 10:00 UTC is 03:00 in Denver, which is the hour the tenant
     * configured. Printed in the reader's zone it would read 05:00 to a
     * clerk in Chicago — a time nobody set, on a screen about whether
     * the tenant's own schedule will fire.
     */
    render(<NextRuns schedule={schedule()} />);

    expect(screen.getByText(/Nov 10, 2026/)).toBeInTheDocument();
    expect(screen.getByText(/3:00/)).toBeInTheDocument();
  });

  it("distinguishes overdue from scheduled, because on the 12th only one is true", () => {
    render(
      <NextRuns
        schedule={schedule({
          cycles: [
            {
              billingCycleId: "c1",
              cycleCode: "R01",
              cycleName: "Residential",
              nextRunAt: "2026-11-12T13:00:00.000Z",
              reason: "overdue",
              windowEnd: "2026-11-10",
              alreadyRun: false,
            },
          ],
        })}
      />,
    );

    expect(screen.getByText(/overdue/i)).toBeInTheDocument();
  });

  it("says a cycle cannot be billed automatically rather than leaving it blank", () => {
    /*
     * An active cycle the rate engine cannot bill is worth an
     * operator's attention. A blank cell would read as "no date yet".
     */
    render(
      <NextRuns
        schedule={schedule({
          cycles: [
            {
              billingCycleId: "c2",
              cycleCode: "Q01",
              cycleName: "Quarterly",
              nextRunAt: null,
              reason: "unsupportedFrequency",
              windowEnd: null,
              alreadyRun: false,
            },
          ],
        })}
      />,
    );

    expect(screen.getByText(/cannot be billed/i)).toBeInTheDocument();
  });

  it("shows nothing at all when the tenant has no active cycle", () => {
    // An empty panel on a screen with an empty table would be two ways
    // of saying the same nothing.
    const { container } = render(<NextRuns schedule={schedule({ cycles: [] })} />);
    expect(container).toBeEmptyDOMElement();
  });
});
