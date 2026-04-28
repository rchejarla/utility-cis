import { randomUUID } from "node:crypto";
import { prisma } from "../lib/prisma.js";
import { EVENT_TYPES } from "@utility-cis/shared";
import type {
  CreateMeterReadInput,
  CreateMeterReadEventInput,
  CorrectMeterReadInput,
  MeterReadQuery,
  ResolveExceptionInput,
  ImportMeterReadsInput,
} from "@utility-cis/shared";
import { paginatedTenantList } from "../lib/pagination.js";
import { auditCreate, auditUpdate, writeAuditRow } from "../lib/audit-wrap.js";

/**
 * Meter-read business logic. The service layer owns the rules the spec
 * documents in section 118: consumption calculation, rollover detection,
 * freeze-after-billing enforcement, and the correction chain that
 * preserves the original read via `correctsReadId`.
 *
 * MeterRead uses a composite PK (id, readDatetime) because TimescaleDB
 * hypertables require the partition column in every unique constraint.
 * Services cannot call `findUnique({ where: { id } })` — they must use
 * `findFirst({ where: { id, utilityId } })` instead. Tenant scope is
 * enforced in every lookup, matching the pattern used elsewhere in the
 * codebase.
 */

const fullInclude = {
  meter: {
    select: {
      id: true,
      meterNumber: true,
      multiplier: true,
      commodityId: true,
      dialCount: true,
    },
  },
  serviceAgreement: {
    select: {
      id: true,
      agreementNumber: true,
      accountId: true,
      premiseId: true,
    },
  },
  register: true,
} as const;

export async function listMeterReads(utilityId: string, query: MeterReadQuery) {
  const where: Record<string, unknown> = { utilityId };

  if (query.meterId) where.meterId = query.meterId;
  if (query.serviceAgreementId) where.serviceAgreementId = query.serviceAgreementId;
  if (query.readEventId) where.readEventId = query.readEventId;
  if (query.readType) where.readType = query.readType;
  if (query.readSource) where.readSource = query.readSource;
  if (query.exceptionCode) where.exceptionCode = query.exceptionCode;
  if (query.hasException === true) where.exceptionCode = { not: null };
  if (query.hasException === false) where.exceptionCode = null;
  if (query.isFrozen !== undefined) where.isFrozen = query.isFrozen;
  if (query.fromDate || query.toDate) {
    const range: Record<string, Date> = {};
    if (query.fromDate) range.gte = new Date(query.fromDate);
    if (query.toDate) range.lte = new Date(query.toDate);
    where.readDate = range;
  }

  return paginatedTenantList(prisma.meterRead, where, query, { include: fullInclude });
}

export async function getMeterRead(id: string, utilityId: string) {
  const read = await prisma.meterRead.findFirst({
    where: { id, utilityId },
    include: {
      ...fullInclude,
      serviceAgreement: {
        include: {
          account: { select: { id: true, accountNumber: true } },
          premise: {
            select: {
              id: true,
              addressLine1: true,
              city: true,
              state: true,
              zip: true,
            },
          },
          commodity: { select: { id: true, name: true } },
        },
      },
    },
  });
  if (!read) {
    throw Object.assign(new Error("Meter read not found"), { statusCode: 404 });
  }
  return read;
}

export async function readsForMeter(
  utilityId: string,
  meterId: string,
  options: { limit?: number; group?: "event" | "flat" } = {},
) {
  const limit = options.limit ?? 100;
  const rows = await prisma.meterRead.findMany({
    where: { utilityId, meterId },
    orderBy: { readDatetime: "desc" },
    take: limit,
    include: fullInclude,
  });

  if (options.group !== "event") return rows;

  // Group sibling reads by readEventId. Rows with a null readEventId
  // (legacy single-register reads) remain individual entries so the
  // consumer sees a uniform "one event = one group" shape regardless
  // of whether the underlying meter is multi-register.
  const eventBuckets = new Map<string, typeof rows>();
  const singletons: typeof rows = [];
  for (const r of rows) {
    if (!r.readEventId) {
      singletons.push(r);
      continue;
    }
    const bucket = eventBuckets.get(r.readEventId);
    if (bucket) bucket.push(r);
    else eventBuckets.set(r.readEventId, [r]);
  }
  const events = [
    ...Array.from(eventBuckets.entries()).map(([readEventId, siblings]) => ({
      readEventId,
      readDatetime: siblings[0].readDatetime,
      readDate: siblings[0].readDate,
      readType: siblings[0].readType,
      readSource: siblings[0].readSource,
      readings: siblings,
    })),
    ...singletons.map((r) => ({
      readEventId: null,
      readDatetime: r.readDatetime,
      readDate: r.readDate,
      readType: r.readType,
      readSource: r.readSource,
      readings: [r],
    })),
  ];
  events.sort((a, b) => b.readDatetime.getTime() - a.readDatetime.getTime());
  return events;
}

export async function listExceptions(
  utilityId: string,
  query: MeterReadQuery,
) {
  return listMeterReads(utilityId, {
    ...query,
    hasException: true,
    isFrozen: false,
  });
}

/**
 * Compute consumption for a new read. Looks up the most recent prior
 * read on the same meter+register to determine `priorReading`, then
 * applies the meter's multiplier. Detects rollover (reading < prior) and
 * reverse flow (negative consumption after rollover handling).
 */
async function computeConsumption(
  utilityId: string,
  meterId: string,
  registerId: string | null | undefined,
  reading: number,
  readDatetime: Date,
): Promise<{
  priorReading: number;
  consumption: number;
  exceptionCode: string | null;
}> {
  const meter = await prisma.meter.findFirst({
    where: { id: meterId, utilityId },
    select: { multiplier: true, dialCount: true },
  });
  if (!meter) {
    throw Object.assign(new Error("Meter not found"), { statusCode: 404 });
  }

  const prior = await prisma.meterRead.findFirst({
    where: {
      utilityId,
      meterId,
      registerId: registerId ?? null,
      readDatetime: { lt: readDatetime },
    },
    orderBy: { readDatetime: "desc" },
    select: { reading: true },
  });

  const multiplier = Number(meter.multiplier);
  const priorReading = prior ? Number(prior.reading) : 0;
  let raw = reading - priorReading;
  let exceptionCode: string | null = null;

  if (raw < 0) {
    if (meter.dialCount && meter.dialCount > 0) {
      const rolloverMax = Math.pow(10, meter.dialCount);
      const rolloverCandidate = rolloverMax - priorReading + reading;
      if (rolloverCandidate >= 0 && rolloverCandidate < rolloverMax / 2) {
        raw = rolloverCandidate;
        exceptionCode = "ROLLOVER";
      } else {
        exceptionCode = "METER_DEFECT";
        raw = 0;
      }
    } else {
      exceptionCode = "REVERSE_FLOW";
      raw = Math.abs(raw);
    }
  }

  return {
    priorReading,
    consumption: raw * multiplier,
    exceptionCode,
  };
}

/**
 * Resolve which service agreement a read belongs to by looking up the
 * active ServiceAgreementMeter row for the meter on the given date.
 * A meter should have at most one active assignment at any moment
 * (`removed_date IS NULL OR removed_date >= readDate`, and
 * `added_date <= readDate`). If none exists, the read can't be
 * recorded — meter reads require an owning agreement for billing.
 */
async function resolveServiceAgreementId(
  utilityId: string,
  meterId: string,
  readDate: Date,
): Promise<string> {
  const assignment = await prisma.serviceAgreementMeter.findFirst({
    where: {
      utilityId,
      meterId,
      addedDate: { lte: readDate },
      OR: [{ removedDate: null }, { removedDate: { gte: readDate } }],
    },
    orderBy: { addedDate: "desc" },
    select: { serviceAgreementId: true },
  });
  if (!assignment) {
    throw Object.assign(
      new Error(
        "Meter is not assigned to any active service agreement at the given read date. Assign the meter to an agreement before recording a read.",
      ),
      { statusCode: 400, code: "METER_NOT_ASSIGNED" },
    );
  }
  return assignment.serviceAgreementId;
}

export async function createMeterRead(
  utilityId: string,
  actorId: string,
  actorName: string,
  data: CreateMeterReadInput,
) {
  const readDatetime = new Date(data.readDatetime);
  const readDate = new Date(data.readDate);

  // Guard: if the meter has 2+ active registers, the single-reading
  // payload silently drops every register past the first. Reject with
  // a clear hint so callers adopt the multi-register payload shape.
  const activeRegisters = await prisma.meterRegister.findMany({
    where: { utilityId, meterId: data.meterId, isActive: true },
    select: { id: true, registerNumber: true },
  });
  if (activeRegisters.length >= 2 && !data.registerId) {
    throw Object.assign(
      new Error(
        "Meter has multiple active registers. Send a multi-register payload with `readings[]` (and optional `skips[]`) covering every active register.",
      ),
      { statusCode: 400, code: "REGISTERS_INCOMPLETE" },
    );
  }

  // Resolve the owning agreement from the junction table if the caller
  // didn't supply one explicitly. Supplied values still win so bulk
  // imports with authoritative agreement data don't incur an extra lookup.
  const serviceAgreementId =
    data.serviceAgreementId ??
    (await resolveServiceAgreementId(utilityId, data.meterId, readDate));

  const [{ priorReading, consumption, exceptionCode: autoException }, meter] =
    await Promise.all([
      computeConsumption(
        utilityId,
        data.meterId,
        data.registerId ?? null,
        data.reading,
        readDatetime,
      ),
      prisma.meter.findUniqueOrThrow({
        where: { id: data.meterId },
        select: { uomId: true },
      }),
    ]);

  // When the caller targets a specific register on a multi-register
  // meter, prefer that register's uomId (which may differ from the
  // meter's default uomId — e.g., kW demand vs. kWh usage).
  let uomId = meter.uomId;
  if (data.registerId) {
    const reg = await prisma.meterRegister.findFirst({
      where: { id: data.registerId, utilityId, meterId: data.meterId },
      select: { uomId: true },
    });
    if (!reg) {
      throw Object.assign(
        new Error("Register not found for this meter"),
        { statusCode: 400, code: "REGISTER_NOT_FOUND" },
      );
    }
    uomId = reg.uomId;
  }

  return auditCreate(
    { utilityId, actorId, actorName, entityType: "MeterRead" },
    EVENT_TYPES.METER_CREATED,
    (tx) =>
      tx.meterRead.create({
        data: {
          utilityId,
          meterId: data.meterId,
          serviceAgreementId,
          registerId: data.registerId ?? null,
          uomId,
          readDate,
          readDatetime,
          reading: data.reading,
          priorReading,
          consumption,
          readType: data.readType ?? "ACTUAL",
          readSource: data.readSource ?? "MANUAL",
          exceptionCode: data.exceptionCode ?? autoException,
          exceptionNotes: data.exceptionNotes ?? null,
          readerId: actorId,
        },
        include: fullInclude,
      }),
  );
}

/**
 * Multi-register read event. A field visit on a meter with N active
 * registers produces N `MeterRead` rows (one per register) sharing a
 * generated `readEventId`, one `readDatetime`, one reader, and one
 * serviceAgreementId. Registers the operator explicitly skips (broken,
 * inaccessible, out of service) get a `MeterEvent` row instead of a
 * `MeterRead`. All writes happen in one transaction; partial success is
 * not allowed.
 *
 * Validation rule: the union of `readings[].registerId` and
 * `skips[].registerId` must cover EVERY active register on the meter.
 * Missing any register errors with REGISTERS_INCOMPLETE so billing can
 * never run against a half-read event.
 */
export async function createMeterReadEvent(
  utilityId: string,
  actorId: string,
  actorName: string,
  data: CreateMeterReadEventInput,
) {
  const readDatetime = new Date(data.readDatetime);
  const readDate = new Date(data.readDate);

  const activeRegisters = await prisma.meterRegister.findMany({
    where: { utilityId, meterId: data.meterId, isActive: true },
    select: { id: true, registerNumber: true, uomId: true },
  });
  if (activeRegisters.length === 0) {
    throw Object.assign(
      new Error("Meter has no active registers — use the single-reading payload."),
      { statusCode: 400, code: "NO_ACTIVE_REGISTERS" },
    );
  }

  const providedIds = new Set([
    ...data.readings.map((r) => r.registerId),
    ...data.skips.map((s) => s.registerId),
  ]);
  const activeIds = new Set(activeRegisters.map((r) => r.id));
  const missing = activeRegisters.filter((r) => !providedIds.has(r.id));
  if (missing.length > 0) {
    throw Object.assign(
      new Error(
        `Readings or skips are missing for register number(s): ${missing.map((r) => r.registerNumber).join(", ")}. Every active register must be either read or explicitly skipped.`,
      ),
      {
        statusCode: 400,
        code: "REGISTERS_INCOMPLETE",
        missingRegisterIds: missing.map((r) => r.id),
      },
    );
  }
  for (const id of providedIds) {
    if (!activeIds.has(id)) {
      throw Object.assign(
        new Error("One or more provided registerIds don't belong to this meter or aren't active."),
        { statusCode: 400, code: "REGISTER_NOT_FOUND" },
      );
    }
  }

  const serviceAgreementId =
    data.serviceAgreementId ??
    (await resolveServiceAgreementId(utilityId, data.meterId, readDate));

  const readEventId = randomUUID();

  // Compute consumption per register BEFORE opening the write transaction
  // so the transaction body only touches the write path.
  const regByIdMap = new Map(activeRegisters.map((r) => [r.id, r]));
  const perReading = await Promise.all(
    data.readings.map(async (r) => {
      const reg = regByIdMap.get(r.registerId)!;
      const calc = await computeConsumption(
        utilityId,
        data.meterId,
        r.registerId,
        r.reading,
        readDatetime,
      );
      return {
        input: r,
        register: reg,
        priorReading: calc.priorReading,
        consumption: calc.consumption,
        exceptionCode: calc.exceptionCode,
      };
    }),
  );

  const created = await prisma.$transaction(async (tx) => {
    const rows = await Promise.all(
      perReading.map((p) =>
        tx.meterRead.create({
          data: {
            utilityId,
            meterId: data.meterId,
            serviceAgreementId,
            registerId: p.register.id,
            readEventId,
            uomId: p.register.uomId,
            readDate,
            readDatetime,
            reading: p.input.reading,
            priorReading: p.priorReading,
            consumption: p.consumption,
            readType: data.readType ?? "ACTUAL",
            readSource: data.readSource ?? "MANUAL",
            exceptionCode: p.exceptionCode,
            exceptionNotes: p.input.exceptionNotes ?? null,
            readerId: actorId,
          },
          include: fullInclude,
        }),
      ),
    );

    // Skip path: one MeterEvent per skipped register. The enum doesn't
    // have a bespoke "register skipped" type today; OTHER + a descriptive
    // payload keeps the record useful without bloating the enum.
    if (data.skips.length > 0) {
      await Promise.all(
        data.skips.map((s) => {
          const reg = regByIdMap.get(s.registerId)!;
          return tx.meterEvent.create({
            data: {
              utilityId,
              meterId: data.meterId,
              eventType: "OTHER",
              source: "MANUAL",
              eventDatetime: readDatetime,
              description:
                `Register ${reg.registerNumber} skipped during read event ${readEventId}: ${s.skipReason}` +
                (s.notes ? ` — ${s.notes}` : ""),
            },
          });
        }),
      );
    }

    // Emit one audit row per created MeterRead in the same transaction
    // so the rows and their audit entries commit atomically.
    for (const row of rows) {
      await writeAuditRow(
        tx,
        { utilityId, actorId, actorName, entityType: "MeterRead" },
        EVENT_TYPES.METER_CREATED,
        row.id,
        null,
        row,
      );
    }

    return rows;
  });

  return {
    readEventId,
    readDatetime,
    readDate,
    readings: created,
    skippedRegisterIds: data.skips.map((s) => s.registerId),
  };
}

/**
 * Correcting a read never mutates the original — we insert a NEW row
 * with read_type=CORRECTED and corrects_read_id pointing at the source.
 * The spec explicitly requires this for audit integrity (rule 5).
 * Frozen reads (already billed) can still be corrected, but a rebill
 * workflow triggers downstream in Phase 3.
 */
export async function correctMeterRead(
  utilityId: string,
  actorId: string,
  actorName: string,
  originalId: string,
  data: CorrectMeterReadInput,
) {
  const original = await prisma.meterRead.findFirst({
    where: { id: originalId, utilityId },
  });
  if (!original) {
    throw Object.assign(new Error("Meter read not found"), { statusCode: 404 });
  }

  const readDatetime = data.readDatetime
    ? new Date(data.readDatetime)
    : original.readDatetime;
  const readDate = data.readDate
    ? new Date(data.readDate)
    : original.readDate;

  const { priorReading, consumption, exceptionCode: autoException } =
    await computeConsumption(
      utilityId,
      original.meterId,
      original.registerId,
      data.reading,
      readDatetime,
    );

  const meter = await prisma.meter.findUniqueOrThrow({
    where: { id: original.meterId },
    select: { uomId: true },
  });

  const corrected = await prisma.$transaction(async (tx) => {
    const row = await tx.meterRead.create({
      data: {
        utilityId,
        meterId: original.meterId,
        serviceAgreementId: original.serviceAgreementId,
        registerId: original.registerId,
        uomId: meter.uomId,
        readDate,
        readDatetime,
        reading: data.reading,
        priorReading,
        consumption,
        readType: "CORRECTED",
        readSource: original.readSource,
        exceptionCode: autoException,
        exceptionNotes: data.exceptionNotes,
        readerId: actorId,
        correctsReadId: original.id,
      },
      include: fullInclude,
    });
    await writeAuditRow(
      tx,
      { utilityId, actorId, actorName, entityType: "MeterRead" },
      "meter_read.corrected",
      row.id,
      original,
      row,
    );
    return row;
  });

  return corrected;
}

/**
 * Hard-delete a meter read. Guarded:
 *   - Frozen reads (already billed) cannot be deleted. The rebill
 *     workflow in Phase 3 is the correct path for retroactive changes
 *     to billed data.
 *   - Reads that have been corrected by a subsequent CORRECTED row
 *     also cannot be deleted — deleting them would orphan the
 *     correction chain and make the audit trail lie. Delete the
 *     correction first if one exists.
 *
 * Hard-delete (vs soft-delete) is acceptable here because the audit
 * log preserves the before state via the emitted domain event.
 */
export async function deleteMeterRead(
  utilityId: string,
  actorId: string,
  actorName: string,
  id: string,
): Promise<void> {
  const before = await prisma.meterRead.findFirst({
    where: { id, utilityId },
  });
  if (!before) {
    throw Object.assign(new Error("Meter read not found"), { statusCode: 404 });
  }
  if (before.isFrozen) {
    throw Object.assign(
      new Error("Cannot delete a frozen (already billed) read. Use the rebill workflow instead."),
      { statusCode: 400, code: "READ_FROZEN" },
    );
  }
  const correctedBy = await prisma.meterRead.findFirst({
    where: { utilityId, correctsReadId: before.id },
    select: { id: true, readDatetime: true },
  });
  if (correctedBy) {
    throw Object.assign(
      new Error(
        "Cannot delete a read that has been corrected by a subsequent CORRECTED row. Delete the correction first.",
      ),
      { statusCode: 400, code: "READ_HAS_CORRECTION" },
    );
  }

  await prisma.$transaction(async (tx) => {
    await tx.meterRead.deleteMany({
      where: { id, utilityId, readDatetime: before.readDatetime },
    });
    await writeAuditRow(
      tx,
      { utilityId, actorId, actorName, entityType: "MeterRead" },
      "meter_read.updated",
      before.id,
      before,
      null,
    );
  });
}

/**
 * Resolve an exception. Does NOT create a new read; it updates the
 * existing one's exception_notes and clears the exception code unless
 * the resolution requires a correction (in which case the caller should
 * use correctMeterRead instead).
 */
export async function resolveException(
  utilityId: string,
  actorId: string,
  actorName: string,
  id: string,
  data: ResolveExceptionInput,
) {
  const before = await prisma.meterRead.findFirst({
    where: { id, utilityId },
  });
  if (!before) {
    throw Object.assign(new Error("Meter read not found"), { statusCode: 404 });
  }
  if (before.isFrozen) {
    throw Object.assign(
      new Error("Cannot resolve exception on a frozen (already billed) read"),
      { statusCode: 400, code: "READ_FROZEN" },
    );
  }

  const shouldClearCode = data.resolution !== "HOLD_FOR_REREAD";

  return auditUpdate(
    { utilityId, actorId, actorName, entityType: "MeterRead" },
    EVENT_TYPES.METER_UPDATED,
    before,
    async (tx) => {
      await tx.meterRead.updateMany({
        where: { id, utilityId, readDatetime: before.readDatetime },
        data: {
          exceptionCode: shouldClearCode ? null : before.exceptionCode,
          exceptionNotes: data.notes
            ? `[${data.resolution}] ${data.notes}`
            : before.exceptionNotes,
        },
      });
      const r = await tx.meterRead.findFirst({
        where: { id, utilityId },
        include: fullInclude,
      });
      if (!r) throw new Error("Meter read vanished after update");
      return r;
    },
  );
}

/**
 * Bulk import of meter reads. Accepts up to 10k rows in one call (the
 * Zod max on `importMeterReadsSchema`). Each row is processed
 * individually inside its own transaction so a single bad row doesn't
 * abort the whole batch — partial success is the expected mode for
 * AMR/AMI ingest where some meters in the field are routinely
 * unassigned, REMOVED, or have unparseable readings.
 *
 * Pipeline per row:
 *   1. Pre-validate via the bulk meterByNumber map (built once,
 *      reused across rows so we don't issue N round-trips for
 *      meter lookups).
 *   2. Resolve owning service agreement at the read date via the
 *      ServiceAgreementMeter junction. Failure raises METER_NOT_ASSIGNED.
 *   3. Compute prior reading + consumption from prior history.
 *   4. INSERT one MeterRead row tagged with the batch id.
 *   5. Audit row emitted in the same transaction.
 *
 * Rows are sorted by (meterId, readDatetime ASC) so that when a batch
 * contains multiple reads for the same meter, the consumption
 * calculation for row N+1 sees row N's reading as its prior — preserving
 * the chronological invariant `computeConsumption` relies on.
 *
 * The ImportBatch record gives operators a traceable handle for the
 * import: status, counts, error list, source metadata. Reads carry
 * `importBatchId` for downstream filtering ("show me everything from
 * the 2026-04-28 AMI batch").
 */
export async function importMeterReads(
  utilityId: string,
  actorId: string,
  actorName: string,
  data: ImportMeterReadsInput,
): Promise<{
  batchId: string;
  imported: number;
  exceptions: number;
  errors: Array<{ row: number; meterNumber: string; error: string }>;
}> {
  const batch = await prisma.importBatch.create({
    data: {
      utilityId,
      source: data.source,
      fileName: data.fileName ?? null,
      recordCount: data.reads.length,
      status: "PROCESSING",
      createdBy: actorId,
    },
  });

  // Resolve every meter referenced in the payload up-front so we can
  // reject unknown numbers in O(1) per row instead of O(N) DB hits.
  const meterNumbers = [...new Set(data.reads.map((r) => r.meterNumber))];
  const meters = await prisma.meter.findMany({
    where: { utilityId, meterNumber: { in: meterNumbers } },
    select: { id: true, meterNumber: true, status: true, uomId: true },
  });
  const meterByNumber = new Map(meters.map((m) => [m.meterNumber, m]));

  const errors: Array<{ row: number; meterNumber: string; error: string }> = [];
  let imported = 0;
  let exceptions = 0;

  // Stable ordering: same meter, oldest reading first. Rows for
  // different meters interleave in their original order.
  const indexedRows = data.reads.map((row, originalIndex) => ({ row, originalIndex }));
  indexedRows.sort((a, b) => {
    if (a.row.meterNumber !== b.row.meterNumber) {
      return a.row.meterNumber.localeCompare(b.row.meterNumber);
    }
    return a.row.readDatetime.localeCompare(b.row.readDatetime);
  });

  for (const { row, originalIndex } of indexedRows) {
    const rowNum = originalIndex + 1; // 1-indexed for user-facing reporting
    const meter = meterByNumber.get(row.meterNumber);

    if (!meter) {
      errors.push({
        row: rowNum,
        meterNumber: row.meterNumber,
        error: `Meter "${row.meterNumber}" not found`,
      });
      continue;
    }
    if (meter.status === "REMOVED") {
      errors.push({
        row: rowNum,
        meterNumber: row.meterNumber,
        error: `Meter "${row.meterNumber}" is REMOVED — reads cannot be imported against it`,
      });
      continue;
    }

    try {
      const readDatetime = new Date(row.readDatetime);
      const readDate = new Date(readDatetime.toISOString().slice(0, 10));

      const serviceAgreementId = await resolveServiceAgreementId(
        utilityId,
        meter.id,
        readDate,
      );
      const { priorReading, consumption, exceptionCode } = await computeConsumption(
        utilityId,
        meter.id,
        null,
        row.reading,
        readDatetime,
      );

      await auditCreate(
        { utilityId, actorId, actorName, entityType: "MeterRead" },
        EVENT_TYPES.METER_CREATED,
        (tx) =>
          tx.meterRead.create({
            data: {
              utilityId,
              meterId: meter.id,
              serviceAgreementId,
              uomId: meter.uomId,
              readDate,
              readDatetime,
              reading: row.reading,
              priorReading,
              consumption,
              readType: row.readType ?? "ACTUAL",
              readSource: row.readSource ?? mapBatchSourceToReadSource(data.source),
              exceptionCode: exceptionCode ?? null,
              readerId: actorId,
              importBatchId: batch.id,
            },
            include: fullInclude,
          }),
      );
      imported++;
      if (exceptionCode) exceptions++;
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Unknown error processing row";
      errors.push({ row: rowNum, meterNumber: row.meterNumber, error: message });
    }
  }

  // Final batch state. FAILED only if every row errored — even a single
  // successful insert means the operator has data to look at, which is
  // a different workflow from "the import did nothing."
  const allFailed = errors.length === data.reads.length;
  await prisma.importBatch.update({
    where: { id: batch.id },
    data: {
      status: allFailed ? "FAILED" : "COMPLETE",
      importedCount: imported,
      exceptionCount: exceptions,
      errorCount: errors.length,
      errors: errors.length > 0 ? (errors as unknown as object) : undefined,
      completedAt: new Date(),
    },
  });

  return { batchId: batch.id, imported, exceptions, errors };
}

/**
 * Map ImportBatchSource → MeterRead.readSource when the row didn't
 * specify its own. AMR/AMI/MANUAL_UPLOAD/API in the batch correspond
 * to AMR/AMI/MANUAL/SYSTEM at the read level. Single-row imports via
 * the API flow record reads as SYSTEM (vs. an operator typing them).
 */
function mapBatchSourceToReadSource(
  batchSource: ImportMeterReadsInput["source"],
): "MANUAL" | "AMR" | "AMI" | "SYSTEM" {
  switch (batchSource) {
    case "AMR":
      return "AMR";
    case "AMI":
      return "AMI";
    case "MANUAL_UPLOAD":
      return "MANUAL";
    case "API":
      return "SYSTEM";
  }
}
