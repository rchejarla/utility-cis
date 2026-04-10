import { prisma } from "../lib/prisma.js";
import { EVENT_TYPES } from "@utility-cis/shared";
import type {
  CreateMeterReadInput,
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
  limit = 100,
) {
  return prisma.meterRead.findMany({
    where: { utilityId, meterId },
    orderBy: { readDatetime: "desc" },
    take: limit,
    include: fullInclude,
  });
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

export async function createMeterRead(
  utilityId: string,
  actorId: string,
  actorName: string,
  data: CreateMeterReadInput,
) {
  const readDatetime = new Date(data.readDatetime);
  const { priorReading, consumption, exceptionCode: autoException } =
    await computeConsumption(
      utilityId,
      data.meterId,
      data.registerId ?? null,
      data.reading,
      readDatetime,
    );

  return auditCreate(
    { utilityId, actorId, actorName, entityType: "MeterRead" },
    EVENT_TYPES.METER_CREATED,
    () =>
      prisma.meterRead.create({
        data: {
          utilityId,
          meterId: data.meterId,
          serviceAgreementId: data.serviceAgreementId,
          registerId: data.registerId ?? null,
          readDate: new Date(data.readDate),
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

  const corrected = await prisma.meterRead.create({
    data: {
      utilityId,
      meterId: original.meterId,
      serviceAgreementId: original.serviceAgreementId,
      registerId: original.registerId,
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
