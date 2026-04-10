# Business Rules

**Last updated:** 2026-04-09
**Purpose:** Master reference of all business rules enforced by the Utility CIS system. Rules are referenced by ID in code, API error messages, UI tooltips, and functional specs.

**Rule ID format:** `BR-<module>-<number>`

---

## BR-CU: Customer Rules

| ID | Rule | Enforcement |
|----|------|-------------|
| BR-CU-001 | An INDIVIDUAL customer requires firstName and lastName. | Zod validator + API |
| BR-CU-002 | An ORGANIZATION customer requires organizationName. | Zod validator + API |
| BR-CU-003 | customerType cannot be changed after creation. | Zod update schema omits customerType |
| BR-CU-004 | A customer can be deactivated (status → INACTIVE) only if all linked accounts are CLOSED or INACTIVE. | API service layer |
| BR-CU-005 | A customer can have zero or more accounts. | No constraint |
| BR-CU-006 | A customer can own zero or more premises (as property owner). | No constraint |
| BR-CU-007 | Deactivating a customer does NOT close their accounts — accounts must be closed independently. | Business process |

---

## BR-CT: Contact Rules

| ID | Rule | Enforcement |
|----|------|-------------|
| BR-CT-001 | A contact belongs to exactly one account. | FK constraint |
| BR-CT-002 | An account can have multiple contacts with different roles (PRIMARY, BILLING, AUTHORIZED, EMERGENCY). | No unique constraint on role |
| BR-CT-003 | Contacts can be hard-deleted (the only entity with hard delete — contacts are not regulated data). | DELETE API endpoint |
| BR-CT-004 | At least one contact should be marked isPrimary per account. | UI warning (not enforced at DB level) |

---

## BR-BA: Billing Address Rules

| ID | Rule | Enforcement |
|----|------|-------------|
| BR-BA-001 | A billing address belongs to exactly one account. | FK constraint |
| BR-BA-002 | An account can have multiple billing addresses (e.g., seasonal address). | No constraint |
| BR-BA-003 | At least one billing address should be marked isPrimary per account. | UI warning |
| BR-BA-004 | The billing address may differ from the premise/service address. | By design |
| BR-BA-005 | International addresses are supported via the country field (2-letter ISO code). | VARCHAR(2) field |

---

## BR-PR: Premise Rules

| ID | Rule | Enforcement |
|----|------|-------------|
| BR-PR-001 | A premise is a physical location — it is permanent and outlives customers. | By design |
| BR-PR-002 | A premise can have an owner (Customer) who may differ from the service account holder (landlord/tenant model). | ownerId FK → Customer |
| BR-PR-003 | A premise must have at least one commodity assigned (commodityIds array min 1). | Zod validator |
| BR-PR-004 | A premise can be deactivated (ACTIVE → INACTIVE) but not deleted. | Soft delete only |
| BR-PR-005 | A CONDEMNED premise cannot have new meters installed or agreements created. | API validation |
| BR-PR-006 | Deactivating a premise does NOT affect existing active meters or agreements — those must be handled independently. | Business process |
| BR-PR-007 | Meter commodity must exist in the premise's commodityIds. | API service layer (BR-MT-003) |

---

## BR-MT: Meter Rules

| ID | Rule | Enforcement |
|----|------|-------------|
| BR-MT-001 | A meter belongs to exactly one premise. | FK constraint |
| BR-MT-002 | A meter is identified by meterNumber, unique within a utility tenant. | Unique constraint [utilityId, meterNumber] |
| BR-MT-003 | A meter's commodity must exist in its premise's commodityIds. | API validation — returns COMMODITY_MISMATCH |
| BR-MT-004 | A meter can have one or more registers (MeterRegister) for multi-channel measurement. | One-to-many relation |
| BR-MT-005 | A meter can be removed (status → REMOVED) but not deleted. Meter history must be retained. | Soft delete only |
| BR-MT-006 | A meter with active service agreements cannot be removed — agreements must be closed first. | API validation |
| BR-MT-007 | Meter multiplier defaults to 1.0. Only change for CT meters, pressure correction, or unit conversion. | Default value |
| BR-MT-008 | When a meter is replaced mid-cycle, both the old and new meter reads should total to the period's consumption. | Phase 2 — consumption calculation |
| BR-MT-009 | Meter meterNumber and premiseId cannot be changed after creation. | Zod update schema omits these fields |

---

## BR-AC: Account Rules

| ID | Rule | Enforcement |
|----|------|-------------|
| BR-AC-001 | An account belongs to one customer (customerId FK). | FK constraint |
| BR-AC-002 | An account is identified by accountNumber, unique within a utility tenant. | Unique constraint [utilityId, accountNumber] |
| BR-AC-003 | An account can exist without any active service agreements (e.g., pending setup, final billed, deposit-only). | No constraint |
| BR-AC-004 | An account CANNOT be closed (status → CLOSED) while it has active or pending service agreements. | API validation in $transaction — returns ACTIVE_AGREEMENTS_EXIST |
| BR-AC-005 | accountNumber cannot be changed after creation. | Zod update schema omits accountNumber |
| BR-AC-006 | An account can have multiple contacts with different roles. | Via Contact entity |
| BR-AC-007 | An account can have multiple billing addresses. | Via BillingAddress entity |
| BR-AC-008 | Deposits may be required for certain account types (e.g., renters). | depositAmount field |
| BR-AC-009 | Deposit can be waived with a reason recorded. | depositWaived + depositWaivedReason |
| BR-AC-010 | Status transitions: ACTIVE can go to INACTIVE, FINAL, SUSPENDED. FINAL can go to CLOSED. CLOSED is terminal. | API validation |

---

## BR-SA: Service Agreement Rules

| ID | Rule | Enforcement |
|----|------|-------------|
| BR-SA-001 | A service agreement links exactly one account, one premise, one commodity, one rate schedule, and one billing cycle. | FK constraints |
| BR-SA-002 | Meters are linked to agreements via ServiceAgreementMeter junction table — an agreement can have one or more meters. | One-to-many via junction |
| BR-SA-003 | All meters on an agreement must be at the same premise and for the same commodity. | Implicit — meters belong to premise, meters have commodity |
| BR-SA-004 | A meter can only be assigned to one active agreement per commodity at a time. | API validation in $transaction — returns METER_ALREADY_ASSIGNED |
| BR-SA-005 | At least one meter must be marked isPrimary per agreement. If none specified, the first meter is auto-set as primary. | API service layer |
| BR-SA-006 | Status transitions: PENDING → ACTIVE → FINAL → CLOSED. No skipping. | isValidStatusTransition() function |
| BR-SA-007 | An agreement's endDate = null means it is currently active. Setting endDate closes the agreement period. | By design |
| BR-SA-008 | Retroactive endDate adjustments are supported for rebilling scenarios. | By design |
| BR-SA-009 | agreementNumber is unique within a utility tenant. | Unique constraint [utilityId, agreementNumber] |
| BR-SA-010 | Agreement cannot be created for a CONDEMNED premise. | API validation |
| BR-SA-011 | When an agreement is set to FINAL, a final meter read should be scheduled. | Phase 2 — workflow |
| BR-SA-012 | Meters can be added to or removed from an active agreement (removedDate tracks when). | ServiceAgreementMeter.removedDate |

---

## BR-RS: Rate Schedule Rules

| ID | Rule | Enforcement |
|----|------|-------------|
| BR-RS-001 | Rate schedules are immutable once created — they cannot be edited, only revised (new version). | No PATCH endpoint; POST /revise creates new version |
| BR-RS-002 | Revising a rate schedule auto-expires the predecessor (sets expirationDate) and creates a new version with version + 1. | API service in $transaction |
| BR-RS-003 | Rate schedules use effective dating — billing always looks up which rate was in effect during the billing period, not the current rate. | effectiveDate / expirationDate |
| BR-RS-004 | rate_config JSONB structure must match the rateType (FLAT, TIERED, TOU, DEMAND, BUDGET). | Zod union validator |
| BR-RS-005 | A rate schedule with active service agreements cannot be expired without a successor. | API validation |
| BR-RS-006 | Version chain is tracked via supersedesId (self-referential FK). | Schema design |
| BR-RS-007 | Rate schedule code + version is unique within a utility tenant. | Unique constraint [utilityId, code, version] |
| BR-RS-008 | Redis cache is invalidated when a rate schedule is created or revised. | API service layer |

---

## BR-BC: Billing Cycle Rules

| ID | Rule | Enforcement |
|----|------|-------------|
| BR-BC-001 | readDayOfMonth and billDayOfMonth must be between 1 and 28 (avoids month-length issues). | Zod validator |
| BR-BC-002 | cycleCode is unique within a utility tenant. | Unique constraint [utilityId, cycleCode] |
| BR-BC-003 | A billing cycle can be deactivated (active → false) but not deleted. | Soft delete via active flag |
| BR-BC-004 | Deactivating a cycle does not affect existing agreements — they retain their cycle assignment. | By design |
| BR-BC-005 | cycleCode cannot be changed after creation. | Zod update schema omits cycleCode |

---

## BR-CO: Commodity Rules

| ID | Rule | Enforcement |
|----|------|-------------|
| BR-CO-001 | Commodities are configurable per tenant — no hardcoded ENUM. | Commodity table, not enum |
| BR-CO-002 | Commodity code is unique within a utility tenant and stored uppercase. | Unique constraint + Zod toUpperCase() |
| BR-CO-003 | A commodity can be deactivated (isActive → false) but not deleted if referenced by meters, agreements, or rate schedules. | API validation |
| BR-CO-004 | Each commodity should have a default unit of measure. | defaultUomId FK |

---

## BR-UO: Unit of Measure Rules

| ID | Rule | Enforcement |
|----|------|-------------|
| BR-UO-001 | A UOM belongs to exactly one commodity. | FK constraint |
| BR-UO-002 | UOM code is unique per commodity per tenant. | Unique constraint [utilityId, commodityId, code] |
| BR-UO-003 | Each commodity must have exactly one base unit (isBaseUnit = true). Setting isBaseUnit=true on a UOM automatically unmarks any existing base unit for that commodity. | API service layer (auto-unmarks existing base unit on POST/PATCH) |
| BR-UO-004 | conversionFactor converts from this unit to the base unit (e.g., 1 CCF = 748.052 GAL). | By design |
| BR-UO-005 | A UOM cannot be deleted if referenced by active meters. | API validation — enforced on DELETE /api/v1/uom/:id |
| BR-UO-006 | A UOM cannot be deleted if it is the default UOM for a commodity (defaultUomId). | API validation — returns UOM_IS_DEFAULT error |

---

## BR-AU: Audit Rules

| ID | Rule | Enforcement |
|----|------|-------------|
| BR-AU-001 | All entity state changes (CREATE, UPDATE, DELETE) are logged with actor, timestamp, before/after state. | Internal event emitter → AuditLog |
| BR-AU-002 | Audit log entries are immutable — they cannot be edited or deleted. | No UPDATE/DELETE endpoints |
| BR-AU-003 | Rate schedule modifications must be logged (regulatory requirement). | Audit log + versioning |
| BR-AU-004 | Manual meter read corrections must retain before/after values. | Phase 2 — MeterRead audit |

---

## BR-TN: Tenant & Security Rules

| ID | Rule | Enforcement |
|----|------|-------------|
| BR-TN-001 | Every entity is scoped by utility_id. Cross-tenant data access is never permitted. | PostgreSQL RLS policies |
| BR-TN-002 | JWT signatures are verified using NEXTAUTH_SECRET. Forged tokens are rejected. | jose JWT verification |
| BR-TN-003 | utility_id must be a valid UUID format before SQL execution. | UUID regex validation |
| BR-TN-004 | All GET-by-ID queries include utility_id in WHERE clause (defense in depth). | API service layer |
| BR-TN-005 | Race conditions on data integrity checks are prevented via $transaction. | Prisma interactive transactions |

---

## BR-GN: General Rules

| ID | Rule | Enforcement |
|----|------|-------------|
| BR-GN-001 | No hard deletes on any entity except Contact. All other entities use soft delete (status change). | By design |
| BR-GN-002 | Financial and regulatory records (rate schedules, billing records) are immutable once created. | No UPDATE endpoints |
| BR-GN-003 | All timestamps use TIMESTAMPTZ (timezone-aware). | Prisma schema |
| BR-GN-004 | Pagination limit is capped at 500 per request. | Zod validators |
| BR-GN-005 | Effective dating is used for time-sensitive records (rate schedules, service agreements, meter assignments). | effectiveDate / expirationDate or startDate / endDate |

---

## BR-RB: RBAC Rules

| ID | Rule | Enforcement |
|----|------|-------------|
| BR-RB-001 | Every user must have exactly one role. | FK constraint |
| BR-RB-002 | System roles (is_system=true) cannot be deleted. | API validation |
| BR-RB-003 | A role cannot be deleted if users are assigned to it. | API validation |
| BR-RB-004 | CREATE, EDIT, DELETE implicitly require VIEW. | UI auto-check + API validation |
| BR-RB-005 | Tenant modules are managed by SaaSLogic, not by CIS admin UI. | No UI for TenantModule |
| BR-RB-006 | User role and tenant modules are cached in Redis (5min/10min TTL). | Cache + invalidation |
| BR-RB-007 | Routes without module declaration are allowed but logged in dev. | Middleware behavior |
| BR-RB-008 | The last System Admin cannot have their role changed. | API validation |
| BR-RB-009 | Deactivated users (is_active=false) are rejected at auth middleware. | Auth check |
