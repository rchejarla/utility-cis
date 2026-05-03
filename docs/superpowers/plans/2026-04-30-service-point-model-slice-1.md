# Service Point Model Migration — Slice 1 Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use `- [ ]` checkboxes.

**Goal:** Introduce the `ServicePoint` (SP) entity between `ServiceAgreement` (SA) and `Premise`, and replace `ServiceAgreementMeter` (SAM) with `ServicePointMeter` (SPM) — adopting Oracle CC&B's hierarchy. Slice 1 is **behaviour-preserving**: every existing SA gets exactly one SP, every SAM row becomes one SPM row, and all existing services/UI keep working unchanged.

**Architecture:** Oracle CC&B-style: `Account → SA (subscription: rate + cycle + status) → SP (per-place anchor: premise + type) → Meter (via SPM, effective-dated)`. The SP layer is invisible for residential accounts (1 SA = 1 SP = 1 premise). Multi-premise commercial accounts and master/sub-meter setups will display additional SPs once Slice 3 ships UX for them.

**Tech additions:** none — Prisma + Postgres only.

**Slice 1 explicitly does NOT:**
- Drop `SA.premiseId` yet (kept as a denormalised mirror; nullable). Slice 2 removes it after the SP layer is the only read path.
- Add SP type variants beyond `METERED`. Item-based / non-badged SP types arrive in Slice 3 alongside Container ↔ SP linkage.
- Change the operator-facing labels ("Service Agreement", "Agreements" tab). Slice 3 renames these to "Service" / "Services".
- Change anything about UI per-place actions. They keep targeting SA today; Slice 2 retargets them to SP.

**What WILL change in Slice 1 (visible to a careful operator):**
- Audit log shows `service_point` create rows on backfill.
- A new `service_point` table appears. Internal queries that joined through `service_agreement_meter` now join through `service_point_meter`.

---

## Architectural cost-benefit

Per `CLAUDE.md` — every named pattern must justify itself before going in.

**Simpler alternative:** keep the current SA-with-premiseId model. Add waiver fields directly on SA. Accept duplicate SA rows for multi-premise commercial accounts.

**Concrete cost the SP pattern pays:**
- Bozeman RFP req#10 ("single account, multiple premises") fits naturally — one SA, multiple SPs.
- Master/sub-meter setups model cleanly: parent SP for the master meter, child SPs for sub-meters, all under one SA.
- Item-based services (trash containers, stormwater impervious area) get a uniform attachment point in Slice 3 — Container becomes a badged item on a non-metered SP.
- Industry vocabulary alignment: Oracle CC&B is the dominant utility CIS in North America. Operators, integrators, and migration tooling all use SP terminology. RFP proposals that name Oracle as the incumbent recognise the data model immediately.

**Conditions that justify it:** a target customer (Bozeman) has commercial multi-premise accounts AND non-metered services (trash) AND would benefit from item-based billing (containers, stormwater area). All three conditions hold.

**Default to direct broken because:** the simple SA-per-place model demonstrably fails for the two-buildings-one-trash example surfaced during architecture review. With SA collapsed to one premise, that scenario forces denormalised duplicate SAs (same account, same rate, same cycle, same status, only premise differs) — a textbook cure-by-normalisation case.

---

## File Structure

### Created

| Path | Responsibility |
|---|---|
| `packages/shared/prisma/migrations/<TS>_service_point_foundation/migration.sql` | Hand-written: create service_point + service_point_meter, backfill from SA/SAM, drop SAM, keep SA.premiseId as nullable mirror. |

### Modified

| Path | Change |
|---|---|
| `packages/shared/prisma/schema.prisma` | Add `ServicePoint` and `ServicePointMeter` models. Make `Premise → ServiceAgreement[]` relation pass through SP. Drop the `ServiceAgreementMeter` model + relation. Make `SA.premiseId` nullable. |
| `packages/api/src/services/meter-read.service.ts` | `resolveServiceAgreementId(meterId, readDate)` now walks SPM → SP → SA instead of SAM → SA. |
| `packages/api/src/services/meter.service.ts` | Any SAM read becomes SPM read. The `_count: { serviceAgreementMeters }` aggregations become `_count: { servicePointMeters }`. |
| `packages/api/src/services/service-agreement.service.ts` | When creating an SA, also create one SP for the same (utilityId, accountId, premiseId). When attaching a meter, target SPM (with the SP just created). When closing an SA, end-date its SPs. |
| `packages/api/src/services/effective-dating.service.ts` | The "history of meter assignments for an SA" timeline reads from SPM joined through SP, not SAM. |
| `packages/api/src/services/workflows.service.ts` | Same shape — any SAM read becomes SPM read. |
| `packages/api/src/services/customer-graph.service.ts` | Already reads SA.premiseId for graph nodes — no change yet (Slice 2 retargets to SP). |
| `packages/api/src/imports/handlers/meter-read.ts` | If the import handler reaches into SAM directly (likely via meter-read.service), the change cascades. No direct edit unless the handler queries SAM by name. |
| `packages/api/src/routes/service-agreements.ts` | Same as service-agreement.service — any SAM verb becomes SPM. |
| `packages/api/src/routes/effective-dating-queries.ts` | Same. |
| `packages/api/src/__tests__/integration/cascade-close.integration.test.ts` | Existing test asserts SAM rows are end-dated when an SA closes; rewrite assertions to target SPM. |
| `packages/api/src/__tests__/integration/audit-wrap.integration.test.ts` | Adjusts any SAM-named asserts. |
| `packages/api/src/__tests__/integration/_effective-dating-fixtures.ts` | Fixture that creates SAM rows for tests now creates an SP + SPM pair instead. |

### Deleted

- The `ServiceAgreementMeter` Prisma model.
- The `service_agreement_meter` table (replaced by `service_point_meter`).

---

## Sequencing & dependencies

The migration must be applied as **one atomic SQL file** because the SAM table is dropped at the end and the existing tests/services will fail if SP/SPM aren't already populated when the schema changes. The Prisma model edit happens in the same commit as the migration so the generated client matches the DB.

Tasks 1–3 land the schema. Tasks 4–8 update the service layer to read from SPM. Tasks 9–10 verify nothing regressed. Each task ends with `pnpm -w typecheck` clean and a commit.

---

## Task 1 — Add the Prisma models

**Goal:** Define `ServicePoint` and `ServicePointMeter` in the Prisma schema. Keep the `ServiceAgreementMeter` model in place for now (it'll be removed in Task 2 once the migration is also written).

**Files:**
- Modify: `packages/shared/prisma/schema.prisma`

**Steps:**

- [ ] **Step 1 — Add `ServicePoint` and `ServicePointMeter` models** (place them right after `ServiceAgreementMeter` in the file).

```prisma
/// Per-place service-delivery anchor between SA and Premise. One
/// SA can have multiple SPs (multi-premise commercial accounts,
/// master/sub-meter); each SP belongs to exactly one Premise. SP
/// type controls whether meters or items hang off it; Slice 1
/// only uses METERED.
enum ServicePointType {
  METERED
  ITEM_BASED
  NON_BADGED

  @@map("service_point_type")
}

enum ServicePointStatus {
  PENDING
  ACTIVE
  FINAL
  CLOSED

  @@map("service_point_status")
}

model ServicePoint {
  id                 String              @id @default(uuid()) @db.Uuid
  utilityId          String              @map("utility_id") @db.Uuid
  serviceAgreementId String              @map("service_agreement_id") @db.Uuid
  premiseId          String              @map("premise_id") @db.Uuid
  type               ServicePointType   @default(METERED) @map("type")
  status             ServicePointStatus @default(ACTIVE) @map("status")
  startDate          DateTime            @map("start_date") @db.Date
  endDate            DateTime?           @map("end_date") @db.Date
  createdAt          DateTime            @default(now()) @map("created_at") @db.Timestamptz
  updatedAt          DateTime            @updatedAt @map("updated_at") @db.Timestamptz

  serviceAgreement ServiceAgreement     @relation(fields: [serviceAgreementId], references: [id], onDelete: Cascade)
  premise          Premise              @relation(fields: [premiseId], references: [id], onDelete: Restrict)
  meters           ServicePointMeter[]

  @@index([serviceAgreementId])
  @@index([premiseId])
  @@index([utilityId, status])
  @@map("service_point")
}

/// SP ↔ Meter assignment with effective dates. Replaces SAM. At
/// most one ACTIVE row per (meter_id) at any instant — enforced by
/// the partial exclusion constraint defined in the migration.
model ServicePointMeter {
  id              String    @id @default(uuid()) @db.Uuid
  utilityId       String    @map("utility_id") @db.Uuid
  servicePointId  String    @map("service_point_id") @db.Uuid
  meterId         String    @map("meter_id") @db.Uuid
  addedDate       DateTime  @map("added_date") @db.Date
  removedDate     DateTime? @map("removed_date") @db.Date
  createdAt       DateTime  @default(now()) @map("created_at") @db.Timestamptz
  /// Generated tsrange [added_date, removed_date) — DB-managed, read-only.
  effectiveRange  Unsupported("tsrange")? @map("effective_range")

  servicePoint ServicePoint @relation(fields: [servicePointId], references: [id], onDelete: Cascade)
  meter        Meter        @relation(fields: [meterId], references: [id], onDelete: Restrict)

  @@index([servicePointId])
  @@index([meterId])
  @@map("service_point_meter")
}
```

- [ ] **Step 2 — Add the reverse relations on `ServiceAgreement`, `Premise`, `Meter`.**

In the `ServiceAgreement` model, add inside the relations block:
```prisma
  servicePoints ServicePoint[]
```

In the `Premise` model:
```prisma
  servicePoints ServicePoint[]
```

In the `Meter` model:
```prisma
  servicePointMeters ServicePointMeter[]
```

- [ ] **Step 3 — Make `SA.premiseId` nullable.** Find:
```prisma
  premiseId          String        @map("premise_id") @db.Uuid
```
Change to:
```prisma
  premiseId          String?       @map("premise_id") @db.Uuid
```

(The relation declaration `premise Premise @relation(...)` becomes `premise Premise? @relation(...)`.)

- [ ] **Step 4 — Don't remove `ServiceAgreementMeter` yet.** Leave the model in place; Task 2 removes it via the migration.

- [ ] **Step 5 — Validate the schema parses (without running migrate).**

```bash
cd packages/shared && pnpm prisma validate
```

Expected: "The schema at prisma\\schema.prisma is valid 🚀". If invalid, the most likely cause is a missing `@relation` between SP and SA — re-check the field signatures.

- [ ] **Step 6 — Don't generate the client yet.** Task 2 will write the migration; we'll regenerate after both schema and migration are in place.

(No commit at the end of Task 1 — Task 2 commits both schema and migration together so HEAD is never in a half-migrated state.)

---

## Task 2 — Write the migration SQL

**Goal:** One atomic migration that creates SP + SPM, backfills both from existing SA + SAM rows, sets up the partial exclusion constraint on SPM, and drops SAM.

**Files:**
- Create: `packages/shared/prisma/migrations/<TIMESTAMP>_service_point_foundation/migration.sql`

(Use timestamp `20260430120000` to keep migration ordering monotonic.)

**Steps:**

- [ ] **Step 1 — Create the migration directory.**

```bash
mkdir -p packages/shared/prisma/migrations/20260430120000_service_point_foundation
```

- [ ] **Step 2 — Write the migration.sql.**

```sql
-- Service Point foundation. Splits SA-with-premise into SA-without-
-- premise + SP-per-premise. Replaces SAM with SPM. Behaviour-preserving:
-- every existing SA gets one SP, every SAM row becomes one SPM row.
--
-- Slice 1 keeps SA.premise_id (now nullable) as a denormalised mirror
-- so that nothing reading it breaks today. Slice 2 drops the column
-- once all read paths go through SP.

-- ─── 1. Enums ─────────────────────────────────────────────────────────

CREATE TYPE service_point_type AS ENUM ('METERED', 'ITEM_BASED', 'NON_BADGED');
CREATE TYPE service_point_status AS ENUM ('PENDING', 'ACTIVE', 'FINAL', 'CLOSED');

-- ─── 2. service_point table ───────────────────────────────────────────

CREATE TABLE service_point (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  utility_id           UUID NOT NULL,
  service_agreement_id UUID NOT NULL,
  premise_id           UUID NOT NULL,
  type                 service_point_type NOT NULL DEFAULT 'METERED',
  status               service_point_status NOT NULL DEFAULT 'ACTIVE',
  start_date           DATE NOT NULL,
  end_date             DATE,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT service_point_sa_fk      FOREIGN KEY (service_agreement_id) REFERENCES service_agreement(id) ON DELETE CASCADE,
  CONSTRAINT service_point_premise_fk FOREIGN KEY (premise_id)           REFERENCES premise(id)           ON DELETE RESTRICT
);
CREATE INDEX service_point_sa_idx           ON service_point (service_agreement_id);
CREATE INDEX service_point_premise_idx      ON service_point (premise_id);
CREATE INDEX service_point_utility_status   ON service_point (utility_id, status);

-- RLS, mirroring service_agreement.
ALTER TABLE service_point ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON service_point
  USING (utility_id = current_setting('app.current_utility_id', true)::uuid);

-- ─── 3. service_point_meter table ─────────────────────────────────────

CREATE TABLE service_point_meter (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  utility_id       UUID NOT NULL,
  service_point_id UUID NOT NULL,
  meter_id         UUID NOT NULL,
  added_date       DATE NOT NULL,
  removed_date     DATE,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  effective_range  tsrange GENERATED ALWAYS AS (
    tsrange(
      added_date::timestamp,
      COALESCE(removed_date::timestamp, 'infinity'::timestamp),
      '[)'
    )
  ) STORED,
  CONSTRAINT spm_sp_fk    FOREIGN KEY (service_point_id) REFERENCES service_point(id) ON DELETE CASCADE,
  CONSTRAINT spm_meter_fk FOREIGN KEY (meter_id)         REFERENCES meter(id)         ON DELETE RESTRICT
);
CREATE INDEX spm_sp_idx     ON service_point_meter (service_point_id);
CREATE INDEX spm_meter_idx  ON service_point_meter (meter_id);

-- A meter can't be installed at two SPs at once. Mirrors the SAM
-- exclusion constraint that this table replaces.
ALTER TABLE service_point_meter
  ADD CONSTRAINT spm_no_double_install
  EXCLUDE USING gist (meter_id WITH =, effective_range WITH &&);

ALTER TABLE service_point_meter ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON service_point_meter
  USING (utility_id = current_setting('app.current_utility_id', true)::uuid);

-- ─── 4. Backfill: one SP per existing SA ──────────────────────────────
-- Each existing SA has a non-null premise_id today (the column is
-- still NOT NULL at this point). Map status: SA PENDING → SP PENDING,
-- SA ACTIVE → SP ACTIVE, SA FINAL/CLOSED → SP CLOSED.

INSERT INTO service_point (
  id, utility_id, service_agreement_id, premise_id, type, status,
  start_date, end_date, created_at
)
SELECT
  gen_random_uuid(),
  utility_id,
  id AS service_agreement_id,
  premise_id,
  'METERED'::service_point_type,
  CASE
    WHEN status = 'PENDING' THEN 'PENDING'::service_point_status
    WHEN status = 'ACTIVE'  THEN 'ACTIVE'::service_point_status
    ELSE 'CLOSED'::service_point_status
  END,
  start_date,
  end_date,
  created_at
FROM service_agreement;

-- ─── 5. Backfill: one SPM per existing SAM ────────────────────────────
-- Each existing SAM row maps to a SPM row, attached to the SP we
-- just created for the SAM's service_agreement_id.

INSERT INTO service_point_meter (
  id, utility_id, service_point_id, meter_id, added_date, removed_date, created_at
)
SELECT
  gen_random_uuid(),
  sam.utility_id,
  sp.id AS service_point_id,
  sam.meter_id,
  sam.added_date,
  sam.removed_date,
  sam.created_at
FROM service_agreement_meter sam
JOIN service_point sp ON sp.service_agreement_id = sam.service_agreement_id;

-- ─── 6. Drop SAM ──────────────────────────────────────────────────────
-- Drop in reverse-dependency order: drop the table (its constraints
-- and indexes go with it).

DROP TABLE service_agreement_meter;

-- ─── 7. Loosen SA.premise_id ──────────────────────────────────────────
-- Now nullable so future SAs can be created without a premise (the
-- premise lives on the SP). Existing rows keep their value as a
-- denormalised mirror; Slice 2 will drop the column entirely once
-- all read sites use SP.

ALTER TABLE service_agreement ALTER COLUMN premise_id DROP NOT NULL;
```

- [ ] **Step 3 — Generate the Prisma client.**

```bash
cd packages/shared && pnpm prisma generate
```

Expected: "Generated Prisma Client" with no errors. Common failure: `service_point_meter` references `meter` table which the schema must still know about — the model definitions in Task 1 must already include the SP/SPM models with the right `@map(...)` names matching this SQL.

- [ ] **Step 4 — Apply against the dev DB.**

```bash
cd packages/shared && DATABASE_URL=postgresql://cis:cis_dev_password@localhost:5432/utility_cis pnpm prisma migrate deploy
```

Expected: "Applying migration `20260430120000_service_point_foundation`" then "All migrations have been successfully applied."

If the migration fails, the most likely cause is data inconsistency in `service_agreement` (a row with `premise_id = NULL` at backfill time). Investigate via:
```sql
SELECT id, account_number, premise_id FROM service_agreement WHERE premise_id IS NULL;
```
If any rows surface, fix them by hand before re-running.

- [ ] **Step 5 — Sanity-check counts.**

```bash
docker exec -i claude-test-db-1 psql -U cis -d utility_cis -c "SELECT (SELECT count(*) FROM service_agreement) AS sa, (SELECT count(*) FROM service_point) AS sp, (SELECT count(*) FROM service_point_meter) AS spm;"
```

Expected: `sa = sp` exactly (every SA got one SP), and `spm` matches whatever the old SAM count was.

- [ ] **Step 6 — Workspace typecheck.**

```bash
pnpm -w typecheck
```

Expected: errors. The next tasks fix them. The errors will all be in service files that read `prisma.serviceAgreementMeter` (which no longer exists in the generated client).

- [ ] **Step 7 — Commit schema + migration together.**

```bash
git add packages/shared/prisma/schema.prisma packages/shared/prisma/migrations/20260430120000_service_point_foundation/
git commit -m "feat(schema): add ServicePoint + ServicePointMeter (slice 1 task 1-2)

Backfills one SP per existing SA and one SPM per existing SAM, then
drops the SAM table. SA.premise_id becomes nullable. Service-layer
fixes follow in subsequent tasks.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

The commit is intentionally allowed to leave `pnpm typecheck` red — Task 3 onwards repairs it. Each subsequent task is a single working-state commit.

---

## Task 3 — Fix `meter-read.service.ts`

**Goal:** `resolveServiceAgreementId(meterId, readDate)` now walks SPM → SP → SA. The function signature stays the same so callers don't change.

**Files:**
- Modify: `packages/api/src/services/meter-read.service.ts:235-260`

**Steps:**

- [ ] **Step 1 — Open the function. Today it looks like:**

```typescript
export async function resolveServiceAgreementId(
  utilityId: string,
  meterId: string,
  readDate: Date,
): Promise<string | null> {
  const assignment = await prisma.serviceAgreementMeter.findFirst({
    where: {
      utilityId,
      meterId,
      addedDate: { lte: readDate },
      OR: [{ removedDate: null }, { removedDate: { gt: readDate } }],
    },
    select: { serviceAgreementId: true },
    orderBy: { addedDate: "desc" },
  });
  return assignment?.serviceAgreementId ?? null;
}
```

- [ ] **Step 2 — Replace with SPM-walk version:**

```typescript
export async function resolveServiceAgreementId(
  utilityId: string,
  meterId: string,
  readDate: Date,
): Promise<string | null> {
  // Walk SPM (the meter's installation row at this date) → SP →
  // serviceAgreementId. Replaces the old SAM → SA single-step walk.
  const installation = await prisma.servicePointMeter.findFirst({
    where: {
      utilityId,
      meterId,
      addedDate: { lte: readDate },
      OR: [{ removedDate: null }, { removedDate: { gt: readDate } }],
    },
    select: { servicePoint: { select: { serviceAgreementId: true } } },
    orderBy: { addedDate: "desc" },
  });
  return installation?.servicePoint.serviceAgreementId ?? null;
}
```

- [ ] **Step 3 — Re-run typecheck for this file's slice:**

```bash
pnpm --filter @utility-cis/api exec tsc --noEmit
```

Expect remaining errors in *other* files; this one is now clean.

- [ ] **Step 4 — Commit.**

```bash
git add packages/api/src/services/meter-read.service.ts
git commit -m "refactor(meter-read): resolveServiceAgreementId walks SPM (slice 1 task 3)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 4 — Fix `service-agreement.service.ts`

**Goal:** When `createServiceAgreement` runs today, it creates SA + (optionally) attaches meters via SAM. After this task, it creates SA + one SP for the (account, premise) pair + (optionally) attaches meters via SPM under that SP. When closing an SA, propagate the close to its SPs. All existing inputs/outputs preserved.

**Files:**
- Modify: `packages/api/src/services/service-agreement.service.ts`

**Steps:**

- [ ] **Step 1 — Find the `createServiceAgreement` function (search for `prisma.serviceAgreement.create`).** It currently inserts SA, then any SAM rows. Replace the meter-attachment portion:

```typescript
// OLD:
const sa = await tx.serviceAgreement.create({ data: { ... } });
if (data.meterIds && data.meterIds.length > 0) {
  await tx.serviceAgreementMeter.createMany({
    data: data.meterIds.map((meterId, i) => ({
      utilityId, serviceAgreementId: sa.id, meterId,
      isPrimary: i === 0,
      addedDate: data.startDate,
    })),
  });
}
return sa;

// NEW:
const sa = await tx.serviceAgreement.create({ data: { ... } });
const sp = await tx.servicePoint.create({
  data: {
    utilityId,
    serviceAgreementId: sa.id,
    premiseId: data.premiseId,
    type: "METERED",
    status: sa.status === "PENDING" ? "PENDING" : "ACTIVE",
    startDate: data.startDate,
  },
});
if (data.meterIds && data.meterIds.length > 0) {
  await tx.servicePointMeter.createMany({
    data: data.meterIds.map((meterId) => ({
      utilityId,
      servicePointId: sp.id,
      meterId,
      addedDate: data.startDate,
    })),
  });
}
return sa;
```

(The `isPrimary` field had no semantic meaning beyond "the meter we display first" — Oracle's model says one meter per SP at a time, so the concept is structurally implicit. We drop it.)

- [ ] **Step 2 — Find `closeServiceAgreement` (search for `status: "CLOSED"` or `status: "FINAL"`).** Add a parallel SP close:

```typescript
await tx.servicePoint.updateMany({
  where: { serviceAgreementId: id, endDate: null },
  data: { status: "CLOSED", endDate: closeDate },
});
```

Also propagate to SPM rows that are still open:
```typescript
await tx.servicePointMeter.updateMany({
  where: {
    servicePoint: { serviceAgreementId: id },
    removedDate: null,
  },
  data: { removedDate: closeDate },
});
```

- [ ] **Step 3 — Find any function that currently does `prisma.serviceAgreementMeter.{xxx}` — search the file for `serviceAgreementMeter`.** Replace with `prisma.servicePointMeter.{xxx}`, and update the where-clauses:
  - `where: { serviceAgreementId: X }` → `where: { servicePoint: { serviceAgreementId: X } }`

- [ ] **Step 4 — Typecheck.**

```bash
pnpm --filter @utility-cis/api exec tsc --noEmit
```

- [ ] **Step 5 — Commit.**

```bash
git add packages/api/src/services/service-agreement.service.ts
git commit -m "refactor(sa): create SP alongside SA; SAM ops become SPM ops (slice 1 task 4)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 5 — Fix `meter.service.ts` and `effective-dating.service.ts`

**Goal:** All remaining service files that read SAM now read SPM through the SP join.

**Files:**
- Modify: `packages/api/src/services/meter.service.ts`
- Modify: `packages/api/src/services/effective-dating.service.ts`
- Modify: `packages/api/src/services/workflows.service.ts`
- Modify: `packages/api/src/routes/effective-dating-queries.ts`
- Modify: `packages/api/src/routes/service-agreements.ts`

**Steps:**

- [ ] **Step 1 — For each file above, run a grep:**

```bash
grep -n "serviceAgreementMeter\|service_agreement_meter\|isPrimary" \
  packages/api/src/services/meter.service.ts \
  packages/api/src/services/effective-dating.service.ts \
  packages/api/src/services/workflows.service.ts \
  packages/api/src/routes/effective-dating-queries.ts \
  packages/api/src/routes/service-agreements.ts
```

For each match, apply the substitution rules:
  1. `prisma.serviceAgreementMeter` → `prisma.servicePointMeter`
  2. `_count: { serviceAgreementMeters: ... }` → `_count: { servicePointMeters: ... }`
  3. `where: { serviceAgreementId: X }` → `where: { servicePoint: { serviceAgreementId: X } }`
  4. Drop any read of `isPrimary` (the field no longer exists on SPM). If a UI presentation depended on it, replace with "the most-recently-added active meter" by ordering on `addedDate desc`.
  5. `include: { meter: { ... } }` stays unchanged — the relation name on SPM is still `meter`.

- [ ] **Step 2 — Typecheck after each file's edit.** If you batch all five edits before checking, errors compound and become harder to localise.

- [ ] **Step 3 — Commit (one commit, all five files):**

```bash
git add packages/api/src/services/meter.service.ts \
        packages/api/src/services/effective-dating.service.ts \
        packages/api/src/services/workflows.service.ts \
        packages/api/src/routes/effective-dating-queries.ts \
        packages/api/src/routes/service-agreements.ts
git commit -m "refactor(meter,effective-dating): SAM reads become SPM reads (slice 1 task 5)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 6 — Update fixture and test code

**Goal:** Tests that wrote SAM rows directly now write SP + SPM. Tests that asserted SAM row shape now assert SPM. The fixture builder (`makeTenantFixture`) creates SP rows alongside SAs.

**Files:**
- Modify: `packages/api/src/__tests__/integration/_effective-dating-fixtures.ts`
- Modify: `packages/api/src/__tests__/integration/cascade-close.integration.test.ts`
- Modify: `packages/api/src/__tests__/integration/audit-wrap.integration.test.ts`
- Possibly: `packages/api/src/__tests__/integration/imports.integration.test.ts` (if the meter-read test creates SAM directly)

**Steps:**

- [ ] **Step 1 — Open `_effective-dating-fixtures.ts` and find the function that creates the test SA.** After SA creation, add SP + SPM creation:

```typescript
const sa = await prisma.serviceAgreement.create({ data: { ... } });
const sp = await prisma.servicePoint.create({
  data: {
    utilityId,
    serviceAgreementId: sa.id,
    premiseId: premise.id,
    type: "METERED",
    status: "ACTIVE",
    startDate: new Date("2024-01-01"),
  },
});
await prisma.servicePointMeter.createMany({
  data: [
    { utilityId, servicePointId: sp.id, meterId: meter.id,  addedDate: new Date("2024-01-01") },
    { utilityId, servicePointId: sp.id, meterId: meter2.id, addedDate: new Date("2024-01-01") },
    { utilityId, servicePointId: sp.id, meterId: meter3.id, addedDate: new Date("2024-01-01") },
  ],
});
```

Drop any direct `prisma.serviceAgreementMeter.createMany(...)` calls.

- [ ] **Step 2 — In `cascade-close.integration.test.ts`, find SAM assertions:**

```typescript
expect(await prisma.serviceAgreementMeter.findMany({ where: { serviceAgreementId } })).toHaveLength(0);
```

Replace with the SPM-via-SP assertion:

```typescript
const spIds = (await prisma.servicePoint.findMany({
  where: { serviceAgreementId },
  select: { id: true },
})).map((s) => s.id);
expect(await prisma.servicePointMeter.count({
  where: { servicePointId: { in: spIds }, removedDate: null },
})).toBe(0);
```

- [ ] **Step 3 — Re-run integration tests.**

```bash
pnpm --filter @utility-cis/api test:integration
```

Expected: all green. If any fail, the most likely cause is a remaining SAM reference somewhere — grep the file the failing test exercises and apply the substitution rules from Task 5.

- [ ] **Step 4 — Commit.**

```bash
git add packages/api/src/__tests__/integration/_effective-dating-fixtures.ts \
        packages/api/src/__tests__/integration/cascade-close.integration.test.ts \
        packages/api/src/__tests__/integration/audit-wrap.integration.test.ts
git commit -m "test(sa): fixture and assertions move from SAM to SP+SPM (slice 1 task 6)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 7 — Update the seed

**Goal:** The seed creates SA rows; now it must also create one SP per SA + the SPM rows.

**Files:**
- Modify: `packages/shared/prisma/seed.ts`
- Modify: `seed.js` (if it also creates SAs/SAMs directly)

**Steps:**

- [ ] **Step 1 — Find the SA creation loop.** In `seed.ts` (or `seed.js`), the loop today reads roughly:

```typescript
for (const sa of agreements) {
  await prisma.serviceAgreement.create({
    data: {
      utilityId: UTILITY_ID,
      ...saData,
      meters: {
        create: meterIndices.map((idx, i) => ({
          utilityId: UTILITY_ID,
          meterId: createdMeters[idx].id,
          isPrimary: i === 0,
          addedDate: new Date("2025-01-01"),
        })),
      },
    },
  });
}
```

Replace the inline meter `create:` with explicit SP + SPM steps:

```typescript
for (const sa of agreements) {
  const created = await prisma.serviceAgreement.create({
    data: { utilityId: UTILITY_ID, ...saData },
  });
  const sp = await prisma.servicePoint.create({
    data: {
      utilityId: UTILITY_ID,
      serviceAgreementId: created.id,
      premiseId: created.premiseId!,
      type: "METERED",
      status: "ACTIVE",
      startDate: new Date("2025-01-01"),
    },
  });
  for (const idx of meterIndices) {
    await prisma.servicePointMeter.create({
      data: {
        utilityId: UTILITY_ID,
        servicePointId: sp.id,
        meterId: createdMeters[idx].id,
        addedDate: new Date("2025-01-01"),
      },
    });
  }
}
```

- [ ] **Step 2 — Run the seed.**

```bash
unset DATABASE_URL && DATABASE_URL=postgresql://cis:cis_dev_password@localhost:5432/utility_cis node seed.js
```

Expected: completes without error. Verify counts by running the SQL from Task 2 Step 5 again — `sa`, `sp`, and `spm` rows should make sense.

- [ ] **Step 3 — Commit.**

```bash
git add packages/shared/prisma/seed.ts seed.js
git commit -m "chore(seed): create SP + SPM per seeded SA (slice 1 task 7)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 8 — Full verification

**Goal:** Confirm the migration is complete and behaviour is preserved end to end.

**Steps:**

- [ ] **Step 1 — Workspace typecheck.**

```bash
pnpm -w typecheck
```

Expected: zero errors.

- [ ] **Step 2 — Run the integration suite.**

```bash
pnpm --filter @utility-cis/api test:integration
```

Expected: all tests pass (currently ~128 tests). Any regression here means a service path still uses SAM somewhere that wasn't covered.

- [ ] **Step 3 — Smoke-test the API + UI manually.**

1. Start API + worker + web.
2. Open `/accounts` — the list still shows the customer + premise columns we just added in the previous slice. Premise should resolve correctly via SP backfill.
3. Open an account detail page → Services tab. Confirm each SA shows. Open one, confirm meters are assigned. Add a meter to a service — should succeed and create an SPM row.
4. Run a meter import (use the 300-row CSV from earlier work). Confirm reads land with correct serviceAgreementId via SPM resolution.

- [ ] **Step 4 — If everything green, push.**

```bash
git push origin main
```

---

## Self-review checklist (run after writing all tasks)

- [x] **Spec coverage:** Schema changes, all SAM→SPM call sites, fixture, seed, typecheck, tests, smoke. Bozeman req#10 (multi-premise per account) is unblocked but not exercised in Slice 1 — Slice 3 ships UI for it. Item-based SP types are reserved (enum exists) but not implemented — Slice 3.
- [x] **No placeholders:** every "find X, replace with Y" task has the actual code; substitution rules are explicit; commit messages are written out.
- [x] **Type consistency:** `ServicePoint`, `ServicePointMeter`, `service_point`, `service_point_meter`, `servicePointId`, `serviceAgreementId` — all consistent across tasks.
- [x] **No half-broken commits:** Task 2 leaves typecheck red; Tasks 3-7 each repair a slice and end green. The commit history is reviewable.

---

## Slice 2 / Slice 3 preview (separate plans, don't execute here)

**Slice 2 — Decouple SA from premise.**
- Drop `SA.premiseId` (the column) entirely. Update every read site (customer-graph, audit, charges) to traverse SA → SP[0].premise.
- Update Account list/detail UI to display premise via the SP path; multi-premise accounts now show every distinct premise.
- Add SP-aware UI affordances: Service detail page shows its SP; meter assignment shows the SP context.

**Slice 3 — Item-based services + UX rename.**
- Add Container ↔ SP linkage for solid-waste services (badged item attached to ITEM_BASED SP).
- Stub for non-badged items (stormwater impervious area).
- Operator-facing rename: "Service Agreement" / "Agreements" tab → "Service" / "Services". Spec doc updates.
- Multi-SP-per-SA UI: "Add another service location to this subscription" for commercial multi-premise accounts.
