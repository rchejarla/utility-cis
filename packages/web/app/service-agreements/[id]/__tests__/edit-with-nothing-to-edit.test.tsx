import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ToastProvider } from "@/components/ui/toast";
import { apiClient } from "@/lib/api-client";
import ServiceAgreementDetailPage from "../page";

/**
 * Saving an edit that changed nothing.
 *
 * Read Sequence was this page's only core editable field, and it went
 * with its column (spec 30). For a tenant that has declared no
 * `service_agreement` custom fields — which is every tenant until one
 * does — Edit now opens a panel with no input in it at all. The button
 * that follows must not then report a change that never happened: a
 * PATCH with an empty body still writes an audit row, because
 * `updated_at` moves, so a CSR would get "updated successfully" and an
 * entry in the Audit tab for having clicked two buttons.
 */

const get = apiClient.get as unknown as ReturnType<typeof vi.fn>;
const patch = apiClient.patch as unknown as ReturnType<typeof vi.fn>;

const agreement = {
  id: "sa-1",
  agreementNumber: "SA-1001",
  status: "ACTIVE",
  startDate: "2026-01-01",
  customFields: {},
  account: { id: "acc-1", accountNumber: "0001000-00" },
  servicePoints: [],
};

async function renderPage() {
  await act(async () => {
    render(
      <ToastProvider>
        <ServiceAgreementDetailPage params={Promise.resolve({ id: "sa-1" })} />
      </ToastProvider>,
    );
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  get.mockImplementation((path: string) =>
    path === "/api/v1/service-agreements/sa-1"
      ? Promise.resolve(agreement)
      : path === "/api/v1/custom-fields/service_agreement"
        ? Promise.resolve({ fields: [] })
        : Promise.resolve({ data: [], meta: { total: 0, page: 1, limit: 25, pages: 1 } }),
  );
  patch.mockResolvedValue(agreement);
});

describe("Service agreement detail — saving an edit that changed nothing", () => {
  it("does not PATCH, and does not claim the agreement was updated", async () => {
    await renderPage();

    await userEvent.click(await screen.findByRole("button", { name: "Edit" }));
    await userEvent.click(await screen.findByRole("button", { name: "Save" }));

    expect(patch).not.toHaveBeenCalled();
    expect(screen.queryByText(/updated successfully/i)).not.toBeInTheDocument();
    // And the panel closes, so the click is not simply inert.
    expect(await screen.findByRole("button", { name: "Edit" })).toBeInTheDocument();
  });

  it("still sends the fields a tenant with custom fields did change", async () => {
    get.mockImplementation((path: string) =>
      path === "/api/v1/service-agreements/sa-1"
        ? Promise.resolve({ ...agreement, customFields: { meter_pit: "front" } })
        : path === "/api/v1/custom-fields/service_agreement"
          ? Promise.resolve({
              fields: [
                { key: "meter_pit", label: "Meter pit", type: "string", required: false },
              ],
            })
          : Promise.resolve({ data: [], meta: { total: 0, page: 1, limit: 25, pages: 1 } }),
    );

    await renderPage();

    await userEvent.click(await screen.findByRole("button", { name: "Edit" }));
    // Queried by role: `CustomFieldsSection` renders its label beside the
    // control rather than tied to it, so there is nothing to look up by
    // label text. In edit mode this is the page's only text box.
    const input = await screen.findByRole("textbox");
    await userEvent.clear(input);
    await userEvent.type(input, "rear");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(patch).toHaveBeenCalledWith("/api/v1/service-agreements/sa-1", {
      customFields: { meter_pit: "rear" },
    });
  });
});
