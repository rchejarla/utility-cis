# Service Point Model Migration — Slice 2 Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use `- [ ]` checkboxes.

**Goal:** Drop `ServiceAgreement.premiseId` and the `ServiceAgreementMeter` Prisma model — the two carryovers from Slice 1. Retarget every read site (API services, web pages, customer-graph) to traverse `SA → ServicePoint → Premise` instead of `SA → Premise` directly.

**Architecture:** Today every existing SA still has `premiseId` populated as a denormalised mirror of its single SP's premise. That mirror has carried us through Slice 1 — the API and UI all continue to work as if the SA owned the premise directly. Slice 2 cuts that crutch. Every place that read `sa.premise.X` or `sa.premiseId` either traverses the SP path explicitly (`sa.servicePoints[0].premise.X`) or, for places that just need *any* premise, picks the first active SP. The column drops at the end via a no-data-loss migration once all read paths are gone.

**Tech additions:** none — Prisma + Postgres only.

**Slice 2 explicitly does NOT:**
- Add multi-SP UX (the "this SA has 3 service points across 3 buildings" surface). That's Slice 3, after the model is fully decoupled.
- Add item-based SP types (containers, stormwater area). Slice 3.
- Rename "Service Agreement" / "Agreements" tab to "Service" / "Services" in the UI. Cosmetic-only relabel deferred to Slice 3.

**Slice 2 IS still scoped to single-SP-per-SA**: the residential reality remains "every SA has exactly one SP," and the UI continues to display "the SA's premise" as if it were one place. The change is purely under-the-hood: API responses populate premise via SP, web reads through SP, and the duplicate column is gone.

---

## Architectural cost-benefit

Per `CLAUDE.md` — every named pattern must justify itself.

**Simpler alternative:** keep `SA.premiseId` as the denormalised mirror it became in Slice 1. The cost we pay every day: nothing functional. The cost we'd pay later: the moment Slice 3 introduces multi-SP-per-SA, the mirror lies (which SP's premise gets reflected?). Worse, two-buildings-one-trash from the Bozeman discussion would have to either pick one premise to mirror (arbitrary) or leave the column null on multi-SP SAs (forking the read path).

**Concrete cost the column-drop pays:**
- Prevents drift between `SA.premiseId` and `SP.premiseId` once multi-SP SAs exist.
- Forces the API and UI through one canonical read path (SP), so when Slice 3 adds multi-SP UX, no half-migrated read sites need rediscovery.
- Removes the "what does premise mean here?" ambiguity from the data model.

**Conditions that justify it:** the next feature on deck (multi-premise commercial accounts, Bozeman req#10) demonstrably breaks the mirror. We're inside the window where landing the change is cheap; deferring it pushes the same work into a slice already busy with UX.

**Default to direct broken because:** Slice 1 left a deliberate denormalised column. The decision was always to drop it once the SP layer was proven; that proof is now done (128/128 integration tests green).

---

## File Structure

### Created

| Path | Responsibility |
|---|---|
| `packages/shared/prisma/migrations/20260430140000_drop_sa_premise/migration.sql` | Drop `service_agreement.premise_id` column + drop the `ServiceAgreementMeter` Prisma model (no SQL change for the latter — the table was already gone in slice 1; this migration is just synced with the schema removal). |

### Modified

| Path | Change |
|---|---|
| `packages/shared/prisma/schema.prisma` | Remove `ServiceAgreementMeter` model entirely. Remove `premiseId` field + `premise` relation from `ServiceAgreement`. Remove the `premise Premise?` field on SA. Remove the `serviceAgreementMeters` reverse relation from `Meter` and `serviceAgreements` from `Premise`. (The `servicePoints` relations stay.) |
| `packages/api/src/services/service-agreement.service.ts` | (1) Remove `premise: true` from `fullInclude`. (2) Replace `where.premiseId = query.premiseId` with `where.servicePoints = { some: { premiseId: query.premiseId } }`. (3) `data.premiseId` on the create-SA path is still consumed to set the new SP's premise — already wired in Slice 1, just verify unchanged. |
| `packages/api/src/services/account.service.ts` | The list/get includes traverse SA → premise. Replace `serviceAgreements: { include: { premise: true, ... } }` with `serviceAgreements: { include: { servicePoints: { include: { premise: true } }, ... } }`. Where the response shape needs `serviceAgreements[i].premise`, populate it post-query (or change consumers to read through SP). |
| `packages/api/src/services/customer-graph.service.ts` | The `ag.premise` reads at lines ~111, ~199, ~229 traverse a direct `premise` include. Switch the include to `servicePoints: { include: { premise: true } }` and read `ag.servicePoints[0]?.premise` instead. |
| `packages/api/src/services/workflows.service.ts` | Multiple `source.premiseId` reads (lines 137, 150, 160, 324) — these expect SA to own a premise. Switch to reading `source.servicePoints[0]?.premiseId` (with a guard returning a friendly error when no SP exists). |
| `packages/api/src/services/service-suspension.service.ts:18-22` | The `premiseId: true` on a select against SA (it queries SA-via-SAM-history but the file already includes premiseId in the select). Switch the SA select to traverse SP. |
| `packages/web/app/service-agreements/page.tsx` | `row.premise` reads → `row.servicePoints[0]?.premise`. Update the type definition to remove top-level `premise`. |
| `packages/web/app/service-agreements/[id]/page.tsx` | Several `sa.premise.X` reads → `sa.servicePoints[0]?.premise.X`. The `sa.premiseId` type field disappears. |
| `packages/web/app/service-agreements/new/page.tsx` | The form still asks for a premiseId — that's correct; the SA *creation* endpoint takes `premiseId` to seed the initial SP. No change to the form. The `m.premiseId === form.premiseId` filter on meters still works (Meter.premiseId is unchanged). |
| `packages/web/components/service-agreements/meters-tab.tsx` | Takes `premiseId` as a prop. The caller in `[id]/page.tsx` passes `sa.premise?.id ?? sa.premiseId ?? ""` — change to `sa.servicePoints[0]?.premise?.id ?? ""`. The component itself doesn't need changes. |
| `packages/web/app/portal/dashboard/page.tsx` | `sa.premise?.addressLine1` → `sa.servicePoints[0]?.premise?.addressLine1`. |
| `packages/web/app/portal/accounts/[id]/page.tsx` | `sa.premise.id` → `sa.servicePoints[0]?.premise.id`. The `premiseMap.set(key, { premise: sa.premise, ... })` becomes `premiseMap.set(key, { premise: sa.servicePoints[0]?.premise, ... })`. |
| `packages/web/app/portal/usage/page.tsx` | `sa.premise` reads → `sa.servicePoints[0]?.premise`. |
| `packages/api/src/__tests__/integration/cascade-close.integration.test.ts` | Any direct read of `sa.premiseId` in assertions becomes a traversal through SP. |
| `packages/api/src/__tests__/integration/effective-dating-constraints.integration.test.ts` | Same. |
| `packages/api/src/__tests__/integration/_effective-dating-fixtures.ts` | The fixture's SA creation still passes `premiseId` — this is *input*, used to set the SP's premise, so it stays. The fixture's `resetDb` truncate list does NOT need changes (already updated in Slice 1 Task 6). |

### Deleted

- The `ServiceAgreementMeter` model from `schema.prisma`.
- The `service_agreement.premise_id` column.
- The `premise` and `premiseId` fields from the `ServiceAgreement` Prisma model.

---

## Sequencing & dependencies

The hard constraint: drop the column LAST. Every read site has to be retargeted before the column goes away, otherwise typecheck or runtime fails. Order:

1. API services → no longer read `SA.premiseId`, traverse SP for premise.
2. Web pages → read SP for premise.
3. Tests → assertions through SP.
4. Schema + migration → remove model, drop column.
5. Verification.

Each task ends with `pnpm -w typecheck` clean and a commit, and integration tests pass at every step until Task 4 (where the column drop happens — that's where Prisma client regenerates and any remaining `SA.premiseId` reference fails).

---

## Task 1 — Update API services to traverse SP for premise

**Goal:** Every API service that reads `SA.premiseId` or includes `SA.premise` directly switches to traversing `SA.servicePoints[0].premise`. Response shapes change visibly: the SA payload no longer has a top-level `premise` field. Web tasks (Task 2) update consumers.

**Files:**
- Modify: `packages/api/src/services/service-agreement.service.ts`
- Modify: `packages/api/src/services/account.service.ts`
- Modify: `packages/api/src/services/customer-graph.service.ts`
- Modify: `packages/api/src/services/workflows.service.ts`
- Modify: `packages/api/src/services/service-suspension.service.ts`

**Steps:**

- [ ] **Step 1 — `service-agreement.service.ts`: drop direct `premise: true` from fullInclude.**

Find the `fullInclude` constant near the top of the file:

```typescript
const fullInclude = {
  account: true,
  premise: true,
  commodity: true,
  rateSchedule: true,
  billingCycle: true,
  servicePoints: {
    where: { endDate: null as null },
    orderBy: { startDate: "asc" as const },
    include: {
      premise: true,
      meters: { ... },
    },
  },
};
```

Remove the `premise: true` line (the top-level one — keep the one nested inside `servicePoints.include`):

```typescript
const fullInclude = {
  account: true,
  commodity: true,
  rateSchedule: true,
  billingCycle: true,
  servicePoints: {
    where: { endDate: null as null },
    orderBy: { startDate: "asc" as const },
    include: {
      premise: true,
      meters: { ... },
    },
  },
};
```

- [ ] **Step 2 — `service-agreement.service.ts`: rewrite the `query.premiseId` filter.**

Find `listServiceAgreements` (around line 37). The current filter:

```typescript
if (query.premiseId) where.premiseId = query.premiseId;
```

Replace with:

```typescript
if (query.premiseId) {
  where.servicePoints = { some: { premiseId: query.premiseId } };
}
```

- [ ] **Step 3 — `service-agreement.service.ts`: verify createServiceAgreement is unchanged.**

Read lines ~120-160 of `createServiceAgreement`. The `data.premiseId` from the input is consumed to create the initial SP — Slice 1 Task 4 already wired this. Confirm the SA creation no longer sets `premiseId` on the SA row itself:

```typescript
// Should NOT have:
//   data: { ..., premiseId: data.premiseId, ... }  ← on the SA create
// Should ONLY pass premiseId via the SP create:
//   const sp = await tx.servicePoint.create({ data: { ..., premiseId: data.premiseId, ... } });
```

If you find `premiseId: data.premiseId` on the `tx.serviceAgreement.create({ data: ... })` call, remove it. The SA's column is going away.

- [ ] **Step 4 — `account.service.ts`: update the list/detail include.**

Find `listAccounts` (around line 9). The current shape:

```typescript
include: {
  _count: { select: { serviceAgreements: true } },
  customer: { select: ... },
  serviceAgreements: {
    select: {
      premise: { select: { id: true, addressLine1: true, city: true, state: true, ... } },
    },
    orderBy: [...],
    take: 1,
  },
},
```

Switch the inner `premise` to a traversal through SP:

```typescript
serviceAgreements: {
  select: {
    servicePoints: {
      select: {
        premise: { select: { id: true, addressLine1: true, city: true, state: true } },
      },
      orderBy: { startDate: "asc" },
      take: 1,
    },
  },
  orderBy: [{ status: "asc" }, { startDate: "desc" }],
  take: 1,
},
```

The response shape changes: `account.serviceAgreements[0].premise` becomes `account.serviceAgreements[0].servicePoints[0].premise`. Web Task 2 updates consumers.

For `getAccount` (around line 33), the current include:

```typescript
serviceAgreements: {
  include: {
    premise: true,
    commodity: true,
    rateSchedule: true,
  },
  orderBy: { startDate: "desc" },
},
```

Switch the inner `premise: true` to a traversal:

```typescript
serviceAgreements: {
  include: {
    servicePoints: { include: { premise: true } },
    commodity: true,
    rateSchedule: true,
  },
  orderBy: { startDate: "desc" },
},
```

- [ ] **Step 5 — `customer-graph.service.ts`: traverse SP for premise.**

Find the SA include (around line 40). It currently has:

```typescript
include: {
  premise: true,
  // ...
}
```

Switch to:

```typescript
include: {
  servicePoints: { include: { premise: true } },
  // ...
}
```

Then update the reads at lines ~111, ~199, ~229. Replace each `ag.premise` (where `ag` is the SA) with `ag.servicePoints[0]?.premise`. Concrete examples — the existing code:

```typescript
if (ag.premise && !premiseById.has(ag.premise.id)) {
  premiseById.set(ag.premise.id, ag.premise);
}
```

Becomes:

```typescript
const sp = ag.servicePoints[0];
if (sp?.premise && !premiseById.has(sp.premise.id)) {
  premiseById.set(sp.premise.id, sp.premise);
}
```

And:

```typescript
premiseId: ag.premise?.id ?? null,
```

Becomes:

```typescript
premiseId: ag.servicePoints[0]?.premise?.id ?? null,
```

(For each `ag.premise.X` reference: introduce a `const sp = ag.servicePoints[0];` once at the top of the block, then read `sp?.premise.X`. Keep the optional chaining since servicePoints[] could be empty for an SA that never got an SP — though in practice that doesn't happen post-Slice-1.)

- [ ] **Step 6 — `workflows.service.ts`: source SA premise reads.**

Search for `source.premiseId` and `source.premise`:

```bash
grep -n "source\.premiseId\|source\.premise" packages/api/src/services/workflows.service.ts
```

For each match, the source variable is an SA (loaded by `prisma.serviceAgreement.findUniqueOrThrow(...)`). The include must now traverse SP. Change the include to:

```typescript
include: {
  servicePoints: { include: { premise: true } },
  // ... other includes preserved ...
}
```

Then change reads:

```typescript
// OLD:
if (!source.premiseId) {
  throw Object.assign(...);
}

// NEW:
const sourcePremiseId = source.servicePoints[0]?.premiseId;
if (!sourcePremiseId) {
  throw Object.assign(
    new Error("Source agreement has no service point with a premise; cannot transfer."),
    { statusCode: 400, code: "SOURCE_AGREEMENT_NO_PREMISE" },
  );
}
```

(Replace any subsequent `source.premiseId` with the new `sourcePremiseId` local variable. Same for `source.premise.X` → use `source.servicePoints[0].premise.X` with appropriate optional-chaining where the value could be missing.)

- [ ] **Step 7 — `service-suspension.service.ts`: select-list traversal.**

Find lines around 16-22:

```typescript
const serviceAgreementSelect = {
  // ...
  premiseId: true,
  // ...
};
```

Switch to traversing SP:

```typescript
const serviceAgreementSelect = {
  // ...
  servicePoints: {
    select: { premiseId: true },
    where: { endDate: null as null },
    orderBy: { startDate: "asc" as const },
    take: 1,
  },
  // ...
};
```

Update consumers in the same file: any `sa.premiseId` becomes `sa.servicePoints[0]?.premiseId`.

- [ ] **Step 8 — Run typecheck.**

```bash
pnpm --filter @utility-cis/api exec tsc --noEmit
```

Expected: zero errors. If errors persist, the most likely cause is a service file we missed — grep:

```bash
grep -rn "\.premiseId\b\|\.premise\b" packages/api/src/services packages/api/src/routes --include="*.ts" | grep -v "premise: " | grep -v "test" | grep -E "(sa|agreement|service)"
```

Anything that still reads `<sa>.premiseId` or `<sa>.premise` directly needs the traversal pattern.

- [ ] **Step 9 — Run integration tests.**

```bash
pnpm --filter @utility-cis/api test:integration
```

Expected: 128/128 pass. Some tests still read `sa.premiseId` in assertions — those are Task 3's scope. If a test fails because the API response no longer has `sa.premise` but the test reads `body.serviceAgreement.premise.X`, that's the response-shape change reaching the test. Note which test, then continue — Task 3 fixes test assertions.

If too many tests fail, STOP and check whether a service include got too aggressively trimmed (e.g., dropped `commodity` or `rateSchedule` accidentally).

- [ ] **Step 10 — Commit.**

```bash
git add packages/api/src/services/service-agreement.service.ts \
        packages/api/src/services/account.service.ts \
        packages/api/src/services/customer-graph.service.ts \
        packages/api/src/services/workflows.service.ts \
        packages/api/src/services/service-suspension.service.ts
git commit -m "$(cat <<'EOF'
refactor(api): SA premise reads traverse ServicePoint (slice 2 task 1)

Drops direct \`premise\` includes on ServiceAgreement queries. All
reads of an SA's premise now go through SA.servicePoints[0].premise.
The SA Prisma model still has premiseId; column drop comes later in
this slice.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2 — Update web pages to traverse SP for premise

**Goal:** Six web files read `sa.premise.X` directly. Switch each to `sa.servicePoints[0]?.premise.X`. The TypeScript type defs need to update to match the new API response shape.

**Files:**
- Modify: `packages/web/app/service-agreements/page.tsx`
- Modify: `packages/web/app/service-agreements/[id]/page.tsx`
- Modify: `packages/web/app/portal/dashboard/page.tsx`
- Modify: `packages/web/app/portal/accounts/[id]/page.tsx`
- Modify: `packages/web/app/portal/usage/page.tsx`
- Modify: `packages/web/components/service-agreements/meters-tab.tsx` (only the call site in `[id]/page.tsx` changes)
- Modify: `packages/web/app/accounts/page.tsx` and `packages/web/app/accounts/[id]/page.tsx` (premise display reads)

**Steps:**

- [ ] **Step 1 — Audit reads.**

```bash
grep -rn "\.premise\b\|\.premiseId\b" packages/web/app/service-agreements packages/web/app/portal packages/web/app/accounts packages/web/components/service-agreements --include="*.tsx" 2>&1
```

For each match where the LHS is an SA (or a row in an SAs list), apply the substitution.

- [ ] **Step 2 — `service-agreements/page.tsx`: list page.**

Find the `Account` row type (or similar — the type for the SA list rows) at the top of the file. Currently:

```typescript
interface Row {
  id: string;
  agreementNumber: string;
  status: string;
  premise?: { addressLine1: string; city: string; state?: string } | null;
  // ...
}
```

Switch to:

```typescript
interface Row {
  id: string;
  agreementNumber: string;
  status: string;
  servicePoints?: Array<{
    premise: { id: string; addressLine1: string; city: string; state?: string };
  }>;
  // ...
}
```

Then update any column render that did `row.premise.addressLine1` to `row.servicePoints?.[0]?.premise.addressLine1 ?? "—"`. Concretely (around line 47):

```typescript
// OLD:
row.premise ? (
  <span>{row.premise.addressLine1}, {row.premise.city}</span>
) : "—"

// NEW:
row.servicePoints?.[0]?.premise ? (
  <span>{row.servicePoints[0].premise.addressLine1}, {row.servicePoints[0].premise.city}</span>
) : "—"
```

- [ ] **Step 3 — `service-agreements/[id]/page.tsx`: detail page.**

The SA type at the top of the file currently has `premise?: { ... }` and `premiseId?: string`. Replace with:

```typescript
servicePoints?: Array<{
  id: string;
  premise: {
    id: string;
    addressLine1: string;
    city: string;
    state: string;
  };
}>;
```

Drop the top-level `premise` and `premiseId` fields.

Then for each read of `sa.premise.X` (around lines 337, 505, 518-520):

```typescript
// OLD:
{sa.account?.accountNumber} — {sa.premise?.addressLine1}

// NEW:
{sa.account?.accountNumber} — {sa.servicePoints?.[0]?.premise.addressLine1 ?? "—"}
```

```typescript
// OLD:
onClick={() => sa.premise && router.push(`/premises/${sa.premise.id}`)}

// NEW:
onClick={() => {
  const sp = sa.servicePoints?.[0];
  if (sp?.premise) router.push(`/premises/${sp.premise.id}`);
}}
```

```typescript
// OLD:
{sa.premise
  ? `${sa.premise.addressLine1}, ${sa.premise.city}, ${sa.premise.state}`
  : "—"}

// NEW:
{(() => {
  const p = sa.servicePoints?.[0]?.premise;
  return p ? `${p.addressLine1}, ${p.city}, ${p.state}` : "—";
})()}
```

For the `meters-tab.tsx` call site (around line 675):

```typescript
// OLD:
premiseId={sa.premise?.id ?? sa.premiseId ?? ""}

// NEW:
premiseId={sa.servicePoints?.[0]?.premise?.id ?? ""}
```

- [ ] **Step 4 — `accounts/page.tsx` and `accounts/[id]/page.tsx`: update premise display.**

In `accounts/page.tsx`, find the `Account` interface and the column-render that reads `serviceAgreements[0].premise`. The list endpoint (Task 1 Step 4) now returns `serviceAgreements[i].servicePoints[0].premise`. Update both the type and the render:

```typescript
// Type:
interface Account {
  // ...
  serviceAgreements?: Array<{
    servicePoints?: Array<{
      premise?: {
        id: string;
        addressLine1: string;
        city: string;
        state: string;
      } | null;
    }>;
  }>;
  // ...
}

// premiseLabel helper:
function premiseLabel(row: Account): string {
  const p = row.serviceAgreements?.[0]?.servicePoints?.[0]?.premise;
  if (!p) return "—";
  return `${p.addressLine1}, ${p.city}`;
}
```

In `accounts/[id]/page.tsx`, find the `Account` interface's `serviceAgreements` field and the subtitle that says `"<TYPE> account · <Customer> · <Premise>"`. Same shape change; update the premise lookup:

```typescript
const p = account.serviceAgreements?.[0]?.servicePoints?.[0]?.premise;
const premiseLabel = p ? `${p.addressLine1}, ${p.city}` : null;
```

The detail page also has an "Agreements" tab that lists each SA with its premise — same traversal: `sa.servicePoints[0].premise`.

- [ ] **Step 5 — Portal pages.**

`portal/dashboard/page.tsx` (line 160):

```typescript
// OLD:
{sa.premise?.addressLine1 ?? sa.agreementNumber}

// NEW:
{sa.servicePoints?.[0]?.premise?.addressLine1 ?? sa.agreementNumber}
```

`portal/dashboard/page.tsx` (line 195):

```typescript
// OLD:
const premises = new Set(acct.serviceAgreements.map((sa) => sa.premise?.addressLine1).filter(Boolean));

// NEW:
const premises = new Set(
  acct.serviceAgreements.map((sa) => sa.servicePoints?.[0]?.premise?.addressLine1).filter(Boolean),
);
```

`portal/accounts/[id]/page.tsx` (lines 63-65):

```typescript
// OLD:
const key = sa.premise.id;
if (!premiseMap.has(key)) {
  premiseMap.set(key, { premise: sa.premise, agreements: [] });
}

// NEW:
const sp = sa.servicePoints?.[0];
if (!sp?.premise) continue;
const key = sp.premise.id;
if (!premiseMap.has(key)) {
  premiseMap.set(key, { premise: sp.premise, agreements: [] });
}
```

`portal/usage/page.tsx` (line 174):

```typescript
// OLD:
{sa.premise ? `${sa.premise.addressLine1}, ${sa.premise.city}` : "—"}

// NEW:
{(() => {
  const p = sa.servicePoints?.[0]?.premise;
  return p ? `${p.addressLine1}, ${p.city}` : "—";
})()}
```

(Update the SA type definition at the top of each portal file similarly — drop top-level `premise` and `premiseId`, add `servicePoints` array.)

- [ ] **Step 6 — Run typecheck.**

```bash
pnpm --filter @utility-cis/web exec tsc --noEmit
```

Expected: zero errors. Common failures:
- A type still says `premise?: { ... }` on a place that should have been removed.
- A read that traverses through `sa.premise` somewhere we missed — re-grep:

```bash
grep -rn "sa\.premise\b\|agreement\.premise\b\|row\.premise\b" packages/web/app packages/web/components --include="*.tsx"
```

If any results return, retarget them.

- [ ] **Step 7 — Build the web package.**

```bash
pnpm --filter @utility-cis/web build
```

Expected: green. (We typecheck above, but Next.js's build catches some integration concerns that bare `tsc` doesn't.)

- [ ] **Step 8 — Commit.**

```bash
git add packages/web
git commit -m "$(cat <<'EOF'
refactor(web): SA premise reads traverse ServicePoint (slice 2 task 2)

Updates 8 pages and the SA list/detail row types to read premise
via SA.servicePoints[0].premise instead of SA.premise.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3 — Update tests that read SA.premiseId in assertions

**Goal:** A handful of tests assert directly on `sa.premiseId` or `body.serviceAgreement.premise.X`. Update them to traverse SP. After this task, `pnpm test:integration` is fully green again with the new API shape.

**Files:**
- Modify: `packages/api/src/__tests__/integration/cascade-close.integration.test.ts` (if any)
- Modify: `packages/api/src/__tests__/integration/effective-dating-constraints.integration.test.ts` (if any)
- Modify: `packages/api/src/__tests__/integration/lifecycle-endpoints.integration.test.ts` (if any)
- Modify: `packages/api/src/__tests__/integration/imports.integration.test.ts` (if any)
- Modify: `packages/api/src/__tests__/integration/point-in-time-helpers.integration.test.ts` (if any)
- Modify: any other test that reads `sa.premiseId` or asserts on a `premise` field of a returned SA.

**Steps:**

- [ ] **Step 1 — Find the references.**

```bash
grep -rn "\.premiseId\b\|\.premise\b" packages/api/src/__tests__ --include="*.ts" 2>&1 | grep -v "premise: " | grep -E "(sa|agreement|service.?agreement)"
```

(Some matches will be in `body.serviceAgreement.premise` patterns, others in `sa.premiseId` directly.)

- [ ] **Step 2 — Apply substitutions.**

| Pattern | Replacement |
|---|---|
| `sa.premiseId` (in setup code that READS the SA from DB) | Drop. The column will be gone. If the test needs the premise id, fetch via `sa.servicePoints[0]?.premiseId`. |
| `sa.premiseId` (in test SETUP that CREATES an SA with a specific premiseId) | Keep — the SA *create* still takes `premiseId` as input (it's the seed for the SP). The Prisma `prisma.serviceAgreement.create({ data: { ..., premiseId: X } })` won't compile after Task 4 drops the schema field. So actually: in any test that does `prisma.serviceAgreement.create({ data: { premiseId: X, ... } })`, drop `premiseId` from the data and instead create an SP after the SA creation. |
| `body.serviceAgreement.premise.X` in API assertions | `body.serviceAgreement.servicePoints[0].premise.X` |
| `body.premise.X` for a returned SA payload | Same: traverse through servicePoints. |

- [ ] **Step 3 — A common pattern: fixture creates an SA with `premiseId`.**

The fixture in `_effective-dating-fixtures.ts` doesn't currently call `prisma.serviceAgreement.create` directly — it goes through `makeTenantFixture` which creates SA + SP via the service. That stays. But individual tests that create their own SAs inline (with `prisma.serviceAgreement.create({ data: { premiseId: X, ... } })`) need to:
1. Drop `premiseId` from the SA data.
2. After the SA exists, create an SP:
```typescript
const sp = await prisma.servicePoint.create({
  data: {
    utilityId,
    serviceAgreementId: sa.id,
    premiseId: <the premise id you intended>,
    type: "METERED",
    status: "ACTIVE",
    startDate: <whatever the test's start date is>,
  },
});
```

- [ ] **Step 4 — Run integration tests.**

```bash
pnpm --filter @utility-cis/api test:integration
```

Expected: 128/128 pass.

- [ ] **Step 5 — Commit.**

```bash
git add packages/api/src/__tests__/integration/
git commit -m "$(cat <<'EOF'
test(sa): assertions traverse ServicePoint for premise reads (slice 2 task 3)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4 — Schema + migration: drop premise_id and remove SAM model

**Goal:** All read sites are gone. Now we can safely drop the column and remove the unused Prisma model.

**Files:**
- Create: `packages/shared/prisma/migrations/20260430140000_drop_sa_premise/migration.sql`
- Modify: `packages/shared/prisma/schema.prisma`

**Steps:**

- [ ] **Step 1 — Create the migration directory.**

```bash
mkdir -p packages/shared/prisma/migrations/20260430140000_drop_sa_premise
```

- [ ] **Step 2 — Write the migration.sql.**

```sql
-- Slice 2 cleanup. Drops:
--   1. service_agreement.premise_id (denormalised mirror — every read
--      site now traverses service_point instead).
--   2. ServiceAgreementMeter (SAM) model — table was already dropped
--      in 20260430120000; this migration is the schema-side counterpart
--      that just removes the Prisma model. No SQL needed for SAM.

-- ─── 1. Drop SA.premise_id ────────────────────────────────────────────

ALTER TABLE service_agreement DROP COLUMN premise_id;
```

(Yes, this migration is a single SQL statement. The SAM model removal is purely a schema.prisma edit — no SQL needed because the table is already gone.)

- [ ] **Step 3 — Update the Prisma schema.**

Open `packages/shared/prisma/schema.prisma`.

**3a. Remove the `ServiceAgreementMeter` model entirely.** Find:
```prisma
model ServiceAgreementMeter {
  // ...
}
```
Delete the whole model block (and the comment block above it if any).

**3b. Remove the `serviceAgreementMeters` reverse relation from `Meter`.** In the `Meter` model, find:
```prisma
serviceAgreementMeters ServiceAgreementMeter[]
```
Delete that line.

**3c. Remove the `premiseId`, `premise` fields from `ServiceAgreement`.** In the `ServiceAgreement` model:
```prisma
  premiseId          String?       @map("premise_id") @db.Uuid
  // ...
  premise            Premise?      @relation(fields: [premiseId], references: [id], onDelete: Restrict)
```
Delete both lines. Remove any index that references `premiseId`:
```prisma
@@index([premiseId])
```

**3d. Remove the `serviceAgreements` reverse relation from `Premise`.** In the `Premise` model, find:
```prisma
serviceAgreements ServiceAgreement[]
```
Delete that line. (We keep `servicePoints ServicePoint[]` — that's the new path.)

- [ ] **Step 4 — Validate the schema.**

```bash
cd packages/shared && pnpm prisma validate
```

Expected: `The schema at prisma\schema.prisma is valid 🚀`. If invalid, the most likely cause is a leftover index referencing premiseId, or the `meter` field on SAM still referenced as a relation somewhere.

- [ ] **Step 5 — Generate the Prisma client.**

```bash
cd packages/shared && DATABASE_URL=postgresql://cis:cis_dev_password@localhost:5432/utility_cis pnpm prisma generate
```

If `prisma generate` fails with a Windows file-lock error, the dev API process is holding the engine DLL. Stop it (Ctrl+C in the run.bat terminal) and retry. Report BLOCKED if the user-controllable processes are confirmed stopped and the lock persists.

- [ ] **Step 6 — Apply the migration.**

```bash
cd packages/shared && DATABASE_URL=postgresql://cis:cis_dev_password@localhost:5432/utility_cis pnpm prisma migrate deploy
```

Expected: "Applying migration `20260430140000_drop_sa_premise`" → "All migrations have been successfully applied."

- [ ] **Step 7 — Workspace typecheck.**

```bash
pnpm -w typecheck
```

Expected: zero errors. If any error surfaces about `premiseId` or `premise` on an SA, it means a read site was missed — go back to Task 1 / Task 2 and fix.

- [ ] **Step 8 — Run integration tests.**

```bash
pnpm --filter @utility-cis/api test:integration
```

Expected: 128/128 pass.

- [ ] **Step 9 — Commit.**

```bash
git add packages/shared/prisma/schema.prisma packages/shared/prisma/migrations/20260430140000_drop_sa_premise/
git commit -m "$(cat <<'EOF'
feat(schema): drop SA.premiseId column + ServiceAgreementMeter model (slice 2 task 4)

Slice 1 left these in as carryovers; all read paths now go through
ServicePoint, so the denormalised mirror and the unused model can go.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5 — Final verification + push

**Goal:** Confirm Slice 2 is complete and push.

**Steps:**

- [ ] **Step 1 — Workspace typecheck.**

```bash
pnpm -w typecheck
```

Expected: zero errors.

- [ ] **Step 2 — All integration tests.**

```bash
pnpm --filter @utility-cis/api test:integration
```

Expected: 128/128 pass.

- [ ] **Step 3 — Smoke-test the dev DB column is gone.**

```bash
docker exec -i claude-test-db-1 psql -U cis -d utility_cis -c "\d service_agreement" 2>&1 | grep premise
```

Expected: zero matches. (No premise_id column on the table.)

```bash
docker exec -i claude-test-db-1 psql -U cis -d utility_cis -c "\dt service_agreement_meter" 2>&1
```

Expected: "Did not find any relation named ..."

- [ ] **Step 4 — Push.**

```bash
git push origin main
```

---

## Self-review checklist (post-write)

- [x] **Spec coverage:** Drop SA.premiseId column. Remove SAM model. Retarget API services (5 files), web pages (8 files), and tests (multiple). Migration applied. Verification scripted.
- [x] **No placeholders:** every "find X, replace with Y" has the actual code; commit messages are inline.
- [x] **Type consistency:** `servicePoints[0].premise` traversal pattern is identical across all replacement sites; the optional-chaining pattern (`?.`) is consistent.
- [x] **Order constraint:** column drop comes LAST (Task 4), only after every read site is updated. If you reorder, the migration breaks at any read site that still expects the column.

---

## Slice 3 preview (separate plan, don't execute here)

- Multi-SP-per-SA UX: a single SA with N service points across N premises shows correctly on the account list/detail and the Services tab.
- Item-based / non-badged SP types: Container ↔ SP linkage for Solid Waste; ImperviousArea-style unbadged items for Stormwater.
- Operator UX rename: "Service Agreement" / "Agreements" → "Service" / "Services" across UI labels.
- "Add another service location to this subscription" affordance for commercial multi-premise accounts.
