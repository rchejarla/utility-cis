import { EVENT_TYPES, RATE_ASSIGNMENT_ROLE_CODES } from "@utility-cis/shared";
import { writeAuditRow } from "../../lib/audit-wrap.js";
import { generateNumber } from "../../lib/number-generator.js";
import { prisma } from "../../lib/prisma.js";
import { registerImportKind } from "../registry.js";
import type { ImportKindHandler } from "../types.js";

/**
 * Service-agreement import kind handler. The one module 22 handler
 * spec 28 names as a prerequisite (OVL-IN-4): an overlay tenant's
 * agreements, with the rate code the legacy CIS billed them under,
 * arrive this way each cycle.
 *
 * Per-row pipeline (within the framework-supplied tx):
 *   1. Resolve account by number, commodity by code, premise by
 *      composite (addressLine1, zip), and — when the column is filled —
 *      meter by number and rate schedule by code. Each miss has its own
 *      error code, because an operator fixing a file needs to know
 *      which column was wrong.
 *   2. Refuse a meter already installed on a live agreement for the
 *      same commodity.
 *   3. Insert the agreement, its service point, the meter install and
 *      the rate assignment.
 *   4. Emit the audit row.
 *
 * **This is the first handler that writes more than one row per source
 * row.** An agreement without a service point is not an agreement
 * anyone can bill: the point is what places it at a premise and holds
 * the meter. All four writes share the framework's per-row
 * transaction, so a row that fails at step 3 leaves nothing behind —
 * which the test pins, because a half-built agreement would be worse
 * than a rejected one.
 *
 * Step 2 is rule 1 of `createServiceAgreement`, restated here rather
 * than called: the service creates one agreement from a validated API
 * payload and returns a fully-included row, neither of which fits a
 * per-row import loop. What must not differ is the *rule* — an import
 * that let a meter serve two live agreements would be a way around a
 * constraint the API enforces, and the meter would then feed two bills.
 *
 * Idempotency: the unique (utility_id, agreement_number) constraint
 * makes a re-sent file report DUPLICATE_AGREEMENT per row rather than
 * overwriting. That is the right default for a migration and the wrong
 * one for spec 28's cycle-by-cycle mirror, which needs upsert-by-legacy-
 * key (OVL-IN-5) — a schema change on the mirrored entities, not a
 * handler change, and deliberately not smuggled in here.
 */

const SA_STATUSES = ["PENDING", "ACTIVE", "FINAL", "CLOSED"] as const;
type SaStatus = (typeof SA_STATUSES)[number];

interface ServiceAgreementRow {
  /** Blank is allowed: a number is generated from the tenant template. */
  agreementNumber?: string;
  accountNumber: string;
  commodityCode: string;
  premiseAddress: string;
  premiseZip: string;
  startDate: Date;
  endDate?: Date;
  status: SaStatus;
  readSequence?: number;
  meterNumber?: string;
  rateScheduleCode?: string;
  rateRoleCode: string;
}

interface BatchData {
  /** Upper-cased account number → account id. */
  accountByNumber: Map<string, string>;
  /** Upper-cased commodity code → commodity id. */
  commodityByCode: Map<string, string>;
  /** "addr1|zip" (lower-cased addr) → premise id, or the AMBIGUOUS
   *  sentinel when that address and zip matched more than one premise. */
  premiseByAddressZip: Map<string, string>;
  /** Upper-cased meter number → meter id. */
  meterByNumber: Map<string, string>;
  /**
   * Upper-cased rate schedule code → the id of its current version:
   * highest `version` among those that are published and not
   * superseded. A code with no such version is absent here even when
   * rows for it exist, which is what separates the two errors below.
   */
  scheduleByCode: Map<string, string>;
  /** Upper-cased codes that exist in any state, published or not. */
  knownScheduleCodes: Set<string>;
}

const AMBIGUOUS = "__ambiguous__";

function premiseKey(addr1: string, zip: string): string {
  return `${addr1.toLowerCase().trim()}|${zip.trim()}`;
}

/** A CSV date column, as a UTC date with no time-of-day. */
function parseDateOnly(raw: string): Date | null {
  const v = raw.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return null;
  const d = new Date(`${v}T00:00:00.000Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

const handler: ImportKindHandler<ServiceAgreementRow, BatchData> = {
  kind: "service_agreement",
  label: "Service agreements",
  module: "agreements",
  permission: "CREATE",
  wizardPath: "/service-agreements/import",

  canonicalFields: [
    {
      name: "agreementNumber",
      label: "Agreement number",
      required: false,
      description:
        "The legacy system's agreement or service number. Left blank, one is generated from the tenant's numbering template.",
      example: "SA-1001",
      aliases: ["^agreementnumber$", "^agreementid$", "^servicenumber$", "^sanum(ber)?$"],
    },
    {
      name: "accountNumber",
      label: "Account number",
      required: true,
      description: "Resolves to an existing account. Unmatched → row error.",
      example: "ACC-1001",
      aliases: ["^accountnumber$", "^accountid$", "^acctnum$", "^acctid$"],
    },
    {
      name: "commodityCode",
      label: "Commodity code",
      required: true,
      description: "Commodity the agreement is for, by code.",
      example: "WATER",
      aliases: ["^commoditycode$", "^commodity$", "^service(type)?$", "^utilitytype$"],
    },
    {
      name: "premiseAddress",
      label: "Premise address line 1",
      required: true,
      description:
        "With the zip, identifies the premise the service point sits at. Two premises at the same address and zip → row error, not a guess.",
      example: "742 Evergreen Terrace",
      aliases: ["^premiseaddress$", "^address(line)?1?$", "^serviceaddress$"],
    },
    {
      name: "premiseZip",
      label: "Premise ZIP",
      required: true,
      example: "62704",
      aliases: ["^premisezip$", "^zip(code)?$", "^postal(code)?$"],
    },
    {
      name: "startDate",
      label: "Start date",
      required: true,
      description: "YYYY-MM-DD. The date service began under this agreement.",
      example: "2026-01-01",
      aliases: ["^startdate$", "^servicestart(date)?$", "^effectivedate$", "^begindate$"],
    },
    {
      name: "endDate",
      label: "End date",
      required: false,
      description: "YYYY-MM-DD. Left blank for a live agreement.",
      example: "2026-12-31",
      aliases: ["^enddate$", "^serviceend(date)?$", "^stopdate$"],
    },
    {
      name: "status",
      label: "Status",
      required: false,
      description: "PENDING (default), ACTIVE, FINAL, or CLOSED.",
      example: "ACTIVE",
      aliases: ["^status$", "^state$"],
    },
    {
      name: "readSequence",
      label: "Read sequence",
      required: false,
      description: "The meter reader's route order, if the legacy system carries one.",
      example: "140",
      aliases: ["^readsequence$", "^readseq$", "^routesequence$", "^sequence$"],
    },
    {
      name: "meterNumber",
      label: "Meter number",
      required: false,
      description:
        "Installs this meter on the new service point. A meter already serving a live agreement for the same commodity → row error.",
      example: "WM-1001",
      aliases: ["^meternumber$", "^meterid$", "^meterno$", "^badgenumber$"],
    },
    {
      name: "rateScheduleCode",
      label: "Rate schedule code",
      required: false,
      description:
        "Assigns the agreement to this rate schedule. The latest version of the code is used.",
      example: "RES-WATER",
      aliases: ["^rateschedulecode$", "^ratecode$", "^rate$", "^tariff(code)?$"],
    },
    {
      name: "rateRoleCode",
      label: "Rate role",
      required: false,
      description: `Role the schedule is assigned in: ${RATE_ASSIGNMENT_ROLE_CODES.join(", ")}. Defaults to primary.`,
      example: "primary",
      aliases: ["^raterolecode$", "^rolecode$", "^role$"],
    },
  ],

  templateRows: [
    {
      agreementNumber: "SA-1001",
      accountNumber: "ACC-1001",
      commodityCode: "WATER",
      premiseAddress: "742 Evergreen Terrace",
      premiseZip: "62704",
      startDate: "2026-01-01",
      endDate: "",
      status: "ACTIVE",
      readSequence: "140",
      meterNumber: "WM-1001",
      rateScheduleCode: "RES-WATER",
      rateRoleCode: "primary",
    },
  ],

  parseRow: (raw) => {
    const accountNumber = (raw.accountNumber ?? "").trim();
    if (!accountNumber) {
      return {
        ok: false,
        code: "MISSING_ACCOUNT_NUMBER",
        message: "account_number is required",
      };
    }

    const commodityCode = (raw.commodityCode ?? "").trim();
    if (!commodityCode) {
      return {
        ok: false,
        code: "MISSING_COMMODITY_CODE",
        message: "commodity_code is required",
      };
    }

    const premiseAddress = (raw.premiseAddress ?? "").trim();
    if (!premiseAddress) {
      return {
        ok: false,
        code: "MISSING_PREMISE_ADDRESS",
        message: "premise_address is required — the service point has to sit somewhere",
      };
    }

    const premiseZip = (raw.premiseZip ?? "").trim();
    if (!premiseZip) {
      return { ok: false, code: "MISSING_PREMISE_ZIP", message: "premise_zip is required" };
    }

    const startDate = parseDateOnly(raw.startDate ?? "");
    if (!startDate) {
      return {
        ok: false,
        code: "INVALID_START_DATE",
        message: `start_date "${raw.startDate ?? ""}" must be a date in YYYY-MM-DD form`,
      };
    }

    let endDate: Date | undefined;
    if ((raw.endDate ?? "").trim()) {
      const parsed = parseDateOnly(raw.endDate ?? "");
      if (!parsed) {
        return {
          ok: false,
          code: "INVALID_END_DATE",
          message: `end_date "${raw.endDate}" must be a date in YYYY-MM-DD form`,
        };
      }
      if (parsed < startDate) {
        return {
          ok: false,
          code: "END_BEFORE_START",
          message: `end_date "${raw.endDate}" is before start_date "${raw.startDate}"`,
        };
      }
      endDate = parsed;
    }

    const stRaw = (raw.status ?? "").trim().toUpperCase();
    let status: SaStatus = "PENDING";
    if (stRaw) {
      if (!SA_STATUSES.includes(stRaw as SaStatus)) {
        return {
          ok: false,
          code: "INVALID_STATUS",
          message: `status "${raw.status}" must be one of ${SA_STATUSES.join(", ")}`,
        };
      }
      status = stRaw as SaStatus;
    }

    let readSequence: number | undefined;
    if ((raw.readSequence ?? "").trim()) {
      const n = Number(raw.readSequence);
      if (!Number.isInteger(n) || n < 0) {
        return {
          ok: false,
          code: "INVALID_READ_SEQUENCE",
          message: `read_sequence "${raw.readSequence}" must be a non-negative whole number`,
        };
      }
      readSequence = n;
    }

    const roleRaw = ((raw.rateRoleCode ?? "").trim() || "primary").toLowerCase();
    if (!(RATE_ASSIGNMENT_ROLE_CODES as readonly string[]).includes(roleRaw)) {
      return {
        ok: false,
        code: "INVALID_ROLE_CODE",
        message: `rate_role_code "${raw.rateRoleCode}" must be one of ${RATE_ASSIGNMENT_ROLE_CODES.join(", ")}`,
      };
    }

    return {
      ok: true,
      row: {
        agreementNumber: ((raw.agreementNumber ?? "").trim()) || undefined,
        accountNumber,
        commodityCode,
        premiseAddress,
        premiseZip,
        startDate,
        endDate,
        status,
        readSequence,
        meterNumber: ((raw.meterNumber ?? "").trim()) || undefined,
        rateScheduleCode: ((raw.rateScheduleCode ?? "").trim()) || undefined,
        rateRoleCode: roleRaw,
      },
    };
  },

  async prepareBatch(ctx, rows) {
    // Five lookups, one query each, so per-row dispatch stays O(1).
    const accountNumbers = new Set(rows.map((r) => r.accountNumber));
    const accountByNumber = new Map<string, string>();
    if (accountNumbers.size > 0) {
      const accounts = await prisma.account.findMany({
        where: { utilityId: ctx.utilityId, accountNumber: { in: [...accountNumbers] } },
        select: { id: true, accountNumber: true },
      });
      for (const a of accounts) accountByNumber.set(a.accountNumber.toUpperCase(), a.id);
    }

    // Commodity cardinality is low (~10 per tenant), so fetch them all
    // and match case-insensitively — same rationale as premise.ts.
    const commodityByCode = new Map<string, string>();
    const commodities = await prisma.commodity.findMany({
      where: { utilityId: ctx.utilityId },
      select: { id: true, code: true },
    });
    for (const c of commodities) commodityByCode.set(c.code.toUpperCase(), c.id);

    // Premise by composite key. Postgres has no composite IN through
    // Prisma, so fetch by the zips the batch names and bucket here.
    const premiseByAddressZip = new Map<string, string>();
    const zips = new Set(rows.map((r) => r.premiseZip.trim()));
    if (zips.size > 0) {
      const candidates = await prisma.premise.findMany({
        where: { utilityId: ctx.utilityId, zip: { in: [...zips] } },
        select: { id: true, addressLine1: true, zip: true },
      });
      const counts = new Map<string, number>();
      for (const p of candidates) {
        const k = premiseKey(p.addressLine1, p.zip);
        counts.set(k, (counts.get(k) ?? 0) + 1);
        premiseByAddressZip.set(k, p.id);
      }
      for (const [k, n] of counts) {
        if (n > 1) premiseByAddressZip.set(k, AMBIGUOUS);
      }
    }

    const meterNumbers = new Set(
      rows.map((r) => r.meterNumber).filter((m): m is string => Boolean(m)),
    );
    const meterByNumber = new Map<string, string>();
    if (meterNumbers.size > 0) {
      const meters = await prisma.meter.findMany({
        where: { utilityId: ctx.utilityId, meterNumber: { in: [...meterNumbers] } },
        select: { id: true, meterNumber: true },
      });
      for (const m of meters) meterByNumber.set(m.meterNumber.toUpperCase(), m.id);
    }

    const scheduleCodes = new Set(
      rows.map((r) => r.rateScheduleCode).filter((c): c is string => Boolean(c)),
    );
    const scheduleByCode = new Map<string, string>();
    const knownScheduleCodes = new Set<string>();
    if (scheduleCodes.size > 0) {
      /*
       * A rate code names a tariff, not a row: `(utility_id, code,
       * version)` is the unique key, so one code has as many versions as
       * it has had revisions. Which one may bill is the codebase's own
       * three-way reading of two columns — draft is `published_at IS
       * NULL AND superseded_by_id IS NULL`, published is `published_at
       * IS NOT NULL AND superseded_by_id IS NULL`, superseded is
       * `superseded_by_id IS NOT NULL` (`rate-schedule.service.ts`'s
       * status filter). Only the middle one is billable, and
       * `bill-segment.service` refuses an unpublished schedule outright.
       *
       * So the whole set is fetched and filtered here rather than taking
       * the highest version, which would land on a draft revision every
       * time a tariff is mid-revision: `reviseRateSchedule` supersedes
       * the predecessor the moment the revision is created and leaves
       * the revision unpublished, so in that window the newest version
       * is precisely the one that cannot bill.
       *
       * Ascending version, so the last write per code is the highest of
       * the billable ones.
       */
      const schedules = await prisma.rateSchedule.findMany({
        where: { utilityId: ctx.utilityId, code: { in: [...scheduleCodes] } },
        orderBy: { version: "asc" },
        select: { id: true, code: true, publishedAt: true, supersededById: true },
      });
      for (const s of schedules) {
        const code = s.code.toUpperCase();
        knownScheduleCodes.add(code);
        if (s.publishedAt !== null && s.supersededById === null) {
          scheduleByCode.set(code, s.id);
        }
      }
    }

    return {
      accountByNumber,
      commodityByCode,
      premiseByAddressZip,
      meterByNumber,
      scheduleByCode,
      knownScheduleCodes,
    };
  },

  async processRow(ctx, row, batch) {
    const accountId = batch.accountByNumber.get(row.accountNumber.toUpperCase());
    if (!accountId) {
      return {
        ok: false,
        code: "ACCOUNT_NOT_FOUND",
        message: `No account with number "${row.accountNumber}"`,
      };
    }

    const commodityId = batch.commodityByCode.get(row.commodityCode.toUpperCase());
    if (!commodityId) {
      return {
        ok: false,
        code: "COMMODITY_NOT_FOUND",
        message: `No commodity with code "${row.commodityCode}"`,
      };
    }

    const premiseId = batch.premiseByAddressZip.get(
      premiseKey(row.premiseAddress, row.premiseZip),
    );
    if (!premiseId) {
      return {
        ok: false,
        code: "PREMISE_NOT_FOUND",
        message: `No premise at "${row.premiseAddress}" with ZIP "${row.premiseZip}"`,
      };
    }
    if (premiseId === AMBIGUOUS) {
      return {
        ok: false,
        code: "PREMISE_AMBIGUOUS",
        message: `More than one premise at "${row.premiseAddress}" with ZIP "${row.premiseZip}" — resolve the duplicate before importing`,
      };
    }

    let meterId: string | undefined;
    if (row.meterNumber) {
      const id = batch.meterByNumber.get(row.meterNumber.toUpperCase());
      if (!id) {
        return {
          ok: false,
          code: "METER_NOT_FOUND",
          message: `No meter with number "${row.meterNumber}"`,
        };
      }
      meterId = id;
    }

    let rateScheduleId: string | undefined;
    if (row.rateScheduleCode) {
      const code = row.rateScheduleCode.toUpperCase();
      const id = batch.scheduleByCode.get(code);
      if (!id) {
        // Two different problems, and conflating them would send the
        // operator to the wrong place: an unknown code means fix the
        // file, a code with no billable version means publish the
        // tariff.
        if (batch.knownScheduleCodes.has(code)) {
          return {
            ok: false,
            code: "RATE_SCHEDULE_NOT_PUBLISHED",
            message: `Rate schedule "${row.rateScheduleCode}" exists but has no published, current version — publish it before importing agreements onto it`,
          };
        }
        return {
          ok: false,
          code: "RATE_SCHEDULE_NOT_FOUND",
          message: `No rate schedule with code "${row.rateScheduleCode}"`,
        };
      }
      rateScheduleId = id;
    }

    // Rule 1 of `createServiceAgreement`: one meter serves one live
    // agreement per commodity. Checked inside the row's tx, so two rows
    // of the same file naming one meter cannot both pass.
    if (meterId) {
      const installed = await ctx.tx.servicePointMeter.findFirst({
        where: {
          meterId,
          removedDate: null,
          servicePoint: {
            serviceAgreement: {
              commodityId,
              status: { in: ["PENDING", "ACTIVE"] },
            },
          },
        },
        select: { id: true },
      });
      if (installed) {
        return {
          ok: false,
          code: "METER_ALREADY_ASSIGNED",
          message: `Meter "${row.meterNumber}" already serves a live agreement for this commodity`,
        };
      }
    }

    try {
      const agreementNumber =
        row.agreementNumber ??
        (await generateNumber({
          utilityId: ctx.utilityId,
          entity: "agreement",
          defaultTemplate: "SA-{seq:4}",
          tableName: "service_agreement",
          columnName: "agreement_number",
          db: ctx.tx,
        }));

      const created = await ctx.tx.serviceAgreement.create({
        data: {
          utilityId: ctx.utilityId,
          agreementNumber,
          accountId,
          commodityId,
          startDate: row.startDate,
          endDate: row.endDate ?? null,
          status: row.status,
          readSequence: row.readSequence,
        },
      });

      // The service point is what places the agreement at a premise.
      // Its status mirrors the agreement's, as `createServiceAgreement`
      // does: everything that is not still pending is serving.
      const servicePoint = await ctx.tx.servicePoint.create({
        data: {
          utilityId: ctx.utilityId,
          serviceAgreementId: created.id,
          premiseId,
          type: "METERED",
          status: row.status === "PENDING" ? "PENDING" : "ACTIVE",
          startDate: row.startDate,
          endDate: row.endDate ?? null,
        },
      });

      if (meterId) {
        await ctx.tx.servicePointMeter.create({
          data: {
            utilityId: ctx.utilityId,
            servicePointId: servicePoint.id,
            meterId,
            addedDate: row.startDate,
          },
        });
      }

      if (rateScheduleId) {
        await ctx.tx.sAScheduleAssignment.create({
          data: {
            utilityId: ctx.utilityId,
            serviceAgreementId: created.id,
            rateScheduleId,
            roleCode: row.rateRoleCode,
            effectiveDate: row.startDate,
            expirationDate: row.endDate ?? null,
          },
        });
      }

      await writeAuditRow(
        ctx.tx,
        {
          utilityId: ctx.utilityId,
          actorId: ctx.actorId,
          actorName: ctx.actorName,
          entityType: "ServiceAgreement",
        },
        EVENT_TYPES.SERVICE_AGREEMENT_CREATED,
        created.id,
        null,
        created,
      );

      return { ok: true, entityId: created.id };
    } catch (err: unknown) {
      if (
        err &&
        typeof err === "object" &&
        "code" in err &&
        (err as { code?: string }).code === "P2002"
      ) {
        return {
          ok: false,
          code: "DUPLICATE_AGREEMENT",
          message: `agreement_number "${row.agreementNumber ?? ""}" already exists`,
        };
      }
      throw err;
    }
  },
};

registerImportKind(handler);
