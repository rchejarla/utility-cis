# Customer Graph View — Spec

**Date:** 2026-04-24
**Last updated:** 2026-04-24 (post-ship polish — timeline removed, filter chips removed, three-row layout replaces force/ELK)
**Scope:** New visual overview of a customer's relationships — an org-chart-style graph of accounts, premises, agreements, meters, and service requests. Complements existing tables/forms; does not replace them.

---

## 1. Goals and non-goals

### Goals

- Give CSRs, supervisors, and admins a single spot to see *everything* tied to a customer — accounts, premises, agreements, meters, service requests — and the relationships between them, without tabbing through five screens.
- Support click-through to existing detail pages from any node so the graph is a navigator, not a replacement.
- Be *data-dense*: nodes are cards with real identifiers (meter #, SR #, SLA status), not abstract dots. The page should answer real questions at a glance ("which meters are on this customer's agreements?", "how many open SRs?").

### Non-goals

- **Editing from the graph.** Clicking a node previews + jumps to the existing detail page for edits; nothing is mutable directly from the graph.
- **Portal surface.** Admin-only; customer portal gets its own scoped view later if needed.
- **Cross-customer navigation.** One customer per render. A global graph across all customers is out of scope and probably a bad idea.
- **Export / embed.** Not PDF, not PNG, not iframe. Just a screen for now.
- **Time-scrubbing / history animation.** Not planned. Node and edge validity windows (`validFrom`, `validTo`) stay on the DTO because they're already populated from real row data (account `closedAt`, meter `removalDate`, etc.) and the card chrome dims closed/removed entities, but there's no renderer mode that treats them as a time axis.

---

## 2. Graph view

### 2.1 Layout

Full-page under `/customers/:id/graph`, linked from the customer detail page header (a "View as graph" secondary action). The page fills the viewport — no outer scrollbar:

```
┌─────────────────────────────────────────────────────────┐
│  CUSTOMER  Jane Smith                  [← Back to detail]│
├─────────────────────────────────────────────────────────┤
│                                                         │
│                                                         │
│                     [GRAPH CANVAS]                      │
│                        (fills)                          │
│                                                         │
│                                                         │
└─────────────────────────────────────────────────────────┘
```

- Top row is a thin identity bar — `CUSTOMER` label, the customer's name, and the back-to-detail link pinned to the right. It's the only chrome above the canvas.
- Floating fullscreen toggle lives at the top-right of the canvas itself (uses the browser Fullscreen API so the whole page — identity bar and all — takes over the screen).
- Right-side drawer opens on single-click and shows the selected node's preview card + "Open full detail page" button.
- React Flow built-in zoom controls (`+` / `−` only) sit at the bottom-left of the canvas. Fit-view, the interactive lock, and MiniMap are all off: they fought the fullscreen toggle or added no value.

### 2.2 Node types + custom cards

Each entity type gets a custom React Flow node. Colors match the existing CIS tokens; accents mirror the sidebar module.

| Node type | Label | Accent | Core data shown |
|---|---|---|---|
| Customer | Name + CustomerType badge | `--accent-primary` | Full name / org, status |
| Account | AccountNumber | `--accent-secondary` | Type, balance, status |
| Premise | AddressLine1 | `--accent-tertiary` | City/state, premise type |
| ServiceAgreement | AgreementNumber | `--info` | Commodity name + rate schedule code |
| Meter | MeterNumber | `--success` | Meter type, install date |
| ServiceRequest | RequestNumber | `--warning` (or `--danger` if breached) | Type, status |

Nodes are ~180×72 cards with a colored left rail (3px accent band), icon, entity-type uppercase label, monospace identifier, and one-line subtext. Closed / removed entities (validTo ≠ null) render at 55% opacity with a status suffix (`(closed)` / `(removed)`).

### 2.3 Edges

Seven kinds, split into a solid spanning tree + a single dashed cross-link:

| Kind | From → To | Style | Purpose |
|---|---|---|---|
| `owns_premise` | Customer → Premise | solid, `--accent-primary`, via `TrunkEdge` | Customer owns/serves at this premise |
| `owns_account` | Customer → Account | solid, `--accent-primary`, via `TrunkEdge` | Customer's billing envelope |
| `premise_has_meter` | Premise → Meter | solid, `--success` | Device at this location |
| `premise_has_service_request` | Premise → ServiceRequest | solid, `--warning` | SR filed about this location |
| `agreement_billed_by_account` | Agreement → Account | solid, `--accent-secondary` | Agreement's billing parent |
| `service_request_on_account` | ServiceRequest → Account | solid, `--warning` | SR's billing-side parent |
| `agreement_uses_meter` | Agreement → Meter | **dashed**, `--success`, 1px | The cross-link: billing ↔ physical bridge |

`TrunkEdge` is a custom React Flow edge that draws an org-chart path (down, across to a shared trunk x, down the trunk, across into target) so every customer→premise edge shares one visible vertical spine behind the premise column, and likewise for accounts.

No explicit premise→agreement edge. The premise↔agreement relationship is expressed transitively through `premise_has_meter` + `agreement_uses_meter`; drawing it directly added a long line across the row without adding information.

Edges carry a `<title>` tooltip with the kind + validFrom but render unlabeled.

### 2.4 Layout algorithm

Bespoke three-row grid (no force layout, no dagre):

```
Row 1                     Customer (centered)
Row 2   Premises │ Meters │ Agreements │ Accounts
Row 3                    Service Requests
```

Column x positions are fixed (`0, 300, 600, 900`) so the visual alignment is predictable across customers.

**Row 2 ordering:**
- Premises sort by meter count DESC — the busiest physical site floats to the top. Tie-break by id for render stability.
- Meters fan symmetrically around their parent premise's y (the premise y is the midpoint of its meters' y spread).
- Accounts sort to align with the topmost premise their agreements serve, so the billing column mirrors the physical column rather than running independently.
- Agreements fan symmetrically around their parent account's y.

**Row 1 & 3:**
- Customer centers horizontally across the full canvas width.
- Service requests spread evenly along the bottom, connecting up to their premise (row 2 col 1) and across to their account (row 2 col 4).

Layout is deterministic — refreshing doesn't reshuffle.

### 2.5 Right-side preview drawer

Selecting a node (single click) opens a right drawer with:
- Entity type header
- 3–5 key fields
- "Open full detail page →" button

Double-click navigates to the existing detail page directly.

---

## 3. Data model — CustomerGraph DTO

The API returns one self-contained payload per request. Shape:

```ts
interface CustomerGraphDTO {
  customerId: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
  /** True when the graph exceeded the server-side node cap (200). */
  truncated: boolean;
}

interface GraphNode {
  id: string;                       // stable DB id, namespaced: "premise:<uuid>"
  type: "customer" | "account" | "premise" | "agreement" | "meter" | "service_request";
  label: string;                    // primary display (name / number / address)
  subtext?: string;                 // one-liner secondary (status, balance, etc.)
  data: Record<string, unknown>;    // full row for preview drawer
  validFrom: string;                // ISO — when this node became part of the customer's graph
  validTo: string | null;           // ISO — when it was closed/removed, null if active
}

interface GraphEdge {
  id: string;
  from: string;                     // node id
  to: string;                       // node id
  kind:
    | "owns_account"
    | "owns_premise"
    | "premise_has_meter"
    | "premise_has_service_request"
    | "agreement_billed_by_account"
    | "service_request_on_account"
    | "agreement_uses_meter";
  validFrom: string;
  validTo: string | null;
}
```

`validFrom` / `validTo` drive the closed/removed card chrome in §2.2 (dimmed 55% + status suffix) but nothing else — the renderer does not hide expired edges or time-filter the graph.

---

## 4. API

Single endpoint:

```
GET /api/v1/customers/:id/graph
Response: CustomerGraphDTO
```

Required permission: `customers:VIEW`.

Server aggregates from existing tables in one tenant-scoped read. Scope limits:
- Include all accounts for the customer regardless of status.
- Include all premises the customer owns AND all premises where the customer has a service agreement (even if they don't own it).
- Include all agreements under any of the above accounts.
- Include meters via `service_agreement_meter`.
- Include the most recent 50 service requests per account (ordered by `createdAt` DESC).
- Cap total nodes at 200; beyond that, return `truncated: true` and the UI shows a warning banner.

---

## 5. Implementation (v1 — shipped)

Landed in these commits (roughly):

1. Spec doc (this file).
2. `GET /api/v1/customers/:id/graph` — service + route.
3. Shared DTO types (`packages/shared/src/validators/customer-graph.ts`).
4. Dependency add: `@xyflow/react`.
5. Page shell at `/customers/:id/graph` — fetches + renders a placeholder.
6. Six custom node components (`graph-nodes.tsx`) with handle pairs on all four sides.
7. `TrunkEdge` custom edge for the customer spine.
8. Three-row layout algorithm + premise/account ordering by meter count / parent-premise.
9. Right-side preview drawer + double-click navigation.
10. Link from customer detail header.
11. Post-ship polish: dropped MiniMap, the fit-view/interactive-lock Controls buttons, and the v1 "hide by type" filter chips; added the customer-name identity bar + fullscreen toggle.
12. Post-ship cleanup: removed the chronological `TimelineStrip` and the `events` field on `CustomerGraphDTO`. The event pills were mostly redundant with what the graph already shows.

---

## 6. Deferred

- Export to PNG / SVG.
- Custom layout — user drags nodes, positions persist per (user, customer).
- "Find path" between two arbitrary nodes.
- Multi-customer view (entire household / org hierarchy).
- Portal-facing consumer version.
- Integration with the graph database — useful when relationships get deeper than 2 hops.

---

## 7. Risks and what we learned

- **Node count on industrial customers.** A manufacturing site with 40 meters and 8 years of SRs could blow past 200 nodes. Truncation is the current answer. If truncation happens often we'll scope-filter (e.g., "show only open").
- **React Flow bundle size.** `@xyflow/react` adds ~150kb. Acceptable for a feature page, not something to include in the main shell.
- **Layout churn.** We tried a radial force layout, then dagre, before landing on the bespoke three-row grid. The grid makes the visual semantically load-bearing — reading left-to-right tells you the physical → billing story — which neither auto-layout managed. Worth keeping in mind for future graph-shaped features: a domain-specific layout often beats a general one.
- **Chrome creep.** The v1 spec added filter chips and a timeline strip on top of the graph. In use, both added clutter without paying their way: the graph already fits on one screen, and the event pills were mostly a restatement of what the nodes show. Removing them tightened the page considerably. Lesson: don't ship supporting chrome until the core view proves it needs it.
