import { prisma } from "../lib/prisma.js";
import { EVENT_TYPES } from "@utility-cis/shared";
import type {
  TransferServiceInput,
  MoveInInput,
  MoveOutInput,
  SearchQuery,
} from "@utility-cis/shared";
import { domainEvents } from "../events/emitter.js";

/**
 * Cross-entity workflows. Each function wraps a multi-step business
 * operation in a single database transaction so there is no partial
 * state if any step fails. Every workflow emits a dedicated audit
 * event (so it shows up in the audit log as one logical action rather
 * than a fan-out of per-entity updates).
 */

function emit(
  type: string,
  utilityId: string,
  actorId: string,
  actorName: string | undefined,
  entityId: string,
  before: unknown,
  after: unknown,
): void {
  domainEvents.emitDomainEvent({
    type,
    entityType: "Workflow",
    entityId,
    utilityId,
    actorId,
    actorName,
    beforeState: (before as Record<string, unknown> | null) ?? null,
    afterState: (after as Record<string, unknown>) ?? null,
    timestamp: new Date().toISOString(),
  });
}

/**
 * Transfer of service: reassigns an active service agreement from one
 * account to another as of `transferDate`. The source agreement is
 * closed with an end_date and an optional FINAL meter read; a new
 * agreement is created on the target account with identical
 * premise/commodity/rateSchedule/billingCycle and an optional ACTUAL
 * meter read. Meter-read history stays linked to whichever agreement
 * owned the meter at the time.
 */
export async function transferService(
  utilityId: string,
  actorId: string,
  actorName: string,
  sourceAgreementId: string,
  data: TransferServiceInput,
) {
  const result = await prisma.$transaction(async (tx) => {
    const source = await tx.serviceAgreement.findFirstOrThrow({
      where: { id: sourceAgreementId, utilityId },
      include: { meters: { where: { removedDate: null }, include: { meter: true } } },
    });

    if (source.status === "CLOSED" || source.status === "FINAL") {
      throw Object.assign(
        new Error(`Cannot transfer a ${source.status} service agreement`),
        { statusCode: 400, code: "AGREEMENT_NOT_TRANSFERABLE" },
      );
    }

    const targetAccount = await tx.account.findFirstOrThrow({
      where: { id: data.targetAccountId, utilityId },
    });

    if (targetAccount.status !== "ACTIVE") {
      throw Object.assign(
        new Error("Target account must be ACTIVE to receive a transferred service"),
        { statusCode: 400, code: "TARGET_ACCOUNT_INACTIVE" },
      );
    }

    const transferDate = new Date(data.transferDate);

    // Optional FINAL read on the source side
    if (data.finalMeterReading !== undefined) {
      const primary = source.meters.find((m) => m.isPrimary) ?? source.meters[0];
      if (primary) {
        await tx.meterRead.create({
          data: {
            utilityId,
            meterId: primary.meterId,
            serviceAgreementId: source.id,
            readDate: transferDate,
            readDatetime: transferDate,
            reading: data.finalMeterReading,
            priorReading: 0,
            consumption: 0,
            readType: "FINAL",
            readSource: "MANUAL",
            readerId: actorId,
          },
        });
      }
    }

    // Close source
    const closedSource = await tx.serviceAgreement.update({
      where: { id: sourceAgreementId },
      data: { status: "FINAL", endDate: transferDate },
    });

    // Create new agreement on target account, cloning the core fields
    const newAgreement = await tx.serviceAgreement.create({
      data: {
        utilityId,
        agreementNumber: data.newAgreementNumber,
        accountId: data.targetAccountId,
        premiseId: source.premiseId,
        commodityId: source.commodityId,
        rateScheduleId: source.rateScheduleId,
        billingCycleId: source.billingCycleId,
        startDate: transferDate,
        status: "ACTIVE",
        readSequence: source.readSequence,
        meters: {
          create: source.meters.map((m) => ({
            utilityId,
            meterId: m.meterId,
            isPrimary: m.isPrimary,
            addedDate: transferDate,
          })),
        },
      },
      include: { meters: { include: { meter: true } } },
    });

    // Optional ACTUAL read on the new agreement side
    if (data.initialMeterReading !== undefined) {
      const primary = newAgreement.meters.find((m) => m.isPrimary) ?? newAgreement.meters[0];
      if (primary) {
        await tx.meterRead.create({
          data: {
            utilityId,
            meterId: primary.meterId,
            serviceAgreementId: newAgreement.id,
            readDate: transferDate,
            readDatetime: transferDate,
            reading: data.initialMeterReading,
            priorReading: data.finalMeterReading ?? 0,
            consumption: 0,
            readType: "ACTUAL",
            readSource: "MANUAL",
            readerId: actorId,
          },
        });
      }
    }

    return { source: closedSource, target: newAgreement };
  });

  emit(
    "workflow.transfer_service",
    utilityId,
    actorId,
    actorName,
    result.target.id,
    { sourceAgreementId },
    {
      sourceAgreementId: result.source.id,
      targetAgreementId: result.target.id,
      targetAccountId: data.targetAccountId,
      transferDate: data.transferDate,
    },
  );

  return result;
}

/**
 * Move-in workflow: create customer (or use existing) + account +
 * one-or-more service agreements in a single transaction. Failure at
 * any step rolls back the whole thing — you don't end up with an
 * orphan account because a meter didn't exist.
 */
export async function moveIn(
  utilityId: string,
  actorId: string,
  actorName: string,
  data: MoveInInput,
) {
  const result = await prisma.$transaction(async (tx) => {
    // Resolve customer
    let customerId: string;
    if (data.existingCustomerId) {
      const customer = await tx.customer.findFirstOrThrow({
        where: { id: data.existingCustomerId, utilityId },
      });
      customerId = customer.id;
    } else if (data.newCustomer) {
      const created = await tx.customer.create({
        data: {
          utilityId,
          customerType: data.newCustomer.customerType,
          firstName: data.newCustomer.firstName ?? null,
          lastName: data.newCustomer.lastName ?? null,
          organizationName: data.newCustomer.organizationName ?? null,
          email: data.newCustomer.email ?? null,
          phone: data.newCustomer.phone ?? null,
          status: "ACTIVE",
        },
      });
      customerId = created.id;
    } else {
      throw new Error("Neither existingCustomerId nor newCustomer provided");
    }

    const moveInDate = new Date(data.moveInDate);

    // Create account
    const account = await tx.account.create({
      data: {
        utilityId,
        accountNumber: data.accountNumber,
        customerId,
        accountType: data.accountType,
        status: "ACTIVE",
        depositAmount: data.depositAmount ?? 0,
      },
    });

    // Create service agreements with optional initial meter readings
    const agreements = [];
    for (const agreement of data.agreements) {
      const sa = await tx.serviceAgreement.create({
        data: {
          utilityId,
          agreementNumber: agreement.agreementNumber,
          accountId: account.id,
          premiseId: data.premiseId,
          commodityId: agreement.commodityId,
          rateScheduleId: agreement.rateScheduleId,
          billingCycleId: agreement.billingCycleId,
          startDate: moveInDate,
          status: "ACTIVE",
        },
      });

      if (agreement.initialMeterReadings) {
        for (const ir of agreement.initialMeterReadings) {
          await tx.serviceAgreementMeter.create({
            data: {
              utilityId,
              serviceAgreementId: sa.id,
              meterId: ir.meterId,
              isPrimary: true,
              addedDate: moveInDate,
            },
          });
          await tx.meterRead.create({
            data: {
              utilityId,
              meterId: ir.meterId,
              serviceAgreementId: sa.id,
              readDate: moveInDate,
              readDatetime: moveInDate,
              reading: ir.reading,
              priorReading: 0,
              consumption: 0,
              readType: "ACTUAL",
              readSource: "MANUAL",
              readerId: actorId,
            },
          });
        }
      }

      agreements.push(sa);
    }

    return { customerId, account, agreements };
  });

  emit(
    "workflow.move_in",
    utilityId,
    actorId,
    actorName,
    result.account.id,
    null,
    {
      accountId: result.account.id,
      customerId: result.customerId,
      premiseId: data.premiseId,
      agreementIds: result.agreements.map((a) => a.id),
      moveInDate: data.moveInDate,
    },
  );

  return result;
}

/**
 * Move-out workflow: close out all active service agreements on an
 * account for a given premise on the same date, record final meter
 * readings, and optionally close the account. Everything in one
 * transaction.
 */
export async function moveOut(
  utilityId: string,
  actorId: string,
  actorName: string,
  data: MoveOutInput,
) {
  const result = await prisma.$transaction(async (tx) => {
    const moveOutDate = new Date(data.moveOutDate);

    const activeAgreements = await tx.serviceAgreement.findMany({
      where: {
        utilityId,
        accountId: data.accountId,
        premiseId: data.premiseId,
        status: { in: ["PENDING", "ACTIVE"] },
      },
    });

    if (activeAgreements.length === 0) {
      throw Object.assign(
        new Error("No active or pending service agreements found for this account and premise"),
        { statusCode: 400, code: "NO_ACTIVE_AGREEMENTS" },
      );
    }

    // Record final meter reads first
    const readingsByMeter = new Map(
      data.finalMeterReadings.map((r) => [r.meterId, r.reading]),
    );
    for (const sa of activeAgreements) {
      const agreementMeters = await tx.serviceAgreementMeter.findMany({
        where: { serviceAgreementId: sa.id, removedDate: null },
      });
      for (const am of agreementMeters) {
        const reading = readingsByMeter.get(am.meterId);
        if (reading !== undefined) {
          await tx.meterRead.create({
            data: {
              utilityId,
              meterId: am.meterId,
              serviceAgreementId: sa.id,
              readDate: moveOutDate,
              readDatetime: moveOutDate,
              reading,
              priorReading: 0,
              consumption: 0,
              readType: "FINAL",
              readSource: "MANUAL",
              readerId: actorId,
            },
          });
        }
        await tx.serviceAgreementMeter.update({
          where: { id: am.id },
          data: { removedDate: moveOutDate },
        });
      }

      await tx.serviceAgreement.update({
        where: { id: sa.id },
        data: { status: "FINAL", endDate: moveOutDate },
      });
    }

    // Optionally close the account
    let account = null;
    if (data.closeAccount) {
      // Make sure NO other active agreements exist on this account
      // (other premises may still be active).
      const remainingActive = await tx.serviceAgreement.count({
        where: {
          utilityId,
          accountId: data.accountId,
          status: { in: ["PENDING", "ACTIVE"] },
        },
      });
      if (remainingActive > 0) {
        throw Object.assign(
          new Error(
            "Cannot close account — other active agreements exist. Move out from all premises first or close the account manually.",
          ),
          { statusCode: 400, code: "ACCOUNT_HAS_OTHER_AGREEMENTS" },
        );
      }
      account = await tx.account.update({
        where: { id: data.accountId },
        data: { status: "CLOSED", closedAt: moveOutDate },
      });
    }

    return { accountId: data.accountId, finalizedAgreements: activeAgreements, account };
  });

  emit(
    "workflow.move_out",
    utilityId,
    actorId,
    actorName,
    data.accountId,
    null,
    {
      accountId: data.accountId,
      premiseId: data.premiseId,
      moveOutDate: data.moveOutDate,
      closedAgreementIds: result.finalizedAgreements.map((a) => a.id),
      accountClosed: Boolean(result.account),
    },
  );

  return result;
}

/**
 * Global full-text search across customers, premises, accounts, and
 * meters. Uses the generated tsvector columns and GIN indexes from the
 * 02_fts migration via raw SQL so Prisma doesn't need to know about
 * them. Each row is hydrated back through Prisma so the response shape
 * matches what the UI expects (same objects as individual entity
 * endpoints, just narrower).
 */
export interface SearchHit {
  kind: "customer" | "premise" | "account" | "meter";
  id: string;
  label: string;
  sublabel?: string;
  rank: number;
}

export async function globalSearch(
  utilityId: string,
  { q, limit, kinds }: SearchQuery,
): Promise<SearchHit[]> {
  // Split on whitespace, escape Postgres tsquery metacharacters, join
  // with & so every term must match. ':*' at the end makes each term a
  // prefix match so "jon" finds "jones" and "12 ma" finds "12 main".
  const terms = q
    .split(/\s+/)
    .map((t) => t.replace(/[^\w]/g, ""))
    .filter((t) => t.length > 0);
  if (terms.length === 0) return [];
  const tsquery = terms.map((t) => `${t}:*`).join(" & ");

  const wanted = new Set(
    kinds && kinds.length > 0 ? kinds : ["customer", "premise", "account", "meter"],
  );

  const hits: SearchHit[] = [];

  if (wanted.has("customer")) {
    const rows = await prisma.$queryRawUnsafe<
      Array<{
        id: string;
        first_name: string | null;
        last_name: string | null;
        organization_name: string | null;
        email: string | null;
        rank: number;
      }>
    >(
      `SELECT id, first_name, last_name, organization_name, email,
              ts_rank(search_vector, to_tsquery('simple', $1)) AS rank
       FROM customer
       WHERE utility_id = $2::uuid
         AND search_vector @@ to_tsquery('simple', $1)
       ORDER BY rank DESC
       LIMIT $3`,
      tsquery,
      utilityId,
      limit,
    );
    for (const r of rows) {
      hits.push({
        kind: "customer",
        id: r.id,
        label:
          r.organization_name ??
          [r.first_name, r.last_name].filter(Boolean).join(" ") ??
          "(unnamed)",
        sublabel: r.email ?? undefined,
        rank: Number(r.rank),
      });
    }
  }

  if (wanted.has("premise")) {
    const rows = await prisma.$queryRawUnsafe<
      Array<{
        id: string;
        address_line1: string;
        city: string;
        state: string;
        zip: string;
        rank: number;
      }>
    >(
      `SELECT id, address_line1, city, state, zip,
              ts_rank(search_vector, to_tsquery('simple', $1)) AS rank
       FROM premise
       WHERE utility_id = $2::uuid
         AND search_vector @@ to_tsquery('simple', $1)
       ORDER BY rank DESC
       LIMIT $3`,
      tsquery,
      utilityId,
      limit,
    );
    for (const r of rows) {
      hits.push({
        kind: "premise",
        id: r.id,
        label: r.address_line1,
        sublabel: `${r.city}, ${r.state} ${r.zip}`,
        rank: Number(r.rank),
      });
    }
  }

  if (wanted.has("account")) {
    const rows = await prisma.$queryRawUnsafe<
      Array<{ id: string; account_number: string; rank: number }>
    >(
      `SELECT id, account_number,
              ts_rank(search_vector, to_tsquery('simple', $1)) AS rank
       FROM account
       WHERE utility_id = $2::uuid
         AND search_vector @@ to_tsquery('simple', $1)
       ORDER BY rank DESC
       LIMIT $3`,
      tsquery,
      utilityId,
      limit,
    );
    for (const r of rows) {
      hits.push({
        kind: "account",
        id: r.id,
        label: r.account_number,
        rank: Number(r.rank),
      });
    }
  }

  if (wanted.has("meter")) {
    const rows = await prisma.$queryRawUnsafe<
      Array<{ id: string; meter_number: string; rank: number }>
    >(
      `SELECT id, meter_number,
              ts_rank(search_vector, to_tsquery('simple', $1)) AS rank
       FROM meter
       WHERE utility_id = $2::uuid
         AND search_vector @@ to_tsquery('simple', $1)
       ORDER BY rank DESC
       LIMIT $3`,
      tsquery,
      utilityId,
      limit,
    );
    for (const r of rows) {
      hits.push({
        kind: "meter",
        id: r.id,
        label: r.meter_number,
        rank: Number(r.rank),
      });
    }
  }

  // Merge by rank descending, tie-break on label
  hits.sort((a, b) => {
    if (b.rank !== a.rank) return b.rank - a.rank;
    return a.label.localeCompare(b.label);
  });

  return hits.slice(0, limit);
}
