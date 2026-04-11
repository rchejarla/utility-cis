# Phase 3 — Billing UI Mockups

Standalone HTML mockups for the Phase 3 SaaSLogic billing integration. Open the `.html` files directly in a browser to preview. These are design spikes that will be ported to the Next.js app when backend readiness permits.

## Files

| File | Purpose |
|---|---|
| `customer-bills.html` | New **Bills** tab on the customer detail page |
| `billing-cycle.html` | **Billing cycle detail** page with line-item state machine |
| `agreement-billing.html` | New **Billing** tab on the service agreement detail page |
| `billing.css` | Shared stylesheet — mirrors the existing CIS design tokens and component styles |

## Design approach

These mockups stay strictly inside the existing CIS design language. No new typefaces, no new accent colors, no new layout patterns. The goal is for these new pages to look indistinguishable from the rest of the app.

**Tokens reused as-is from `packages/web/app/globals.css`:**
- Dark background layering (`--bg-deep` / `--bg-surface` / `--bg-card` / `--bg-elevated` / `--bg-hover`)
- Indigo / cyan / violet accent system (`--accent-primary` and friends)
- Semantic colors (`--success` / `--warning` / `--danger` / `--info`) — Paid invoices use `--success`, not a bespoke color
- DM Sans for body, JetBrains Mono for numeric values (the same pairing `StatCard` uses today)
- 10px border radius throughout

**Components replicated from `packages/web/components/ui/`:**
- `PageHeader` — 22px/600 title, 14px secondary subtitle, primary action button on the right
- `StatCard` — icon chip + JetBrains Mono value + label, `flex: 1 1 160px`
- `StatusBadge` — rounded pill with a 6px colored dot, subtle background + colored border + colored text
- `DataTable` — table on `--bg-card`, `--bg-elevated` header with 11px/600/uppercase column labels, 13px row text, `--border-subtle` row dividers, `--bg-hover` on row hover
- `Tabs` — horizontal tab strip with a 2px `--accent-primary` underline on the active tab
- Card with a 13px uppercase section header + 180px label / 1fr value field grid (matches the pattern used on customer, meter, premise, and agreement detail pages)
- Sidebar nav with grouped sections and an active-state indigo pill (matches the real sidebar)

## Page layouts

### Customer → Bills tab

Follows the same shape as every other customer detail tab:
1. Crumb line above the title
2. `PageHeader` with customer name + type/status subtitle + Edit / "Issue ad-hoc charge" actions
3. Four `StatCard`s across the top: Balance due (danger), Year to date (neutral), Lifetime paid (success), On-time rate (neutral)
4. Tab strip with Bills as the active tab
5. `DataTable` with columns: Invoice # · Period · Premise · Commodities · Amount · Status · Action. Amounts right-aligned in mono. Status column uses `StatusBadge` with the existing tones. "View invoice" link-outs at the end of each row go to the SaaSLogic hosted URL.

### Billing cycle detail

1. Crumb line
2. `PageHeader` with cycle name + closed-at subtitle + "Export batch report" / "Retry failed" actions
3. Four `StatCard`s: Line items · Agreements in cycle · Pushed so far (success) · Failures (danger)
4. Tab strip (Line items · Aggregation rules · Agreements in cycle · Call log)
5. Four-column kanban for the `BillingLineItem` state machine: Pending → Sent → Acked → Failed. Each column is a card styled like the existing list containers with a header row on `--bg-elevated` and compact rows underneath. Error messages in the Failed column use `--danger` color to make them scannable.

### Agreement → Billing tab

1. Crumb line
2. `PageHeader` with agreement number + an inline Active badge, customer/premise/commodity subtitle
3. Tab strip with Billing as the active tab (alongside existing Overview, Meters, Reads, etc.)
4. Two-column card layout — the same `card` / `field` pattern the existing detail pages use:
   - **SaaSLogic Subscription** card: subscription ID, plan, provisioned date, link status badge, last reconciled time, primary action buttons at the bottom
   - **Current Cycle Snapshot** card: period, closes in, accumulated usage, estimated charge, last interval read, line item state badge
5. Recent activity `DataTable` at the bottom: When · Event · Detail · Amount · Status

## What is *not* here

Everything I put in the first pass that did not belong:
- No Fraunces serif, no italic display, no oversized numerals, no `§` watermarks
- No "gold" accent color reserved for PAID — the existing `--success` covers it
- No vertical timeline rail — a regular table reads better and matches every other list in the app
- No radial atmosphere glow, no grain overlay, no staggered load animations
- No "Treasury" wordmark

## Porting notes

- Every visual choice already has a component in `packages/web/components/ui/`. When porting, the HTML maps more or less 1:1 to `<PageHeader>`, `<StatCard>`, `<Tabs>`, `<DataTable>`, `<StatusBadge>`, and the existing `fieldStyle` / `cardStyle` patterns used on customer detail.
- The kanban columns on the cycle detail page are the one new layout, but they are just `DataTable`-style containers stacked horizontally — no new primitive needed. A lightweight `<KanbanColumn title count>` wrapper would be enough.
- The "Bills" tab for customer detail can be added to `packages/web/app/customers/[id]/page.tsx` alongside the existing Accounts / Contacts / Premises / Attachments tabs.
- The "Billing" tab for agreement detail goes in `packages/web/app/service-agreements/[id]/page.tsx`.
- The billing cycle detail page replaces or extends the existing billing-cycle detail route.
