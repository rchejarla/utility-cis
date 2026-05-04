# Rate Model v2 — Slice 2: Visual Configurator UI — Spec

**Date:** 2026-05-04
**Slice of:** Rate Model v2 ([`07b-rate-model-v2-design.md`](../../specs/07b-rate-model-v2-design.md))
**Builds on:** Slice 1 schema + Slice 3 engine + Slice 4 loaders (all shipped)
**Scope:** Web UI for tenants to author RateComponents on a RateSchedule. Skip what isn't core to the configurator workflow.

---

## 1. Goals and non-goals

### Goals (MVP)

- Replace the "Components (coming soon)" placeholder on the rate-schedule detail page with a real component list + add/edit/delete UX.
- A **structured component editor** that:
  - Picks `kindCode` from a dropdown driven by the rate-grammar (closed grammar).
  - Renders a per-pricing-type editor for the **4 most common types**: `flat`, `tiered`, `lookup`, `percent_of`. The other 4 types (`catalog`, `per_unit`, `indexed`, `floor`) fall back to a Zod-validated JSON textarea — fine for MVP.
  - Renders a **structured predicate builder** for the common cases: `{}`, `{class}`, `{class_in}`, `{drought_stage_active}`, `{premise_attr}`. Other operators fall back to JSON textarea.
  - Renders a **structured quantity-source builder** for the common cases: `metered`, `wqa`, `fixed`, `item_count`, `linked_commodity`. Transforms get a JSON textarea (rare use; no need to make this fancy).
- **Server-side validation** on save:
  - Zod parses the component (already there from Slice 1)
  - **New: cycle-detection endpoint** that runs `detectCycles` against the schedule's components and rejects the save if the new/edited component would introduce a cycle.
- **Variable picker** dropdown driven by a new `/api/v1/rate-grammar/registered` endpoint that exposes loader capabilities + closed-grammar atoms. Used by the predicate builder + quantity-source builder + pricing editors anywhere a `{var: "..."}` reference is allowed.
- SA detail page shows the assigned schedules with their components (read-only — write happens on the schedule pages).

### Non-goals

- **Per-kind editors for `catalog`, `per_unit`, `indexed`, `floor`** — JSON textarea is OK for MVP. Add structured editors when a tenant complains.
- **Visual selector builder for `percent_of`** — just expose the closed-grammar selector ops as a dropdown + value field. Composition (`and`/`or`) via JSON.
- **Multi-step wizard** — single modal with the form is fine.
- **Rate index admin page** — Slice 1 ships CRUD endpoints; tenants can use API or Postman until UI lands. Defer.
- **Kind / role override management UI** — tenants rarely override; defer.
- **Configurator save-time validation against actual rate-engine execution** — beyond cycle detection. Don't try to "preview" the bill from the configurator; that's Slice 5's bill-preview territory.
- **Drag-to-reorder components** — `sortOrder` numeric input is fine. Skip drag handles.
- **Component diff view** — comparing two schedule versions side-by-side. Defer.
- **History / audit trail of component edits** — entity audit already happens via `auditCreate/auditUpdate`; UI surfaces this separately or not at all in MVP.

---

## 2. Architecture summary

The configurator lives in the existing Next.js web package at `packages/web/app/rate-schedules/[id]/page.tsx` (extended) and a new component editor under `packages/web/components/rate-schedules/`.

Backend additions:
- `GET /api/v1/rate-grammar/registered` — exposes the closed-grammar atoms (kinds, pricing types, predicate ops, transforms, selectors) plus loader capabilities. Drives configurator dropdowns. Read-only.
- `POST /api/v1/rate-schedules/:scheduleId/cycle-check` — accepts a proposed component (new or modified) and returns 200 if no cycle is introduced, 400 with cycle path if one would be.

Frontend additions:
- `<ComponentList>` — read-only component table on the schedule detail page
- `<ComponentEditor>` — modal form with per-kind editors
- `<PredicateBuilder>` — structured editor for common predicate operators
- `<QuantitySourceBuilder>` — structured editor for common quantity sources
- `<PricingEditor>` — switch over pricing.type; renders the appropriate sub-editor or JSON textarea fallback
- `<VariablePicker>` — dropdown driven by registered variables; lets users insert `{var: "..."}` refs

The new module structure on the frontend:

```
packages/web/components/rate-schedules/
├── component-list.tsx
├── component-editor.tsx
├── predicate-builder.tsx
├── quantity-source-builder.tsx
├── pricing-editor.tsx
├── pricing-editors/
│   ├── flat-editor.tsx
│   ├── tiered-editor.tsx
│   ├── lookup-editor.tsx
│   ├── percent-of-editor.tsx
│   └── json-fallback-editor.tsx
└── variable-picker.tsx
```

---

## 3. New API endpoints

### `GET /api/v1/rate-grammar/registered`

Returns the closed-grammar atoms + loader capabilities for the configurator UI.

**Response shape:**

```jsonc
{
  "kinds": [
    { "code": "service_charge", "label": "Service Charge", "sortOrder": 10 },
    { "code": "consumption", "label": "Consumption", "sortOrder": 20 },
    // ... globals + tenant overrides resolved
  ],
  "pricingTypes": [
    { "code": "flat", "label": "Flat per unit", "structuredEditor": true },
    { "code": "tiered", "label": "Tiered blocks", "structuredEditor": true },
    { "code": "lookup", "label": "Lookup table", "structuredEditor": true },
    { "code": "catalog", "label": "Catalog (multi-key)", "structuredEditor": false },
    { "code": "per_unit", "label": "Per unit", "structuredEditor": false },
    { "code": "percent_of", "label": "Percent of selected lines", "structuredEditor": true },
    { "code": "indexed", "label": "Indexed value", "structuredEditor": false },
    { "code": "floor", "label": "Minimum floor", "structuredEditor": false }
  ],
  "predicateOps": [
    { "code": "and", "label": "AND" },
    { "code": "or", "label": "OR" },
    { "code": "class", "label": "Customer class equals", "structuredEditor": true },
    { "code": "class_in", "label": "Customer class is one of", "structuredEditor": true },
    { "code": "drought_stage_active", "label": "Drought stage is active", "structuredEditor": true },
    { "code": "premise_attr", "label": "Premise attribute", "structuredEditor": true },
    // ... rest
  ],
  "quantitySources": [
    { "code": "metered", "label": "Metered consumption" },
    { "code": "wqa", "label": "Winter Quarter Average" },
    { "code": "fixed", "label": "Fixed (1)" },
    { "code": "item_count", "label": "Count of attached items" },
    { "code": "linked_commodity", "label": "Linked commodity" },
    { "code": "premise_attribute", "label": "Premise attribute" },
    { "code": "peak_demand", "label": "Peak demand", "supported": false }
  ],
  "transforms": [
    { "code": "clamp", "label": "Clamp" },
    { "code": "net", "label": "Net (subtract)" },
    { "code": "prorate", "label": "Prorate by days" },
    { "code": "subtract_linked_commodity", "label": "Subtract linked commodity" },
    { "code": "floor", "label": "Floor (minimum)" },
    { "code": "ratchet", "label": "Ratchet (peak demand)", "supported": false }
  ],
  "selectorOps": [
    { "code": "component_id", "label": "Specific component" },
    { "code": "kind", "label": "By kind" },
    { "code": "kind_in", "label": "By kinds (multiple)" },
    { "code": "exclude_kind", "label": "Exclude kinds" },
    { "code": "source_schedule_id", "label": "By source schedule" },
    { "code": "source_schedule_role", "label": "By schedule role" },
    { "code": "has_label_prefix", "label": "By label prefix" }
  ],
  "variables": [
    // From registry.describeAll()
    {
      "pattern": "account:class",
      "scope": "per_sa",
      "description": "Customer service class for this SA's commodity"
    },
    {
      "pattern": "meter:reads:<meter_id>",
      "scope": "per_sa",
      "description": "Aggregated meter consumption for the billing period"
    },
    // ... all 8 loader namespaces
  ]
}
```

The endpoint sources data from:
- `kinds` — `prisma.rateComponentKind.findMany()` with override resolution (existing `listRateComponentKinds` service from Slice 1)
- `roles` — same pattern from `rate_assignment_role`
- `pricingTypes`, `predicateOps`, `quantitySources`, `transforms`, `selectorOps` — hardcoded constants in the engine module (export from `rate-engine/grammar-introspection.ts`)
- `variables` — `registry.describeAll()` against a registry built with all loaders

**Slice 2 simplification:** the `variables` section uses a static set rather than building a real registry per-request (since the registry is per-rating-call). Just hardcode the 8 namespaces' patterns + descriptions.

Permission: `rate_schedules:VIEW` — anyone who can view rate schedules can see the grammar.

### `POST /api/v1/rate-schedules/:scheduleId/cycle-check`

**Request body:**

```jsonc
{
  "componentId": "<id-or-null-if-new>",
  "kindCode": "surcharge",
  "predicate": { "drought_stage_active": true },
  "quantitySource": { "base": "metered" },
  "pricing": {
    "type": "percent_of",
    "selector": { "kind": "consumption" },
    "percent": 25
  },
  "sortOrder": 80
}
```

**Logic:**
- Fetch all current components for the schedule
- Replace/add the proposed component into the list (by `componentId` or as a new id if null)
- Run `detectCycles` from the rate engine
- Return 200 with `{ valid: true }` if no cycle
- Return 400 with `{ valid: false, cycle: [...componentIds] }` if cycle detected

This endpoint is hit by the configurator on save. Pure validation — does not persist.

Permission: `rate_schedules:EDIT`.

---

## 4. UI behavior

### Rate schedule detail page (`/rate-schedules/[id]`)

After this slice, the "Components (coming soon)" placeholder is replaced by:

- A **Components panel** with a table:
  - Columns: `sort_order` (sortable), `label`, `kind`, `pricing.type`, `effective range`, actions (edit / delete)
  - Sorted by `sortOrder` ascending
  - Row click opens edit modal
- An **"Add Component"** button that opens the editor modal in create mode

### Component editor modal

A single-modal form (no wizard). Fields:

1. **Label** — text input
2. **Kind** — dropdown driven by `kinds` from `/api/v1/rate-grammar/registered`. Once selected, the form below adapts.
3. **Sort order** — numeric input
4. **Effective date** + **Expiration date** — date pickers (both come from existing date-picker component)
5. **Predicate** — `<PredicateBuilder>` (see below)
6. **Quantity source** — `<QuantitySourceBuilder>` (see below)
7. **Pricing** — `<PricingEditor>` (see below)
8. **Save / Cancel** buttons

Save flow:
1. Client validates the assembled component with the existing Zod schema (re-imported from `@utility-cis/shared`).
2. Client POSTs to `/api/v1/rate-schedules/:scheduleId/cycle-check`. If cycle → show error inline, don't proceed.
3. Client POSTs to `/api/v1/rate-schedules/:scheduleId/components` (create) or PATCHes (edit). Existing CRUD from Slice 1.
4. On success, modal closes, component list refreshes.

Cancel: discard changes, close modal.

### `<PredicateBuilder>`

Two modes — picker on top:
- **Structured** (default): dropdown of common operators. Once chosen, render specific inputs:
  - `{}` (no predicate / always true) — no inputs, just a "no predicate" label
  - `{class}` — text input or dropdown of registered classes
  - `{class_in}` — multi-input
  - `{drought_stage_active}` — boolean toggle
  - `{premise_attr}` — three inputs: attr (dropdown), eq/ne (dropdown), value (text)
- **JSON** (escape hatch): Monaco-style or basic textarea with Zod validation on change

The "common operators" set is small: empty, class, class_in, drought_stage_active, premise_attr. Anything else → JSON.

`<QuantitySourceBuilder>` follows the same pattern — common bases get structured form, transforms always go through JSON textarea.

### `<PricingEditor>`

Pricing type dropdown drives which sub-editor renders:

- `flat` — `<FlatEditor>`: rate (numeric), unit (text)
- `tiered` — `<TieredEditor>`: dynamic table with `to` + `rate` columns; null `to` allowed for unbounded final tier
- `lookup` — `<LookupEditor>`: `by` field selector + key-value table editor
- `percent_of` — `<PercentOfEditor>`: selector picker (kind dropdown for MVP) + percent numeric input
- Other 4 types — `<JsonFallbackEditor>` with Zod validation

### `<VariablePicker>` component

Used inside predicate builder and pricing editor wherever a `{var: "..."}` reference is expected. Renders a dropdown sourced from `/api/v1/rate-grammar/registered`'s `variables` list. User selects a pattern, then fills wildcard params via inline inputs (e.g., for `meter:reads:<meter_id>`, the user inputs the meter id).

---

## 5. Test strategy

### 5.1 Backend

- New Zod schemas for `cycle-check` request body
- Integration test for `/api/v1/rate-grammar/registered`: returns all expected sections + at least the documented globals
- Integration test for `/api/v1/rate-schedules/:id/cycle-check`:
  - Returns 200 valid for a new component that doesn't introduce a cycle
  - Returns 400 with cycle path for a component that DOES introduce a cycle
  - Tests existing components stay unchanged when modifying one

### 5.2 Frontend

Vitest unit tests for the structured builders:
- `<PredicateBuilder>` round-trips: input value → form state → assembled value matches input
- `<TieredEditor>` correctly adds/removes/edits tiers
- `<LookupEditor>` correctly builds key/value table
- `<PercentOfEditor>` correctly assembles selector + percent

Skip Playwright/end-to-end UI tests for MVP; prefer fast vitest + visual review of the running app.

---

## 6. Risks and open issues

| Risk | Mitigation |
|---|---|
| **Tier editor complexity for break points** | Use a simple table with up/down sort buttons; auto-fill `null` for last tier. |
| **Predicate JSON escape hatch can produce invalid grammar** | Live Zod validation on every keystroke (debounced); show inline error. |
| **Variable picker UX for parameterized vars** (e.g. meter_id) | Two-step: pick the pattern, then fill the wildcard params via additional inputs. |
| **Cycle-check race**: tenant edits component A, then before save, tenant edits component B that creates a cycle with edited A. | Cycle check uses the saved-state schedule + the proposed component. If two edits race, the second save fails cycle check. Acceptable for MVP. |
| **Performance of the registered-grammar endpoint** | Cache the static parts (pricing types, etc.) in memory; only kinds/roles/variables vary by tenant. Fast. |
| **Existing rate-schedule revise flow** | Revise creates a new schedule with the same code, no components copied. The configurator works on the new (empty) version after revise — caller copies components manually for now. (Slice 2 doesn't add "copy components on revise" — defer.) |

---

## 7. Acceptance criteria

The slice is **done** when:

- [ ] Rate schedule detail page renders the components table and supports add/edit/delete
- [ ] Component editor modal works for all 11 kindCodes
- [ ] Structured pricing editors implemented for `flat`, `tiered`, `lookup`, `percent_of`
- [ ] JSON fallback editor handles the other 4 pricing types with Zod validation
- [ ] Structured predicate builder for empty / class / class_in / drought_stage_active / premise_attr
- [ ] Structured quantity-source builder for metered / wqa / fixed / item_count / linked_commodity
- [ ] `/api/v1/rate-grammar/registered` endpoint returns the documented shape
- [ ] `/api/v1/rate-schedules/:id/cycle-check` endpoint validates without persisting
- [ ] Save flow runs cycle check before persisting
- [ ] Variable picker reads from registered endpoint and inserts `{var: "..."}` refs
- [ ] SA detail page shows assignments with their schedules + components (read-only)
- [ ] Workspace typecheck clean
- [ ] Existing per-task tests pass; new backend tests pass; new frontend unit tests pass
- [ ] Slice 2 plan executed via subagent-driven-development

---

## 8. Out of scope (explicit)

- Structured editors for `catalog`, `per_unit`, `indexed`, `floor` pricing — JSON OK
- Selector composition UI (`and`/`or` of selectors) — JSON OK
- Rate index admin page — defer
- Kind/role override UI — defer
- Visual cycle highlight on the components table — error message only
- Drag-to-reorder
- Bill preview from configurator
- Multi-step wizard
- Component history / audit-trail UI

---

## 9. Implementation note: grouping into tasks

Suggested 9-task breakdown:

1. Backend: `/api/v1/rate-grammar/registered` endpoint + integration test
2. Backend: `/api/v1/rate-schedules/:id/cycle-check` endpoint + integration test
3. Frontend: `<ComponentList>` table on the rate-schedule detail page
4. Frontend: `<ComponentEditor>` modal scaffold (kind/label/sortOrder/dates) + JSON textareas for predicate/quantitySource/pricing fallback. Save → cycle-check → CRUD.
5. Frontend: structured `<PricingEditor>` for `flat` + `tiered`
6. Frontend: structured `<PricingEditor>` for `lookup` + `percent_of`
7. Frontend: structured `<PredicateBuilder>` and `<QuantitySourceBuilder>`
8. Frontend: `<VariablePicker>` integrated into predicate + pricing editors
9. Frontend: SA detail page renders assignments + components (read-only); final integration test + push

Order: 1 → 2 → 3 → 4 → 5/6/7/8 (parallel) → 9. Each task ends with a commit; final task pushes.
