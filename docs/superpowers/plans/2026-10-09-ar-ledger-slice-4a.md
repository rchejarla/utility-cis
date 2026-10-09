# AR Ledger Slice 4a — The Account AR Tab

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. One whole-branch review at the end, so this plan carries the interface contract.

**Goal:** An operator can open an account, see what it owes and why, and act on it — post a bill, take a payment, raise a fee, forgive a charge — without a terminal.

**Architecture:** One new read endpoint and one new tab. `ledger.service.ts` lists an account's entries with the vocabulary a human needs (type, reason label, what is still open); `GET /api/v1/accounts/:id/ledger` serves it behind `accounts:VIEW`. The UI is `components/ar/ar-tab.tsx`, mounted as a tab on the existing account detail page, following `BillsTab`'s shape exactly: a client component, `apiClient`, `DataTable`, `useToast`, `usePermission`, inline styles over the CSS custom properties the rest of the app uses.

**Tech Stack:** Next.js 14 App Router, React client components, `apiClient` over the Fastify API, Vitest + testcontainers for the endpoint, the web package's existing component test setup for the tab.

**Spec:** `docs/superpowers/specs/2026-10-09-ar-ledger-design.md` §8 (Account detail UI: "AR tab: ledger, aging summary, record-payment, adjust/waive actions"), §10 slice 4. `docs/specs/23-accounts-receivable.md` for the eleven endpoints this drives.

## Why this is 4a and not 4

Slice 4 in the design doc is "statement view, aging query, account AR tab, portal amount due". Those are four deliverables with one thing in common — they all read the ledger — and **no endpoint lists a ledger today**. The three AR `GET`s are `unposted-bills`, `ar/reasons` and `ar/reconciliation`.

So the smallest honest increment is: the ledger read, and the tab that makes the eleven existing endpoints reachable by a person. Deliberately **not** in 4a, each for a reason:

- **Statement (§7.1)** — needs "ledger activity since the previous bill", which means bill-period boundaries, not just a list. Its own task set.
- **Aging (§7.2)** — five buckets over `today − dueDate`. Small, but it is a second query with its own tests and belongs with the dashboard widget that consumes it (reqs 149–150).
- **Portal amount due** — a different app surface, different auth, and the portal exposes no balance at all today.
- **Reason-code CRUD** — surfaced by slice 3's review; §3.4 says a utility adds its own codes without a code change, and today it can only take the 12 defaults.

## Global Constraints

- Money is `Decimal(14,2)` in the ledger. The API returns money as **strings** already formatted to 2dp, and the UI never does arithmetic on it. Every existing AR endpoint does this; the UI's job is to display, not to compute.
- Signed amounts, one viewpoint: positive increases what the customer owes. The UI must make the sign legible rather than hiding it — a payment shows as a credit, not as a positive number in a "payments" column.
- Every query carries an explicit `utilityId` predicate. RLS does not enforce.
- The tab follows `BillsTab` (`packages/web/components/bills/bills-tab.tsx`): `"use client"`, `apiClient`, `useToast`, inline styles with `var(--accent-primary)` / `var(--text-secondary)` / `var(--border)` / `var(--radius)`. **No Tailwind classes** — these components do not use them, whatever the stack list says.
- Actions are gated by `usePermission`, which returns `{ canView, canCreate, canEdit }` and already accounts for the tenant having the module enabled. A button the user cannot use is not rendered.
- `accounts:VIEW` for reading the ledger; the action buttons follow the module that owns them — `accounts:EDIT` to post a bill, `payments:CREATE` to take one, `payments:EDIT` to reverse, `ar_adjustments:CREATE` for a fee, `ar_adjustments:EDIT` to waive or write off.

## Review Focus

Five conditions the design implies that no happy path exercises.

- **An account with no ledger entries at all** — the common case for a new account, and the one a table built around rows gets wrong. Must read as "nothing owed", not an empty grid with headers. Test in Task 2.
- **A credit balance** — a negative total. "Total due −20.00" is wrong English; the UI has to say the customer is in credit. Test in Task 2.
- **A reversed entry** — both the original and its `REVERSAL` appear, and a reader who does not know the model will think they have been charged twice. The row has to show that one negates the other. Test in Task 2.
- **A fully-settled entry next to a part-settled one** — `openAmount` of 0 versus 15.00 of 40.00. The distinction between "charged" and "still owed" is the whole point of an open-item ledger and the easiest thing to render as one number. Test in Task 1 and Task 2.
- **A permission the user does not have** — a CSR with `payments` but not `ar_adjustments` must see the payment action and not the waive action, and the API must refuse it anyway. Test in Task 3.

---

## File Structure

| File | Responsibility |
|---|---|
| `packages/api/src/services/ar/ledger.service.ts` | **New.** List an account's entries for display |
| `packages/api/src/routes/ar.ts` | `GET /api/v1/accounts/:id/ledger` |
| `packages/web/components/ar/ar-tab.tsx` | **New.** The tab: balance header, ledger table, actions |
| `packages/web/components/ar/record-payment-dialog.tsx` | **New.** Take a payment |
| `packages/web/components/ar/adjust-dialog.tsx` | **New.** Raise a fee, waive, or write off — one dialog, three modes |
| `packages/web/app/accounts/[id]/page.tsx` | Mount the tab |

---

## Task 1: `GET /api/v1/accounts/:id/ledger`

**Files:**
- Create: `packages/api/src/services/ar/ledger.service.ts`
- Modify: `packages/api/src/routes/ar.ts`
- Test: `packages/api/src/__tests__/integration/ledger-list.integration.test.ts`, and the route cases in `ledger-routes.integration.test.ts`

**Interfaces — Produces:**

```ts
export interface LedgerRow {
  id: string;
  type: string;                 // BILL_CHARGE, PAYMENT, FEE, ...
  amount: string;               // signed, 2dp
  openAmount: string;           // signed, 2dp
  settled: boolean;             // openAmount === 0
  effectiveDate: string;        // YYYY-MM-DD
  dueDate: string | null;
  postedAt: string;             // ISO
  reasonCode: string | null;
  reasonLabel: string | null;
  billNumber: string | null;    // when the entry came from a bill
  tender: string | null;
  memo: string | null;
  reversedByEntryId: string | null;  // set when something reverses THIS
  reversesEntryId: string | null;    // set when this IS a reversal
}

export interface LedgerPage {
  data: LedgerRow[];
  balance: string;              // the account's cached balance, 2dp
  openCount: number;            // entries with openAmount <> 0
}

export async function listLedger(
  utilityId: string,
  accountId: string,
  opts?: { limit?: number; openOnly?: boolean },
): Promise<LedgerPage>;
```

`balance` is returned alongside the rows so the tab makes one call rather than two, and so the number in the header and the rows below it come from the same read. `reversedByEntryId` and `reversesEntryId` are both resolved server-side: the UI must not have to work out which of two rows negates the other.

Newest first (`postedAt` desc, `id` desc for a total order), default limit 100, and `openOnly` for the "what is still owed" view.

- [ ] **Step 1: Write the failing tests**

```ts
describe("listLedger", () => {
  it("returns an empty page with a zero balance for an account with no entries", async () => {
    const page = await ledger.listLedger(utilityId, emptyAccountId);
    expect(page.data).toEqual([]);
    expect(page.balance).toBe("0.00");
    expect(page.openCount).toBe(0);
  });

  it("returns newest first with the reason label resolved", async () => {
    await fee.assessFee(utilityId, ACTOR, "T", accountId, {
      amount: "25.00", reasonId: lateFeeId, dueDate: "2026-07-14",
    });
    const page = await ledger.listLedger(utilityId, accountId);
    expect(page.data[0]!.type).toBe("FEE");
    expect(page.data[0]!.reasonCode).toBe("LATE_FEE");
    expect(page.data[0]!.reasonLabel).toBe("Late payment fee");
    expect(page.balance).toBe("25.00");
  });

  // Review Focus: charged vs still owed is the point of an open-item ledger.
  it("distinguishes a settled entry from a part-settled one", async () => {
    const d = await debit("40.00", "2026-06-14");
    await payment.recordPayment(utilityId, ACTOR, "T", accountId, {
      amount: "25.00", tender: "CHECK",
    });
    const page = await ledger.listLedger(utilityId, accountId);
    const charge = page.data.find((r) => r.id === d)!;
    expect(charge.amount).toBe("40.00");
    expect(charge.openAmount).toBe("15.00");
    expect(charge.settled).toBe(false);

    const paid = page.data.find((r) => r.type === "PAYMENT")!;
    expect(paid.amount).toBe("-25.00");
    expect(paid.openAmount).toBe("0.00");
    expect(paid.settled).toBe(true);
  });

  it("names the bill an entry came from", async () => {
    const billId = await makeBill("50.0000");
    await posting.postBill(utilityId, ACTOR, "T", billId);
    const page = await ledger.listLedger(utilityId, accountId);
    expect(page.data[0]!.billNumber).toMatch(/^BILL-/);
  });

  // Review Focus: a reader must see that one row negates the other.
  it("links a reversal to what it reversed, in both directions", async () => {
    const pay = await payment.recordPayment(utilityId, ACTOR, "T", accountId, {
      amount: "10.00", tender: "CHECK",
    });
    const rev = await reversal.reverseEntry(utilityId, ACTOR, "T", pay.paymentId, {});

    const page = await ledger.listLedger(utilityId, accountId);
    const original = page.data.find((r) => r.id === pay.paymentId)!;
    const reversalRow = page.data.find((r) => r.id === rev.reversalId)!;
    expect(original.reversedByEntryId).toBe(rev.reversalId);
    expect(reversalRow.reversesEntryId).toBe(pay.paymentId);
  });

  it("counts only entries that are still open", async () => {
    await debit("40.00", "2026-06-14");
    await payment.recordPayment(utilityId, ACTOR, "T", accountId, {
      amount: "40.00", tender: "CHECK",
    });
    const page = await ledger.listLedger(utilityId, accountId);
    expect(page.data).toHaveLength(2);
    expect(page.openCount).toBe(0);
  });

  it("filters to open entries when asked", async () => {
    await debit("40.00", "2026-06-14");
    await payment.recordPayment(utilityId, ACTOR, "T", accountId, {
      amount: "40.00", tender: "CHECK",
    });
    const page = await ledger.listLedger(utilityId, accountId, { openOnly: true });
    expect(page.data).toEqual([]);
    // The balance is still the account's, not the filtered sum.
    expect(page.balance).toBe("0.00");
  });

  it("never returns another tenant's entries", async () => { /* stray entry in otherUtilityId */ });

  it("refuses an unknown account", async () => {
    await expect(
      ledger.listLedger(utilityId, "00000000-0000-4000-8000-00000000dead"),
    ).rejects.toMatchObject({ code: "ACCOUNT_NOT_FOUND" });
  });

  it("caps the page, so a long history cannot return unbounded", async () => {
    for (let i = 0; i < 5; i++) await debit("1.00", "2026-06-14");
    const page = await ledger.listLedger(utilityId, accountId, { limit: 3 });
    expect(page.data).toHaveLength(3);
  });
});
```

- [ ] **Step 2: Run to verify they fail** — cannot resolve `ledger.service.js`.

- [ ] **Step 3: Write the service**

```ts
import { prisma } from "../../lib/prisma.js";

/**
 * An account's ledger, in the vocabulary a person needs.
 *
 * Read-only and deliberately separate from the services that write: this
 * resolves what a row MEANS — the reason's label, the bill it came from,
 * whether something has reversed it — so the UI never has to work that
 * out from ids. In particular `reversedByEntryId` and `reversesEntryId`
 * are both filled in, because two rows that cancel each other are the
 * thing a reader most easily misreads as being charged twice.
 *
 * `balance` comes from `Account.balance`, not from summing the rows: the
 * page may be capped or filtered, and the header must show what the
 * account actually owes. The two agree because the cache is written in
 * the same transaction as every entry (§3.6) and proved by
 * GET /api/v1/ar/reconciliation.
 */

function err(code: string, message: string, statusCode: number): Error {
  return Object.assign(new Error(message), { code, statusCode });
}

export interface LedgerRow { /* as in Interfaces above */ }
export interface LedgerPage { /* as in Interfaces above */ }

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

export async function listLedger(
  utilityId: string,
  accountId: string,
  opts: { limit?: number; openOnly?: boolean } = {},
): Promise<LedgerPage> {
  const account = await prisma.account.findFirst({
    where: { id: accountId, utilityId },
    select: { balance: true },
  });
  if (!account) throw err("ACCOUNT_NOT_FOUND", `Account ${accountId} not found`, 404);

  const take = Math.min(opts.limit ?? DEFAULT_LIMIT, MAX_LIMIT);

  const rows = await prisma.ledgerEntry.findMany({
    where: {
      utilityId,
      accountId,
      ...(opts.openOnly ? { NOT: { openAmount: 0 } } : {}),
    },
    orderBy: [{ postedAt: "desc" }, { id: "desc" }],
    take,
    select: {
      id: true, type: true, amount: true, openAmount: true,
      effectiveDate: true, dueDate: true, postedAt: true,
      tender: true, memo: true, reversesId: true,
      reason: { select: { code: true, label: true } },
      bill: { select: { billNumber: true } },
      reversedBy: { select: { id: true }, take: 1 },
    },
  });

  const openCount = await prisma.ledgerEntry.count({
    where: { utilityId, accountId, NOT: { openAmount: 0 } },
  });

  return {
    balance: account.balance.toFixed(2),
    openCount,
    data: rows.map((e) => ({
      id: e.id,
      type: e.type,
      amount: e.amount.toFixed(2),
      openAmount: e.openAmount.toFixed(2),
      settled: e.openAmount.isZero(),
      effectiveDate: e.effectiveDate.toISOString().slice(0, 10),
      dueDate: e.dueDate ? e.dueDate.toISOString().slice(0, 10) : null,
      postedAt: e.postedAt.toISOString(),
      reasonCode: e.reason?.code ?? null,
      reasonLabel: e.reason?.label ?? null,
      billNumber: e.bill?.billNumber ?? null,
      tender: e.tender ?? null,
      memo: e.memo ?? null,
      reversedByEntryId: e.reversedBy[0]?.id ?? null,
      reversesEntryId: e.reversesId ?? null,
    })),
  };
}
```

- [ ] **Step 4: Add the route**

```ts
  app.get(
    "/api/v1/accounts/:id/ledger",
    { config: { module: "accounts", permission: "VIEW" } },
    async (request, reply) => {
      const { id: accountId } = idParamSchema.parse(request.params);
      const q = request.query as { limit?: string; openOnly?: string };
      const page = await listLedger(request.user.utilityId, accountId, {
        limit: q.limit ? Number(q.limit) : undefined,
        openOnly: q.openOnly === "true",
      });
      return reply.send(page);
    },
  );
```

Plus route tests: 200 with the shape, 403 without `accounts:VIEW`, 404 for another tenant's account.

- [ ] **Step 5: Run everything, then commit**

```bash
pnpm typecheck
cd packages/api && pnpm exec vitest run --config vitest.integration.config.ts src/__tests__/integration/ledger-list.integration.test.ts src/__tests__/integration/ledger-routes.integration.test.ts
git commit -m "feat(ar): GET /accounts/:id/ledger lists an account's entries for display (slice 4a task 1)"
```

---

## Task 2: The AR tab — balance and ledger

**Files:**
- Create: `packages/web/components/ar/ar-tab.tsx`
- Modify: `packages/web/app/accounts/[id]/page.tsx`
- Test: `packages/web/components/ar/__tests__/ar-tab.test.tsx`

**Interfaces:**
- Consumes: `GET /api/v1/accounts/:id/ledger` from Task 1; `usePermission` from `@/lib/use-permission`; `DataTable`, `StatCard`, `useToast` from `@/components/ui/*`.
- Produces: `<ArTab accountId={string} />`, mounted as the `ar` tab.

- [ ] **Step 1: Write the failing component tests**

Mock `apiClient.get` and assert on rendered text. The cases are the Review Focus ones, because they are what a table gets wrong:

```tsx
it("says nothing is owed when the ledger is empty", async () => {
  mockGet({ data: [], balance: "0.00", openCount: 0 });
  render(<ArTab accountId="a1" />);
  expect(await screen.findByText(/nothing owed/i)).toBeInTheDocument();
  // Not an empty grid with headers.
  expect(screen.queryByRole("table")).not.toBeInTheDocument();
});

it("says the customer is in credit rather than showing a negative amount due", async () => {
  mockGet({ data: [paymentRow("-20.00", "-20.00")], balance: "-20.00", openCount: 1 });
  render(<ArTab accountId="a1" />);
  expect(await screen.findByText(/in credit/i)).toBeInTheDocument();
  expect(screen.getByText("$20.00")).toBeInTheDocument();
  expect(screen.queryByText("-$20.00")).not.toBeInTheDocument();
});

it("shows what is still owed separately from what was charged", async () => {
  mockGet({ data: [chargeRow("40.00", "15.00")], balance: "15.00", openCount: 1 });
  render(<ArTab accountId="a1" />);
  expect(await screen.findByText("$40.00")).toBeInTheDocument();  // charged
  expect(screen.getByText("$15.00")).toBeInTheDocument();          // still open
});

it("marks a reversed entry as reversed, so it does not read as a double charge", async () => {
  mockGet({
    data: [
      { ...chargeRow("50.00", "0.00"), id: "e1", reversedByEntryId: "e2" },
      { ...reversalRow("-50.00"), id: "e2", reversesEntryId: "e1" },
    ],
    balance: "0.00",
    openCount: 0,
  });
  render(<ArTab accountId="a1" />);
  expect(await screen.findByText(/reversed/i)).toBeInTheDocument();
});

it("hides actions the user has no permission for", async () => { /* Task 3 covers the matrix */ });
```

- [ ] **Step 2: Run to verify they fail.**

- [ ] **Step 3: Write the tab**

Shape, following `BillsTab`:

- A header row of `StatCard`s: **Amount due** (or **In credit** when the balance is negative, shown as a positive number with the word), and **Open items** from `openCount`.
- A `DataTable` of rows: Date (`effectiveDate`), Type (a readable label, not the enum — "Bill charge", "Payment", "Late fee" from `reasonLabel` when present), Charged (`amount`), Still owed (`openAmount` or `—` when settled), and a note column carrying `billNumber`, `tender`, `memo`, and a **Reversed** marker when `reversedByEntryId` is set or **Reverses** when `reversesEntryId` is.
- Signs rendered as meaning, not arithmetic: a negative `amount` shows as a credit — `($25.00)` or a distinct colour via `var(--text-secondary)` — never as a raw minus the reader has to interpret.
- Empty state through `ListEmptyCta`, saying nothing is owed rather than drawing an empty table.

- [ ] **Step 4: Mount it**

In `app/accounts/[id]/page.tsx`, add `{ key: "ar", label: "AR" }` to the `tabs` array after `bills`, and render `<ArTab accountId={id} />` when `activeTab === "ar"`.

- [ ] **Step 5: Run the web suite, typecheck, commit.**

---

## Task 3: Actions — post, pay, reverse

**Files:**
- Create: `packages/web/components/ar/record-payment-dialog.tsx`
- Modify: `packages/web/components/ar/ar-tab.tsx`
- Test: `packages/web/components/ar/__tests__/ar-tab-actions.test.tsx`

**Interfaces:** Consumes `POST /api/v1/accounts/:id/payments`, `POST /api/v1/bills/:id/post`, `GET /api/v1/accounts/:id/unposted-bills`, `POST /api/v1/ledger-entries/:id/reverse`.

- An **unposted bills** strip above the table when `GET unposted-bills` returns any, each with a **Post** button gated on `accounts:EDIT`. This is §8's "unposted-bills list with a Post action", and it is the only way to post a bill without curl.
- **Record payment** button gated on `payments:CREATE`, opening a dialog: amount, tender (the five `PaymentTender` values), received date, external reference, memo. On success, toast the new balance and refresh.
- **Reverse** on a row, gated on `payments:EDIT`, behind `ConfirmDialog` — it is irreversible in the sense that it writes history that cannot be removed. The confirm text names what will be restored.

- [ ] **Step 1: Write the failing tests** — the permission matrix is the point:

```tsx
it("shows record-payment to payments:CREATE and hides waive from a user without ar_adjustments", async () => {
  mockPermissions({ payments: ["VIEW", "CREATE"], accounts: ["VIEW"] });
  /* ... */
  expect(await screen.findByRole("button", { name: /record payment/i })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /waive/i })).not.toBeInTheDocument();
});

it("hides the Post action without accounts:EDIT", async () => { /* ... */ });

it("surfaces the API's error message when a payment is refused", async () => {
  mockPost(() => Promise.reject(Object.assign(new Error("Validation failed"), { status: 400 })));
  /* assert the toast, and that the dialog stays open so the entry is not lost */
});
```

- [ ] **Steps 2-5:** implement, run, commit.

---

## Task 4: Actions — fee, waive, write off; and the docs

**Files:**
- Create: `packages/web/components/ar/adjust-dialog.tsx`
- Modify: `packages/web/components/ar/ar-tab.tsx`
- Modify: `docs/specs/23-accounts-receivable.md`, `docs/design/utility-cis-architecture.md`

One dialog, three modes, because the three differ only in which endpoint they call and which reason type they offer:

| Mode | Endpoint | Reason filter | Needs a target row |
|---|---|---|---|
| Fee | `POST /accounts/:id/fees` | `appliesToType=FEE` | no |
| Waive | `POST /accounts/:id/waivers` | `appliesToType=ADJUSTMENT_CREDIT` | yes |
| Write off | `POST /accounts/:id/write-offs` | `appliesToType=WRITE_OFF` | yes |

The reason dropdown is populated from `GET /api/v1/ar/reasons?appliesToType=…`, which is why that filter exists — a waive dialog offering write-off reasons would be the obvious failure, and the API would 422 it.

- [ ] **Step 1: Failing tests**, including the one that matters most for §3.5: the waive dialog must not offer write-off reasons, and the write-off dialog must not offer waiver reasons. If a user can pick the wrong one the API refuses it with 422, so this is about not presenting an impossible choice.
- [ ] **Step 2:** also assert the empty-reasons case — a tenant that has never seeded reason codes gets a message pointing at `POST /ar/reasons/seed-defaults`, not an empty dropdown with a disabled submit.
- [ ] **Steps 3-5:** implement, run, commit.
- [ ] **Step 6: Docs** — spec 23's UI section stops saying "nothing"; architecture §8 records that the AR tab ships and names what is still missing (statement, aging, portal).

---

## Self-Review

**Spec coverage.** §8's "AR tab: ledger, aging summary, record-payment, adjust/waive actions" — ledger and the actions here; **aging summary deliberately deferred** with 4b's query, and that is a visible gap against §8 which I am naming rather than quietly dropping. §10 slice 4's other three deliverables are scoped out above with reasons.

**Placeholders.** Task 1 carries full code and test bodies. Tasks 2-4 give the component contract, the rendering rules, the permission matrix and the test intents, but not every line of JSX — the house pattern is `BillsTab` and copying 200 lines of inline styles into a plan would make it less accurate than pointing at the file. Every decision is made; no step says "style appropriately".

**Type consistency.** `LedgerRow` / `LedgerPage` are defined once in Task 1 and consumed by name in Tasks 2-4. The tab takes `accountId` only, like `BillsTab`, and reads permissions itself rather than being passed them.

**Review Focus coverage.** Empty ledger → Task 2. Credit balance → Task 2. Reversed entry → Tasks 1 and 2. Settled versus part-settled → Tasks 1 and 2. Permission matrix → Task 3.

**Known risks.** (1) Task 2 adds a tab to a page that already has eight; if the bar wraps badly at phone width that is a real finding about `Tabs`, not about AR. (2) `usePermission` is globally mocked to "all allowed" in `packages/web/vitest.setup.ts`, so Task 3's permission-matrix tests MUST override it per case with `vi.mocked(...).mockReturnValue(...)` — the default makes every action visible and a test that forgets to override will pass while asserting nothing.

**Checked, not assumed.** The web harness is ready for this: `vitest.setup.ts` already mocks `@/lib/api-client` with `vi.fn()` per method and `@/lib/use-permission` with an all-allowed default, shims `matchMedia` for `DataTable`'s breakpoint hook, and `entity-list-page.test.tsx` is a working example of `vi.mocked(apiClient.get)` plus `userEvent`. No new test infrastructure is needed.
