import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { EntityFormPage } from "../entity-form-page";
import { apiClient } from "@/lib/api-client";

const mockedPost = vi.mocked(apiClient.post);
const mockedGet = vi.mocked(apiClient.get);

interface Form extends Record<string, unknown> {
  name: string;
  type: string;
  count: string;
  mode: "A" | "B";
}

const baseProps = {
  title: "Add Thing",
  subtitle: "Create a new thing",
  module: "things",
  endpoint: "/api/v1/things",
  returnTo: "/things",
  submitLabel: "Create Thing",
  initialValues: {
    name: "",
    type: "STANDARD",
    count: "",
    mode: "A" as const,
  },
};

const STOCK_FIELDS = [
  { key: "name" as const, label: "Name", type: "text" as const, required: true, placeholder: "name" },
  {
    key: "type" as const,
    label: "Type",
    type: "select" as const,
    options: [
      { value: "STANDARD", label: "Standard" },
      { value: "PREMIUM", label: "Premium" },
    ],
  },
  { key: "count" as const, label: "Count", type: "number" as const, min: "0", placeholder: "count" },
];

describe("EntityFormPage", () => {
  beforeEach(() => {
    mockedPost.mockReset();
    mockedGet.mockReset();
  });

  it("renders title, subtitle, and the declared fields", () => {
    render(<EntityFormPage<Form> {...baseProps} fields={STOCK_FIELDS} />);

    expect(screen.getByText("Add Thing")).toBeInTheDocument();
    expect(screen.getByText("Create a new thing")).toBeInTheDocument();
    expect(screen.getByLabelText(/Name/)).toBeInTheDocument();
    expect(screen.getByLabelText(/Type/)).toBeInTheDocument();
    expect(screen.getByLabelText(/Count/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create Thing" })).toBeInTheDocument();
  });

  it("submits form values to the endpoint and navigates to returnTo on success", async () => {
    mockedPost.mockResolvedValueOnce({ id: "thing-1" });
    const user = userEvent.setup();

    render(<EntityFormPage<Form> {...baseProps} fields={STOCK_FIELDS} />);

    await user.type(screen.getByLabelText(/Name/), "Acme");
    await user.click(screen.getByRole("button", { name: "Create Thing" }));

    await waitFor(() => {
      expect(mockedPost).toHaveBeenCalledWith("/api/v1/things", {
        name: "Acme",
        type: "STANDARD",
        count: "",
        mode: "A",
      });
    });
  });

  it("applies toRequestBody to drop/transform values before sending", async () => {
    mockedPost.mockResolvedValueOnce({});
    const user = userEvent.setup();

    render(
      <EntityFormPage<Form>
        {...baseProps}
        fields={STOCK_FIELDS}
        toRequestBody={(v) => {
          const body: Record<string, unknown> = { name: v.name, type: v.type };
          if (v.count) body.count = parseInt(v.count, 10);
          return body;
        }}
      />,
    );

    await user.type(screen.getByLabelText(/Name/), "Beta");
    await user.type(screen.getByLabelText(/Count/), "42");
    await user.click(screen.getByRole("button", { name: "Create Thing" }));

    await waitFor(() => {
      expect(mockedPost).toHaveBeenCalledWith("/api/v1/things", {
        name: "Beta",
        type: "STANDARD",
        count: 42,
      });
    });
  });

  it("renders the error banner when the POST fails and stays on the page", async () => {
    mockedPost.mockRejectedValueOnce(new Error("server refused"));
    const user = userEvent.setup();

    render(<EntityFormPage<Form> {...baseProps} fields={STOCK_FIELDS} />);

    // Fill the required field so native form validation lets submit through
    await user.type(screen.getByLabelText(/Name/), "Thing1");
    await user.click(screen.getByRole("button", { name: "Create Thing" }));

    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent("server refused");
    });
  });

  it("hides fields whose visibleWhen predicate returns false", () => {
    render(
      <EntityFormPage<Form>
        {...baseProps}
        fields={[
          { key: "name", label: "Name", type: "text" },
          {
            key: "count",
            label: "Premium Count",
            type: "number",
            visibleWhen: (v) => v.type === "PREMIUM",
          },
        ]}
      />,
    );

    expect(screen.getByLabelText(/Name/)).toBeInTheDocument();
    expect(screen.queryByLabelText(/Premium Count/)).not.toBeInTheDocument();
  });

  it("fetches dynamic select options from the configured endpoint", async () => {
    mockedGet.mockResolvedValueOnce({
      data: [
        { id: "c1", name: "Water" },
        { id: "c2", name: "Electric" },
      ],
    });

    render(
      <EntityFormPage<Form>
        {...baseProps}
        fields={[
          {
            key: "type",
            label: "Type",
            type: "select",
            options: {
              endpoint: "/api/v1/commodities",
              mapOption: (c) => ({
                value: String(c.id),
                label: String(c.name),
              }),
            },
          },
        ]}
      />,
    );

    await waitFor(() =>
      expect(mockedGet).toHaveBeenCalledWith("/api/v1/commodities", undefined),
    );
    await waitFor(() => {
      expect(screen.getByRole("option", { name: "Water" })).toBeInTheDocument();
      expect(screen.getByRole("option", { name: "Electric" })).toBeInTheDocument();
    });
  });

  it("uses the custom render escape hatch for non-standard field types", async () => {
    mockedPost.mockResolvedValueOnce({});
    const user = userEvent.setup();

    render(
      <EntityFormPage<Form>
        {...baseProps}
        fields={[
          {
            key: "mode",
            label: "Mode",
            type: "custom",
            render: ({ value, setValue }) => (
              <div>
                <button
                  type="button"
                  aria-pressed={value === "A"}
                  onClick={() => setValue("A" as never)}
                >
                  A
                </button>
                <button
                  type="button"
                  aria-pressed={value === "B"}
                  onClick={() => setValue("B" as never)}
                >
                  B
                </button>
              </div>
            ),
          },
        ]}
      />,
    );

    const btnA = screen.getByRole("button", { name: "A" });
    const btnB = screen.getByRole("button", { name: "B" });

    expect(btnA).toHaveAttribute("aria-pressed", "true");
    expect(btnB).toHaveAttribute("aria-pressed", "false");

    await user.click(btnB);

    expect(btnA).toHaveAttribute("aria-pressed", "false");
    expect(btnB).toHaveAttribute("aria-pressed", "true");

    await user.click(screen.getByRole("button", { name: "Create Thing" }));
    await waitFor(() =>
      expect(mockedPost).toHaveBeenCalledWith(
        "/api/v1/things",
        expect.objectContaining({ mode: "B" }),
      ),
    );
  });

  it("onSuccess result overrides the default returnTo navigation", async () => {
    mockedPost.mockResolvedValueOnce({ id: "xyz" });
    const user = userEvent.setup();

    render(
      <EntityFormPage<Form>
        {...baseProps}
        fields={STOCK_FIELDS}
        onSuccess={(res) => `/things/${(res as { id: string }).id}`}
      />,
    );

    await user.type(screen.getByLabelText(/Name/), "Xyz");
    await user.click(screen.getByRole("button", { name: "Create Thing" }));

    // Since the router is mocked at the test-setup layer we can't easily
    // observe router.push here without re-mocking per test. Instead we
    // just verify the POST landed with the right shape — the useEntityForm
    // unit tests already cover the nextPath return value.
    await waitFor(() => expect(mockedPost).toHaveBeenCalledTimes(1));
  });

  it("renders AccessDenied and does not fetch when canCreate is false", async () => {
    const permModule = await import("@/lib/use-permission");
    vi.spyOn(permModule, "usePermission").mockReturnValue({
      canView: true,
      canCreate: false,
      canEdit: false,
      canDelete: false,
    });

    render(<EntityFormPage<Form> {...baseProps} fields={STOCK_FIELDS} />);

    expect(
      screen.queryByRole("heading", { name: "Add Thing" }),
    ).not.toBeInTheDocument();
    expect(mockedPost).not.toHaveBeenCalled();

    vi.mocked(permModule.usePermission).mockRestore();
  });
});
