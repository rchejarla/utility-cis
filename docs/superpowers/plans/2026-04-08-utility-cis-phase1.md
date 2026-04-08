# Utility CIS Phase 1 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the foundation layer of the Utility CIS — database schema (13 entities), REST API (29 endpoints), multi-tenancy (RLS), internal events, and admin UI with map view and theme editor.

**Architecture:** Turborepo monorepo with three packages: `shared` (Prisma + Zod + types), `api` (Fastify on port 3001), `web` (Next.js on port 3000). PostgreSQL with RLS for multi-tenancy, TimescaleDB for meter reads, Redis for caching. API-first approach — build the API, then the UI consumes it.

**Tech Stack:** TypeScript, Turborepo, Fastify, Next.js 14+, Prisma, PostgreSQL 16+, TimescaleDB, Redis, NextAuth.js, Zod, shadcn/ui, Tailwind, Mapbox GL JS, Vitest

**Spec:** `docs/superpowers/specs/2026-04-08-utility-cis-phase1-design.md`

---

## Task 1: Monorepo Scaffolding

**Files:**
- Create: `package.json` (root)
- Create: `turbo.json`
- Create: `docker-compose.yml`
- Create: `.gitignore`
- Create: `.env.example`
- Create: `packages/shared/package.json`
- Create: `packages/shared/tsconfig.json`
- Create: `packages/api/package.json`
- Create: `packages/api/tsconfig.json`
- Create: `packages/web/package.json`
- Create: `packages/web/tsconfig.json`

- [ ] **Step 1: Initialize root package.json**

```json
{
  "name": "utility-cis",
  "private": true,
  "workspaces": ["packages/*"],
  "scripts": {
    "dev": "turbo dev",
    "build": "turbo build",
    "test": "turbo test",
    "lint": "turbo lint",
    "db:generate": "turbo db:generate",
    "db:push": "turbo db:push",
    "db:migrate": "turbo db:migrate"
  },
  "devDependencies": {
    "turbo": "^2.4.0",
    "typescript": "^5.7.0"
  },
  "packageManager": "pnpm@9.15.0"
}
```

- [ ] **Step 2: Create turbo.json**

```json
{
  "$schema": "https://turbo.build/schema.json",
  "tasks": {
    "build": {
      "dependsOn": ["^build"],
      "outputs": [".next/**", "dist/**"]
    },
    "dev": {
      "cache": false,
      "persistent": true
    },
    "test": {
      "dependsOn": ["^build"]
    },
    "lint": {},
    "db:generate": {
      "cache": false
    },
    "db:push": {
      "cache": false
    },
    "db:migrate": {
      "cache": false
    }
  }
}
```

- [ ] **Step 3: Create docker-compose.yml**

```yaml
version: "3.8"
services:
  postgres:
    image: timescale/timescaledb:latest-pg16
    ports:
      - "5432:5432"
    environment:
      POSTGRES_USER: cis
      POSTGRES_PASSWORD: cis_dev_password
      POSTGRES_DB: utility_cis
    volumes:
      - pgdata:/var/lib/postgresql/data

  redis:
    image: redis:7-alpine
    ports:
      - "6379:6379"

volumes:
  pgdata:
```

- [ ] **Step 4: Create .gitignore**

```
node_modules/
.next/
dist/
.env
.env.local
*.log
.turbo/
.superpowers/
```

- [ ] **Step 5: Create .env.example**

```
DATABASE_URL=postgresql://cis:cis_dev_password@localhost:5432/utility_cis
REDIS_URL=redis://localhost:6379
NEXTAUTH_SECRET=change-me-in-production
NEXTAUTH_URL=http://localhost:3000
API_URL=http://localhost:3001
MAPBOX_TOKEN=pk.your-mapbox-token-here
```

- [ ] **Step 6: Create packages/shared/package.json**

```json
{
  "name": "@utility-cis/shared",
  "version": "0.0.1",
  "private": true,
  "main": "./src/index.ts",
  "types": "./src/index.ts",
  "scripts": {
    "build": "tsc",
    "db:generate": "prisma generate",
    "db:push": "prisma db push",
    "db:migrate": "prisma migrate dev",
    "test": "vitest run"
  },
  "dependencies": {
    "@prisma/client": "^6.4.0",
    "zod": "^3.24.0"
  },
  "devDependencies": {
    "prisma": "^6.4.0",
    "typescript": "^5.7.0",
    "vitest": "^3.0.0"
  }
}
```

- [ ] **Step 7: Create packages/shared/tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "esModuleInterop": true,
    "outDir": "dist",
    "rootDir": "src",
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "skipLibCheck": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist"]
}
```

- [ ] **Step 8: Create packages/api/package.json**

```json
{
  "name": "@utility-cis/api",
  "version": "0.0.1",
  "private": true,
  "scripts": {
    "dev": "tsx watch src/server.ts",
    "build": "tsc",
    "start": "node dist/server.js",
    "test": "vitest run"
  },
  "dependencies": {
    "@utility-cis/shared": "workspace:*",
    "fastify": "^5.2.0",
    "@fastify/cors": "^10.0.0",
    "@fastify/jwt": "^9.0.0",
    "ioredis": "^5.4.0"
  },
  "devDependencies": {
    "tsx": "^4.19.0",
    "typescript": "^5.7.0",
    "vitest": "^3.0.0",
    "@types/node": "^22.0.0"
  }
}
```

- [ ] **Step 9: Create packages/api/tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "esModuleInterop": true,
    "outDir": "dist",
    "rootDir": "src",
    "declaration": true,
    "sourceMap": true,
    "skipLibCheck": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist"]
}
```

- [ ] **Step 10: Create packages/web/package.json**

```json
{
  "name": "@utility-cis/web",
  "version": "0.0.1",
  "private": true,
  "scripts": {
    "dev": "next dev",
    "build": "next build",
    "start": "next start",
    "lint": "next lint",
    "test": "vitest run"
  },
  "dependencies": {
    "@utility-cis/shared": "workspace:*",
    "next": "^15.2.0",
    "react": "^19.0.0",
    "react-dom": "^19.0.0",
    "next-auth": "^4.24.0",
    "@tanstack/react-query": "^5.62.0",
    "@tanstack/react-table": "^8.21.0",
    "react-hook-form": "^7.54.0",
    "@hookform/resolvers": "^4.1.0",
    "react-map-gl": "^7.1.0",
    "mapbox-gl": "^3.9.0",
    "supercluster": "^8.0.0"
  },
  "devDependencies": {
    "typescript": "^5.7.0",
    "tailwindcss": "^4.0.0",
    "@types/node": "^22.0.0",
    "@types/react": "^19.0.0",
    "@types/supercluster": "^7.1.0",
    "vitest": "^3.0.0"
  }
}
```

- [ ] **Step 11: Create packages/web/tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["dom", "dom.iterable", "esnext"],
    "allowJs": true,
    "skipLibCheck": true,
    "strict": true,
    "noEmit": true,
    "esModuleInterop": true,
    "module": "esnext",
    "moduleResolution": "bundler",
    "resolveJsonModule": true,
    "isolatedModules": true,
    "jsx": "preserve",
    "incremental": true,
    "plugins": [{ "name": "next" }],
    "paths": { "@/*": ["./src/*"] }
  },
  "include": ["next-env.d.ts", "**/*.ts", "**/*.tsx", ".next/types/**/*.ts"],
  "exclude": ["node_modules"]
}
```

- [ ] **Step 12: Install dependencies and verify**

Run: `pnpm install`
Expected: All dependencies installed, workspace links resolved.

Run: `docker compose up -d`
Expected: PostgreSQL (with TimescaleDB) and Redis containers running.

- [ ] **Step 13: Commit**

```bash
git add -A
git commit -m "feat: scaffold Turborepo monorepo with shared, api, and web packages"
```

---

## Task 2: Prisma Schema — All 13 Entities

**Files:**
- Create: `packages/shared/prisma/schema.prisma`

- [ ] **Step 1: Write the full Prisma schema**

```prisma
generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

// ============ REFERENCE ENTITIES ============

model Commodity {
  id            String   @id @default(uuid()) @db.Uuid
  utilityId     String   @map("utility_id") @db.Uuid
  code          String   @db.VarChar(50)
  name          String   @db.VarChar(100)
  defaultUomId  String?  @map("default_uom_id") @db.Uuid
  isActive      Boolean  @default(true) @map("is_active")
  displayOrder  Int      @default(0) @map("display_order")
  createdAt     DateTime @default(now()) @map("created_at") @db.Timestamptz

  defaultUom         UnitOfMeasure?       @relation("DefaultUom", fields: [defaultUomId], references: [id])
  unitsOfMeasure     UnitOfMeasure[]      @relation("CommodityUoms")
  meters             Meter[]
  serviceAgreements  ServiceAgreement[]
  rateSchedules      RateSchedule[]

  @@unique([utilityId, code])
  @@map("commodity")
}

model UnitOfMeasure {
  id               String   @id @default(uuid()) @db.Uuid
  utilityId        String   @map("utility_id") @db.Uuid
  code             String   @db.VarChar(20)
  name             String   @db.VarChar(100)
  commodityId      String   @map("commodity_id") @db.Uuid
  conversionFactor Decimal  @map("conversion_factor") @db.Decimal(15, 8)
  isBaseUnit       Boolean  @default(false) @map("is_base_unit")
  isActive         Boolean  @default(true) @map("is_active")
  createdAt        DateTime @default(now()) @map("created_at") @db.Timestamptz

  commodity            Commodity   @relation("CommodityUoms", fields: [commodityId], references: [id])
  defaultForCommodity  Commodity[] @relation("DefaultUom")
  meters               Meter[]

  @@unique([utilityId, commodityId, code])
  @@map("unit_of_measure")
}

// ============ CORE ENTITIES ============

enum PremiseType {
  RESIDENTIAL
  COMMERCIAL
  INDUSTRIAL
  MUNICIPAL

  @@map("premise_type")
}

enum PremiseStatus {
  ACTIVE
  INACTIVE
  CONDEMNED

  @@map("premise_status")
}

model Premise {
  id                 String        @id @default(uuid()) @db.Uuid
  utilityId          String        @map("utility_id") @db.Uuid
  addressLine1       String        @map("address_line1") @db.VarChar(255)
  addressLine2       String?       @map("address_line2") @db.VarChar(255)
  city               String        @db.VarChar(100)
  state              String        @db.Char(2)
  zip                String        @db.VarChar(10)
  geoLat             Decimal?      @map("geo_lat") @db.Decimal(9, 6)
  geoLng             Decimal?      @map("geo_lng") @db.Decimal(9, 6)
  premiseType        PremiseType   @map("premise_type")
  commodityIds       String[]      @map("commodity_ids") @db.Uuid
  serviceTerritoryId String?       @map("service_territory_id") @db.Uuid
  municipalityCode   String?       @map("municipality_code") @db.VarChar(50)
  status             PremiseStatus @default(ACTIVE)
  createdAt          DateTime      @default(now()) @map("created_at") @db.Timestamptz
  updatedAt          DateTime      @updatedAt @map("updated_at") @db.Timestamptz

  meters             Meter[]
  serviceAgreements  ServiceAgreement[]

  @@map("premise")
}

enum MeterType {
  AMR
  AMI
  MANUAL
  SMART

  @@map("meter_type")
}

enum MeterStatus {
  ACTIVE
  REMOVED
  DEFECTIVE
  PENDING_INSTALL

  @@map("meter_status")
}

model Meter {
  id           String      @id @default(uuid()) @db.Uuid
  utilityId    String      @map("utility_id") @db.Uuid
  premiseId    String      @map("premise_id") @db.Uuid
  meterNumber  String      @map("meter_number") @db.VarChar(100)
  commodityId  String      @map("commodity_id") @db.Uuid
  meterType    MeterType   @map("meter_type")
  uomId        String      @map("uom_id") @db.Uuid
  dialCount    Int?        @map("dial_count")
  multiplier   Decimal     @default(1.0) @db.Decimal(10, 4)
  installDate  DateTime    @map("install_date") @db.Date
  removalDate  DateTime?   @map("removal_date") @db.Date
  status       MeterStatus @default(ACTIVE)
  notes        String?     @db.Text
  createdAt    DateTime    @default(now()) @map("created_at") @db.Timestamptz
  updatedAt    DateTime    @updatedAt @map("updated_at") @db.Timestamptz

  premise                Premise                @relation(fields: [premiseId], references: [id])
  commodity              Commodity              @relation(fields: [commodityId], references: [id])
  uom                    UnitOfMeasure          @relation(fields: [uomId], references: [id])
  serviceAgreementMeters ServiceAgreementMeter[]
  meterReads             MeterRead[]

  @@unique([utilityId, meterNumber])
  @@map("meter")
}

enum AccountType {
  RESIDENTIAL
  COMMERCIAL
  INDUSTRIAL
  MUNICIPAL

  @@map("account_type")
}

enum AccountStatus {
  ACTIVE
  INACTIVE
  FINAL
  CLOSED
  SUSPENDED

  @@map("account_status")
}

enum CreditRating {
  EXCELLENT
  GOOD
  FAIR
  POOR
  UNRATED

  @@map("credit_rating")
}

model Account {
  id                  String        @id @default(uuid()) @db.Uuid
  utilityId           String        @map("utility_id") @db.Uuid
  accountNumber       String        @map("account_number") @db.VarChar(50)
  customerId          String?       @map("customer_id") @db.Uuid
  accountType         AccountType   @map("account_type")
  status              AccountStatus @default(ACTIVE)
  creditRating        CreditRating  @default(UNRATED) @map("credit_rating")
  depositAmount       Decimal       @default(0) @map("deposit_amount") @db.Decimal(10, 2)
  depositWaived       Boolean       @default(false) @map("deposit_waived")
  depositWaivedReason String?       @map("deposit_waived_reason") @db.VarChar(255)
  languagePref        String        @default("en-US") @map("language_pref") @db.Char(5)
  paperlessBilling    Boolean       @default(false) @map("paperless_billing")
  budgetBilling       Boolean       @default(false) @map("budget_billing")
  saaslogicAccountId  String?       @map("saaslogic_account_id") @db.Uuid
  createdAt           DateTime      @default(now()) @map("created_at") @db.Timestamptz
  closedAt            DateTime?     @map("closed_at") @db.Timestamptz

  serviceAgreements ServiceAgreement[]

  @@unique([utilityId, accountNumber])
  @@map("account")
}

// ============ AGREEMENT ENTITIES ============

enum AgreementStatus {
  PENDING
  ACTIVE
  FINAL
  CLOSED

  @@map("agreement_status")
}

model ServiceAgreement {
  id              String          @id @default(uuid()) @db.Uuid
  utilityId       String          @map("utility_id") @db.Uuid
  agreementNumber String          @map("agreement_number") @db.VarChar(50)
  accountId       String          @map("account_id") @db.Uuid
  premiseId       String          @map("premise_id") @db.Uuid
  commodityId     String          @map("commodity_id") @db.Uuid
  rateScheduleId  String          @map("rate_schedule_id") @db.Uuid
  billingCycleId  String          @map("billing_cycle_id") @db.Uuid
  startDate       DateTime        @map("start_date") @db.Date
  endDate         DateTime?       @map("end_date") @db.Date
  status          AgreementStatus @default(PENDING)
  readSequence    Int?            @map("read_sequence")
  createdAt       DateTime        @default(now()) @map("created_at") @db.Timestamptz
  updatedAt       DateTime        @updatedAt @map("updated_at") @db.Timestamptz

  account      Account              @relation(fields: [accountId], references: [id])
  premise      Premise              @relation(fields: [premiseId], references: [id])
  commodity    Commodity            @relation(fields: [commodityId], references: [id])
  rateSchedule RateSchedule         @relation(fields: [rateScheduleId], references: [id])
  billingCycle BillingCycle         @relation(fields: [billingCycleId], references: [id])
  meters       ServiceAgreementMeter[]
  meterReads   MeterRead[]

  @@unique([utilityId, agreementNumber])
  @@map("service_agreement")
}

model ServiceAgreementMeter {
  id                 String    @id @default(uuid()) @db.Uuid
  utilityId          String    @map("utility_id") @db.Uuid
  serviceAgreementId String    @map("service_agreement_id") @db.Uuid
  meterId            String    @map("meter_id") @db.Uuid
  isPrimary          Boolean   @default(true) @map("is_primary")
  addedDate          DateTime  @map("added_date") @db.Date
  removedDate        DateTime? @map("removed_date") @db.Date
  createdAt          DateTime  @default(now()) @map("created_at") @db.Timestamptz

  serviceAgreement ServiceAgreement @relation(fields: [serviceAgreementId], references: [id])
  meter            Meter            @relation(fields: [meterId], references: [id])

  @@map("service_agreement_meter")
}

// ============ CONFIG ENTITIES ============

enum RateType {
  FLAT
  TIERED
  TIME_OF_USE
  DEMAND
  BUDGET
  SEASONAL

  @@map("rate_type")
}

model RateSchedule {
  id             String    @id @default(uuid()) @db.Uuid
  utilityId      String    @map("utility_id") @db.Uuid
  name           String    @db.VarChar(255)
  code           String    @db.VarChar(50)
  commodityId    String    @map("commodity_id") @db.Uuid
  rateType       RateType  @map("rate_type")
  effectiveDate  DateTime  @map("effective_date") @db.Date
  expirationDate DateTime? @map("expiration_date") @db.Date
  description    String?   @db.Text
  regulatoryRef  String?   @map("regulatory_ref") @db.VarChar(100)
  rateConfig     Json      @map("rate_config")
  version        Int       @default(1)
  supersedesId   String?   @map("supersedes_id") @db.Uuid
  createdAt      DateTime  @default(now()) @map("created_at") @db.Timestamptz

  commodity         Commodity          @relation(fields: [commodityId], references: [id])
  supersedes        RateSchedule?      @relation("RateScheduleVersions", fields: [supersedesId], references: [id])
  supersededBy      RateSchedule[]     @relation("RateScheduleVersions")
  serviceAgreements ServiceAgreement[]

  @@unique([utilityId, code, version])
  @@map("rate_schedule")
}

enum BillingFrequency {
  MONTHLY
  BIMONTHLY
  QUARTERLY

  @@map("billing_frequency")
}

model BillingCycle {
  id             String           @id @default(uuid()) @db.Uuid
  utilityId      String           @map("utility_id") @db.Uuid
  name           String           @db.VarChar(255)
  cycleCode      String           @map("cycle_code") @db.VarChar(20)
  readDayOfMonth Int              @map("read_day_of_month")
  billDayOfMonth Int              @map("bill_day_of_month")
  frequency      BillingFrequency @default(MONTHLY)
  active         Boolean          @default(true)

  serviceAgreements ServiceAgreement[]

  @@unique([utilityId, cycleCode])
  @@map("billing_cycle")
}

// ============ TIME-SERIES (schema only — CRUD is Phase 2) ============

enum ReadType {
  ACTUAL
  ESTIMATED
  CORRECTED
  FINAL
  AMI

  @@map("read_type")
}

enum ReadSource {
  MANUAL
  AMR
  AMI
  CUSTOMER_SELF
  SYSTEM

  @@map("read_source")
}

model MeterRead {
  id                 String     @id @default(uuid()) @db.Uuid
  utilityId          String     @map("utility_id") @db.Uuid
  meterId            String     @map("meter_id") @db.Uuid
  serviceAgreementId String     @map("service_agreement_id") @db.Uuid
  readDate           DateTime   @map("read_date") @db.Date
  readDatetime       DateTime   @map("read_datetime") @db.Timestamptz
  reading            Decimal    @db.Decimal(12, 4)
  priorReading       Decimal    @map("prior_reading") @db.Decimal(12, 4)
  consumption        Decimal    @db.Decimal(12, 4)
  readType           ReadType   @map("read_type")
  readSource         ReadSource @map("read_source")
  exceptionCode      String?    @map("exception_code") @db.VarChar(50)
  readerId           String?    @map("reader_id") @db.Uuid
  createdAt          DateTime   @default(now()) @map("created_at") @db.Timestamptz

  meter            Meter            @relation(fields: [meterId], references: [id])
  serviceAgreement ServiceAgreement @relation(fields: [serviceAgreementId], references: [id])

  @@map("meter_read")
}

// ============ SYSTEM ENTITIES ============

enum AuditAction {
  CREATE
  UPDATE
  DELETE

  @@map("audit_action")
}

model AuditLog {
  id          String      @id @default(uuid()) @db.Uuid
  utilityId   String      @map("utility_id") @db.Uuid
  entityType  String      @map("entity_type") @db.VarChar(100)
  entityId    String      @map("entity_id") @db.Uuid
  action      AuditAction
  actorId     String      @map("actor_id") @db.Uuid
  beforeState Json?       @map("before_state")
  afterState  Json?       @map("after_state")
  metadata    Json?
  createdAt   DateTime    @default(now()) @map("created_at") @db.Timestamptz

  @@index([utilityId, entityType, entityId])
  @@index([utilityId, createdAt])
  @@map("audit_log")
}

enum ThemeMode {
  DARK
  LIGHT
  SYSTEM

  @@map("theme_mode")
}

model TenantTheme {
  id           String   @id @default(uuid()) @db.Uuid
  utilityId    String   @unique @map("utility_id") @db.Uuid
  preset       String?  @db.VarChar(50)
  colors       Json
  typography   Json
  borderRadius Int      @default(10) @map("border_radius")
  logoUrl      String?  @map("logo_url") @db.VarChar(500)
  createdAt    DateTime @default(now()) @map("created_at") @db.Timestamptz
  updatedAt    DateTime @updatedAt @map("updated_at") @db.Timestamptz

  @@map("tenant_theme")
}

model UserPreference {
  id          String    @id @default(uuid()) @db.Uuid
  utilityId   String    @map("utility_id") @db.Uuid
  userId      String    @map("user_id") @db.Uuid
  themeMode   ThemeMode @default(SYSTEM) @map("theme_mode")
  preferences Json      @default("{}")
  createdAt   DateTime  @default(now()) @map("created_at") @db.Timestamptz
  updatedAt   DateTime  @updatedAt @map("updated_at") @db.Timestamptz

  @@unique([utilityId, userId])
  @@map("user_preference")
}
```

- [ ] **Step 2: Generate Prisma client and push schema**

Run: `cp .env.example .env` (then edit DATABASE_URL if needed)
Run: `cd packages/shared && npx prisma generate && npx prisma db push`
Expected: Prisma client generated, all tables created in PostgreSQL.

- [ ] **Step 3: Create RLS migration**

Create: `packages/shared/prisma/migrations/00_rls_policies/migration.sql`

```sql
-- Enable RLS on all entity tables
ALTER TABLE commodity ENABLE ROW LEVEL SECURITY;
ALTER TABLE unit_of_measure ENABLE ROW LEVEL SECURITY;
ALTER TABLE premise ENABLE ROW LEVEL SECURITY;
ALTER TABLE meter ENABLE ROW LEVEL SECURITY;
ALTER TABLE account ENABLE ROW LEVEL SECURITY;
ALTER TABLE service_agreement ENABLE ROW LEVEL SECURITY;
ALTER TABLE service_agreement_meter ENABLE ROW LEVEL SECURITY;
ALTER TABLE rate_schedule ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing_cycle ENABLE ROW LEVEL SECURITY;
ALTER TABLE meter_read ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_theme ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_preference ENABLE ROW LEVEL SECURITY;

-- Create RLS policies for each table
CREATE POLICY tenant_isolation ON commodity
  USING (utility_id = current_setting('app.current_utility_id')::uuid);

CREATE POLICY tenant_isolation ON unit_of_measure
  USING (utility_id = current_setting('app.current_utility_id')::uuid);

CREATE POLICY tenant_isolation ON premise
  USING (utility_id = current_setting('app.current_utility_id')::uuid);

CREATE POLICY tenant_isolation ON meter
  USING (utility_id = current_setting('app.current_utility_id')::uuid);

CREATE POLICY tenant_isolation ON account
  USING (utility_id = current_setting('app.current_utility_id')::uuid);

CREATE POLICY tenant_isolation ON service_agreement
  USING (utility_id = current_setting('app.current_utility_id')::uuid);

CREATE POLICY tenant_isolation ON service_agreement_meter
  USING (utility_id = current_setting('app.current_utility_id')::uuid);

CREATE POLICY tenant_isolation ON rate_schedule
  USING (utility_id = current_setting('app.current_utility_id')::uuid);

CREATE POLICY tenant_isolation ON billing_cycle
  USING (utility_id = current_setting('app.current_utility_id')::uuid);

CREATE POLICY tenant_isolation ON meter_read
  USING (utility_id = current_setting('app.current_utility_id')::uuid);

CREATE POLICY tenant_isolation ON audit_log
  USING (utility_id = current_setting('app.current_utility_id')::uuid);

CREATE POLICY tenant_isolation ON tenant_theme
  USING (utility_id = current_setting('app.current_utility_id')::uuid);

CREATE POLICY tenant_isolation ON user_preference
  USING (utility_id = current_setting('app.current_utility_id')::uuid);

-- Create a superuser bypass role for migrations and admin tasks
CREATE ROLE cis_admin BYPASSRLS;

-- Convert meter_read to TimescaleDB hypertable
SELECT create_hypertable('meter_read', 'read_datetime', migrate_data => true);
```

- [ ] **Step 4: Apply RLS migration**

Run: `psql $DATABASE_URL -f packages/shared/prisma/migrations/00_rls_policies/migration.sql`
Expected: RLS policies and hypertable created.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/prisma/
git commit -m "feat: add Prisma schema for all 13 entities with RLS and TimescaleDB"
```

---

## Task 3: Shared Package — Types, Validators, Events

**Files:**
- Create: `packages/shared/src/index.ts`
- Create: `packages/shared/src/types/index.ts`
- Create: `packages/shared/src/types/api.ts`
- Create: `packages/shared/src/validators/commodity.ts`
- Create: `packages/shared/src/validators/uom.ts`
- Create: `packages/shared/src/validators/premise.ts`
- Create: `packages/shared/src/validators/meter.ts`
- Create: `packages/shared/src/validators/account.ts`
- Create: `packages/shared/src/validators/service-agreement.ts`
- Create: `packages/shared/src/validators/rate-schedule.ts`
- Create: `packages/shared/src/validators/billing-cycle.ts`
- Create: `packages/shared/src/validators/theme.ts`
- Create: `packages/shared/src/validators/index.ts`
- Create: `packages/shared/src/events/index.ts`
- Test: `packages/shared/src/validators/__tests__/premise.test.ts`
- Test: `packages/shared/src/validators/__tests__/service-agreement.test.ts`
- Test: `packages/shared/src/validators/__tests__/rate-schedule.test.ts`

- [ ] **Step 1: Create shared API types**

Create `packages/shared/src/types/api.ts`:

```typescript
export interface PaginatedResponse<T> {
  data: T[];
  meta: {
    total: number;
    page: number;
    limit: number;
    pages: number;
  };
}

export interface PaginationQuery {
  page?: number;
  limit?: number;
  sort?: string;
  order?: "asc" | "desc";
}

export interface ApiError {
  error: {
    code: string;
    message: string;
    details?: Array<{ field: string; message: string }>;
  };
}

export interface DomainEvent {
  type: string;
  entityType: string;
  entityId: string;
  utilityId: string;
  actorId: string;
  beforeState: Record<string, unknown> | null;
  afterState: Record<string, unknown> | null;
  timestamp: string;
}
```

- [ ] **Step 2: Create Zod validators for all entities**

Create `packages/shared/src/validators/commodity.ts`:

```typescript
import { z } from "zod";

export const createCommoditySchema = z.object({
  code: z.string().min(1).max(50).toUpperCase(),
  name: z.string().min(1).max(100),
  defaultUomId: z.string().uuid().optional(),
  isActive: z.boolean().default(true),
  displayOrder: z.number().int().default(0),
});

export const updateCommoditySchema = createCommoditySchema.partial();

export type CreateCommodityInput = z.infer<typeof createCommoditySchema>;
export type UpdateCommodityInput = z.infer<typeof updateCommoditySchema>;
```

Create `packages/shared/src/validators/uom.ts`:

```typescript
import { z } from "zod";

export const createUomSchema = z.object({
  code: z.string().min(1).max(20).toUpperCase(),
  name: z.string().min(1).max(100),
  commodityId: z.string().uuid(),
  conversionFactor: z.number().positive(),
  isBaseUnit: z.boolean().default(false),
  isActive: z.boolean().default(true),
});

export const updateUomSchema = createUomSchema.partial();

export type CreateUomInput = z.infer<typeof createUomSchema>;
export type UpdateUomInput = z.infer<typeof updateUomSchema>;
```

Create `packages/shared/src/validators/premise.ts`:

```typescript
import { z } from "zod";

export const premiseTypeEnum = z.enum([
  "RESIDENTIAL",
  "COMMERCIAL",
  "INDUSTRIAL",
  "MUNICIPAL",
]);

export const premiseStatusEnum = z.enum(["ACTIVE", "INACTIVE", "CONDEMNED"]);

export const createPremiseSchema = z.object({
  addressLine1: z.string().min(1).max(255),
  addressLine2: z.string().max(255).optional(),
  city: z.string().min(1).max(100),
  state: z.string().length(2),
  zip: z.string().min(5).max(10),
  geoLat: z.number().min(-90).max(90).optional(),
  geoLng: z.number().min(-180).max(180).optional(),
  premiseType: premiseTypeEnum,
  commodityIds: z.array(z.string().uuid()).min(1),
  serviceTerritoryId: z.string().uuid().optional(),
  municipalityCode: z.string().max(50).optional(),
  status: premiseStatusEnum.default("ACTIVE"),
});

export const updatePremiseSchema = createPremiseSchema.partial();

export const premiseQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(25),
  sort: z.string().default("created_at"),
  order: z.enum(["asc", "desc"]).default("desc"),
  status: premiseStatusEnum.optional(),
  premiseType: premiseTypeEnum.optional(),
  serviceTerritoryId: z.string().uuid().optional(),
});

export type CreatePremiseInput = z.infer<typeof createPremiseSchema>;
export type UpdatePremiseInput = z.infer<typeof updatePremiseSchema>;
export type PremiseQuery = z.infer<typeof premiseQuerySchema>;
```

Create `packages/shared/src/validators/meter.ts`:

```typescript
import { z } from "zod";

export const meterTypeEnum = z.enum(["AMR", "AMI", "MANUAL", "SMART"]);
export const meterStatusEnum = z.enum([
  "ACTIVE",
  "REMOVED",
  "DEFECTIVE",
  "PENDING_INSTALL",
]);

export const createMeterSchema = z.object({
  premiseId: z.string().uuid(),
  meterNumber: z.string().min(1).max(100),
  commodityId: z.string().uuid(),
  meterType: meterTypeEnum,
  uomId: z.string().uuid(),
  dialCount: z.number().int().positive().optional(),
  multiplier: z.number().positive().default(1.0),
  installDate: z.string().date(),
  status: meterStatusEnum.default("ACTIVE"),
  notes: z.string().optional(),
});

export const updateMeterSchema = createMeterSchema
  .partial()
  .omit({ premiseId: true, meterNumber: true });

export const meterQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(25),
  sort: z.string().default("created_at"),
  order: z.enum(["asc", "desc"]).default("desc"),
  premiseId: z.string().uuid().optional(),
  commodityId: z.string().uuid().optional(),
  status: meterStatusEnum.optional(),
});

export type CreateMeterInput = z.infer<typeof createMeterSchema>;
export type UpdateMeterInput = z.infer<typeof updateMeterSchema>;
export type MeterQuery = z.infer<typeof meterQuerySchema>;
```

Create `packages/shared/src/validators/account.ts`:

```typescript
import { z } from "zod";

export const accountTypeEnum = z.enum([
  "RESIDENTIAL",
  "COMMERCIAL",
  "INDUSTRIAL",
  "MUNICIPAL",
]);

export const accountStatusEnum = z.enum([
  "ACTIVE",
  "INACTIVE",
  "FINAL",
  "CLOSED",
  "SUSPENDED",
]);

export const creditRatingEnum = z.enum([
  "EXCELLENT",
  "GOOD",
  "FAIR",
  "POOR",
  "UNRATED",
]);

export const createAccountSchema = z.object({
  accountNumber: z.string().min(1).max(50),
  customerId: z.string().uuid().optional(),
  accountType: accountTypeEnum,
  status: accountStatusEnum.default("ACTIVE"),
  creditRating: creditRatingEnum.default("UNRATED"),
  depositAmount: z.number().min(0).default(0),
  depositWaived: z.boolean().default(false),
  depositWaivedReason: z.string().max(255).optional(),
  languagePref: z.string().length(5).default("en-US"),
  paperlessBilling: z.boolean().default(false),
  budgetBilling: z.boolean().default(false),
  saaslogicAccountId: z.string().uuid().optional(),
});

export const updateAccountSchema = createAccountSchema
  .partial()
  .omit({ accountNumber: true });

export const accountQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(25),
  sort: z.string().default("created_at"),
  order: z.enum(["asc", "desc"]).default("desc"),
  status: accountStatusEnum.optional(),
  accountType: accountTypeEnum.optional(),
  search: z.string().optional(),
});

export type CreateAccountInput = z.infer<typeof createAccountSchema>;
export type UpdateAccountInput = z.infer<typeof updateAccountSchema>;
export type AccountQuery = z.infer<typeof accountQuerySchema>;
```

Create `packages/shared/src/validators/service-agreement.ts`:

```typescript
import { z } from "zod";

export const agreementStatusEnum = z.enum([
  "PENDING",
  "ACTIVE",
  "FINAL",
  "CLOSED",
]);

const VALID_STATUS_TRANSITIONS: Record<string, string[]> = {
  PENDING: ["ACTIVE"],
  ACTIVE: ["FINAL"],
  FINAL: ["CLOSED"],
  CLOSED: [],
};

export const meterAssignmentSchema = z.object({
  meterId: z.string().uuid(),
  isPrimary: z.boolean().default(false),
});

export const createServiceAgreementSchema = z.object({
  agreementNumber: z.string().min(1).max(50),
  accountId: z.string().uuid(),
  premiseId: z.string().uuid(),
  commodityId: z.string().uuid(),
  rateScheduleId: z.string().uuid(),
  billingCycleId: z.string().uuid(),
  startDate: z.string().date(),
  endDate: z.string().date().optional(),
  status: agreementStatusEnum.default("PENDING"),
  readSequence: z.number().int().optional(),
  meters: z.array(meterAssignmentSchema).min(1),
});

export const updateServiceAgreementSchema = z.object({
  rateScheduleId: z.string().uuid().optional(),
  billingCycleId: z.string().uuid().optional(),
  endDate: z.string().date().optional(),
  status: agreementStatusEnum.optional(),
  readSequence: z.number().int().optional(),
});

export const serviceAgreementQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(25),
  sort: z.string().default("created_at"),
  order: z.enum(["asc", "desc"]).default("desc"),
  accountId: z.string().uuid().optional(),
  premiseId: z.string().uuid().optional(),
  status: agreementStatusEnum.optional(),
});

export function isValidStatusTransition(
  from: string,
  to: string
): boolean {
  return VALID_STATUS_TRANSITIONS[from]?.includes(to) ?? false;
}

export type CreateServiceAgreementInput = z.infer<
  typeof createServiceAgreementSchema
>;
export type UpdateServiceAgreementInput = z.infer<
  typeof updateServiceAgreementSchema
>;
export type ServiceAgreementQuery = z.infer<
  typeof serviceAgreementQuerySchema
>;
```

Create `packages/shared/src/validators/rate-schedule.ts`:

```typescript
import { z } from "zod";

export const rateTypeEnum = z.enum([
  "FLAT",
  "TIERED",
  "TIME_OF_USE",
  "DEMAND",
  "BUDGET",
  "SEASONAL",
]);

const flatRateConfigSchema = z.object({
  base_charge: z.number().min(0),
  unit: z.string(),
});

const tierSchema = z.object({
  from: z.number().min(0),
  to: z.number().nullable(),
  rate: z.number().min(0),
});

const tieredRateConfigSchema = z.object({
  base_charge: z.number().min(0),
  tiers: z.array(tierSchema).min(1),
  unit: z.string(),
});

const touPeriodSchema = z.object({
  name: z.string(),
  hours: z.string(),
  days: z.string(),
  rate: z.number().min(0),
});

const touRateConfigSchema = z.object({
  periods: z.array(touPeriodSchema).min(1),
  unit: z.string(),
  season: z.record(z.string()).optional(),
});

const demandRateConfigSchema = z.object({
  demand_rate: z.number().min(0),
  energy_rate: z.number().min(0),
  demand_minimum_kw: z.number().min(0),
  unit: z.string(),
});

const budgetRateConfigSchema = z.object({
  monthly_amount: z.number().min(0),
  trueup_month: z.number().int().min(1).max(12),
  base_rate_schedule_id: z.string(),
});

export const rateConfigSchema = z.union([
  flatRateConfigSchema,
  tieredRateConfigSchema,
  touRateConfigSchema,
  demandRateConfigSchema,
  budgetRateConfigSchema,
]);

export const createRateScheduleSchema = z.object({
  name: z.string().min(1).max(255),
  code: z.string().min(1).max(50),
  commodityId: z.string().uuid(),
  rateType: rateTypeEnum,
  effectiveDate: z.string().date(),
  expirationDate: z.string().date().optional(),
  description: z.string().optional(),
  regulatoryRef: z.string().max(100).optional(),
  rateConfig: rateConfigSchema,
});

export const rateScheduleQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(25),
  sort: z.string().default("effective_date"),
  order: z.enum(["asc", "desc"]).default("desc"),
  commodityId: z.string().uuid().optional(),
  rateType: rateTypeEnum.optional(),
  active: z.coerce.boolean().optional(),
});

export type CreateRateScheduleInput = z.infer<
  typeof createRateScheduleSchema
>;
export type RateScheduleQuery = z.infer<typeof rateScheduleQuerySchema>;
```

Create `packages/shared/src/validators/billing-cycle.ts`:

```typescript
import { z } from "zod";

export const billingFrequencyEnum = z.enum([
  "MONTHLY",
  "BIMONTHLY",
  "QUARTERLY",
]);

export const createBillingCycleSchema = z.object({
  name: z.string().min(1).max(255),
  cycleCode: z.string().min(1).max(20),
  readDayOfMonth: z.number().int().min(1).max(28),
  billDayOfMonth: z.number().int().min(1).max(28),
  frequency: billingFrequencyEnum.default("MONTHLY"),
  active: z.boolean().default(true),
});

export const updateBillingCycleSchema = createBillingCycleSchema
  .partial()
  .omit({ cycleCode: true });

export type CreateBillingCycleInput = z.infer<
  typeof createBillingCycleSchema
>;
export type UpdateBillingCycleInput = z.infer<
  typeof updateBillingCycleSchema
>;
```

Create `packages/shared/src/validators/theme.ts`:

```typescript
import { z } from "zod";

const colorSetSchema = z.object({
  "bg-deep": z.string(),
  "bg-surface": z.string(),
  "bg-card": z.string(),
  "accent-primary": z.string(),
  "accent-secondary": z.string().optional(),
  "text-primary": z.string(),
  "text-secondary": z.string().optional(),
  success: z.string().optional(),
  danger: z.string().optional(),
  warning: z.string().optional(),
});

const colorsSchema = z.object({
  dark: colorSetSchema,
  light: colorSetSchema,
});

const typographySchema = z.object({
  body: z.string(),
  display: z.string().optional(),
});

export const updateThemeSchema = z.object({
  preset: z.string().max(50).optional(),
  colors: colorsSchema,
  typography: typographySchema,
  borderRadius: z.number().int().min(0).max(20).default(10),
  logoUrl: z.string().url().max(500).optional(),
});

export const themeModeEnum = z.enum(["DARK", "LIGHT", "SYSTEM"]);

export const updateUserPreferenceSchema = z.object({
  themeMode: themeModeEnum.optional(),
  preferences: z.record(z.unknown()).optional(),
});

export type UpdateThemeInput = z.infer<typeof updateThemeSchema>;
export type UpdateUserPreferenceInput = z.infer<
  typeof updateUserPreferenceSchema
>;
```

Create `packages/shared/src/validators/index.ts`:

```typescript
export * from "./commodity";
export * from "./uom";
export * from "./premise";
export * from "./meter";
export * from "./account";
export * from "./service-agreement";
export * from "./rate-schedule";
export * from "./billing-cycle";
export * from "./theme";
```

- [ ] **Step 3: Create event type definitions**

Create `packages/shared/src/events/index.ts`:

```typescript
export interface DomainEvent {
  type: string;
  entityType: string;
  entityId: string;
  utilityId: string;
  actorId: string;
  beforeState: Record<string, unknown> | null;
  afterState: Record<string, unknown> | null;
  timestamp: string;
}

export const EVENT_TYPES = {
  COMMODITY_CREATED: "commodity.created",
  COMMODITY_UPDATED: "commodity.updated",
  UOM_CREATED: "uom.created",
  UOM_UPDATED: "uom.updated",
  PREMISE_CREATED: "premise.created",
  PREMISE_UPDATED: "premise.updated",
  METER_CREATED: "meter.created",
  METER_UPDATED: "meter.updated",
  ACCOUNT_CREATED: "account.created",
  ACCOUNT_UPDATED: "account.updated",
  SERVICE_AGREEMENT_CREATED: "service_agreement.created",
  SERVICE_AGREEMENT_UPDATED: "service_agreement.updated",
  RATE_SCHEDULE_CREATED: "rate_schedule.created",
  RATE_SCHEDULE_REVISED: "rate_schedule.revised",
  BILLING_CYCLE_CREATED: "billing_cycle.created",
  BILLING_CYCLE_UPDATED: "billing_cycle.updated",
} as const;

export type EventType = (typeof EVENT_TYPES)[keyof typeof EVENT_TYPES];
```

- [ ] **Step 4: Create shared index**

Create `packages/shared/src/index.ts`:

```typescript
export * from "./validators";
export * from "./events";
export * from "./types/api";
```

- [ ] **Step 5: Write validator tests**

Create `packages/shared/src/validators/__tests__/premise.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { createPremiseSchema, premiseQuerySchema } from "../premise";

describe("createPremiseSchema", () => {
  it("validates a valid premise", () => {
    const result = createPremiseSchema.safeParse({
      addressLine1: "742 Evergreen Terrace",
      city: "Springfield",
      state: "IL",
      zip: "62704",
      premiseType: "RESIDENTIAL",
      commodityIds: ["550e8400-e29b-41d4-a716-446655440000"],
    });
    expect(result.success).toBe(true);
  });

  it("rejects missing address", () => {
    const result = createPremiseSchema.safeParse({
      city: "Springfield",
      state: "IL",
      zip: "62704",
      premiseType: "RESIDENTIAL",
      commodityIds: ["550e8400-e29b-41d4-a716-446655440000"],
    });
    expect(result.success).toBe(false);
  });

  it("rejects invalid state code", () => {
    const result = createPremiseSchema.safeParse({
      addressLine1: "742 Evergreen Terrace",
      city: "Springfield",
      state: "Illinois",
      zip: "62704",
      premiseType: "RESIDENTIAL",
      commodityIds: ["550e8400-e29b-41d4-a716-446655440000"],
    });
    expect(result.success).toBe(false);
  });

  it("rejects empty commodityIds", () => {
    const result = createPremiseSchema.safeParse({
      addressLine1: "742 Evergreen Terrace",
      city: "Springfield",
      state: "IL",
      zip: "62704",
      premiseType: "RESIDENTIAL",
      commodityIds: [],
    });
    expect(result.success).toBe(false);
  });

  it("validates geo coordinates within bounds", () => {
    const result = createPremiseSchema.safeParse({
      addressLine1: "742 Evergreen Terrace",
      city: "Springfield",
      state: "IL",
      zip: "62704",
      geoLat: 39.7817,
      geoLng: -89.6501,
      premiseType: "RESIDENTIAL",
      commodityIds: ["550e8400-e29b-41d4-a716-446655440000"],
    });
    expect(result.success).toBe(true);
  });

  it("rejects out-of-bounds latitude", () => {
    const result = createPremiseSchema.safeParse({
      addressLine1: "742 Evergreen Terrace",
      city: "Springfield",
      state: "IL",
      zip: "62704",
      geoLat: 91.0,
      geoLng: -89.6501,
      premiseType: "RESIDENTIAL",
      commodityIds: ["550e8400-e29b-41d4-a716-446655440000"],
    });
    expect(result.success).toBe(false);
  });
});

describe("premiseQuerySchema", () => {
  it("provides defaults for empty query", () => {
    const result = premiseQuerySchema.parse({});
    expect(result.page).toBe(1);
    expect(result.limit).toBe(25);
    expect(result.order).toBe("desc");
  });

  it("coerces string page to number", () => {
    const result = premiseQuerySchema.parse({ page: "3" });
    expect(result.page).toBe(3);
  });
});
```

Create `packages/shared/src/validators/__tests__/service-agreement.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import {
  createServiceAgreementSchema,
  isValidStatusTransition,
} from "../service-agreement";

describe("createServiceAgreementSchema", () => {
  const validInput = {
    agreementNumber: "SA-001",
    accountId: "550e8400-e29b-41d4-a716-446655440000",
    premiseId: "550e8400-e29b-41d4-a716-446655440001",
    commodityId: "550e8400-e29b-41d4-a716-446655440002",
    rateScheduleId: "550e8400-e29b-41d4-a716-446655440003",
    billingCycleId: "550e8400-e29b-41d4-a716-446655440004",
    startDate: "2026-04-01",
    meters: [
      { meterId: "550e8400-e29b-41d4-a716-446655440005", isPrimary: true },
    ],
  };

  it("validates a valid service agreement", () => {
    const result = createServiceAgreementSchema.safeParse(validInput);
    expect(result.success).toBe(true);
  });

  it("requires at least one meter", () => {
    const result = createServiceAgreementSchema.safeParse({
      ...validInput,
      meters: [],
    });
    expect(result.success).toBe(false);
  });

  it("allows multiple meters", () => {
    const result = createServiceAgreementSchema.safeParse({
      ...validInput,
      meters: [
        { meterId: "550e8400-e29b-41d4-a716-446655440005", isPrimary: true },
        { meterId: "550e8400-e29b-41d4-a716-446655440006", isPrimary: false },
      ],
    });
    expect(result.success).toBe(true);
  });
});

describe("isValidStatusTransition", () => {
  it("allows PENDING -> ACTIVE", () => {
    expect(isValidStatusTransition("PENDING", "ACTIVE")).toBe(true);
  });

  it("allows ACTIVE -> FINAL", () => {
    expect(isValidStatusTransition("ACTIVE", "FINAL")).toBe(true);
  });

  it("allows FINAL -> CLOSED", () => {
    expect(isValidStatusTransition("FINAL", "CLOSED")).toBe(true);
  });

  it("rejects PENDING -> FINAL (skip)", () => {
    expect(isValidStatusTransition("PENDING", "FINAL")).toBe(false);
  });

  it("rejects CLOSED -> anything", () => {
    expect(isValidStatusTransition("CLOSED", "ACTIVE")).toBe(false);
  });

  it("rejects backward transitions", () => {
    expect(isValidStatusTransition("ACTIVE", "PENDING")).toBe(false);
  });
});
```

Create `packages/shared/src/validators/__tests__/rate-schedule.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { createRateScheduleSchema } from "../rate-schedule";

describe("createRateScheduleSchema", () => {
  it("validates a flat rate schedule", () => {
    const result = createRateScheduleSchema.safeParse({
      name: "Sewer Flat Rate",
      code: "SEWER-FLAT",
      commodityId: "550e8400-e29b-41d4-a716-446655440000",
      rateType: "FLAT",
      effectiveDate: "2026-04-01",
      rateConfig: { base_charge: 9.0, unit: "MONTH" },
    });
    expect(result.success).toBe(true);
  });

  it("validates a tiered rate schedule", () => {
    const result = createRateScheduleSchema.safeParse({
      name: "Residential Water RS-1",
      code: "RS-1",
      commodityId: "550e8400-e29b-41d4-a716-446655440000",
      rateType: "TIERED",
      effectiveDate: "2026-04-01",
      rateConfig: {
        base_charge: 12.5,
        tiers: [
          { from: 0, to: 2000, rate: 0.004 },
          { from: 2001, to: 5000, rate: 0.006 },
          { from: 5001, to: null, rate: 0.009 },
        ],
        unit: "GAL",
      },
    });
    expect(result.success).toBe(true);
  });

  it("rejects tiered config with no tiers", () => {
    const result = createRateScheduleSchema.safeParse({
      name: "Bad Rate",
      code: "BAD",
      commodityId: "550e8400-e29b-41d4-a716-446655440000",
      rateType: "TIERED",
      effectiveDate: "2026-04-01",
      rateConfig: { base_charge: 12.5, tiers: [], unit: "GAL" },
    });
    expect(result.success).toBe(false);
  });

  it("rejects negative base charge", () => {
    const result = createRateScheduleSchema.safeParse({
      name: "Bad Rate",
      code: "BAD",
      commodityId: "550e8400-e29b-41d4-a716-446655440000",
      rateType: "FLAT",
      effectiveDate: "2026-04-01",
      rateConfig: { base_charge: -5, unit: "MONTH" },
    });
    expect(result.success).toBe(false);
  });
});
```

- [ ] **Step 6: Run validator tests**

Run: `cd packages/shared && npx vitest run`
Expected: All tests pass.

- [ ] **Step 7: Commit**

```bash
git add packages/shared/src/
git commit -m "feat: add shared types, Zod validators, and event definitions for all entities"
```

---

## Task 4: Fastify API Foundation

**Files:**
- Create: `packages/api/src/server.ts`
- Create: `packages/api/src/app.ts`
- Create: `packages/api/src/middleware/auth.ts`
- Create: `packages/api/src/middleware/tenant.ts`
- Create: `packages/api/src/middleware/error-handler.ts`
- Create: `packages/api/src/lib/prisma.ts`
- Create: `packages/api/src/lib/redis.ts`
- Create: `packages/api/src/lib/pagination.ts`
- Create: `packages/api/src/events/emitter.ts`
- Create: `packages/api/src/events/audit-writer.ts`
- Test: `packages/api/src/__tests__/pagination.test.ts`

- [ ] **Step 1: Create Prisma client wrapper**

Create `packages/api/src/lib/prisma.ts`:

```typescript
import { PrismaClient } from "@prisma/client";

export const prisma = new PrismaClient();

export async function setTenantContext(utilityId: string): Promise<void> {
  await prisma.$executeRawUnsafe(
    `SET app.current_utility_id = '${utilityId}'`
  );
}
```

- [ ] **Step 2: Create Redis client**

Create `packages/api/src/lib/redis.ts`:

```typescript
import Redis from "ioredis";

export const redis = new Redis(process.env.REDIS_URL || "redis://localhost:6379");
```

- [ ] **Step 3: Create pagination helper**

Create `packages/api/src/lib/pagination.ts`:

```typescript
import type { PaginatedResponse } from "@utility-cis/shared";

export interface PaginationParams {
  page: number;
  limit: number;
  sort: string;
  order: "asc" | "desc";
}

export function paginationArgs(params: PaginationParams) {
  return {
    skip: (params.page - 1) * params.limit,
    take: params.limit,
    orderBy: { [params.sort]: params.order },
  };
}

export function paginatedResponse<T>(
  data: T[],
  total: number,
  params: PaginationParams
): PaginatedResponse<T> {
  return {
    data,
    meta: {
      total,
      page: params.page,
      limit: params.limit,
      pages: Math.ceil(total / params.limit),
    },
  };
}
```

- [ ] **Step 4: Create auth middleware**

Create `packages/api/src/middleware/auth.ts`:

```typescript
import type { FastifyRequest, FastifyReply } from "fastify";

export interface AuthUser {
  id: string;
  utilityId: string;
  email: string;
  role: string;
}

declare module "fastify" {
  interface FastifyRequest {
    user: AuthUser;
  }
}

export async function authMiddleware(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  const authHeader = request.headers.authorization;

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    reply.status(401).send({
      error: {
        code: "UNAUTHORIZED",
        message: "Missing or invalid authorization header",
      },
    });
    return;
  }

  try {
    // In production, verify JWT from NextAuth
    // For Phase 1 dev, decode the JWT payload
    const token = authHeader.split(" ")[1];
    const payload = JSON.parse(
      Buffer.from(token.split(".")[1], "base64").toString()
    );

    request.user = {
      id: payload.sub,
      utilityId: payload.utility_id,
      email: payload.email,
      role: payload.role || "user",
    };
  } catch {
    reply.status(401).send({
      error: { code: "UNAUTHORIZED", message: "Invalid token" },
    });
  }
}
```

- [ ] **Step 5: Create tenant context middleware**

Create `packages/api/src/middleware/tenant.ts`:

```typescript
import type { FastifyRequest, FastifyReply } from "fastify";
import { setTenantContext } from "../lib/prisma";

export async function tenantMiddleware(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  if (!request.user?.utilityId) {
    reply.status(400).send({
      error: {
        code: "MISSING_TENANT",
        message: "No utility_id in token",
      },
    });
    return;
  }

  await setTenantContext(request.user.utilityId);
}
```

- [ ] **Step 6: Create error handler**

Create `packages/api/src/middleware/error-handler.ts`:

```typescript
import type { FastifyError, FastifyReply, FastifyRequest } from "fastify";
import { ZodError } from "zod";

export function errorHandler(
  error: FastifyError,
  request: FastifyRequest,
  reply: FastifyReply
): void {
  if (error instanceof ZodError) {
    reply.status(400).send({
      error: {
        code: "VALIDATION_ERROR",
        message: "Invalid request data",
        details: error.errors.map((e) => ({
          field: e.path.join("."),
          message: e.message,
        })),
      },
    });
    return;
  }

  if (error.statusCode) {
    reply.status(error.statusCode).send({
      error: {
        code: error.code || "ERROR",
        message: error.message,
      },
    });
    return;
  }

  request.log.error(error);
  reply.status(500).send({
    error: {
      code: "INTERNAL_ERROR",
      message: "An unexpected error occurred",
    },
  });
}
```

- [ ] **Step 7: Create domain event emitter and audit writer**

Create `packages/api/src/events/emitter.ts`:

```typescript
import { EventEmitter } from "events";
import type { DomainEvent } from "@utility-cis/shared";

class DomainEventEmitter extends EventEmitter {
  emitDomainEvent(event: DomainEvent): void {
    this.emit("domain-event", event);
    this.emit(event.type, event);
  }
}

export const domainEvents = new DomainEventEmitter();
```

Create `packages/api/src/events/audit-writer.ts`:

```typescript
import { prisma } from "../lib/prisma";
import { domainEvents } from "./emitter";
import type { DomainEvent } from "@utility-cis/shared";

function mapActionFromEventType(eventType: string): "CREATE" | "UPDATE" | "DELETE" {
  if (eventType.endsWith(".created")) return "CREATE";
  if (eventType.endsWith(".revised")) return "UPDATE";
  if (eventType.endsWith(".deleted")) return "DELETE";
  return "UPDATE";
}

export function startAuditWriter(): void {
  domainEvents.on("domain-event", async (event: DomainEvent) => {
    try {
      await prisma.$executeRawUnsafe(
        `SET app.current_utility_id = '${event.utilityId}'`
      );

      await prisma.auditLog.create({
        data: {
          utilityId: event.utilityId,
          entityType: event.entityType,
          entityId: event.entityId,
          action: mapActionFromEventType(event.type),
          actorId: event.actorId,
          beforeState: event.beforeState ?? undefined,
          afterState: event.afterState ?? undefined,
          metadata: { eventType: event.type },
        },
      });
    } catch (err) {
      console.error("Failed to write audit log:", err);
    }
  });
}
```

- [ ] **Step 8: Create app and server entry points**

Create `packages/api/src/app.ts`:

```typescript
import Fastify from "fastify";
import cors from "@fastify/cors";
import { authMiddleware } from "./middleware/auth";
import { tenantMiddleware } from "./middleware/tenant";
import { errorHandler } from "./middleware/error-handler";
import { startAuditWriter } from "./events/audit-writer";

export async function buildApp() {
  const app = Fastify({ logger: true });

  await app.register(cors, { origin: process.env.WEB_URL || "http://localhost:3000" });

  app.setErrorHandler(errorHandler);

  // Apply auth + tenant middleware to all /api/v1 routes
  app.addHook("onRequest", authMiddleware);
  app.addHook("onRequest", tenantMiddleware);

  // Health check (no auth)
  app.get("/health", { config: { skipAuth: true } }, async () => ({ status: "ok" }));

  // Start audit log writer
  startAuditWriter();

  return app;
}
```

Create `packages/api/src/server.ts`:

```typescript
import { buildApp } from "./app";

async function start() {
  const app = await buildApp();

  const port = parseInt(process.env.PORT || "3001", 10);
  const host = process.env.HOST || "0.0.0.0";

  await app.listen({ port, host });
  console.log(`CIS API listening on http://${host}:${port}`);
}

start().catch((err) => {
  console.error("Failed to start server:", err);
  process.exit(1);
});
```

- [ ] **Step 9: Write pagination test**

Create `packages/api/src/__tests__/pagination.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { paginationArgs, paginatedResponse } from "../lib/pagination";

describe("paginationArgs", () => {
  it("calculates skip correctly for page 1", () => {
    const result = paginationArgs({ page: 1, limit: 25, sort: "created_at", order: "desc" });
    expect(result.skip).toBe(0);
    expect(result.take).toBe(25);
  });

  it("calculates skip correctly for page 3", () => {
    const result = paginationArgs({ page: 3, limit: 10, sort: "name", order: "asc" });
    expect(result.skip).toBe(20);
    expect(result.take).toBe(10);
  });
});

describe("paginatedResponse", () => {
  it("builds correct meta", () => {
    const result = paginatedResponse(["a", "b"], 50, { page: 2, limit: 25, sort: "id", order: "asc" });
    expect(result.meta.total).toBe(50);
    expect(result.meta.page).toBe(2);
    expect(result.meta.pages).toBe(2);
    expect(result.data).toEqual(["a", "b"]);
  });
});
```

- [ ] **Step 10: Run tests and verify server starts**

Run: `cd packages/api && npx vitest run`
Expected: All tests pass.

Run: `cd packages/api && npx tsx src/server.ts` (smoke test — ctrl+c after startup)
Expected: Server logs "CIS API listening on http://0.0.0.0:3001"

- [ ] **Step 11: Commit**

```bash
git add packages/api/src/
git commit -m "feat: add Fastify API foundation with auth, tenant RLS, event system, and audit writer"
```

---

## Task 5: API Routes — Reference Entities (Commodity, UOM)

**Files:**
- Create: `packages/api/src/services/commodity.service.ts`
- Create: `packages/api/src/services/uom.service.ts`
- Create: `packages/api/src/routes/commodities.ts`
- Create: `packages/api/src/routes/uom.ts`
- Modify: `packages/api/src/app.ts` (register routes)
- Test: `packages/api/src/__tests__/commodities.test.ts`

This task establishes the pattern used by all remaining route tasks: service layer + route module + tests.

- [ ] **Step 1: Create commodity service**

Create `packages/api/src/services/commodity.service.ts`:

```typescript
import { prisma } from "../lib/prisma";
import { domainEvents } from "../events/emitter";
import { EVENT_TYPES } from "@utility-cis/shared";
import type { CreateCommodityInput, UpdateCommodityInput } from "@utility-cis/shared";

export async function listCommodities(utilityId: string) {
  return prisma.commodity.findMany({
    orderBy: { displayOrder: "asc" },
    include: { defaultUom: true },
  });
}

export async function createCommodity(
  utilityId: string,
  actorId: string,
  data: CreateCommodityInput
) {
  const commodity = await prisma.commodity.create({
    data: { utilityId, ...data },
    include: { defaultUom: true },
  });

  domainEvents.emitDomainEvent({
    type: EVENT_TYPES.COMMODITY_CREATED,
    entityType: "Commodity",
    entityId: commodity.id,
    utilityId,
    actorId,
    beforeState: null,
    afterState: commodity as unknown as Record<string, unknown>,
    timestamp: new Date().toISOString(),
  });

  return commodity;
}

export async function updateCommodity(
  utilityId: string,
  actorId: string,
  id: string,
  data: UpdateCommodityInput
) {
  const before = await prisma.commodity.findUniqueOrThrow({ where: { id } });

  const commodity = await prisma.commodity.update({
    where: { id },
    data,
    include: { defaultUom: true },
  });

  domainEvents.emitDomainEvent({
    type: EVENT_TYPES.COMMODITY_UPDATED,
    entityType: "Commodity",
    entityId: id,
    utilityId,
    actorId,
    beforeState: before as unknown as Record<string, unknown>,
    afterState: commodity as unknown as Record<string, unknown>,
    timestamp: new Date().toISOString(),
  });

  return commodity;
}
```

- [ ] **Step 2: Create commodity routes**

Create `packages/api/src/routes/commodities.ts`:

```typescript
import type { FastifyInstance } from "fastify";
import { createCommoditySchema, updateCommoditySchema } from "@utility-cis/shared";
import * as commodityService from "../services/commodity.service";

export async function commodityRoutes(app: FastifyInstance) {
  app.get("/api/v1/commodities", async (request) => {
    return commodityService.listCommodities(request.user.utilityId);
  });

  app.post("/api/v1/commodities", async (request, reply) => {
    const data = createCommoditySchema.parse(request.body);
    const commodity = await commodityService.createCommodity(
      request.user.utilityId,
      request.user.id,
      data
    );
    reply.status(201).send(commodity);
  });

  app.patch("/api/v1/commodities/:id", async (request) => {
    const { id } = request.params as { id: string };
    const data = updateCommoditySchema.parse(request.body);
    return commodityService.updateCommodity(
      request.user.utilityId,
      request.user.id,
      id,
      data
    );
  });
}
```

- [ ] **Step 3: Create UOM service and routes**

Create `packages/api/src/services/uom.service.ts`:

```typescript
import { prisma } from "../lib/prisma";
import { domainEvents } from "../events/emitter";
import { EVENT_TYPES } from "@utility-cis/shared";
import type { CreateUomInput, UpdateUomInput } from "@utility-cis/shared";

export async function listUom(utilityId: string, commodityId?: string) {
  return prisma.unitOfMeasure.findMany({
    where: commodityId ? { commodityId } : undefined,
    include: { commodity: true },
    orderBy: { code: "asc" },
  });
}

export async function createUom(
  utilityId: string,
  actorId: string,
  data: CreateUomInput
) {
  const uom = await prisma.unitOfMeasure.create({
    data: { utilityId, ...data },
    include: { commodity: true },
  });

  domainEvents.emitDomainEvent({
    type: EVENT_TYPES.UOM_CREATED,
    entityType: "UnitOfMeasure",
    entityId: uom.id,
    utilityId,
    actorId,
    beforeState: null,
    afterState: uom as unknown as Record<string, unknown>,
    timestamp: new Date().toISOString(),
  });

  return uom;
}

export async function updateUom(
  utilityId: string,
  actorId: string,
  id: string,
  data: UpdateUomInput
) {
  const before = await prisma.unitOfMeasure.findUniqueOrThrow({ where: { id } });

  const uom = await prisma.unitOfMeasure.update({
    where: { id },
    data,
    include: { commodity: true },
  });

  domainEvents.emitDomainEvent({
    type: EVENT_TYPES.UOM_UPDATED,
    entityType: "UnitOfMeasure",
    entityId: id,
    utilityId,
    actorId,
    beforeState: before as unknown as Record<string, unknown>,
    afterState: uom as unknown as Record<string, unknown>,
    timestamp: new Date().toISOString(),
  });

  return uom;
}
```

Create `packages/api/src/routes/uom.ts`:

```typescript
import type { FastifyInstance } from "fastify";
import { createUomSchema, updateUomSchema } from "@utility-cis/shared";
import * as uomService from "../services/uom.service";

export async function uomRoutes(app: FastifyInstance) {
  app.get("/api/v1/uom", async (request) => {
    const { commodityId } = request.query as { commodityId?: string };
    return uomService.listUom(request.user.utilityId, commodityId);
  });

  app.post("/api/v1/uom", async (request, reply) => {
    const data = createUomSchema.parse(request.body);
    const uom = await uomService.createUom(
      request.user.utilityId,
      request.user.id,
      data
    );
    reply.status(201).send(uom);
  });

  app.patch("/api/v1/uom/:id", async (request) => {
    const { id } = request.params as { id: string };
    const data = updateUomSchema.parse(request.body);
    return uomService.updateUom(
      request.user.utilityId,
      request.user.id,
      id,
      data
    );
  });
}
```

- [ ] **Step 4: Register routes in app.ts**

Add to `packages/api/src/app.ts` before `return app`:

```typescript
import { commodityRoutes } from "./routes/commodities";
import { uomRoutes } from "./routes/uom";

// Inside buildApp(), before return app:
await app.register(commodityRoutes);
await app.register(uomRoutes);
```

- [ ] **Step 5: Commit**

```bash
git add packages/api/src/
git commit -m "feat: add Commodity and UOM CRUD routes with services and event emission"
```

---

## Task 6: API Routes — Premises (with GeoJSON endpoint)

**Files:**
- Create: `packages/api/src/services/premise.service.ts`
- Create: `packages/api/src/routes/premises.ts`
- Modify: `packages/api/src/app.ts` (register route)

Follow the same service + route pattern from Task 5. This task adds the GeoJSON endpoint for the map view.

- [ ] **Step 1: Create premise service**

Create `packages/api/src/services/premise.service.ts`:

```typescript
import { prisma } from "../lib/prisma";
import { domainEvents } from "../events/emitter";
import { EVENT_TYPES } from "@utility-cis/shared";
import type { CreatePremiseInput, UpdatePremiseInput, PremiseQuery } from "@utility-cis/shared";
import { paginationArgs, paginatedResponse } from "../lib/pagination";

export async function listPremises(utilityId: string, query: PremiseQuery) {
  const where: Record<string, unknown> = {};
  if (query.status) where.status = query.status;
  if (query.premiseType) where.premiseType = query.premiseType;
  if (query.serviceTerritoryId) where.serviceTerritoryId = query.serviceTerritoryId;

  const [data, total] = await Promise.all([
    prisma.premise.findMany({
      where,
      ...paginationArgs(query),
      include: {
        _count: { select: { meters: true, serviceAgreements: true } },
      },
    }),
    prisma.premise.count({ where }),
  ]);

  return paginatedResponse(data, total, query);
}

export async function getPremise(id: string) {
  return prisma.premise.findUniqueOrThrow({
    where: { id },
    include: {
      meters: { where: { status: "ACTIVE" } },
      serviceAgreements: {
        where: { status: { in: ["PENDING", "ACTIVE"] } },
        include: { account: true, rateSchedule: true, billingCycle: true },
      },
    },
  });
}

export async function getPremisesGeo(utilityId: string) {
  const premises = await prisma.premise.findMany({
    select: {
      id: true,
      geoLat: true,
      geoLng: true,
      premiseType: true,
      status: true,
      commodityIds: true,
      addressLine1: true,
      city: true,
      state: true,
    },
    where: {
      geoLat: { not: null },
      geoLng: { not: null },
    },
  });

  return {
    type: "FeatureCollection" as const,
    features: premises.map((p) => ({
      type: "Feature" as const,
      geometry: {
        type: "Point" as const,
        coordinates: [Number(p.geoLng), Number(p.geoLat)],
      },
      properties: {
        id: p.id,
        premiseType: p.premiseType,
        status: p.status,
        commodityIds: p.commodityIds,
        address: `${p.addressLine1}, ${p.city}, ${p.state}`,
      },
    })),
  };
}

export async function createPremise(
  utilityId: string,
  actorId: string,
  data: CreatePremiseInput
) {
  const premise = await prisma.premise.create({
    data: { utilityId, ...data },
  });

  domainEvents.emitDomainEvent({
    type: EVENT_TYPES.PREMISE_CREATED,
    entityType: "Premise",
    entityId: premise.id,
    utilityId,
    actorId,
    beforeState: null,
    afterState: premise as unknown as Record<string, unknown>,
    timestamp: new Date().toISOString(),
  });

  return premise;
}

export async function updatePremise(
  utilityId: string,
  actorId: string,
  id: string,
  data: UpdatePremiseInput
) {
  const before = await prisma.premise.findUniqueOrThrow({ where: { id } });

  const premise = await prisma.premise.update({
    where: { id },
    data,
  });

  domainEvents.emitDomainEvent({
    type: EVENT_TYPES.PREMISE_UPDATED,
    entityType: "Premise",
    entityId: id,
    utilityId,
    actorId,
    beforeState: before as unknown as Record<string, unknown>,
    afterState: premise as unknown as Record<string, unknown>,
    timestamp: new Date().toISOString(),
  });

  return premise;
}
```

- [ ] **Step 2: Create premise routes**

Create `packages/api/src/routes/premises.ts`:

```typescript
import type { FastifyInstance } from "fastify";
import {
  createPremiseSchema,
  updatePremiseSchema,
  premiseQuerySchema,
} from "@utility-cis/shared";
import * as premiseService from "../services/premise.service";

export async function premiseRoutes(app: FastifyInstance) {
  app.get("/api/v1/premises", async (request) => {
    const query = premiseQuerySchema.parse(request.query);
    return premiseService.listPremises(request.user.utilityId, query);
  });

  app.get("/api/v1/premises/geo", async (request) => {
    return premiseService.getPremisesGeo(request.user.utilityId);
  });

  app.get("/api/v1/premises/:id", async (request) => {
    const { id } = request.params as { id: string };
    return premiseService.getPremise(id);
  });

  app.post("/api/v1/premises", async (request, reply) => {
    const data = createPremiseSchema.parse(request.body);
    const premise = await premiseService.createPremise(
      request.user.utilityId,
      request.user.id,
      data
    );
    reply.status(201).send(premise);
  });

  app.patch("/api/v1/premises/:id", async (request) => {
    const { id } = request.params as { id: string };
    const data = updatePremiseSchema.parse(request.body);
    return premiseService.updatePremise(
      request.user.utilityId,
      request.user.id,
      id,
      data
    );
  });
}
```

- [ ] **Step 3: Register in app.ts and commit**

Add to `packages/api/src/app.ts`:

```typescript
import { premiseRoutes } from "./routes/premises";
await app.register(premiseRoutes);
```

```bash
git add packages/api/src/
git commit -m "feat: add Premise CRUD routes with GeoJSON endpoint for map view"
```

---

## Task 7: API Routes — Meters, Accounts, Billing Cycles

**Files:**
- Create: `packages/api/src/services/meter.service.ts`
- Create: `packages/api/src/services/account.service.ts`
- Create: `packages/api/src/services/billing-cycle.service.ts`
- Create: `packages/api/src/routes/meters.ts`
- Create: `packages/api/src/routes/accounts.ts`
- Create: `packages/api/src/routes/billing-cycles.ts`
- Modify: `packages/api/src/app.ts`

These follow the exact same service + route + event emission pattern as Tasks 5-6. Meter service includes the commodity-premise validation. Account service includes the closure guard.

- [ ] **Step 1: Create meter service with commodity-premise validation**

Create `packages/api/src/services/meter.service.ts`:

```typescript
import { prisma } from "../lib/prisma";
import { domainEvents } from "../events/emitter";
import { EVENT_TYPES } from "@utility-cis/shared";
import type { CreateMeterInput, UpdateMeterInput, MeterQuery } from "@utility-cis/shared";
import { paginationArgs, paginatedResponse } from "../lib/pagination";

export async function listMeters(utilityId: string, query: MeterQuery) {
  const where: Record<string, unknown> = {};
  if (query.premiseId) where.premiseId = query.premiseId;
  if (query.commodityId) where.commodityId = query.commodityId;
  if (query.status) where.status = query.status;

  const [data, total] = await Promise.all([
    prisma.meter.findMany({
      where,
      ...paginationArgs(query),
      include: { premise: true, commodity: true, uom: true },
    }),
    prisma.meter.count({ where }),
  ]);

  return paginatedResponse(data, total, query);
}

export async function getMeter(id: string) {
  return prisma.meter.findUniqueOrThrow({
    where: { id },
    include: {
      premise: true,
      commodity: true,
      uom: true,
      serviceAgreementMeters: {
        include: { serviceAgreement: true },
        where: { removedDate: null },
      },
    },
  });
}

export async function createMeter(
  utilityId: string,
  actorId: string,
  data: CreateMeterInput
) {
  // Validate: meter commodity must exist in premise's commodity_ids
  const premise = await prisma.premise.findUniqueOrThrow({
    where: { id: data.premiseId },
  });

  if (!premise.commodityIds.includes(data.commodityId)) {
    throw Object.assign(
      new Error("Meter commodity must match one of the premise's commodities"),
      { statusCode: 400, code: "COMMODITY_MISMATCH" }
    );
  }

  const meter = await prisma.meter.create({
    data: { utilityId, ...data },
    include: { premise: true, commodity: true, uom: true },
  });

  domainEvents.emitDomainEvent({
    type: EVENT_TYPES.METER_CREATED,
    entityType: "Meter",
    entityId: meter.id,
    utilityId,
    actorId,
    beforeState: null,
    afterState: meter as unknown as Record<string, unknown>,
    timestamp: new Date().toISOString(),
  });

  return meter;
}

export async function updateMeter(
  utilityId: string,
  actorId: string,
  id: string,
  data: UpdateMeterInput
) {
  const before = await prisma.meter.findUniqueOrThrow({ where: { id } });

  const meter = await prisma.meter.update({
    where: { id },
    data,
    include: { premise: true, commodity: true, uom: true },
  });

  domainEvents.emitDomainEvent({
    type: EVENT_TYPES.METER_UPDATED,
    entityType: "Meter",
    entityId: id,
    utilityId,
    actorId,
    beforeState: before as unknown as Record<string, unknown>,
    afterState: meter as unknown as Record<string, unknown>,
    timestamp: new Date().toISOString(),
  });

  return meter;
}
```

- [ ] **Step 2: Create account service with closure guard**

Create `packages/api/src/services/account.service.ts`:

```typescript
import { prisma } from "../lib/prisma";
import { domainEvents } from "../events/emitter";
import { EVENT_TYPES } from "@utility-cis/shared";
import type { CreateAccountInput, UpdateAccountInput, AccountQuery } from "@utility-cis/shared";
import { paginationArgs, paginatedResponse } from "../lib/pagination";

export async function listAccounts(utilityId: string, query: AccountQuery) {
  const where: Record<string, unknown> = {};
  if (query.status) where.status = query.status;
  if (query.accountType) where.accountType = query.accountType;
  if (query.search) {
    where.OR = [
      { accountNumber: { contains: query.search, mode: "insensitive" } },
    ];
  }

  const [data, total] = await Promise.all([
    prisma.account.findMany({
      where,
      ...paginationArgs(query),
      include: {
        _count: { select: { serviceAgreements: true } },
      },
    }),
    prisma.account.count({ where }),
  ]);

  return paginatedResponse(data, total, query);
}

export async function getAccount(id: string) {
  return prisma.account.findUniqueOrThrow({
    where: { id },
    include: {
      serviceAgreements: {
        include: { premise: true, commodity: true, rateSchedule: true },
        orderBy: { startDate: "desc" },
      },
    },
  });
}

export async function createAccount(
  utilityId: string,
  actorId: string,
  data: CreateAccountInput
) {
  const account = await prisma.account.create({
    data: { utilityId, ...data },
  });

  domainEvents.emitDomainEvent({
    type: EVENT_TYPES.ACCOUNT_CREATED,
    entityType: "Account",
    entityId: account.id,
    utilityId,
    actorId,
    beforeState: null,
    afterState: account as unknown as Record<string, unknown>,
    timestamp: new Date().toISOString(),
  });

  return account;
}

export async function updateAccount(
  utilityId: string,
  actorId: string,
  id: string,
  data: UpdateAccountInput
) {
  // Account closure guard
  if (data.status === "CLOSED") {
    const activeAgreements = await prisma.serviceAgreement.count({
      where: { accountId: id, status: { in: ["PENDING", "ACTIVE"] } },
    });

    if (activeAgreements > 0) {
      throw Object.assign(
        new Error("Cannot close account with active service agreements"),
        { statusCode: 400, code: "ACTIVE_AGREEMENTS_EXIST" }
      );
    }
  }

  const before = await prisma.account.findUniqueOrThrow({ where: { id } });

  const account = await prisma.account.update({
    where: { id },
    data,
  });

  domainEvents.emitDomainEvent({
    type: EVENT_TYPES.ACCOUNT_UPDATED,
    entityType: "Account",
    entityId: id,
    utilityId,
    actorId,
    beforeState: before as unknown as Record<string, unknown>,
    afterState: account as unknown as Record<string, unknown>,
    timestamp: new Date().toISOString(),
  });

  return account;
}
```

- [ ] **Step 3: Create billing cycle service**

Create `packages/api/src/services/billing-cycle.service.ts`:

```typescript
import { prisma } from "../lib/prisma";
import { domainEvents } from "../events/emitter";
import { EVENT_TYPES } from "@utility-cis/shared";
import type { CreateBillingCycleInput, UpdateBillingCycleInput } from "@utility-cis/shared";

export async function listBillingCycles(utilityId: string) {
  return prisma.billingCycle.findMany({
    orderBy: { cycleCode: "asc" },
  });
}

export async function createBillingCycle(
  utilityId: string,
  actorId: string,
  data: CreateBillingCycleInput
) {
  const cycle = await prisma.billingCycle.create({
    data: { utilityId, ...data },
  });

  domainEvents.emitDomainEvent({
    type: EVENT_TYPES.BILLING_CYCLE_CREATED,
    entityType: "BillingCycle",
    entityId: cycle.id,
    utilityId,
    actorId,
    beforeState: null,
    afterState: cycle as unknown as Record<string, unknown>,
    timestamp: new Date().toISOString(),
  });

  return cycle;
}

export async function updateBillingCycle(
  utilityId: string,
  actorId: string,
  id: string,
  data: UpdateBillingCycleInput
) {
  const before = await prisma.billingCycle.findUniqueOrThrow({ where: { id } });

  const cycle = await prisma.billingCycle.update({
    where: { id },
    data,
  });

  domainEvents.emitDomainEvent({
    type: EVENT_TYPES.BILLING_CYCLE_UPDATED,
    entityType: "BillingCycle",
    entityId: id,
    utilityId,
    actorId,
    beforeState: before as unknown as Record<string, unknown>,
    afterState: cycle as unknown as Record<string, unknown>,
    timestamp: new Date().toISOString(),
  });

  return cycle;
}
```

- [ ] **Step 4: Create route files for all three entities**

Create `packages/api/src/routes/meters.ts`:

```typescript
import type { FastifyInstance } from "fastify";
import { createMeterSchema, updateMeterSchema, meterQuerySchema } from "@utility-cis/shared";
import * as meterService from "../services/meter.service";

export async function meterRoutes(app: FastifyInstance) {
  app.get("/api/v1/meters", async (request) => {
    const query = meterQuerySchema.parse(request.query);
    return meterService.listMeters(request.user.utilityId, query);
  });

  app.get("/api/v1/meters/:id", async (request) => {
    const { id } = request.params as { id: string };
    return meterService.getMeter(id);
  });

  app.post("/api/v1/meters", async (request, reply) => {
    const data = createMeterSchema.parse(request.body);
    const meter = await meterService.createMeter(
      request.user.utilityId, request.user.id, data
    );
    reply.status(201).send(meter);
  });

  app.patch("/api/v1/meters/:id", async (request) => {
    const { id } = request.params as { id: string };
    const data = updateMeterSchema.parse(request.body);
    return meterService.updateMeter(
      request.user.utilityId, request.user.id, id, data
    );
  });
}
```

Create `packages/api/src/routes/accounts.ts`:

```typescript
import type { FastifyInstance } from "fastify";
import { createAccountSchema, updateAccountSchema, accountQuerySchema } from "@utility-cis/shared";
import * as accountService from "../services/account.service";

export async function accountRoutes(app: FastifyInstance) {
  app.get("/api/v1/accounts", async (request) => {
    const query = accountQuerySchema.parse(request.query);
    return accountService.listAccounts(request.user.utilityId, query);
  });

  app.get("/api/v1/accounts/:id", async (request) => {
    const { id } = request.params as { id: string };
    return accountService.getAccount(id);
  });

  app.post("/api/v1/accounts", async (request, reply) => {
    const data = createAccountSchema.parse(request.body);
    const account = await accountService.createAccount(
      request.user.utilityId, request.user.id, data
    );
    reply.status(201).send(account);
  });

  app.patch("/api/v1/accounts/:id", async (request) => {
    const { id } = request.params as { id: string };
    const data = updateAccountSchema.parse(request.body);
    return accountService.updateAccount(
      request.user.utilityId, request.user.id, id, data
    );
  });
}
```

Create `packages/api/src/routes/billing-cycles.ts`:

```typescript
import type { FastifyInstance } from "fastify";
import { createBillingCycleSchema, updateBillingCycleSchema } from "@utility-cis/shared";
import * as billingCycleService from "../services/billing-cycle.service";

export async function billingCycleRoutes(app: FastifyInstance) {
  app.get("/api/v1/billing-cycles", async (request) => {
    return billingCycleService.listBillingCycles(request.user.utilityId);
  });

  app.post("/api/v1/billing-cycles", async (request, reply) => {
    const data = createBillingCycleSchema.parse(request.body);
    const cycle = await billingCycleService.createBillingCycle(
      request.user.utilityId, request.user.id, data
    );
    reply.status(201).send(cycle);
  });

  app.patch("/api/v1/billing-cycles/:id", async (request) => {
    const { id } = request.params as { id: string };
    const data = updateBillingCycleSchema.parse(request.body);
    return billingCycleService.updateBillingCycle(
      request.user.utilityId, request.user.id, id, data
    );
  });
}
```

- [ ] **Step 5: Register all routes in app.ts and commit**

```typescript
import { meterRoutes } from "./routes/meters";
import { accountRoutes } from "./routes/accounts";
import { billingCycleRoutes } from "./routes/billing-cycles";

await app.register(meterRoutes);
await app.register(accountRoutes);
await app.register(billingCycleRoutes);
```

```bash
git add packages/api/src/
git commit -m "feat: add Meter, Account, and BillingCycle CRUD routes with business rules"
```

---

## Task 8: API Routes — Service Agreements (with meter junction)

**Files:**
- Create: `packages/api/src/services/service-agreement.service.ts`
- Create: `packages/api/src/routes/service-agreements.ts`
- Modify: `packages/api/src/app.ts`

The most complex service — handles meter assignment uniqueness validation, status transitions, and the junction table.

- [ ] **Step 1: Create service agreement service**

Create `packages/api/src/services/service-agreement.service.ts`:

```typescript
import { prisma } from "../lib/prisma";
import { domainEvents } from "../events/emitter";
import { EVENT_TYPES, isValidStatusTransition } from "@utility-cis/shared";
import type {
  CreateServiceAgreementInput,
  UpdateServiceAgreementInput,
  ServiceAgreementQuery,
} from "@utility-cis/shared";
import { paginationArgs, paginatedResponse } from "../lib/pagination";

export async function listServiceAgreements(
  utilityId: string,
  query: ServiceAgreementQuery
) {
  const where: Record<string, unknown> = {};
  if (query.accountId) where.accountId = query.accountId;
  if (query.premiseId) where.premiseId = query.premiseId;
  if (query.status) where.status = query.status;

  const [data, total] = await Promise.all([
    prisma.serviceAgreement.findMany({
      where,
      ...paginationArgs(query),
      include: {
        account: true,
        premise: true,
        commodity: true,
        rateSchedule: true,
        billingCycle: true,
        meters: { include: { meter: true }, where: { removedDate: null } },
      },
    }),
    prisma.serviceAgreement.count({ where }),
  ]);

  return paginatedResponse(data, total, query);
}

export async function getServiceAgreement(id: string) {
  return prisma.serviceAgreement.findUniqueOrThrow({
    where: { id },
    include: {
      account: true,
      premise: true,
      commodity: true,
      rateSchedule: true,
      billingCycle: true,
      meters: {
        include: { meter: { include: { uom: true } } },
        orderBy: { addedDate: "asc" },
      },
    },
  });
}

export async function createServiceAgreement(
  utilityId: string,
  actorId: string,
  data: CreateServiceAgreementInput
) {
  // Validate: each meter can only be in one active agreement per commodity
  for (const meterAssignment of data.meters) {
    const existing = await prisma.serviceAgreementMeter.findFirst({
      where: {
        meterId: meterAssignment.meterId,
        removedDate: null,
        serviceAgreement: {
          commodityId: data.commodityId,
          status: { in: ["PENDING", "ACTIVE"] },
        },
      },
    });

    if (existing) {
      throw Object.assign(
        new Error(
          `Meter ${meterAssignment.meterId} is already assigned to an active agreement for this commodity`
        ),
        { statusCode: 400, code: "METER_ALREADY_ASSIGNED" }
      );
    }
  }

  // Ensure at least one primary meter
  const hasPrimary = data.meters.some((m) => m.isPrimary);
  const metersToCreate = hasPrimary
    ? data.meters
    : data.meters.map((m, i) => (i === 0 ? { ...m, isPrimary: true } : m));

  const agreement = await prisma.serviceAgreement.create({
    data: {
      utilityId,
      agreementNumber: data.agreementNumber,
      accountId: data.accountId,
      premiseId: data.premiseId,
      commodityId: data.commodityId,
      rateScheduleId: data.rateScheduleId,
      billingCycleId: data.billingCycleId,
      startDate: new Date(data.startDate),
      endDate: data.endDate ? new Date(data.endDate) : null,
      status: data.status || "PENDING",
      readSequence: data.readSequence,
      meters: {
        create: metersToCreate.map((m) => ({
          utilityId,
          meterId: m.meterId,
          isPrimary: m.isPrimary,
          addedDate: new Date(data.startDate),
        })),
      },
    },
    include: {
      account: true,
      premise: true,
      commodity: true,
      rateSchedule: true,
      billingCycle: true,
      meters: { include: { meter: true } },
    },
  });

  domainEvents.emitDomainEvent({
    type: EVENT_TYPES.SERVICE_AGREEMENT_CREATED,
    entityType: "ServiceAgreement",
    entityId: agreement.id,
    utilityId,
    actorId,
    beforeState: null,
    afterState: agreement as unknown as Record<string, unknown>,
    timestamp: new Date().toISOString(),
  });

  return agreement;
}

export async function updateServiceAgreement(
  utilityId: string,
  actorId: string,
  id: string,
  data: UpdateServiceAgreementInput
) {
  const before = await prisma.serviceAgreement.findUniqueOrThrow({
    where: { id },
  });

  // Validate status transition
  if (data.status && data.status !== before.status) {
    if (!isValidStatusTransition(before.status, data.status)) {
      throw Object.assign(
        new Error(
          `Invalid status transition: ${before.status} → ${data.status}`
        ),
        { statusCode: 400, code: "INVALID_STATUS_TRANSITION" }
      );
    }
  }

  const updateData: Record<string, unknown> = {};
  if (data.rateScheduleId) updateData.rateScheduleId = data.rateScheduleId;
  if (data.billingCycleId) updateData.billingCycleId = data.billingCycleId;
  if (data.endDate) updateData.endDate = new Date(data.endDate);
  if (data.status) updateData.status = data.status;
  if (data.readSequence !== undefined) updateData.readSequence = data.readSequence;

  const agreement = await prisma.serviceAgreement.update({
    where: { id },
    data: updateData,
    include: {
      account: true,
      premise: true,
      commodity: true,
      rateSchedule: true,
      billingCycle: true,
      meters: { include: { meter: true }, where: { removedDate: null } },
    },
  });

  domainEvents.emitDomainEvent({
    type: EVENT_TYPES.SERVICE_AGREEMENT_UPDATED,
    entityType: "ServiceAgreement",
    entityId: id,
    utilityId,
    actorId,
    beforeState: before as unknown as Record<string, unknown>,
    afterState: agreement as unknown as Record<string, unknown>,
    timestamp: new Date().toISOString(),
  });

  return agreement;
}
```

- [ ] **Step 2: Create routes and register**

Create `packages/api/src/routes/service-agreements.ts`:

```typescript
import type { FastifyInstance } from "fastify";
import {
  createServiceAgreementSchema,
  updateServiceAgreementSchema,
  serviceAgreementQuerySchema,
} from "@utility-cis/shared";
import * as saService from "../services/service-agreement.service";

export async function serviceAgreementRoutes(app: FastifyInstance) {
  app.get("/api/v1/service-agreements", async (request) => {
    const query = serviceAgreementQuerySchema.parse(request.query);
    return saService.listServiceAgreements(request.user.utilityId, query);
  });

  app.get("/api/v1/service-agreements/:id", async (request) => {
    const { id } = request.params as { id: string };
    return saService.getServiceAgreement(id);
  });

  app.post("/api/v1/service-agreements", async (request, reply) => {
    const data = createServiceAgreementSchema.parse(request.body);
    const agreement = await saService.createServiceAgreement(
      request.user.utilityId, request.user.id, data
    );
    reply.status(201).send(agreement);
  });

  app.patch("/api/v1/service-agreements/:id", async (request) => {
    const { id } = request.params as { id: string };
    const data = updateServiceAgreementSchema.parse(request.body);
    return saService.updateServiceAgreement(
      request.user.utilityId, request.user.id, id, data
    );
  });
}
```

Register in `app.ts`:

```typescript
import { serviceAgreementRoutes } from "./routes/service-agreements";
await app.register(serviceAgreementRoutes);
```

- [ ] **Step 3: Commit**

```bash
git add packages/api/src/
git commit -m "feat: add ServiceAgreement CRUD with multi-meter junction and status transitions"
```

---

## Task 9: API Routes — Rate Schedules (with versioning)

**Files:**
- Create: `packages/api/src/services/rate-schedule.service.ts`
- Create: `packages/api/src/routes/rate-schedules.ts`
- Modify: `packages/api/src/app.ts`

Includes the special `/revise` endpoint that creates a new version and auto-expires the predecessor.

- [ ] **Step 1: Create rate schedule service**

Create `packages/api/src/services/rate-schedule.service.ts`:

```typescript
import { prisma } from "../lib/prisma";
import { redis } from "../lib/redis";
import { domainEvents } from "../events/emitter";
import { EVENT_TYPES } from "@utility-cis/shared";
import type { CreateRateScheduleInput, RateScheduleQuery } from "@utility-cis/shared";
import { paginationArgs, paginatedResponse } from "../lib/pagination";

export async function listRateSchedules(
  utilityId: string,
  query: RateScheduleQuery
) {
  const where: Record<string, unknown> = {};
  if (query.commodityId) where.commodityId = query.commodityId;
  if (query.rateType) where.rateType = query.rateType;
  if (query.active === true) where.expirationDate = null;
  if (query.active === false) where.expirationDate = { not: null };

  const [data, total] = await Promise.all([
    prisma.rateSchedule.findMany({
      where,
      ...paginationArgs(query),
      include: { commodity: true },
    }),
    prisma.rateSchedule.count({ where }),
  ]);

  return paginatedResponse(data, total, query);
}

export async function getRateSchedule(id: string) {
  const schedule = await prisma.rateSchedule.findUniqueOrThrow({
    where: { id },
    include: {
      commodity: true,
      supersedes: true,
      supersededBy: true,
    },
  });
  return schedule;
}

export async function createRateSchedule(
  utilityId: string,
  actorId: string,
  data: CreateRateScheduleInput
) {
  const schedule = await prisma.rateSchedule.create({
    data: {
      utilityId,
      name: data.name,
      code: data.code,
      commodityId: data.commodityId,
      rateType: data.rateType,
      effectiveDate: new Date(data.effectiveDate),
      expirationDate: data.expirationDate ? new Date(data.expirationDate) : null,
      description: data.description,
      regulatoryRef: data.regulatoryRef,
      rateConfig: data.rateConfig,
    },
    include: { commodity: true },
  });

  // Invalidate cache
  await redis.del(`rate-schedule:${utilityId}:${data.code}`);

  domainEvents.emitDomainEvent({
    type: EVENT_TYPES.RATE_SCHEDULE_CREATED,
    entityType: "RateSchedule",
    entityId: schedule.id,
    utilityId,
    actorId,
    beforeState: null,
    afterState: schedule as unknown as Record<string, unknown>,
    timestamp: new Date().toISOString(),
  });

  return schedule;
}

export async function reviseRateSchedule(
  utilityId: string,
  actorId: string,
  id: string,
  data: CreateRateScheduleInput
) {
  const predecessor = await prisma.rateSchedule.findUniqueOrThrow({
    where: { id },
  });

  // Auto-expire predecessor and create new version in a transaction
  const [, newSchedule] = await prisma.$transaction([
    prisma.rateSchedule.update({
      where: { id },
      data: {
        expirationDate: new Date(data.effectiveDate),
      },
    }),
    prisma.rateSchedule.create({
      data: {
        utilityId,
        name: data.name,
        code: predecessor.code,
        commodityId: data.commodityId,
        rateType: data.rateType,
        effectiveDate: new Date(data.effectiveDate),
        expirationDate: data.expirationDate ? new Date(data.expirationDate) : null,
        description: data.description,
        regulatoryRef: data.regulatoryRef,
        rateConfig: data.rateConfig,
        version: predecessor.version + 1,
        supersedesId: id,
      },
      include: { commodity: true },
    }),
  ]);

  // Invalidate cache
  await redis.del(`rate-schedule:${utilityId}:${predecessor.code}`);

  domainEvents.emitDomainEvent({
    type: EVENT_TYPES.RATE_SCHEDULE_REVISED,
    entityType: "RateSchedule",
    entityId: newSchedule.id,
    utilityId,
    actorId,
    beforeState: predecessor as unknown as Record<string, unknown>,
    afterState: newSchedule as unknown as Record<string, unknown>,
    timestamp: new Date().toISOString(),
  });

  return newSchedule;
}
```

- [ ] **Step 2: Create routes and register**

Create `packages/api/src/routes/rate-schedules.ts`:

```typescript
import type { FastifyInstance } from "fastify";
import { createRateScheduleSchema, rateScheduleQuerySchema } from "@utility-cis/shared";
import * as rateScheduleService from "../services/rate-schedule.service";

export async function rateScheduleRoutes(app: FastifyInstance) {
  app.get("/api/v1/rate-schedules", async (request) => {
    const query = rateScheduleQuerySchema.parse(request.query);
    return rateScheduleService.listRateSchedules(request.user.utilityId, query);
  });

  app.get("/api/v1/rate-schedules/:id", async (request) => {
    const { id } = request.params as { id: string };
    return rateScheduleService.getRateSchedule(id);
  });

  app.post("/api/v1/rate-schedules", async (request, reply) => {
    const data = createRateScheduleSchema.parse(request.body);
    const schedule = await rateScheduleService.createRateSchedule(
      request.user.utilityId, request.user.id, data
    );
    reply.status(201).send(schedule);
  });

  app.post("/api/v1/rate-schedules/:id/revise", async (request, reply) => {
    const { id } = request.params as { id: string };
    const data = createRateScheduleSchema.parse(request.body);
    const schedule = await rateScheduleService.reviseRateSchedule(
      request.user.utilityId, request.user.id, id, data
    );
    reply.status(201).send(schedule);
  });
}
```

Register in `app.ts`:

```typescript
import { rateScheduleRoutes } from "./routes/rate-schedules";
await app.register(rateScheduleRoutes);
```

- [ ] **Step 3: Commit**

```bash
git add packages/api/src/
git commit -m "feat: add RateSchedule CRUD with versioning, revision endpoint, and Redis cache invalidation"
```

---

## Task 10: API Routes — Theme and Audit Log

**Files:**
- Create: `packages/api/src/services/theme.service.ts`
- Create: `packages/api/src/routes/theme.ts`
- Create: `packages/api/src/routes/audit-log.ts`
- Modify: `packages/api/src/app.ts`

- [ ] **Step 1: Create theme service**

Create `packages/api/src/services/theme.service.ts`:

```typescript
import { prisma } from "../lib/prisma";
import type { UpdateThemeInput } from "@utility-cis/shared";

const DEFAULT_THEME = {
  preset: "midnight",
  colors: {
    dark: {
      "bg-deep": "#06080d",
      "bg-surface": "#0c1018",
      "bg-card": "#111722",
      "accent-primary": "#3b82f6",
      "text-primary": "#e8edf5",
    },
    light: {
      "bg-deep": "#ffffff",
      "bg-surface": "#f8fafc",
      "bg-card": "#ffffff",
      "accent-primary": "#0f766e",
      "text-primary": "#0f172a",
    },
  },
  typography: { body: "DM Sans", display: "Fraunces" },
  borderRadius: 10,
};

export async function getTheme(utilityId: string) {
  const theme = await prisma.tenantTheme.findUnique({
    where: { utilityId },
  });
  return theme || DEFAULT_THEME;
}

export async function updateTheme(utilityId: string, data: UpdateThemeInput) {
  return prisma.tenantTheme.upsert({
    where: { utilityId },
    create: { utilityId, ...data },
    update: data,
  });
}

export async function resetTheme(utilityId: string) {
  return prisma.tenantTheme.upsert({
    where: { utilityId },
    create: { utilityId, ...DEFAULT_THEME },
    update: DEFAULT_THEME,
  });
}
```

- [ ] **Step 2: Create theme and audit log routes**

Create `packages/api/src/routes/theme.ts`:

```typescript
import type { FastifyInstance } from "fastify";
import { updateThemeSchema } from "@utility-cis/shared";
import * as themeService from "../services/theme.service";

export async function themeRoutes(app: FastifyInstance) {
  app.get("/api/v1/theme", async (request) => {
    return themeService.getTheme(request.user.utilityId);
  });

  app.put("/api/v1/theme", async (request) => {
    const data = updateThemeSchema.parse(request.body);
    return themeService.updateTheme(request.user.utilityId, data);
  });

  app.post("/api/v1/theme/reset", async (request) => {
    return themeService.resetTheme(request.user.utilityId);
  });
}
```

Create `packages/api/src/routes/audit-log.ts`:

```typescript
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { paginationArgs, paginatedResponse } from "../lib/pagination";

const auditQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(25),
  sort: z.string().default("created_at"),
  order: z.enum(["asc", "desc"]).default("desc"),
  entityType: z.string().optional(),
  entityId: z.string().uuid().optional(),
  action: z.enum(["CREATE", "UPDATE", "DELETE"]).optional(),
  actorId: z.string().uuid().optional(),
  startDate: z.string().datetime().optional(),
  endDate: z.string().datetime().optional(),
});

export async function auditLogRoutes(app: FastifyInstance) {
  app.get("/api/v1/audit-log", async (request) => {
    const query = auditQuerySchema.parse(request.query);

    const where: Record<string, unknown> = {};
    if (query.entityType) where.entityType = query.entityType;
    if (query.entityId) where.entityId = query.entityId;
    if (query.action) where.action = query.action;
    if (query.actorId) where.actorId = query.actorId;
    if (query.startDate || query.endDate) {
      where.createdAt = {};
      if (query.startDate) (where.createdAt as Record<string, unknown>).gte = new Date(query.startDate);
      if (query.endDate) (where.createdAt as Record<string, unknown>).lte = new Date(query.endDate);
    }

    const [data, total] = await Promise.all([
      prisma.auditLog.findMany({ where, ...paginationArgs(query) }),
      prisma.auditLog.count({ where }),
    ]);

    return paginatedResponse(data, total, query);
  });
}
```

- [ ] **Step 3: Register and commit**

Register in `app.ts`:

```typescript
import { themeRoutes } from "./routes/theme";
import { auditLogRoutes } from "./routes/audit-log";

await app.register(themeRoutes);
await app.register(auditLogRoutes);
```

```bash
git add packages/api/src/
git commit -m "feat: add Theme CRUD with presets and AuditLog query endpoint"
```

---

## Task 11: Next.js Web Foundation

**Files:**
- Create: `packages/web/next.config.ts`
- Create: `packages/web/tailwind.config.ts`
- Create: `packages/web/app/globals.css`
- Create: `packages/web/app/layout.tsx`
- Create: `packages/web/app/page.tsx`
- Create: `packages/web/app/login/page.tsx`
- Create: `packages/web/lib/api-client.ts`
- Create: `packages/web/lib/auth.ts`
- Create: `packages/web/lib/theme-provider.tsx`
- Create: `packages/web/lib/query-provider.tsx`
- Create: `packages/web/components/sidebar.tsx`
- Create: `packages/web/components/topbar.tsx`

This task sets up the Next.js admin UI shell: auth, layout, sidebar navigation, top bar, theme provider, and API client.

- [ ] **Step 1: Create Next.js config, Tailwind config, and globals.css**

These are standard setup files. The globals.css should include CSS custom properties for the theme system (both dark and light variants) that map to the `data-theme` attribute on `<html>`.

- [ ] **Step 2: Create auth configuration (NextAuth.js)**

Create `packages/web/lib/auth.ts` with a credentials provider for dev and JWT strategy that includes `utility_id` in the token.

- [ ] **Step 3: Create API client**

Create `packages/web/lib/api-client.ts` — a fetch wrapper that adds the JWT Bearer token from the session and handles error responses.

- [ ] **Step 4: Create theme provider**

Create `packages/web/lib/theme-provider.tsx` — React context that loads theme from API on mount, applies CSS variables to `document.documentElement`, and provides a toggle function for light/dark mode.

- [ ] **Step 5: Create query provider**

Create `packages/web/lib/query-provider.tsx` — TanStack Query provider wrapper.

- [ ] **Step 6: Create layout shell**

Create `packages/web/app/layout.tsx` — root layout with auth session provider, query provider, theme provider, sidebar, and top bar.

- [ ] **Step 7: Create sidebar navigation component**

Create `packages/web/components/sidebar.tsx` — collapsible sidebar with sections (Operations, Configuration, System) and nav items with entity counts.

- [ ] **Step 8: Create top bar component**

Create `packages/web/components/topbar.tsx` — breadcrumbs, global search input, theme toggle (sun/moon), user menu.

- [ ] **Step 9: Create login and home pages**

Create login page with NextAuth sign-in form. Home page redirects to `/premises`.

- [ ] **Step 10: Verify dev server starts**

Run: `cd packages/web && pnpm dev`
Expected: Next.js dev server on port 3000, login page renders.

- [ ] **Step 11: Commit**

```bash
git add packages/web/
git commit -m "feat: add Next.js admin UI shell with auth, sidebar, topbar, and theme system"
```

---

## Task 12: Reusable UI Components

**Files:**
- Create: `packages/web/components/ui/data-table.tsx`
- Create: `packages/web/components/ui/entity-form.tsx`
- Create: `packages/web/components/ui/detail-page.tsx`
- Create: `packages/web/components/ui/status-badge.tsx`
- Create: `packages/web/components/ui/commodity-badge.tsx`
- Create: `packages/web/components/ui/pagination.tsx`
- Create: `packages/web/components/ui/filter-bar.tsx`

This task creates the reusable components used across all entity pages. Install shadcn/ui components first (`npx shadcn@latest init`, then add table, form, input, select, button, tabs, dialog, toast, badge, card).

- [ ] **Step 1: Initialize shadcn/ui and add base components**

Run: `cd packages/web && npx shadcn@latest init && npx shadcn@latest add table button input select form tabs dialog badge card toast`

- [ ] **Step 2: Create DataTable component**

Wrapper around TanStack Table with server-side pagination, column sorting, and filter bar.

- [ ] **Step 3: Create StatusBadge and CommodityBadge components**

Reusable badge components with color coding per status/commodity.

- [ ] **Step 4: Create Pagination component**

Page buttons, prev/next, showing X of Y.

- [ ] **Step 5: Create FilterBar component**

Pill-style filters that map to URL query params.

- [ ] **Step 6: Commit**

```bash
git add packages/web/components/
git commit -m "feat: add reusable UI components — DataTable, badges, pagination, filters"
```

---

## Task 13: Admin UI — Entity Pages (Premises, Meters, Accounts, Agreements, Rates, Cycles)

**Files:**
- Create all pages from the App Router structure in the spec (Section 7.2)

Each entity follows the same pattern:
1. **List page** — DataTable + filters + stats bar + "Add" button
2. **Create page** — Form with Zod validation via react-hook-form
3. **Detail page** — Tabbed layout (Overview, Related, Audit History)

- [ ] **Step 1: Build Premises pages (list + create + detail)**

The premises list page includes the table/map toggle (map view is Task 14).

- [ ] **Step 2: Build Meters pages**

Create form includes premise selector (dependent dropdown) and commodity-premise validation.

- [ ] **Step 3: Build Accounts pages**

List page includes search by name/account number. Detail shows linked agreements.

- [ ] **Step 4: Build Service Agreements pages**

Create form is the most complex — links account + premise + meters (multi-select) + rate schedule + billing cycle. All dependent dropdowns.

- [ ] **Step 5: Build Rate Schedules pages**

Includes the rate config builder component (select rate type → dynamic form) with tier builder and live calculation preview. Detail page shows version history chain.

- [ ] **Step 6: Build Billing Cycles pages**

Simpler — list and create form.

- [ ] **Step 7: Build Audit Log page**

Searchable/filterable log with entity type, action, actor, and date range filters.

- [ ] **Step 8: Commit per entity group**

Commit after each entity's pages are complete.

---

## Task 14: Premises Map View

**Files:**
- Create: `packages/web/components/premises/map-view.tsx`
- Create: `packages/web/components/premises/map-pin.tsx`
- Create: `packages/web/components/premises/map-popup.tsx`
- Create: `packages/web/components/premises/map-legend.tsx`
- Create: `packages/web/components/premises/map-filters.tsx`
- Modify: `packages/web/app/premises/page.tsx` (add map toggle)

- [ ] **Step 1: Create MapView component**

Uses `react-map-gl` with Mapbox GL JS. Switches between `mapbox://styles/mapbox/dark-v11` and `light-v11` based on theme. Loads data from `GET /api/v1/premises/geo`.

- [ ] **Step 2: Create Supercluster integration**

Client-side clustering with Supercluster. Clusters show count badge, expand on zoom, color-coded by majority premise type.

- [ ] **Step 3: Create MapPopup component**

Popup on pin click — shows premise address, type, territory, commodities, meters, agreements, status, and View Details / Manage buttons.

- [ ] **Step 4: Create MapLegend and MapFilters**

Legend shows color coding. Filters toggle premise types on/off on the map.

- [ ] **Step 5: Add table/map toggle to Premises list page**

Toggle state stored in URL params and localStorage.

- [ ] **Step 6: Commit**

```bash
git add packages/web/
git commit -m "feat: add Premises map view with Mapbox, clustering, popups, and type filters"
```

---

## Task 15: Theme Editor Page

**Files:**
- Create: `packages/web/app/theme/page.tsx`
- Create: `packages/web/components/theme/preset-grid.tsx`
- Create: `packages/web/components/theme/color-picker.tsx`
- Create: `packages/web/components/theme/font-selector.tsx`
- Create: `packages/web/components/theme/radius-slider.tsx`
- Create: `packages/web/components/theme/logo-upload.tsx`
- Create: `packages/web/components/theme/live-preview.tsx`

- [ ] **Step 1: Create preset grid**

4 built-in presets (Midnight/Daybreak, Dusk/Dawn, Forest/Meadow) as clickable cards showing color dots and name. Selecting a preset populates all color/font fields.

- [ ] **Step 2: Create color pickers**

Color swatch + hex input for each theme color (primary, accent, success, danger, warning, backgrounds). Groups for brand colors and surface colors.

- [ ] **Step 3: Create font selector and radius slider**

Font dropdowns for body and display fonts. Range slider for border radius (0-20px).

- [ ] **Step 4: Create logo upload**

Drag-and-drop zone for SVG/PNG upload. Preview of uploaded logo.

- [ ] **Step 5: Create live preview panel**

Shows buttons, badges, status pills, and a mini data table using the current theme colors in real-time.

- [ ] **Step 6: Wire up to theme API**

Save button calls `PUT /api/v1/theme`. Reset calls `POST /api/v1/theme/reset`. Changes apply instantly via the theme provider context.

- [ ] **Step 7: Commit**

```bash
git add packages/web/
git commit -m "feat: add tenant theme editor with presets, color pickers, and live preview"
```

---

## Task 16: Integration Tests

**Files:**
- Create: `packages/api/src/__tests__/integration/premises.test.ts`
- Create: `packages/api/src/__tests__/integration/service-agreements.test.ts`
- Create: `packages/api/src/__tests__/integration/rate-schedules.test.ts`
- Create: `packages/api/src/__tests__/integration/rls.test.ts`
- Create: `packages/api/src/__tests__/integration/audit.test.ts`
- Create: `packages/api/vitest.config.ts`

- [ ] **Step 1: Set up integration test infrastructure**

Create `vitest.config.ts` with test database setup/teardown. Use Docker Compose test database or Testcontainers.

- [ ] **Step 2: Test Premises CRUD + GeoJSON**

Full lifecycle: create premise, list, get by ID, update, verify GeoJSON endpoint returns correct features.

- [ ] **Step 3: Test ServiceAgreement business rules**

Test: create agreement with meters, verify overlap rejection, verify status transitions (valid and invalid), verify account closure guard.

- [ ] **Step 4: Test RateSchedule versioning**

Test: create schedule, revise it, verify predecessor is expired, verify version chain.

- [ ] **Step 5: Test RLS isolation**

Test: create data as tenant A, switch to tenant B context, verify tenant B cannot see tenant A's data.

- [ ] **Step 6: Test audit log capture**

Test: create an entity, verify audit log entry was created with correct before/after state.

- [ ] **Step 7: Run all tests**

Run: `pnpm test`
Expected: All unit and integration tests pass.

- [ ] **Step 8: Commit**

```bash
git add packages/api/src/__tests__/
git commit -m "feat: add integration tests for CRUD, business rules, RLS, and audit logging"
```
