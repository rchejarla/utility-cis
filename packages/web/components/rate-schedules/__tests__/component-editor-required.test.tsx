import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { apiClient } from "@/lib/api-client";
import { ToastProvider } from "@/components/ui/toast";
import { ComponentEditor } from "../component-editor";

/**
 * Which fields the Add Component popup will not let you leave blank,
 * and whether it says so.
 *
 * Every one of these already blocked Save — `allValid` has always
 * required a kind, a label, an effective date and three valid
 * sub-shapes — and none of them were marked, so a disabled Save button
 * was the only feedback and it named nothing. The mark is
 * `RequiredMark`, the same asterisk plus screen-reader "(required)"
 * that `FormField` has always rendered; this modal is built from raw
 * labels and so had no way to get it without copying the markup.
 */

const get = apiClient.get as unknown as ReturnType<typeof vi.fn>;

const GRAMMAR = {
  kinds: [{ code: "consumption", label: "Consumption" }],
  transforms: [{ code: "prorate", label: "Prorate by days", supported: true }],
};

beforeEach(() => {
  vi.clearAllMocks();
  get.mockImplementation((path: string) => {
    if (path === "/api/v1/rate-grammar/registered") return Promise.resolve(GRAMMAR);
    if (path === "/api/v1/tou-periods") {
      return Promise.resolve({ data: [{ peakCode: "peak", label: "On-peak" }] });
    }
    return Promise.resolve([]);
  });
});

const open = () =>
  render(
    <ToastProvider>
      <ComponentEditor
        scheduleId="sched-1"
        component={null}
        onClose={vi.fn()}
        onSaved={vi.fn()}
        commodityId="com-1"
      />
    </ToastProvider>,
  );

/** The label element whose text begins with `name`, asterisk and all. */
const labelFor = async (name: string) =>
  await screen.findByText(new RegExp(`^${name}`));

describe("the Add Component popup's required fields", () => {
  it("marks the fields the form has always demanded", async () => {
    open();

    for (const name of ["Kind", "Label", "Effective Date"]) {
      expect((await labelFor(name)).textContent).toMatch(/\*/);
    }
  });

  it("leaves the genuinely optional ones unmarked", async () => {
    open();

    // Expiration is optional in createRateComponentSchema; sortOrder has
    // a default there, and the form always sends a number.
    expect((await labelFor("Expiration Date")).textContent).not.toMatch(/\*/);
    expect((await labelFor("Sort Order")).textContent).not.toMatch(/\*/);
  });

  it("exposes the requirement to assistive tech, not only as a glyph", async () => {
    open();

    expect(await screen.findByLabelText("Label")).toBeRequired();
    expect(await screen.findByLabelText("Kind")).toBeRequired();
  });

  it("marks the TOU period once a TOU charge is being written", async () => {
    open();

    await userEvent.selectOptions(
      await screen.findByLabelText("Quantity source"),
      "tou_period",
    );

    expect((await labelFor("TOU period")).textContent).toMatch(/\*/);
    expect(await screen.findByLabelText("TOU period")).toBeRequired();
  });

  it("marks the premise attribute once that source is chosen", async () => {
    open();

    await userEvent.selectOptions(
      await screen.findByLabelText("Quantity source"),
      "premise_attribute",
    );

    expect((await labelFor("Source attribute")).textContent).toMatch(/\*/);
    expect(await screen.findByLabelText("Source attribute")).toBeRequired();
  });
});
