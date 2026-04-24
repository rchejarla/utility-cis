# Customer Graph View — Spec

**Date:** 2026-04-24
**Scope:** New visual overview of a customer's relationships — a force-directed graph with a linked event timeline. Complements existing tables/forms; does not replace them.

---

## 1. Goals and non-goals

### Goals

- Give CSRs, supervisors, and admins a single spot to see *everything* tied to a customer — accounts, premises, agreements, meters, service requests — and the relationships between them, without tabbing through five screens.
- Support click-through to existing detail pages from any node so the graph is a navigator, not a replacement.
- Lay data-model groundwork for time-travel (v2) — every node and edge carries a validity window from day one so v2 is a renderer change, not a data-model change.
- Be *data-dense*: nodes are cards with real identifiers (meter #, SR #, SLA status), not abstract dots. The page should answer real questions at a glance ("which meters are on this customer's agreements?", "how many open SRs?").

### Non-goals (v1)

- **Time-scrubbing** (phase-shifting the graph through past states). Reserved for v2 — see §6.
- **Editing from the graph.** Clicking a node previews + jumps to the existing detail page for edits; nothing is mutable directly from the graph.
- **Portal surface.** Admin-only; customer portal gets its own scoped view later if needed.
- **Cross-customer navigation.** One customer per render. A global graph across all customers is out of scope and probably a bad idea.
- **Export / embed.** Not PDF, not PNG, not iframe. Just a screen for now.

---

## 2. v1 — graph + linked timeline strip

### 2.1 Layout

Full-page under `/customers/:id/graph`, linked from the customer detail page header (a "View as graph" secondary action).

```
┌─────────────────────────────────────────────────────────┐
│  Customer: Jane Smith             [Back to detail]      │
├─────────────────────────────────────────────────────────┤
│                                                         │
│                      [GRAPH CANVAS]                     │
│                                                         │
│                (React Flow, ~70% height)                │
│                                                         │
├─────────────────────────────────────────────────────────┤
│  TIMELINE STRIP — chronological events for this customer│
│                (~25% height, scrollable)                │
└─────────────────────────────────────────────────────────┘
```

- Right-side drawer (collapsible) shows the currently-selected node's preview card + "Open full page" button.
- Top-right filter chip row: entity-type toggles to hide categories (e.g., hide Service Requests to declutter).

### 2.2 Node types + custom cards

Each entity type gets a custom React Flow node. Colors match the existing CIS tokens; accents mirror the sidebar module.

| Node type | Label | Accent | Core data shown |
|---|---|---|---|
| Customer | Name + CustomerType badge | `--accent-primary` | Full name / org, status |
| Account | AccountNumber | `--accent-secondary` | Type, balance, status |
| Premise | AddressLine1 | `--accent-tertiary` | City/state, premise type |
| ServiceAgreement | AgreementNumber | `--info` | Commodity name + rate schedule code |
| Meter | MeterNumber | `--success` | Commodity, most recent read |
| ServiceRequest | RequestNumber | `--warning` (or `--danger` if breached) | Type, status, SLA countdown |

Nodes are ~160×80 cards with an icon, monospace identifier, and one-line subtext. Larger than default dots but still comfortably 40+ nodes on screen.

### 2.3 Edges

- Customer → Account: ownership (solid line, no label)
- Customer → Premise: "owns" (solid, thin)
- Account → ServiceAgreement: solid
- Premise → ServiceAgreement: dashed (context — the agreement happens at this premise)
- ServiceAgreement → Meter: via `service_agreement_meter`
- Account → ServiceRequest: solid
- Premise → ServiceRequest: dashed (where the SR is located)

All edges carry tooltip metadata (relationship type + formation date) but render unlabeled by default to reduce visual noise.

### 2.4 Layout algorithm

React Flow's built-in force layout (or ELK for hierarchical) with seed positions:
- Customer fixed at center.
- Accounts radiate clockwise from the 12 o'clock direction.
- Premises radiate counter-clockwise.
- Agreements cluster between their account and their premise.
- Meters hang off their agreement.
- Service Requests orbit their account.

Layout is deterministic (seeded) so refreshing the page doesn't reshuffle visually.

### 2.5 Timeline strip

Horizontal scrollable list of events, oldest → newest:
- Customer created
- Account opened / closed
- Service agreement signed / ended
- Meter installed / removed
- Service request filed / completed
- Delinquency action taken
- Payment received (if Module 10 lives by v1 ship)

Each event is a pill with date + short label + icon matching the corresponding node type. Hovering an event highlights the related node(s) in the graph with a glow; clicking the event centers the graph on that node.

### 2.6 Right-side preview drawer

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
  events: TimelineEvent[];
}

interface GraphNode {
  id: string;                       // stable DB id
  type: "customer" | "account" | "premise" | "agreement" | "meter" | "service_request";
  label: string;                    // primary display (name / number / address)
  subtext?: string;                 // one-liner secondary (status, balance, etc.)
  data: Record<string, unknown>;    // full row for preview drawer
  validFrom: string;                // ISO — when this node became part of the customer's graph
  validTo: string | null;           // ISO — when it was closed/removed, null if active
}

interface GraphEdge {
  from: string;                     // node id
  to: string;                       // node id
  kind: "owns" | "has_account" | "at_premise" | "measured_by" | "filed_against";
  validFrom: string;
  validTo: string | null;
}

interface TimelineEvent {
  id: string;
  occurredAt: string;               // ISO
  kind: string;                     // "account.opened", "agreement.signed", etc.
  label: string;                    // human-readable
  relatedNodeIds: string[];         // nodes this event affects — drives cross-highlight
}
```

The `validFrom / validTo` fields carry no weight in v1 (the renderer shows all active-or-closed nodes equally) but are the foundation for v2's time-travel.

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
- Include all premises where `owner_id = customer.id`.
- Include all agreements under any of the above accounts.
- Include meters via `service_agreement_meter`.
- Include service requests for any of the above accounts (last 90 days + all open).
- Cap total nodes at 200 for v1; beyond that, return an `{ truncated: true }` flag and a warning node.

---

## 5. Implementation plan (v1)

Commits, roughly:

1. Spec doc (this file).
2. `GET /api/v1/customers/:id/graph` — service + route + validator.
3. Dependency add: `@xyflow/react`.
4. Page shell at `/customers/:id/graph` — fetches the DTO, renders a placeholder graph.
5. Custom node components for the six entity types.
6. Edge styling + layout seeding.
7. Right-side preview drawer + double-click navigation.
8. Timeline strip + cross-highlighting.
9. Link from customer detail header.

---

## 6. v2 — time-scrubbing graph (design only)

### 6.1 UX shape

Add a horizontal date slider to the timeline strip. Drag it and the graph *animates* to reflect the customer's state at the selected point in time:

- Nodes appear when their `validFrom` reaches the slider.
- Nodes dim / disappear when their `validTo` passes.
- Edges rewire accordingly.
- A "▶ Play" button animates forward from the customer's creation to now over ~20 seconds.
- Keyboard arrows step to the next/previous event.
- Date label pinned above the slider; key events marked as ticks.

The static "today" view is still the default — the scrubber is an opt-in mode.

### 6.2 Why this matters

Utility customers accumulate state over years. A snapshot hides:
- Was this premise always on this customer, or inherited from a prior owner?
- When did the second commodity get added?
- Did this SR get filed during the delinquency episode or after?

A time-scrubber answers each of those with a gesture. It's the feature no other CIS has because most of them model customer history as an audit log, not as a dimension of the live graph.

### 6.3 Why v2 (not v1)

Implementation cost:
- Renderer has to respect a `asOf` timestamp and recompute visibility per node/edge.
- Timeline strip needs keyframe markers instead of just event pills.
- Animation transitions (fade in/out, edge re-route) require layout stability across frames.
- Performance sensitivity: we can't re-run force layout per frame for large customers.

None of this is hard individually; all of it is distracting while landing v1. The v1 DTO already carries `validFrom/validTo`, so v2 is a pure-frontend change.

### 6.4 v2 scope

Three commits once v1 is live and used:
1. `TimeScrubber` component + slider + play/pause.
2. `asOf`-aware graph renderer (filter by `validFrom ≤ asOf < validTo`).
3. Transition animations + event markers on the slider.

---

## 7. Deferred (post-v2)

- Export to PNG / SVG.
- Custom layout — user drags nodes, positions persist per (user, customer).
- "Find path" between two arbitrary nodes.
- Multi-customer view (entire household / org hierarchy).
- Portal-facing consumer version.
- Integration with the graph database — useful when relationships get deeper than 2 hops.

---

## 8. Risks

- **Node count on industrial customers.** A manufacturing site with 40 meters and 8 years of SRs could blow past 200 nodes. Truncation is v1's answer; if truncation happens often, we revisit scope filtering (e.g., "show only open").
- **Layout readability.** Force layouts can look tangled. Seeded positioning + category clustering should keep the 20–60 node median readable; above 100, we may need a "hide category" affordance and we already have it.
- **React Flow bundle size.** `@xyflow/react` adds ~150kb. Acceptable for a feature page, not something to include in the main shell.
