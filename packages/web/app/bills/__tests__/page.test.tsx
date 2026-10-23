import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ToastProvider } from "@/components/ui/toast";
import { apiClient } from "@/lib/api-client";
import * as permModule from "@/lib/use-permission";
import BillsPage from "../page";

/*
 * The global setup pins `useSearchParams` to an empty URLSearchParams,
 * so a page that reads one cannot be exercised through it. Overridden
 * per file the way the cluster jobs suite does.
 */
let search = new URLSearchParams();
vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    refresh: vi.fn(),
    prefetch: vi.fn(),
  }),
  usePathname: () => "/bills",
  useSearchParams: () => search,
}));

/**
 * The bill-document actions on the tenant-wide bill list.
 *
 * One button answers "give me the bill", because whether a PDF was
 * produced before is a fact about our storage and not something a CSR
 * should read off a row. The order inside it is what these cases pin:
 * fetch first, produce only on a 404. A produce-first button would stop
 * a read-only user from downloading a PDF that already exists, since
 * producing is `accounts:EDIT` and downloading is `accounts:VIEW`.
 *
 * Regenerate is separate because it overwrites a copy that cannot be
 * recovered, and it is absent for a user who may only look.
 */

const get = apiClient.get as unknown as ReturnType<typeof vi.fn>;
const post = apiClient.post as unknown as ReturnType<typeof vi.fn>;
const headersOnly = apiClient.getAuthHeadersOnly as unknown as ReturnType<typeof vi.fn>;

function bill(over: Record<string, unknown> = {}) {
  return {
    id: "bill-1",
    billNumber: "B-1001",
    billDate: "2026-03-01",
    dueDate: "2026-03-31",
    periodStart: "2026-02-01",
    periodEnd: "2026-02-28",
    total: "107.50",
    postedAt: "2026-03-01",
    billingCycleName: "Residential",
    account: { id: "acc-1", accountNumber: "A-900", customerName: "Jane Smith" },
    charge: { entryId: "le-1", openAmount: "107.50", reversed: false },
    // The API decides both of these; the defaults are a bill that is
    // neither late nor part paid, and the dueDate above is only here to
    // be displayed.
    overdue: false,
    partPaid: false,
    ...over,
  };
}

/** A response for the download fetch: the PDF, or a status. */
function pdfResponse() {
  return {
    ok: true,
    status: 200,
    blob: async () => new Blob(["%PDF-"], { type: "application/pdf" }),
  };
}

function notProduced() {
  return { ok: false, status: 404, json: async () => ({ error: { code: "NOT_GENERATED" } }) };
}

function payload(rows: unknown[]) {
  return { data: rows, meta: { total: rows.length, page: 1, limit: 25, pages: 1 } };
}

function renderPage() {
  return render(
    <ToastProvider>
      <BillsPage />
    </ToastProvider>,
  );
}

const fetchMock = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  search = new URLSearchParams();
  vi.stubGlobal("fetch", fetchMock);
  // jsdom implements none of these. Viewing a bill opens a tab and
  // points it at a blob URL; left unstubbed, jsdom's window.open returns
  // null and every case would quietly exercise the download fallback
  // instead of the path the button actually takes.
  vi.stubGlobal("open", vi.fn(() => ({ location: { href: "" }, close: vi.fn() })));
  window.URL.createObjectURL = vi.fn(() => "blob:bill");
  window.URL.revokeObjectURL = vi.fn();
  headersOnly.mockResolvedValue({ Authorization: "Bearer t" });
  fetchMock.mockResolvedValue({
    ok: true,
    status: 200,
    blob: async () => new Blob(["%PDF-"], { type: "application/pdf" }),
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  // clearAllMocks resets calls but leaves a spy's implementation in
  // place, so the permission spy below would otherwise make every later
  // case read-only.
  vi.restoreAllMocks();
});

/**
 * The Status filter and the status pill.
 *
 * Both used to answer issuance only — posted or not — so a fully paid
 * bill read "Posted" and the paid fact appeared as a dash in the column
 * before it. What a CSR and collections ask about is settlement.
 */
describe("Bills page — status", () => {
  it("offers settlement states, not just posted and not posted", async () => {
    get.mockResolvedValue(payload([bill()]));
    renderPage();
    await screen.findByText("B-1001");

    await userEvent.click(screen.getByRole("button", { name: /Status/ }));

    // The dropdown items are buttons; a row's status pill is a span, so
    // role filters out the one that is not a control.
    for (const label of [
      "Not posted",
      "Outstanding",
      "Overdue",
      "Part paid",
      "Paid",
      "Reversed",
    ]) {
      expect(screen.getByRole("button", { name: label })).toBeInTheDocument();
    }
  });

  it("asks the API for the chosen state", async () => {
    get.mockResolvedValue(payload([bill()]));
    renderPage();
    await screen.findByText("B-1001");

    await userEvent.click(screen.getByRole("button", { name: /Status/ }));
    await userEvent.click(screen.getByRole("button", { name: "Overdue" }));

    await waitFor(() =>
      expect(get.mock.calls.some(([u]) => String(u).includes("state=overdue"))).toBe(true),
    );
    // And the old issuance-only param is gone, not sent alongside.
    expect(get.mock.calls.every(([u]) => !String(u).includes("posted="))).toBe(true);
  });

  it("reads Paid once nothing is owed, rather than Posted", async () => {
    get.mockResolvedValue(
      payload([bill({ charge: { entryId: "le-1", openAmount: "0.00", reversed: false } })]),
    );
    renderPage();

    expect(await screen.findByText("Paid")).toBeInTheDocument();
    expect(screen.queryByText("Outstanding")).not.toBeInTheDocument();
  });

  it("reads Part paid when the row says something has been applied", async () => {
    get.mockResolvedValue(
      payload([
        bill({
          dueDate: "2099-01-01",
          partPaid: true,
          charge: { entryId: "le-1", openAmount: "40.00", reversed: false },
        }),
      ]),
    );
    renderPage();

    expect(await screen.findByText("Part paid")).toBeInTheDocument();
  });

  /**
   * The pill used to ask `openAmount < total` here, comparing the 2dp
   * ledger column to the 4dp bill column. The rate engine does not round
   * and bill totals are stored at 4dp, so any bill carrying a fraction
   * of a cent satisfied that with nothing paid — it read "Part paid"
   * while `state=partPaid` correctly returned nothing, because no
   * application existed. The API answers it now.
   */
  it("does not read Part paid on an unpaid bill whose total carries a half-cent", async () => {
    get.mockResolvedValue(
      payload([
        bill({
          dueDate: "2099-01-01",
          total: "32.2100",
          partPaid: false,
          charge: { entryId: "le-1", openAmount: "32.21", reversed: false },
        }),
      ]),
    );
    renderPage();

    expect(await screen.findByText("Outstanding")).toBeInTheDocument();
    expect(screen.queryByText("Part paid")).not.toBeInTheDocument();
  });

  /**
   * Whether a bill is late is the API's answer, not this page's.
   *
   * This test used to compute the boundary here from the browser's
   * calendar date, which is exactly what made the pill and the
   * `state=overdue` filter disagree each evening west of Greenwich: two
   * copies of one judgement in two zones. The date arithmetic is now
   * tested where it lives, against a real database, in
   * `bill-list.integration.test.ts`. What this page owes is to render
   * what it is told.
   */
  it("reads Overdue when the row says so, and not when it does not", async () => {
    get.mockResolvedValue(
      payload([
        bill({
          overdue: false,
          charge: { entryId: "le-1", openAmount: "107.50", reversed: false },
        }),
      ]),
    );
    const notLate = renderPage();
    expect(await screen.findByText("Outstanding")).toBeInTheDocument();
    expect(screen.queryByText("Overdue")).not.toBeInTheDocument();
    notLate.unmount();

    get.mockResolvedValue(
      payload([
        bill({
          overdue: true,
          charge: { entryId: "le-1", openAmount: "107.50", reversed: false },
        }),
      ]),
    );
    renderPage();
    expect(await screen.findByText("Overdue")).toBeInTheDocument();
  });

  it("reads Reversed before anything about payment", async () => {
    get.mockResolvedValue(
      payload([
        bill({ dueDate: "2020-01-01", charge: { entryId: "le-1", openAmount: "0.00", reversed: true } }),
      ]),
    );
    renderPage();

    // A reversed charge is owed by nobody, so "Paid" would be a lie.
    expect(await screen.findByText("Reversed")).toBeInTheDocument();
    expect(screen.queryByText("Paid")).not.toBeInTheDocument();
  });
});

describe("Bills page — bill document actions", () => {
  it("downloads an existing PDF without producing anything", async () => {
    get.mockResolvedValue(payload([bill()]));
    fetchMock.mockResolvedValue(pdfResponse());
    renderPage();

    await userEvent.click(await screen.findByRole("button", { name: "View bill" }));

    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(([u]) => String(u).endsWith("/api/v1/bills/bill-1/document")),
      ).toBe(true),
    );
    // The point of fetching first: no write happens for a bill that
    // already has one, so a read-only user can still get it.
    expect(post).not.toHaveBeenCalled();
    // And the bytes must not go through the JSON client, which would try
    // to parse a PDF as JSON.
    expect(get.mock.calls.every(([u]) => !String(u).includes("/document"))).toBe(true);
  });

  /** The whole reason there is only one button. */
  it("generates the PDF on a 404 and then downloads it", async () => {
    get.mockResolvedValue(payload([bill()]));
    fetchMock.mockResolvedValueOnce(notProduced()).mockResolvedValue(pdfResponse());
    post.mockResolvedValue({ id: "doc-1" });
    renderPage();

    await userEvent.click(await screen.findByRole("button", { name: "View bill" }));

    await waitFor(() =>
      expect(post).toHaveBeenCalledWith("/api/v1/bills/bill-1/document", {}),
    );
    // Fetched, produced, fetched again — the operator asked for the
    // bill, not for a confirmation that one now exists.
    expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("surfaces the missing issuer fields when a bill cannot be generated", async () => {
    get.mockResolvedValue(payload([bill()]));
    fetchMock.mockResolvedValue(notProduced());
    post.mockRejectedValue(
      new Error("API error 422: No issuer identity is configured (remittanceCity)"),
    );
    renderPage();

    await userEvent.click(await screen.findByRole("button", { name: "View bill" }));

    expect(await screen.findByText(/remittanceCity/)).toBeInTheDocument();
  });

  it("reports a failed download rather than trying to generate over it", async () => {
    get.mockResolvedValue(payload([bill()]));
    fetchMock.mockResolvedValue({
      ok: false,
      status: 502,
      json: async () => ({
        error: { code: "STORAGE_UNAVAILABLE", message: "The bill document store refused" },
      }),
    });
    renderPage();

    await userEvent.click(await screen.findByRole("button", { name: "View bill" }));

    expect(await screen.findByText(/store refused/i)).toBeInTheDocument();
    // Only a 404 means "not produced yet"; a 502 must not trigger a write.
    expect(post).not.toHaveBeenCalled();
  });

  /**
   * What stays on the row, and what does not.
   *
   * The only inline action is the one that just reads — getting the PDF.
   * Everything that moves money or overwrites something is behind More,
   * so the row reads as a list of bills rather than a control panel.
   */
  it("keeps only the PDF download inline", async () => {
    get.mockResolvedValue(payload([bill()]));
    fetchMock.mockResolvedValue(pdfResponse());
    renderPage();

    expect(await screen.findByRole("button", { name: "View bill" })).toBeInTheDocument();

    // Nothing else is a button on the row, and nothing is open yet.
    expect(screen.queryByRole("button", { name: /Take payment/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("puts everything that writes in the More menu, money first", async () => {
    get.mockResolvedValue(payload([bill()]));
    renderPage();

    await userEvent.click(await screen.findByRole("button", { name: /More actions/ }));

    expect(await screen.findByRole("menu")).toBeInTheDocument();
    const items = screen.getAllByRole("menuitem").map((el) => el.textContent);
    // Ordered by how often it is reached and what it costs to get wrong:
    // money first, reversal last and furthest from the pointer.
    expect(items).toEqual([
      "Take payment on account",
      "Regenerate PDF",
      "Waive",
      "Write off",
      "Reverse charge",
    ]);
  });

  it("opens the payment dialog from the menu", async () => {
    get.mockResolvedValue(payload([bill()]));
    renderPage();

    await userEvent.click(await screen.findByRole("button", { name: /More actions/ }));
    await userEvent.click(
      await screen.findByRole("menuitem", { name: "Take payment on account" }),
    );

    // The dialog is account-scoped, which is the whole reason the label
    // says "on account".
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
  });

  it("confirms a regenerate from the menu, denying what it does not do", async () => {
    get.mockResolvedValue(payload([bill()]));
    post.mockResolvedValue({ id: "doc-1" });
    renderPage();

    await userEvent.click(await screen.findByRole("button", { name: /More actions/ }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "Regenerate PDF" }));

    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    expect(screen.getByText(/does not change what is owed/i)).toBeInTheDocument();
    expect(screen.getByText(/previous copy is not kept/i)).toBeInTheDocument();
    expect(post).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole("button", { name: "Generate again" }));

    await waitFor(() =>
      expect(post).toHaveBeenCalledWith("/api/v1/bills/bill-1/document?force=true", {}),
    );
  });

  /**
   * The menu is not merely a different place to put the same buttons —
   * each item keeps the rule that decided whether it was offered at all.
   * A settled charge has nothing left to forgive.
   */
  it("omits Waive and Write off once the charge is settled", async () => {
    get.mockResolvedValue(
      payload([bill({ charge: { entryId: "le-1", openAmount: "0.00", reversed: false } })]),
    );
    renderPage();

    await userEvent.click(await screen.findByRole("button", { name: /More actions/ }));

    await screen.findByRole("menu");
    expect(screen.getByRole("menuitem", { name: "Reverse charge" })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "Waive" })).not.toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "Write off" })).not.toBeInTheDocument();
  });

  it("offers no menu at all to a user who can only look", async () => {
    vi.spyOn(permModule, "usePermission").mockReturnValue({
      canView: true,
      canCreate: false,
      canEdit: false,
      canDelete: false,
    });
    get.mockResolvedValue(payload([bill()]));
    fetchMock.mockResolvedValue(pdfResponse());
    renderPage();

    // The download is a read, so it stays; there is nothing to put in a
    // menu, so no empty trigger appears.
    expect(await screen.findByRole("button", { name: "View bill" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /More actions/ })).not.toBeInTheDocument();
  });

  /**
   * A bill is a calculation until it is posted. Offering its document
   * would promise a PDF the API refuses to make, with a 409.
   */
  it("offers no PDF action on an unposted bill", async () => {
    get.mockResolvedValue(payload([bill({ postedAt: null, charge: null })]));
    renderPage();

    expect(await screen.findByRole("button", { name: "Post" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "View bill" })).not.toBeInTheDocument();
    // The menu is the only place Regenerate can appear, and on an unposted
    // bill every item is gated on postedAt or a charge, so no trigger is
    // rendered at all. This used to assert on a `button` named
    // "Regenerate", which could never fail: the item is a menuitem
    // labelled "Regenerate PDF", behind a menu that starts closed.
    expect(screen.queryByRole("button", { name: /More actions/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "Regenerate PDF" })).not.toBeInTheDocument();
  });
});

/**
 * Arriving at a bill from somewhere else.
 *
 * A billing run's Billed tab lists accounts, and its View action has to
 * land on the bill it names. It used to link to `?search=<bill id>`,
 * and the list's search matches bill number, account number and
 * customer name — never an id — so the operator arrived at an empty
 * list with a UUID in the search box, which reads as "that bill does
 * not exist".
 */
describe("Bills — arriving with a bill named in the URL", () => {
  it("opens that bill rather than searching for its id", async () => {
    get.mockImplementation((path: string) => {
      if (path === `/api/v1/bills/${"bill-1"}`) {
        return Promise.resolve({
          ...bill(),
          subtotal: "107.50",
          taxes: "0.00",
          credits: "0.00",
          segments: [],
        });
      }
      return Promise.resolve(payload([bill()]));
    });
    search = new URLSearchParams({ bill: "bill-1" });

    renderPage();

    // The dialog fetches the one bill by id; the list is not filtered by
    // a value it could never match.
    await waitFor(() => expect(get).toHaveBeenCalledWith("/api/v1/bills/bill-1"));
    const listCalls = get.mock.calls.filter((c) => c[0] === "/api/v1/bills");
    for (const call of listCalls) {
      expect(call[1]?.search).toBeUndefined();
    }
  });

  it("shows the plain list when no bill is named", async () => {
    get.mockResolvedValue(payload([bill()]));
    search = new URLSearchParams();

    renderPage();

    await screen.findByText("B-1001");
    expect(get).not.toHaveBeenCalledWith("/api/v1/bills/bill-1");
  });
});
