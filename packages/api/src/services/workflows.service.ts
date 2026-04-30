import { prisma } from "../lib/prisma.js";
import type {
  TransferServiceInput,
  MoveInInput,
  MoveOutInput,
  SearchQuery,
} from "@utility-cis/shared";
import { writeAuditRow } from "../lib/audit-wrap.js";
import { generateNumber } from "../lib/number-generator.js";
import { closeServiceAgreement } from "./effective-dating.service.js";

/**
 * Cross-entity workflows. Each function wraps a multi-step business
 * operation in a single database transaction so there is no partial
 * state if any step fails. Every workflow emits a dedicated audit
 * event (so it shows up in the audit log as one logical action rather
 * than a fan-out of per-entity updates).
 */

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
      include: {
        servicePoints: {
          where: { endDate: null },
          include: {
            meters: {
              where: { removedDate: null },
              orderBy: { addedDate: "desc" },
              include: { meter: true },
            },
          },
        },
      },
    });
    // Flatten the SPMs across all open SPs on this SA. Ordered most
    // recent addedDate first so callers can grab `[0]` as the
    // representative meter (primacy is implicit in the SP model).
    const sourceSpms = source.servicePoints.flatMap((sp) => sp.meters);

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

    const sourcePremiseId = source.servicePoints[0]?.premiseId;
    if (!sourcePremiseId) {
      throw Object.assign(
        new Error("Source agreement has no service point with a premise; cannot transfer."),
        { statusCode: 400, code: "SOURCE_AGREEMENT_NO_PREMISE" },
      );
    }

    // Optional FINAL read on the source side
    if (data.finalMeterReading !== undefined) {
      // Most-recently-added open SPM; primacy is implicit in the SP model.
      const primary = sourceSpms[0];
      if (primary) {
        const pm = await tx.meter.findUniqueOrThrow({ where: { id: primary.meterId }, select: { uomId: true } });
        await tx.meterRead.create({
          data: {
            utilityId,
            meterId: primary.meterId,
            serviceAgreementId: source.id,
            uomId: pm.uomId,
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

    // Close source via the cascade helper. This atomically marks the
    // source SA as FINAL and sets `removed_date = transferDate` on every
    // still-open SAM child — closing the silent-orphan gap where the
    // old direct-update path left meter assignments dangling.
    const { agreement: closedSource } = await closeServiceAgreement(
      utilityId,
      actorId,
      actorName,
      {
        saId: sourceAgreementId,
        endDate: transferDate,
        status: "FINAL",
        reason: `Transferred to account ${data.targetAccountId}`,
      },
      tx,
    );

    // Create new agreement on target account, cloning the core fields.
    // If no explicit number was provided, generate from the tenant
    // template (same pattern as move-in).
    const newAgreementNumber =
      data.newAgreementNumber ??
      (await generateNumber({
        utilityId,
        entity: "agreement",
        defaultTemplate: "SA-{seq:4}",
        tableName: "service_agreement",
        columnName: "agreement_number",
        db: tx,
      }));
    const newAgreementBase = await tx.serviceAgreement.create({
      data: {
        utilityId,
        agreementNumber: newAgreementNumber,
        accountId: data.targetAccountId,
        commodityId: source.commodityId,
        rateScheduleId: source.rateScheduleId,
        billingCycleId: source.billingCycleId,
        startDate: transferDate,
        status: "ACTIVE",
        readSequence: source.readSequence,
      },
    });

    // Create one SP on the new SA mirroring the source's premise, then
    // copy each open meter from the source's SPMs onto it. Primacy is
    // implicit in the SP model (one meter at a time per SP).
    const newSp = await tx.servicePoint.create({
      data: {
        utilityId,
        serviceAgreementId: newAgreementBase.id,
        premiseId: sourcePremiseId,
        type: "METERED",
        status: "ACTIVE",
        startDate: transferDate,
      },
    });
    if (sourceSpms.length > 0) {
      await tx.servicePointMeter.createMany({
        data: sourceSpms.map((m) => ({
          utilityId,
          servicePointId: newSp.id,
          meterId: m.meterId,
          addedDate: transferDate,
        })),
      });
    }

    // Re-read the new agreement with the include shape callers expect.
    const newAgreement = await tx.serviceAgreement.findUniqueOrThrow({
      where: { id: newAgreementBase.id },
      include: {
        servicePoints: {
          where: { endDate: null },
          include: {
            meters: {
              where: { removedDate: null },
              orderBy: { addedDate: "desc" },
              include: { meter: true },
            },
          },
        },
      },
    });
    const newAgreementSpms = newAgreement.servicePoints.flatMap((sp) => sp.meters);

    // Optional ACTUAL read on the new agreement side
    if (data.initialMeterReading !== undefined) {
      const primary = newAgreementSpms[0];
      if (primary) {
        const pm2 = await tx.meter.findUniqueOrThrow({ where: { id: primary.meterId }, select: { uomId: true } });
        await tx.meterRead.create({
          data: {
            utilityId,
            meterId: primary.meterId,
            serviceAgreementId: newAgreement.id,
            uomId: pm2.uomId,
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

    await writeAuditRow(
      tx,
      { utilityId, actorId, actorName, entityType: "Workflow" },
      "workflow.transfer_service",
      newAgreement.id,
      { sourceAgreementId },
      {
        sourceAgreementId: closedSource.id,
        targetAgreementId: newAgreement.id,
        targetAccountId: data.targetAccountId,
        transferDate: data.transferDate,
      },
    );

    return { source: closedSource, target: newAgreement };
  });

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

    // Create account. accountNumber is optional in the move-in payload;
    // if absent, generate from the tenant's numberFormats.account
    // template inside this transaction.
    const accountNumber =
      data.accountNumber ??
      (await generateNumber({
        utilityId,
        entity: "account",
        defaultTemplate: "AC-{seq:5}",
        tableName: "account",
        columnName: "account_number",
        db: tx,
      }));
    const account = await tx.account.create({
      data: {
        utilityId,
        accountNumber,
        customerId,
        accountType: data.accountType,
        status: "ACTIVE",
        depositAmount: data.depositAmount ?? 0,
      },
    });

    // Create service agreements with optional initial meter readings.
    // Each agreement's number is auto-generated if the caller omitted
    // it; the generator runs inside this tx so the second agreement
    // sees the first one's row when picking its next sequence.
    const agreements = [];
    for (const agreement of data.agreements) {
      const agreementNumber =
        agreement.agreementNumber ??
        (await generateNumber({
          utilityId,
          entity: "agreement",
          defaultTemplate: "SA-{seq:4}",
          tableName: "service_agreement",
          columnName: "agreement_number",
          db: tx,
        }));
      const sa = await tx.serviceAgreement.create({
        data: {
          utilityId,
          agreementNumber,
          accountId: account.id,
          commodityId: agreement.commodityId,
          rateScheduleId: agreement.rateScheduleId,
          billingCycleId: agreement.billingCycleId,
          startDate: moveInDate,
          status: "ACTIVE",
        },
      });

      // One SP per SA at create time (slice 1 invariant). SPMs hang
      // off this SP; primacy is implicit (one meter at a time per SP).
      const sp = await tx.servicePoint.create({
        data: {
          utilityId,
          serviceAgreementId: sa.id,
          premiseId: data.premiseId,
          type: "METERED",
          status: "ACTIVE",
          startDate: moveInDate,
        },
      });

      if (agreement.initialMeterReadings) {
        for (const ir of agreement.initialMeterReadings) {
          await tx.servicePointMeter.create({
            data: {
              utilityId,
              servicePointId: sp.id,
              meterId: ir.meterId,
              addedDate: moveInDate,
            },
          });
          const irm = await tx.meter.findUniqueOrThrow({ where: { id: ir.meterId }, select: { uomId: true } });
          await tx.meterRead.create({
            data: {
              utilityId,
              meterId: ir.meterId,
              serviceAgreementId: sa.id,
              uomId: irm.uomId,
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

    await writeAuditRow(
      tx,
      { utilityId, actorId, actorName, entityType: "Workflow" },
      "workflow.move_in",
      account.id,
      null,
      {
        accountId: account.id,
        customerId,
        premiseId: data.premiseId,
        agreementIds: agreements.map((a) => a.id),
        moveInDate: data.moveInDate,
      },
    );

    return { customerId, account, agreements };
  });

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
        servicePoints: { some: { premiseId: data.premiseId } },
        status: { in: ["PENDING", "ACTIVE"] },
      },
    });

    if (activeAgreements.length === 0) {
      throw Object.assign(
        new Error("No active or pending service agreements found for this account and premise"),
        { statusCode: 400, code: "NO_ACTIVE_AGREEMENTS" },
      );
    }

    // Record final meter reads first, then cascade-close the SA. The
    // cascade helper sets `removed_date` on every open SAM child in the
    // same tx, replacing the per-SAM update loop the old code did inline.
    const readingsByMeter = new Map(
      data.finalMeterReadings.map((r) => [r.meterId, r.reading]),
    );
    for (const sa of activeAgreements) {
      const agreementMeters = await tx.servicePointMeter.findMany({
        where: {
          servicePoint: { serviceAgreementId: sa.id },
          removedDate: null,
        },
      });
      for (const am of agreementMeters) {
        const reading = readingsByMeter.get(am.meterId);
        if (reading !== undefined) {
          const fmr = await tx.meter.findUniqueOrThrow({ where: { id: am.meterId }, select: { uomId: true } });
          await tx.meterRead.create({
            data: {
              utilityId,
              meterId: am.meterId,
              serviceAgreementId: sa.id,
              uomId: fmr.uomId,
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
      }

      await closeServiceAgreement(
        utilityId,
        actorId,
        actorName,
        {
          saId: sa.id,
          endDate: moveOutDate,
          status: "FINAL",
          reason: `Move-out from premise ${data.premiseId}`,
        },
        tx,
      );
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

    await writeAuditRow(
      tx,
      { utilityId, actorId, actorName, entityType: "Workflow" },
      "workflow.move_out",
      data.accountId,
      null,
      {
        accountId: data.accountId,
        premiseId: data.premiseId,
        moveOutDate: data.moveOutDate,
        closedAgreementIds: activeAgreements.map((a) => a.id),
        accountClosed: Boolean(account),
      },
    );

    return { accountId: data.accountId, finalizedAgreements: activeAgreements, account };
  });

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
