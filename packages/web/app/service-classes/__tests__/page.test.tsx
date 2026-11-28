import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ToastProvider } from "@/components/ui/toast";
import { apiClient } from "@/lib/api-client";
import ServiceClassesPage from "../page";

/**
 * The service classes list (spec 05): per commodity, how many agreements are
 * in each, a code that cannot change after creation, and a retirement that
 * asks first when agreements are in the class.
 */

const get = apiClient.get as unknown as ReturnType<typeof vi.fn>;
const post = apiClient.post as unknown as ReturnType<typeof vi.fn>;
const patch = apiClient.patch as unknown as ReturnType<typeof vi.fn>;

const COMMODITIES = [
  { id: "electric", name: "Electric", code: "ELECTRIC" },
  { id: "water", name: "Water", code: "WATER" },
];
const ELECTRIC_CLASSES = [
  { id: "c-res", commodityId: "electric", code: "residential", label: "Residential", sortOrder: 10, isActive: true, _count: { serviceAgreements: 4 } },
  { id: "c-light", commodityId: "electric", code: "lighting", label: "Lighting", sortOrder: 50, isActive: true, _count: { serviceAgreements: 0 } },
];

beforeEach(() => {
  vi.clearAllMocks();
  get.mockImplementation(async (url: string, params?: { commodityId: string }) => {
    if (url === "/api/v1/commodities") return { data: COMMODITIES };
    if (url === "/api/v1/rate-service-classes") return params?.commodityId === "electric" ? ELECTRIC_CLASSES : [];
    return { data: [] };
  });
  post.mockResolvedValue({});
  patch.mockResolvedValue({});
});

async function renderPage() {
  await act(async () => {
    render(
      <ToastProvider>
        <ServiceClassesPage />
      </ToastProvider>,
    );
  });
}

describe("Service Classes", () => {
  it("lists the first commodity's classes with how many agreements are in each", async () => {
    await renderPage();

    expect(await screen.findByText("Residential")).toBeInTheDocument();
    expect(get).toHaveBeenCalledWith("/api/v1/rate-service-classes", { commodityId: "electric" });
    expect(screen.getByTestId("in-use-residential").textContent).toBe("4");
    expect(screen.getByTestId("in-use-lighting").textContent).toBe("0");
  });

  it("says a commodity with no classes cannot take agreements yet", async () => {
    await renderPage();
    await screen.findByText("Residential");

    await userEvent.selectOptions(screen.getByLabelText("Commodity"), "water");

    expect(await screen.findByText(/agreements for it cannot be created until one exists/)).toBeInTheDocument();
  });

  it("creates a class for the chosen commodity, with the code made valid as it is typed", async () => {
    await renderPage();
    await screen.findByText("Residential");

    await userEvent.click(screen.getByRole("button", { name: "+ Add Service Class" }));
    await userEvent.type(screen.getByLabelText("Code"), "Small Commercial");
    await userEvent.type(screen.getAllByLabelText("Label")[0]!, "Small Commercial");
    await userEvent.click(screen.getByRole("button", { name: "Create" }));

    expect(post).toHaveBeenCalledWith("/api/v1/rate-service-classes", {
      commodityId: "electric",
      code: "small_commercial",
      label: "Small Commercial",
      sortOrder: 100,
      isActive: true,
    });
  });

  it("never offers the code for editing, and sends only the label, order and status", async () => {
    await renderPage();
    const row = (await screen.findByText("Lighting")).closest("tr")!;

    await userEvent.click(within(row).getByRole("button", { name: "Edit" }));
    const label = within(row).getByLabelText("Label");
    await userEvent.clear(label);
    await userEvent.type(label, "Street Lighting");
    await userEvent.click(within(row).getByRole("button", { name: "Save" }));

    expect(within(row).queryByLabelText("Code")).toBeNull();
    expect(patch).toHaveBeenCalledWith("/api/v1/rate-service-classes/c-light", {
      label: "Street Lighting",
      sortOrder: 50,
      isActive: true,
    });
  });

  it("asks before retiring a class agreements are in, and saves only on confirm", async () => {
    await renderPage();
    const row = (await screen.findByText("Residential")).closest("tr")!;

    await userEvent.click(within(row).getByRole("button", { name: "Edit" }));
    await userEvent.click(within(row).getByRole("checkbox"));
    await userEvent.click(within(row).getByRole("button", { name: "Save" }));

    expect(patch).not.toHaveBeenCalled();
    expect(await screen.findByText(/4 agreements are in this class and will stay in it/)).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Retire" }));

    expect(patch).toHaveBeenCalledWith("/api/v1/rate-service-classes/c-res", {
      label: "Residential",
      sortOrder: 10,
      isActive: false,
    });
  });
});
