# Rate Model v2 — Slice 2: Visual Configurator UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use `- [ ]` checkboxes.

**Goal:** Replace the "Components (coming soon)" placeholder with a working visual configurator — tenants can add/edit/delete RateComponents with structured editors for the most common kinds/predicates/pricing types, with cycle-detection on save.

**Architecture:** Two new API endpoints (`/api/v1/rate-grammar/registered` for dropdown sources, `/api/v1/rate-schedules/:id/cycle-check` for save-time validation) + UI components under `packages/web/components/rate-schedules/`. Lean on existing patterns: React state, fetch via `apiClient`, modals, date pickers from `@/components/ui`.

**Tech Stack:** Next.js 14, React, TypeScript, Tailwind, Zod (re-imported from `@utility-cis/shared`).

**Reference:** [`docs/superpowers/specs/2026-05-04-rate-model-v2-slice-2.md`](../specs/2026-05-04-rate-model-v2-slice-2.md). Engine + grammar at `packages/api/src/lib/rate-engine/`. Existing rate-schedule pages at `packages/web/app/rate-schedules/`.

---

## File structure

**Backend (api):**
- `packages/api/src/routes/rate-grammar.ts` (new) — `/api/v1/rate-grammar/registered`
- `packages/api/src/routes/rate-schedules.ts` (modify) — add `/cycle-check`
- `packages/api/src/services/rate-grammar.service.ts` (new) — assembles the registered grammar response
- `packages/api/src/services/rate-component.service.ts` (modify) — add cycle-check function
- `packages/api/src/__tests__/integration/rate-grammar.integration.test.ts` (new)
- `packages/api/src/__tests__/integration/rate-component-cycle-check.integration.test.ts` (new)

**Engine (api/lib):**
- `packages/api/src/lib/rate-engine/grammar-introspection.ts` (new) — exports the closed-grammar atom lists (predicate ops, transforms, selector ops, pricing types). Used by `rate-grammar.service.ts`.

**Frontend (web):**
- `packages/web/components/rate-schedules/component-list.tsx` (new)
- `packages/web/components/rate-schedules/component-editor.tsx` (new)
- `packages/web/components/rate-schedules/predicate-builder.tsx` (new)
- `packages/web/components/rate-schedules/quantity-source-builder.tsx` (new)
- `packages/web/components/rate-schedules/pricing-editor.tsx` (new)
- `packages/web/components/rate-schedules/pricing-editors/flat-editor.tsx` (new)
- `packages/web/components/rate-schedules/pricing-editors/tiered-editor.tsx` (new)
- `packages/web/components/rate-schedules/pricing-editors/lookup-editor.tsx` (new)
- `packages/web/components/rate-schedules/pricing-editors/percent-of-editor.tsx` (new)
- `packages/web/components/rate-schedules/pricing-editors/json-fallback-editor.tsx` (new)
- `packages/web/components/rate-schedules/variable-picker.tsx` (new)
- `packages/web/app/rate-schedules/[id]/page.tsx` (modify) — wire in ComponentList + ComponentEditor
- `packages/web/app/service-agreements/[id]/page.tsx` (modify) — render assignments + components (read-only)

---

## Task 1 — Backend: `/api/v1/rate-grammar/registered`

**Goal:** Endpoint returning the closed-grammar atoms + tenant-resolved kinds/roles + loader-capability descriptions for the configurator UI.

**Files:**
- Create: `packages/api/src/lib/rate-engine/grammar-introspection.ts`
- Create: `packages/api/src/services/rate-grammar.service.ts`
- Create: `packages/api/src/routes/rate-grammar.ts`
- Modify: `packages/api/src/app.ts` (register route)
- Create: `packages/api/src/__tests__/integration/rate-grammar.integration.test.ts`

### Steps

- [ ] **Step 1 — `grammar-introspection.ts`** — single source of truth for the closed grammar. Exports:

```typescript
export const PRICING_TYPES = [
  { code: "flat", label: "Flat per unit", structuredEditor: true },
  { code: "tiered", label: "Tiered blocks", structuredEditor: true },
  { code: "lookup", label: "Lookup table", structuredEditor: true },
  { code: "catalog", label: "Catalog (multi-key)", structuredEditor: false },
  { code: "per_unit", label: "Per unit", structuredEditor: false },
  { code: "percent_of", label: "Percent of selected lines", structuredEditor: true },
  { code: "indexed", label: "Indexed value", structuredEditor: false },
  { code: "floor", label: "Minimum floor", structuredEditor: false },
] as const;

export const PREDICATE_OPS = [
  { code: "and", label: "AND", structuredEditor: false },
  { code: "or", label: "OR", structuredEditor: false },
  { code: "not", label: "NOT", structuredEditor: false },
  { code: "class", label: "Customer class equals", structuredEditor: true },
  { code: "class_in", label: "Customer class is one of", structuredEditor: true },
  { code: "drought_stage_active", label: "Drought stage is active", structuredEditor: true },
  { code: "premise_attr", label: "Premise attribute", structuredEditor: true },
  { code: "meter_size", label: "Meter size equals", structuredEditor: false },
  { code: "meter_size_in", label: "Meter size is one of", structuredEditor: false },
  { code: "meter_role", label: "Meter role", structuredEditor: false },
  { code: "season", label: "Season", structuredEditor: false },
  { code: "tou_window", label: "TOU window", structuredEditor: false },
  { code: "qty_gte", label: "Quantity ≥", structuredEditor: false },
  { code: "qty_lte", label: "Quantity ≤", structuredEditor: false },
  { code: "customer_attr", label: "Customer attribute", structuredEditor: false },
  { code: "period", label: "Bill period within range", structuredEditor: false },
  { code: "eq", label: "Equals", structuredEditor: false },
  { code: "ne", label: "Not equals", structuredEditor: false },
  { code: "in", label: "In set", structuredEditor: false },
] as const;

export const QUANTITY_SOURCES = [
  { code: "metered", label: "Metered consumption", supported: true },
  { code: "wqa", label: "Winter Quarter Average", supported: true },
  { code: "fixed", label: "Fixed (1)", supported: true },
  { code: "item_count", label: "Count of attached items", supported: true },
  { code: "linked_commodity", label: "Linked commodity quantity", supported: true },
  { code: "premise_attribute", label: "Premise attribute", supported: true },
  { code: "peak_demand", label: "Peak demand (Slice 4+ only)", supported: false },
] as const;

export const TRANSFORMS = [
  { code: "clamp", label: "Clamp (min/max)", supported: true },
  { code: "net", label: "Net (subtract var)", supported: true },
  { code: "prorate", label: "Prorate by days", supported: true },
  { code: "subtract_linked_commodity", label: "Subtract linked commodity", supported: true },
  { code: "floor", label: "Floor (minimum)", supported: true },
  { code: "ratchet", label: "Ratchet (peak-demand-based)", supported: false },
  { code: "tou_window_filter", label: "Filter by TOU window", supported: false },
  { code: "power_factor", label: "Power factor adjustment", supported: false },
  { code: "load_factor", label: "Load factor adjustment", supported: false },
] as const;

export const SELECTOR_OPS = [
  { code: "component_id", label: "Specific component" },
  { code: "kind", label: "By kind" },
  { code: "kind_in", label: "By kinds (multiple)" },
  { code: "exclude_kind", label: "Exclude kinds" },
  { code: "source_schedule_id", label: "From a specific schedule" },
  { code: "source_schedule_role", label: "By schedule role" },
  { code: "has_label_prefix", label: "By label prefix" },
  { code: "and", label: "AND composition" },
  { code: "or", label: "OR composition" },
] as const;

export const VARIABLE_NAMESPACES = [
  { pattern: "account:class", scope: "per_sa", description: "Customer service class for this SA's commodity" },
  { pattern: "account:flag:<flag_name>", scope: "per_sa", description: "Boolean flag on the account" },
  { pattern: "meter:reads:<meter_id>", scope: "per_sa", description: "Aggregated meter consumption for the billing period" },
  { pattern: "meter:size:<meter_id>", scope: "per_sa", description: "Meter size (e.g. 5/8\", 1\")" },
  { pattern: "meter:role:<meter_id>", scope: "per_sa", description: "Meter role (primary, irrigation, etc.)" },
  { pattern: "wqa:current:<sa_id>", scope: "per_sa", description: "Current WQA value (override or computed)" },
  { pattern: "tenant:drought_stage", scope: "per_tenant", description: "Currently declared drought stage" },
  { pattern: "tenant:flags:<flag_name>", scope: "per_tenant", description: "Tenant-level boolean flag" },
  { pattern: "premise:attr:<attr_name>", scope: "per_sa", description: "Premise attribute (eru_count, has_stormwater_infra, etc.)" },
  { pattern: "index:<index_name>:<period>", scope: "global", description: "External rate index value" },
  { pattern: "linked:<commodity_id>:current_period", scope: "per_sa", description: "Aggregated quantity from a sibling SA on the same account+premise" },
  { pattern: "items:<sp_id>:<item_type>", scope: "per_sa", description: "Containers attached to the SA, filtered by item_type" },
] as const;
```

- [ ] **Step 2 — `rate-grammar.service.ts`:**

```typescript
import { prisma } from "../lib/prisma.js";
import {
  PRICING_TYPES,
  PREDICATE_OPS,
  QUANTITY_SOURCES,
  TRANSFORMS,
  SELECTOR_OPS,
  VARIABLE_NAMESPACES,
} from "../lib/rate-engine/grammar-introspection.js";
import { listRateComponentKinds } from "./rate-component-kind.service.js";
import { listRateAssignmentRoles } from "./rate-assignment-role.service.js";

export async function getRegisteredGrammar(utilityId: string) {
  const [kinds, roles] = await Promise.all([
    listRateComponentKinds(utilityId),
    listRateAssignmentRoles(utilityId),
  ]);

  return {
    kinds,
    roles,
    pricingTypes: [...PRICING_TYPES],
    predicateOps: [...PREDICATE_OPS],
    quantitySources: [...QUANTITY_SOURCES],
    transforms: [...TRANSFORMS],
    selectorOps: [...SELECTOR_OPS],
    variables: [...VARIABLE_NAMESPACES],
  };
}
```

- [ ] **Step 3 — Route:**

```typescript
// packages/api/src/routes/rate-grammar.ts
import type { FastifyInstance } from "fastify";
import { getRegisteredGrammar } from "../services/rate-grammar.service.js";

export async function rateGrammarRoutes(app: FastifyInstance) {
  app.get(
    "/api/v1/rate-grammar/registered",
    { config: { module: "rate_schedules", permission: "VIEW" } },
    async (request) => {
      const { utilityId } = request.user;
      return getRegisteredGrammar(utilityId);
    },
  );
}
```

Register in `app.ts`.

- [ ] **Step 4 — Integration test** at `packages/api/src/__tests__/integration/rate-grammar.integration.test.ts`. ~3 tests:
  1. Returns expected sections (kinds, roles, pricingTypes, predicateOps, quantitySources, transforms, selectorOps, variables)
  2. Kinds includes 11 globals
  3. Roles includes 5 globals

- [ ] **Step 5 — Run + commit:**

```bash
cd /c/development/claude-test
pnpm --filter @utility-cis/api exec vitest run --config vitest.integration.config.ts integration/rate-grammar
pnpm --filter @utility-cis/api exec tsc --noEmit
git add packages/api/src/lib/rate-engine/grammar-introspection.ts \
        packages/api/src/services/rate-grammar.service.ts \
        packages/api/src/routes/rate-grammar.ts \
        packages/api/src/app.ts \
        packages/api/src/__tests__/integration/rate-grammar.integration.test.ts
git commit -m "feat(rate-grammar): /api/v1/rate-grammar/registered endpoint (slice 2 task 1)"
```

---

## Task 2 — Backend: `/api/v1/rate-schedules/:id/cycle-check`

**Goal:** Validation endpoint that detects whether a proposed component would introduce a `percent_of` cycle.

**Files:**
- Modify: `packages/api/src/services/rate-component.service.ts` (add `checkComponentCycle`)
- Modify: `packages/api/src/routes/rate-components.ts` (add cycle-check route)
- Modify: `packages/shared/src/validators/rate-component.ts` (add `cycleCheckRequestSchema`)
- Create: `packages/api/src/__tests__/integration/rate-component-cycle-check.integration.test.ts`

### Steps

- [ ] **Step 1 — Add Zod schema** at `packages/shared/src/validators/rate-component.ts`:

```typescript
export const cycleCheckRequestSchema = z
  .object({
    componentId: z.string().uuid().nullable(),
    kindCode: z.string(),
    label: z.string(),
    predicate: z.unknown(),
    quantitySource: z.unknown(),
    pricing: z.unknown(),
    sortOrder: z.number().int().nonnegative(),
  })
  .strict();
```

- [ ] **Step 2 — Service:**

```typescript
// In rate-component.service.ts
import { detectCycles } from "../lib/rate-engine/index.js";
import type { RateComponentSnapshot } from "../lib/rate-engine/types.js";

export async function checkComponentCycle(
  utilityId: string,
  rateScheduleId: string,
  proposed: {
    componentId: string | null;
    kindCode: string;
    label: string;
    predicate: unknown;
    quantitySource: unknown;
    pricing: unknown;
    sortOrder: number;
  },
): Promise<{ valid: boolean; cycle?: string[] }> {
  // Verify schedule belongs to tenant
  await prisma.rateSchedule.findUniqueOrThrow({
    where: { id: rateScheduleId, utilityId },
  });

  // Load current components, replace/add proposed
  const current = await prisma.rateComponent.findMany({
    where: { rateScheduleId, utilityId },
  });

  const proposedSnapshot: RateComponentSnapshot = {
    id: proposed.componentId ?? "PROPOSED-NEW",
    rateScheduleId,
    kindCode: proposed.kindCode,
    label: proposed.label,
    predicate: proposed.predicate,
    quantitySource: proposed.quantitySource,
    pricing: proposed.pricing,
    sortOrder: proposed.sortOrder,
    effectiveDate: new Date(),
    expirationDate: null,
  };

  const merged: RateComponentSnapshot[] = [
    ...current
      .filter((c) => c.id !== proposed.componentId)
      .map((c) => ({
        id: c.id,
        rateScheduleId: c.rateScheduleId,
        kindCode: c.kindCode,
        label: c.label,
        predicate: c.predicate,
        quantitySource: c.quantitySource,
        pricing: c.pricing,
        sortOrder: c.sortOrder,
        effectiveDate: c.effectiveDate,
        expirationDate: c.expirationDate,
      })),
    proposedSnapshot,
  ];

  const result = detectCycles(merged);
  if (result === null) return { valid: true };
  return { valid: false, cycle: result.cycle };
}
```

- [ ] **Step 3 — Route:**

```typescript
// In rate-components.ts, alongside existing routes
app.post(
  "/api/v1/rate-schedules/:scheduleId/cycle-check",
  { config: { module: "rate_schedules", permission: "EDIT" } },
  async (request, reply) => {
    const { utilityId } = request.user;
    const { scheduleId } = scheduleIdParamSchema.parse(request.params);
    const data = cycleCheckRequestSchema.parse(request.body);
    const result = await checkComponentCycle(utilityId, scheduleId, data);
    if (!result.valid) {
      return reply.status(400).send(result);
    }
    return reply.status(200).send(result);
  },
);
```

- [ ] **Step 4 — Tests** (~3):
  1. Acyclic component → 200 valid
  2. Component creating a cycle (A's percent_of selector matches B's kind, B's matches A's kind) → 400 with cycle path
  3. Editing existing component without cycle → 200

- [ ] **Step 5 — Commit:**

```bash
git add packages/shared/src/validators/rate-component.ts \
        packages/api/src/services/rate-component.service.ts \
        packages/api/src/routes/rate-components.ts \
        packages/api/src/__tests__/integration/rate-component-cycle-check.integration.test.ts
git commit -m "feat(rate-schedules): cycle-check endpoint (slice 2 task 2)"
```

---

## Task 3 — Frontend: ComponentList on rate-schedule detail page

**Goal:** Replace the "Components (coming soon)" placeholder with a real components table.

**Files:**
- Create: `packages/web/components/rate-schedules/component-list.tsx`
- Modify: `packages/web/app/rate-schedules/[id]/page.tsx`

### Steps

- [ ] **Step 1 — Component list component.** Reads components via `apiClient.get('/api/v1/rate-schedules/${scheduleId}/components')`. Renders a Tailwind table:

```tsx
"use client";
import { useEffect, useState } from "react";
import { apiClient } from "@/lib/api-client";

interface RateComponent {
  id: string;
  kindCode: string;
  label: string;
  sortOrder: number;
  effectiveDate: string;
  expirationDate: string | null;
  pricing: { type: string };
  predicate: unknown;
  quantitySource: unknown;
}

export function ComponentList({
  scheduleId,
  onEdit,
  onAdd,
  refreshKey,
}: {
  scheduleId: string;
  onEdit: (c: RateComponent) => void;
  onAdd: () => void;
  refreshKey: number;
}) {
  const [components, setComponents] = useState<RateComponent[] | null>(null);
  useEffect(() => {
    apiClient.get<RateComponent[]>(`/api/v1/rate-schedules/${scheduleId}/components`).then(setComponents);
  }, [scheduleId, refreshKey]);

  const handleDelete = async (id: string) => {
    if (!confirm("Delete this component?")) return;
    await apiClient.delete(`/api/v1/rate-components/${id}`);
    setComponents((prev) => prev?.filter((c) => c.id !== id) ?? null);
  };

  if (!components) return <div>Loading components…</div>;

  return (
    <div>
      <div className="flex justify-between items-center mb-4">
        <h2 className="text-lg font-semibold">Components</h2>
        <button onClick={onAdd} className="bg-blue-600 text-white px-3 py-1 rounded">+ Add Component</button>
      </div>
      <table className="w-full">
        <thead>
          <tr>
            <th className="text-left">Sort</th>
            <th className="text-left">Label</th>
            <th className="text-left">Kind</th>
            <th className="text-left">Pricing</th>
            <th className="text-left">Effective</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {components.map((c) => (
            <tr key={c.id} onClick={() => onEdit(c)} className="cursor-pointer hover:bg-gray-50">
              <td>{c.sortOrder}</td>
              <td>{c.label}</td>
              <td>{c.kindCode}</td>
              <td>{c.pricing.type}</td>
              <td>{c.effectiveDate.slice(0, 10)}{c.expirationDate ? ` — ${c.expirationDate.slice(0, 10)}` : ""}</td>
              <td>
                <button onClick={(e) => { e.stopPropagation(); handleDelete(c.id); }} className="text-red-600">Delete</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
```

(Adjust to match the existing project's UI conventions — DataTable component, button styles, etc. Look at how other detail pages render tables in `packages/web/components/ui/data-table.tsx` and re-use if it fits.)

- [ ] **Step 2 — Wire into rate-schedule detail page.** Replace the "Components (coming soon)" placeholder section in `packages/web/app/rate-schedules/[id]/page.tsx` with `<ComponentList>`. Pass schedule id, edit/add handlers, and a `refreshKey` state that increments to trigger reload.

- [ ] **Step 3 — Manual smoke test in dev**: navigate to `/rate-schedules/<id>`, see the table render with seeded components.

- [ ] **Step 4 — Typecheck + commit:**

```bash
pnpm --filter @utility-cis/web exec tsc --noEmit
git add packages/web/components/rate-schedules/component-list.tsx \
        packages/web/app/rate-schedules/[id]/page.tsx
git commit -m "feat(rate-schedules): ComponentList table on schedule detail page (slice 2 task 3)"
```

---

## Task 4 — Frontend: ComponentEditor modal scaffold

**Goal:** Modal that creates or edits a component. Initially uses JSON textareas for predicate/quantitySource/pricing — structured editors land in subsequent tasks.

**Files:**
- Create: `packages/web/components/rate-schedules/component-editor.tsx`
- Create: `packages/web/components/rate-schedules/pricing-editors/json-fallback-editor.tsx`
- Modify: `packages/web/app/rate-schedules/[id]/page.tsx` (wire in modal)

### Steps

- [ ] **Step 1 — `<JsonFallbackEditor>` component.** Textarea + Zod-validation-on-change. Exposes value via callback. Shows inline error for invalid JSON.

- [ ] **Step 2 — `<ComponentEditor>` component.**
  - Props: `scheduleId`, `component` (null for create), `onClose`, `onSaved`.
  - State: kindCode, label, sortOrder, effectiveDate, expirationDate, predicate (JSON string), quantitySource (JSON string), pricing (JSON string).
  - Fetches `/api/v1/rate-grammar/registered` on mount to populate kind dropdown.
  - Save flow: validate JSON → POST to `/api/v1/rate-schedules/:id/cycle-check` → if valid, POST/PATCH to `/api/v1/rate-schedules/:id/components` (or `/api/v1/rate-components/:id` for edit).
  - If cycle-check returns 400, show inline error with the cycle path.
  - On success → onSaved (which triggers list refresh via refreshKey++).

- [ ] **Step 3 — Wire into rate-schedule detail page.** State for `editingComponent: RateComponent | null` + `modalMode: 'add' | 'edit' | null`. Open via list's onAdd/onEdit. Increment refreshKey on save.

- [ ] **Step 4 — Manual smoke test**: open the modal, create a flat consumption component via JSON textareas, see it appear in the list. Edit it. Delete it.

- [ ] **Step 5 — Commit:**

```bash
git commit -m "feat(rate-schedules): ComponentEditor modal with JSON fallback (slice 2 task 4)"
```

---

## Task 5 — Frontend: structured pricing editors for `flat` + `tiered`

**Goal:** Replace the JSON textarea for pricing with structured editors when pricing.type is `flat` or `tiered`.

**Files:**
- Create: `packages/web/components/rate-schedules/pricing-editor.tsx`
- Create: `packages/web/components/rate-schedules/pricing-editors/flat-editor.tsx`
- Create: `packages/web/components/rate-schedules/pricing-editors/tiered-editor.tsx`
- Modify: `packages/web/components/rate-schedules/component-editor.tsx`

### Steps

- [ ] **Step 1 — `<FlatEditor>`**: rate input (numeric), unit input (text). Returns `{ type: "flat", rate, unit }`.

- [ ] **Step 2 — `<TieredEditor>`**: dynamic table rows with `to` (numeric, blank = unbounded final) and `rate` columns. Add/remove buttons. Returns `{ type: "tiered", tiers: [...] }`.

- [ ] **Step 3 — `<PricingEditor>` switcher:** dropdown for pricing.type. Renders `<FlatEditor>` if flat, `<TieredEditor>` if tiered, `<JsonFallbackEditor>` otherwise.

- [ ] **Step 4 — Wire into ComponentEditor:** replace the pricing JSON textarea with `<PricingEditor>`.

- [ ] **Step 5 — Frontend unit tests** in `packages/web/__tests__/components/rate-schedules/`:
  - `<FlatEditor>` round-trips its value
  - `<TieredEditor>` adds/removes/edits tiers correctly
  - `<TieredEditor>` handles unbounded final tier (null `to`)

- [ ] **Step 6 — Commit:**

```bash
git commit -m "feat(rate-schedules): structured flat + tiered pricing editors (slice 2 task 5)"
```

---

## Task 6 — Frontend: structured pricing editors for `lookup` + `percent_of`

**Files:**
- Create: `packages/web/components/rate-schedules/pricing-editors/lookup-editor.tsx`
- Create: `packages/web/components/rate-schedules/pricing-editors/percent-of-editor.tsx`
- Modify: `packages/web/components/rate-schedules/pricing-editor.tsx` (extend switcher)

### Steps

- [ ] **Step 1 — `<LookupEditor>`**: `by` field selector + key/value table (rows are key strings + numeric rates). Returns `{ type: "lookup", by, table }`.

- [ ] **Step 2 — `<PercentOfEditor>`**: selector op dropdown (kind, kind_in, exclude_kind, etc.) + value field appropriate to the chosen op + percent numeric input. Returns `{ type: "percent_of", selector, percent }`.

- [ ] **Step 3 — Extend `<PricingEditor>` switcher** to render both new editors.

- [ ] **Step 4 — Frontend unit tests** for lookup/percent_of round-trips.

- [ ] **Step 5 — Commit:**

```bash
git commit -m "feat(rate-schedules): structured lookup + percent_of pricing editors (slice 2 task 6)"
```

---

## Task 7 — Frontend: PredicateBuilder + QuantitySourceBuilder

**Files:**
- Create: `packages/web/components/rate-schedules/predicate-builder.tsx`
- Create: `packages/web/components/rate-schedules/quantity-source-builder.tsx`
- Modify: `packages/web/components/rate-schedules/component-editor.tsx`

### Steps

- [ ] **Step 1 — `<PredicateBuilder>`**: top-level dropdown (operator) + per-operator inputs:
  - `{}` (empty) — no inputs, "always applies" label
  - `class` — text input or dropdown
  - `class_in` — comma-separated text input
  - `drought_stage_active` — boolean toggle
  - `premise_attr` — attr dropdown + eq/ne dropdown + value input
  - For all other operators → fall through to JSON textarea (escape hatch)

- [ ] **Step 2 — `<QuantitySourceBuilder>`**: base dropdown + per-base inputs:
  - `metered` — no extra inputs
  - `wqa` — no extra inputs
  - `fixed` — no extra inputs
  - `item_count` — no extra inputs
  - `linked_commodity` — no extra inputs (parameterization happens via the predicate or the variable picker)
  - `premise_attribute` — `source_attr` text input
  - For `peak_demand` → show "not yet supported" message
  - Transforms section: collapsible, defaults to JSON textarea

- [ ] **Step 3 — Wire into ComponentEditor.**

- [ ] **Step 4 — Frontend unit tests.**

- [ ] **Step 5 — Commit:**

```bash
git commit -m "feat(rate-schedules): PredicateBuilder + QuantitySourceBuilder (slice 2 task 7)"
```

---

## Task 8 — Frontend: VariablePicker

**Goal:** Reusable dropdown that lets users pick from the registered variable namespaces. Used inside PredicateBuilder + PricingEditors anywhere a `{var: "..."}` reference is allowed.

**Files:**
- Create: `packages/web/components/rate-schedules/variable-picker.tsx`
- Modify: relevant editors that need it (e.g., `<NetTransformEditor>` if you have one, or anywhere a var ref is allowed)

### Steps

- [ ] **Step 1 — `<VariablePicker>` component**. Reads grammar from `/api/v1/rate-grammar/registered` (cache it via React Query or similar — or fetch once at editor open time). Two-stage: pick a pattern, then fill wildcard params via inline inputs. Returns the assembled key string.

- [ ] **Step 2 — Integrate where useful** — in PredicateBuilder for predicate operators that take a `var` reference (e.g., `qty_gte: { var: "..." }`), in PercentOfEditor (no — selector doesn't take vars).

For Slice 2, VariablePicker integration is a polish step. If time pressure, just wire into PredicateBuilder for `qty_gte`/`qty_lte`/`customer_attr`.

- [ ] **Step 3 — Commit:**

```bash
git commit -m "feat(rate-schedules): VariablePicker for var refs (slice 2 task 8)"
```

---

## Task 9 — SA detail page + final verification + push

**Goal:** Show assigned schedules + components on the SA detail page (read-only). Final verification + push.

**Files:**
- Modify: `packages/web/app/service-agreements/[id]/page.tsx`

### Steps

- [ ] **Step 1 — SA detail page change.** Where it currently shows "Components (coming soon)" or placeholder, render an "Assignments" panel listing each `rateScheduleAssignment` with its schedule name, role, effective dates, and a collapsible component list. Read-only — clicking through goes to the rate-schedule detail page.

- [ ] **Step 2 — Final test sweep:**

```bash
cd /c/development/claude-test
pnpm -w typecheck
pnpm --filter @utility-cis/api exec vitest run
pnpm --filter @utility-cis/web exec tsc --noEmit
```

Expected: all integration + unit tests pass; typecheck clean.

- [ ] **Step 3 — Manual smoke test the full flow in the dev browser:**
  1. Navigate to a seeded rate schedule
  2. Add a component via the editor (use structured editors where available)
  3. Edit it
  4. Try to introduce a cycle — see error
  5. Delete it
  6. Navigate to a seeded SA detail; see its assignments + components

- [ ] **Step 4 — Commit + push:**

```bash
cd /c/development/claude-test
git add packages/web/app/service-agreements/[id]/page.tsx
git commit -m "$(cat <<'EOF'
feat(rate-schedules): SA detail shows assigned schedules + components (slice 2 task 9)

Closes Slice 2. Visual configurator complete with structured editors for
the 4 most common pricing types (flat, tiered, lookup, percent_of), the 5
most common predicate operators (empty, class, class_in,
drought_stage_active, premise_attr), the 5 most common quantity sources
(metered, wqa, fixed, item_count, linked_commodity), JSON fallback for
the rest, cycle-check on save, and read-only SA detail view of assigned
schedules + components.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"

git log --oneline a388028..HEAD
git push origin main
```

(`a388028` is the Slice 4 final commit.)

---

## Self-review checklist

- [x] Spec coverage: every section maps to a task
- [x] Backend has 2 new endpoints + tests
- [x] Frontend has 4 structured pricing editors + 1 JSON fallback
- [x] Frontend has structured predicate + quantity-source builders
- [x] Variable picker reads from registered grammar
- [x] Cycle-check runs before save
- [x] SA detail page surfaces assignments
- [x] Final task pushes to main

Order: 1 → 2 → 3 → 4 → 5/6/7/8 (parallel after 4) → 9.
