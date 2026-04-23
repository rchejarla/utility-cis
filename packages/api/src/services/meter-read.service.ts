import { randomUUID } from "node:crypto";
import { prisma } from "../lib/prisma.js";
import { EVENT_TYPES } from "@utility-cis/shared";
import type {
  CreateMeterReadInput,
  CreateMeterReadEventInput,
  CorrectMeterReadInput,
  MeterReadQuery,
  ResolveExceptionInput,
} from "@utility-cis/shared";
import { paginatedTenantList } from "../lib/pagination.js";
import { auditCreate, auditUpdate } from "../lib/audit-wrap.js";
import { domainEvents } from "../events/emitter.js";

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

function emitMeterReadEvent(
  type: "meter_read.created" | "meter_read.updated" | "meter_read.corrected",
  utilityId: string,
  actorId: string,
  actorName: string | undefined,
  entityId: string,
  before: unknown,
  after: unknown,
): void {
  domainEvents.emitDomainEvent({
    type,
    entityType: "MeterRead",
    entityId,
    utilityId,
    actorId,
    actorName,
    beforeState: (before as Record<string, unknown> | null) ?? null,
    afterState: (after as Record<string, unknown>) ?? null,
    timestamp: new Date().toISOString(),
  });
}

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
    () =>
      prisma.meterRead.create({
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

    return rows;
  });

  for (const row of created) {
    domainEvents.emitDomainEvent({
      type: EVENT_TYPES.METER_CREATED,
      entityType: "MeterRead",
      entityId: row.id,
      utilityId,
      actorId,
      actorName,
      beforeState: null,
      afterState: row as unknown as Record<string, unknown>,
      timestamp: new Date().toISOString(),
    });
  }

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

  const corrected = await prisma.meterRead.create({
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

  emitMeterReadEvent(
    "meter_read.corrected",
    utilityId,
    actorId,
    actorName,
    corrected.id,
    original,
    corrected,
  );

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

  await prisma.meterRead.deleteMany({
    where: { id, utilityId, readDatetime: before.readDatetime },
  });

  emitMeterReadEvent(
    "meter_read.updated",
    utilityId,
    actorId,
    actorName,
    before.id,
    before,
    null,
  );
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
    () =>
      prisma.meterRead.updateMany({
        where: { id, utilityId, readDatetime: before.readDatetime },
        data: {
          exceptionCode: shouldClearCode ? null : before.exceptionCode,
          exceptionNotes: data.notes
            ? `[${data.resolution}] ${data.notes}`
            : before.exceptionNotes,
        },
      }).then(async () =>
        prisma.meterRead.findFirst({
          where: { id, utilityId },
          include: fullInclude,
        }).then((r) => {
          if (!r) throw new Error("Meter read vanished after update");
          return r;
        }),
      ),
  );
}
