import { randomUUID } from "node:crypto";
import { prisma } from "../lib/prisma.js";
import { cacheDel } from "../lib/cache-redis.js";
import { EVENT_TYPES } from "@utility-cis/shared";
import type {
  CreateRateScheduleInput,
  RateScheduleQuery,
  ReviseRateScheduleInput,
} from "@utility-cis/shared";
import { paginatedTenantList } from "../lib/pagination.js";
import { auditCreate, auditUpdate } from "../lib/audit-wrap.js";

/**
 * Recursive deep-walk that rewrites every `component_id: <uuid>` key it
 * finds, using the supplied old→new id map. Used when copying components
 * to a new revision: a `pricing.percent_of.selector` (or nested
 * `and`/`or` selector) may reference a sibling component by id, and
 * those references need to point at the freshly-minted ids in the new
 * schedule. References that aren't in the map (e.g., to an expired
 * component that wasn't copied) are left untouched — the rate engine
 * will surface the dangling reference at evaluation time, which matches
 * what would happen anyway.
 */
function remapComponentIds(value: unknown, idMap: Map<string, string>): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((v) => remapComponentIds(v, idMap));
  const obj = value as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(obj)) {
    if (key === "component_id" && typeof val === "string") {
      result[key] = idMap.get(val) ?? val;
    } else {
      result[key] = remapComponentIds(val, idMap);
    }
  }
  return result;
}

const fullInclude = {
  commodity: true,
};

export async function listRateSchedules(utilityId: string, query: RateScheduleQuery) {
  const where: Record<string, unknown> = { utilityId };

  if (query.commodityId) where.commodityId = query.commodityId;
  if (query.active === true) where.expirationDate = null;
  if (query.active === false) where.expirationDate = { not: null };

  return paginatedTenantList(prisma.rateSchedule, where, query, { include: fullInclude });
}

export async function getRateSchedule(id: string, utilityId: string) {
  const schedule = await prisma.rateSchedule.findUniqueOrThrow({
    where: { id, utilityId },
    include: {
      commodity: true,
      supersedes: true,
      supersededBy: true,
    },
  });

  // Full version chain — every schedule that shares this (utilityId, code)
  // ordered by version asc. Lets the detail page render a single timeline
  // (v1 → v2 → … → vN) instead of only the immediate predecessor, so an
  // operator can jump to any prior version in one click rather than
  // walking the supersedes chain hop-by-hop.
  const chain = await prisma.rateSchedule.findMany({
    where: { utilityId, code: schedule.code },
    select: {
      id: true,
      version: true,
      effectiveDate: true,
      expirationDate: true,
      publishedAt: true,
      supersededById: true,
    },
    orderBy: { version: "asc" },
  });

  return { ...schedule, chain };
}

export async function createRateSchedule(
  utilityId: string,
  actorId: string,
  actorName: string,
  data: CreateRateScheduleInput
) {
  return auditCreate(
    { utilityId, actorId, actorName, entityType: "RateSchedule" },
    EVENT_TYPES.RATE_SCHEDULE_CREATED,
    async (tx) => {
      const schedule = await tx.rateSchedule.create({
        data: {
          utilityId,
          name: data.name,
          code: data.code,
          commodityId: data.commodityId,
          effectiveDate: new Date(data.effectiveDate),
          expirationDate: data.expirationDate ? new Date(data.expirationDate) : null,
          description: data.description,
          regulatoryRef: data.regulatoryRef,
          version: 1,
        },
        include: fullInclude,
      });
      await cacheDel(`rate-schedule:${utilityId}:${data.code}`);
      return schedule;
    }
  );
}

export async function reviseRateSchedule(
  utilityId: string,
  actorId: string,
  actorName: string,
  id: string,
  data: ReviseRateScheduleInput
) {
  const predecessor = await prisma.rateSchedule.findUniqueOrThrow({ where: { id, utilityId } });

  const newEffectiveDate = new Date(data.effectiveDate);
  if (newEffectiveDate <= predecessor.effectiveDate) {
    throw Object.assign(
      new Error("Revision effective date must be after the predecessor's"),
      { statusCode: 400, code: "REVISE_DATE_NOT_AFTER_PREDECESSOR" },
    );
  }

  return auditUpdate(
    { utilityId, actorId, actorName, entityType: "RateSchedule" },
    EVENT_TYPES.RATE_SCHEDULE_REVISED,
    predecessor,
    async (tx) => {
      const newSchedule = await tx.rateSchedule.create({
        data: {
          utilityId,
          name: predecessor.name,
          code: predecessor.code,
          commodityId: predecessor.commodityId,
          effectiveDate: newEffectiveDate,
          expirationDate: data.expirationDate ? new Date(data.expirationDate) : null,
          description: data.description ?? predecessor.description,
          regulatoryRef: data.regulatoryRef ?? predecessor.regulatoryRef,
          version: predecessor.version + 1,
          supersedesId: id,
          // publishedAt left NULL — the new revision is a draft until
          // the operator explicitly publishes it. This is the whole
          // point of the publish/draft state: backdating workflows are
          // safe because the schedule is editable until publish.
        },
        include: fullInclude,
      });
      // Set the predecessor's expiration AND its supersededById so the
      // editability gate (publishedAt IS NULL AND supersededById IS NULL)
      // becomes a single column read instead of an inverse-relation count.
      await tx.rateSchedule.update({
        where: { id },
        data: {
          expirationDate: newEffectiveDate,
          supersededById: newSchedule.id,
        },
      });

      // Carry forward every still-active component (expirationDate IS
      // NULL) onto the new revision. Pre-generate ids so we can rewrite
      // intra-schedule `component_id` references in pricing selectors
      // (percent_of / floor / and / or) to point at the new ids before
      // insert. Components with an explicit expirationDate are treated
      // as "retired in the predecessor" and not carried forward.
      const activeComponents = await tx.rateComponent.findMany({
        where: { rateScheduleId: id, utilityId, expirationDate: null },
        orderBy: { sortOrder: "asc" },
      });
      if (activeComponents.length > 0) {
        const idMap = new Map<string, string>();
        for (const c of activeComponents) idMap.set(c.id, randomUUID());
        await tx.rateComponent.createMany({
          data: activeComponents.map((c) => ({
            id: idMap.get(c.id)!,
            utilityId,
            rateScheduleId: newSchedule.id,
            kindCode: c.kindCode,
            label: c.label,
            predicate: c.predicate as object,
            quantitySource: c.quantitySource as object,
            pricing: remapComponentIds(c.pricing, idMap) as object,
            sortOrder: c.sortOrder,
            effectiveDate: newEffectiveDate,
            expirationDate: null,
          })),
        });
      }

      await cacheDel(`rate-schedule:${utilityId}:${predecessor.code}`);
      return newSchedule;
    }
  );
}

export async function publishRateSchedule(
  utilityId: string,
  actorId: string,
  actorName: string,
  id: string,
) {
  const before = await prisma.rateSchedule.findUniqueOrThrow({
    where: { id, utilityId },
  });

  if (before.publishedAt !== null) {
    throw Object.assign(
      new Error("Schedule is already published"),
      { statusCode: 409, code: "ALREADY_PUBLISHED" },
    );
  }
  if (before.supersededById !== null) {
    throw Object.assign(
      new Error("Cannot publish a superseded schedule"),
      { statusCode: 409, code: "SUPERSEDED" },
    );
  }

  return auditUpdate(
    { utilityId, actorId, actorName, entityType: "RateSchedule" },
    EVENT_TYPES.RATE_SCHEDULE_PUBLISHED,
    before,
    async (tx) => {
      const updated = await tx.rateSchedule.update({
        where: { id, utilityId },
        data: { publishedAt: new Date() },
        include: fullInclude,
      });
      await cacheDel(`rate-schedule:${utilityId}:${before.code}`);
      return updated;
    },
  );
}
