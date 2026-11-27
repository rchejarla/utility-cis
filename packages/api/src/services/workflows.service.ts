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
import type { FinalBillResult } from "./final-bill.service.js";

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
 * agreement is created on the target account, and an optional ACTUAL
 * read is recorded against it. Meter-read history stays linked to
 * whichever agreement owned the meter at the time.
 *
 * **What is carried:** `commodity_id`, every open service point (each
 * at its own premise, with its own open meters), and — when the tenant's
 * `transferCarriesRateSchedule` is on, which is the default — the
 * rate-schedule assignments in force on the transfer date. Not
 * `billingCycleId`, which left the SA in slice 5b.1: the target account
 * owns the cycle, so the target's applies. Not the premise as an
 * agreement field, because it is not one — it arrives on the service
 * points below.
 *
 * This comment claimed "identical premise/commodity/rateSchedule/
 * billingCycle" until 2026-11-17, when three of the four were wrong, and
 * the rate schedule became true again on 2026-11-18 by being built
 * rather than by being described. `readSequence` was the fourth, and its
 * column is gone (spec 30).
 *
 * **Every open service point is mirrored, not flattened.** Until
 * 2026-11-18 the workflow created *one* point, at the premise of the
 * source's first open point, and copied every meter from every point
 * onto it — so an agreement serving two premises came out serving one,
 * with the second premise's meters hanging at the first. Nothing can
 * create a second point on an agreement today (all four create paths
 * make exactly one, and the overlay upsert refuses a premise change
 * rather than adding one), so this was unreachable; it was wrong rather
 * than merely unsupported, which is why it is a loop now instead of a
 * refusal. Spec 05's transfer section records the decision.
 *
 * This does **not** make multi-premise agreements supported. The rate
 * engine still rates a whole agreement at `servicePoints[0]`'s premise
 * (`lib/rate-engine-loaders/load-base.ts`), and the customer graph and
 * service-request screens still show the first point's premise. Transfer
 * has stopped corrupting such an agreement; nothing else has learned
 * about it.
 */
export async function transferService(
  utilityId: string,
  actorId: string,
  actorName: string,
  sourceAgreementId: string,
  data: TransferServiceInput,
) {
  // Needed before the read below, which filters the source's
  // rate-schedule assignments to the ones in force on this day.
  const transferDate = new Date(data.transferDate);

  const result = await prisma.$transaction(async (tx) => {
    const source = await tx.serviceAgreement.findFirstOrThrow({
      where: { id: sourceAgreementId, utilityId },
      include: {
        servicePoints: {
          where: { endDate: null },
          // Oldest point first, so the mirrored agreement lists its
          // premises in the order the source did rather than in whatever
          // order Postgres returns. `servicePoints[0]` is the premise six
          // other call sites read as "the agreement's premise", so which
          // row is first is not cosmetic.
          orderBy: { startDate: "asc" },
          include: {
            meters: {
              where: { removedDate: null },
              orderBy: { addedDate: "desc" },
              include: { meter: true },
            },
          },
        },
        /*
         * The assignments the new agreement inherits if the tenant's flag
         * says to: those **in force** on the transfer date, and those
         * **scheduled to start after it**.
         *
         * Only the first until 2026-11-27, so a rate change the source
         * already had booked for next month — a new tariff year, a move
         * off an introductory rate — was silently dropped: the premise
         * was the same, the scheduled change was the utility's decision
         * about it, and the new agreement stayed on the old rate forever.
         *
         * `expirationDate` is inclusive, matching the rate engine's own
         * window filter in `load-base.ts`: an assignment expiring on the
         * transfer date is still in force that day.
         */
        rateScheduleAssignments: {
          where: {
            OR: [
              {
                effectiveDate: { lte: transferDate },
                OR: [{ expirationDate: null }, { expirationDate: { gte: transferDate } }],
              },
              { effectiveDate: { gt: transferDate } },
            ],
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

    /*
     * A transfer to the account that already holds the agreement.
     *
     * Refused rather than performed, because performing it is
     * destructive and looks like a no-op: the agreement goes FINAL, a
     * second one opens on the same account at the same premise, and the
     * customer's service history now reads as a change of
     * responsibility that never happened. A final bill may follow.
     *
     * The wizard has refused this client-side since it shipped
     * (`app/workflows/transfer/page.tsx`), which made the rule real for
     * anyone using the screen and no one using the API. One wrong pick
     * in a dropdown is the whole distance to it.
     */
    if (source.accountId === data.targetAccountId) {
      throw Object.assign(
        new Error(
          "Target account already holds this service agreement; a transfer needs a different account.",
        ),
        { statusCode: 400, code: "TRANSFER_TO_SAME_ACCOUNT" },
      );
    }

    /*
     * One reading, more than one meter: refused, because the number
     * names no meter.
     *
     * `finalMeterReading` and `initialMeterReading` are single scalars
     * written against `sourceSpms[0]` — the most recently *added* open
     * meter. With one meter that is unambiguous. With two it silently
     * picks by install order, so a CSR's final read lands on whichever
     * meter happened to be fitted last, and the other meter's service
     * ends with no final read at all.
     *
     * This is reachable today and has nothing to do with multiple
     * premises: `createServiceAgreement` takes a list of meters and
     * attaches all of them to the one point it makes. Refusing sends the
     * operator to the reads endpoint, which can say which meter it
     * means; the transfer itself still works without a reading.
     */
    if (
      (data.finalMeterReading !== undefined || data.initialMeterReading !== undefined) &&
      sourceSpms.length > 1
    ) {
      throw Object.assign(
        new Error(
          `This agreement has ${sourceSpms.length} meters, so a single reading does not say which meter it is for. ` +
            "Transfer without a reading and record each meter's read directly.",
        ),
        { statusCode: 400, code: "TRANSFER_READING_AMBIGUOUS" },
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

    // Every open point moves. Zero of them is still a refusal: an
    // agreement with no open service point has no premise to transfer,
    // and the new agreement would serve nowhere.
    const openSps = source.servicePoints;
    if (openSps.length === 0) {
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
        // The operator's reason, where they gave one, so the closure
        // itself says why and not only that it was a transfer.
        reason: data.reason
          ? `Transferred to account ${data.targetAccountId}: ${data.reason}`
          : `Transferred to account ${data.targetAccountId}`,
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
    // Slice 5b.1 — billingCycleId is no longer on SA; the target Account
    // owns it. The transfer simply attaches to the target account; the
    // target's billing cycle applies automatically.
    const newAgreementBase = await tx.serviceAgreement.create({
      data: {
        utilityId,
        agreementNumber: newAgreementNumber,
        accountId: data.targetAccountId,
        commodityId: source.commodityId,
        startDate: transferDate,
        status: "ACTIVE",
      },
    });

    /*
     * Mirror each open service point onto the new agreement — its own
     * premise, its own meters. Serial rather than a `createMany`,
     * because each point's meters need the id of the point just created.
     * It is one iteration for every agreement this product can currently
     * produce.
     *
     * **This must stay after the close, and the database now enforces
     * why.** `before_one_live_service_per_premise` refuses a second live
     * point at one premise for one commodity, so creating these before
     * the source was closed would make a transfer refuse itself. It is
     * safe twice over as written: the source agreement is FINAL by now,
     * which takes it out of the rule, and its points end on
     * `transferDate` while these start on it — a hand-over, not an
     * overlap, since the comparison is half-open.
     *
     * `type` is carried from the source point instead of hard-coded
     * `METERED`, which is what this did before: a point that is not
     * metered would have come out of a transfer claiming it was.
     *
     * `status` is not carried. The new points are ACTIVE because the new
     * agreement is, and what a non-ACTIVE-but-not-ended point should
     * become on transfer is a question nobody has had to answer yet.
     */
    for (const sp of openSps) {
      const newSp = await tx.servicePoint.create({
        data: {
          utilityId,
          serviceAgreementId: newAgreementBase.id,
          premiseId: sp.premiseId,
          type: sp.type,
          status: "ACTIVE",
          startDate: transferDate,
        },
      });
      if (sp.meters.length > 0) {
        await tx.servicePointMeter.createMany({
          data: sp.meters.map((m) => ({
            utilityId,
            servicePointId: newSp.id,
            meterId: m.meterId,
            addedDate: transferDate,
          })),
        });
      }
    }

    /*
     * Carry the tariff, if the tenant says to.
     *
     * No row at all means every default, the way `getTenantConfig`
     * reads it — so the absence of a config row carries the schedule
     * rather than silently dropping it. The column default agrees.
     *
     * The *source's* assignments are left as they are. Its own end date
     * says when it stopped serving, and expiring its assignments is
     * `closeServiceAgreement`'s business if it is anybody's — that
     * cascade is shared with move-out and every other closure path, and
     * widening it from here would change all of them.
     *
     * `effectiveDate` is the later of the transfer date and the source
     * assignment's own: an assignment in force is re-dated to the transfer
     * date, because the new agreement did not exist before it and an
     * earlier date would claim a period it cannot have served; one
     * scheduled for later keeps its own start, which is the point of
     * carrying it. `expirationDate` is carried as-is — a tariff that ends
     * in June still ends in June.
     */
    const config = await tx.utilityConfig.findUnique({
      where: { utilityId },
      select: { transferCarriesRateSchedule: true },
    });
    const carried = (config?.transferCarriesRateSchedule ?? true)
      ? source.rateScheduleAssignments
      : [];
    if (carried.length > 0) {
      await tx.sAScheduleAssignment.createMany({
        data: carried.map((a) => ({
          utilityId,
          serviceAgreementId: newAgreementBase.id,
          rateScheduleId: a.rateScheduleId,
          roleCode: a.roleCode,
          effectiveDate: a.effectiveDate > transferDate ? a.effectiveDate : transferDate,
          expirationDate: a.expirationDate,
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
        /*
         * What actually moved, because the two counts cannot be
         * reconstructed afterwards. `transferCarriesRateSchedule` is a
         * per-tenant flag somebody may turn off between one transfer and
         * the next, and without this an unrated new agreement looks the
         * same whether the flag was off or the source simply had no
         * tariff.
         */
        servicePointsMirrored: openSps.length,
        rateScheduleAssignmentsCarried: carried.length,
        /*
         * The operator's own words. The wizard has offered a "Reason"
         * field since it shipped and this workflow read it nowhere — it
         * passed a constructed string to the close and recorded nothing
         * — so a CSR's "sale of property" went into a 2000-character
         * box and was discarded on submit.
         */
        reason: data.reason ?? null,
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
        billingCycleId: data.billingCycleId,
        // Set by the ledger below, not here: it is a cache of the
        // DEPOSIT entries, like `balance` is of the receivable.
        depositAmount: 0,
      },
    });

    // A deposit taken at move-in is money that moved, so it goes on the
    // ledger. In THIS transaction, so the account and the deposit it was
    // opened with commit together or not at all.
    if (data.depositAmount && data.depositAmount > 0) {
      const { recordDeposit } = await import("./ar/deposit.service.js");
      await recordDeposit(
        utilityId,
        actorId,
        actorName,
        account.id,
        {
          amount: data.depositAmount.toFixed(2),
          // So the deposit can be tied out against the bank slip it
          // arrived on; absent means unknown rather than zero.
          tender: data.depositTender,
          memo: "Deposit taken at move-in",
        },
        tx,
      );
    }

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
        servicePoints: { some: { premiseId: data.premiseId, endDate: null } },
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
      /*
       * `FINAL`, not `CLOSED` — for now.
       *
       * Spec 04 defines `FINAL` as "final bill being prepared", and
       * that is exactly where this account is: the service has stopped
       * and the last days are not billed yet. The account is closed
       * below, once the bill exists or once it is clear there is
       * nothing to bill. `closeServiceAgreement` already describes the
       * same step for an agreement — "FINAL → CLOSED is a legitimate
       * billing-lifecycle step (final bill issued)".
       *
       * `closedAt` is deliberately not set here: the account is not
       * closed.
       */
      account = await tx.account.update({
        where: { id: data.accountId },
        data: { status: "FINAL" },
      });
    }

    /**
     * Return the deposit, if asked.
     *
     * `refundDeposit` has been on this payload and on the move-out form
     * since the workflow shipped, and nothing read it — an operator
     * ticked a box and no money moved. This is where it starts meaning
     * something, and it has to be here rather than as a follow-up step
     * because closing an account is exactly what strands a deposit: the
     * absorb-into-next-charge mechanism that makes a credit harmless on
     * an active account has no next charge to work with.
     *
     * In THIS transaction, so a move-out that fails does not leave a
     * cheque recorded against an account that was never closed.
     *
     * Deliberately NOT applied to the final bill first. The deposit pool
     * is excluded from allocation on purpose, and deciding to withhold
     * against what is owed is a policy judgement nobody has made here —
     * so the full amount is returned and what the account still owes is
     * reported back, for the operator to see rather than discover.
     */
    let depositReturn: {
      refunded: string;
      entryId: string | null;
      stillOwed: string;
    } | null = null;
    if (data.refundDeposit) {
      const { recordRefund, availableToRefund } = await import("./ar/refund.service.js");
      const held = await availableToRefund(tx, utilityId, data.accountId, "DEPOSIT");
      if (held.gt(0)) {
        const issued = await recordRefund(
          utilityId,
          actorId,
          actorName,
          data.accountId,
          {
            amount: held.toFixed(2),
            source: "DEPOSIT",
            tender: data.depositTender,
            memo: `Deposit returned at move-out from premise ${data.premiseId}`,
            issuedOn: data.moveOutDate,
          },
          tx,
        );
        depositReturn = {
          refunded: issued.amount,
          entryId: issued.entryId,
          stillOwed: issued.balance,
        };
      } else {
        // Asked for, nothing held. Reported rather than silent, so the
        // operator is not left believing a cheque is coming.
        const current = await tx.account.findFirstOrThrow({
          where: { id: data.accountId, utilityId },
          select: { balance: true },
        });
        depositReturn = {
          refunded: "0.00",
          entryId: null,
          stillOwed: current.balance.toFixed(2),
        };
      }
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
        depositReturned: depositReturn?.refunded ?? null,
      },
    );

    return {
      accountId: data.accountId,
      finalizedAgreements: activeAgreements,
      account,
      depositReturn,
    };
  });

  /*
   * The final bill (Req 134), and only when the account is closing.
   *
   * **After the transaction, not inside it.** Stopping service is a
   * physical fact somebody has already acted on, and rating can fail
   * for reasons that have nothing to do with it — an unpublished
   * tariff, a gap in interval data. A move-out that rolled back over
   * one would send the operator back to re-enter a move-out that had,
   * in every sense that matters, happened. So the service stops, the
   * account waits at `FINAL`, and the reason is reported.
   *
   * **Only when `closeAccount`.** Closing one premise of several leaves
   * the account live, and the part-period for the service that stopped
   * is billed by its next cycle run — which is what the run's window
   * filter was fixed to do on 2026-11-08. A separate bill there would
   * be a second bill in the same month for a customer who is getting
   * one anyway.
   *
   * Dated the move-out date, so a read taken after service stopped
   * belongs to nobody's final bill.
   */
  let finalBill: FinalBillResult | null = null;
  if (data.closeAccount) {
    const { generateFinalBill } = await import("./final-bill.service.js");
    try {
      finalBill = await generateFinalBill(utilityId, actorId, actorName, data.accountId, {
        asOf: new Date(data.moveOutDate),
      });
    } catch (err) {
      finalBill = {
        billId: null,
        total: null,
        error: err instanceof Error ? err.message : "The final bill could not be produced",
      };
    }

    /*
     * Closed once there is nothing left to do: a bill was produced, or
     * there was nothing to bill. A fault leaves the account at `FINAL`
     * for somebody to act on — which is the one state where `FINAL`
     * means what spec 04 says it means, rather than a status nothing
     * ever set.
     */
    if (!finalBill.error) {
      await prisma.account.update({
        where: { id: data.accountId },
        data: { status: "CLOSED", closedAt: new Date(data.moveOutDate) },
      });
    }
  }

  /*
   * The balance after the bill, not the one from inside the
   * transaction.
   *
   * `depositReturn.stillOwed` is computed where the refund is written,
   * which is before the final bill exists — so an operator handing back
   * a deposit was told what the account owed *excluding* the charges
   * about to be raised. Reported alongside rather than overwritten, so
   * the refund's own figure still reads as what it was at the time.
   */
  const closingBalance = finalBill?.billId
    ? (
        await prisma.account.findFirstOrThrow({
          where: { id: data.accountId, utilityId },
          select: { balance: true },
        })
      ).balance.toFixed(2)
    : null;

  return { ...result, finalBill, closingBalance };
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
