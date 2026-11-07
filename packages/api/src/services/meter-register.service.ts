import { prisma } from "../lib/prisma.js";
import { EVENT_TYPES } from "@utility-cis/shared";
import { auditUpdate } from "../lib/audit-wrap.js";

/**
 * Which TOU period a register counts (spec 26, TOU-REG-1, TOU-UI-4).
 *
 * The one write a register has. There is no register CRUD: registers
 * arrive with the meter, from an import or the seed, and the thing a
 * person needs to change about one is this — the *utility's assignment
 * of meaning to a dial*. The meter reports a number; "register 2 means
 * on-peak" is ours to say.
 *
 * It is not versioned or effective-dated, and must not become the
 * declaration of which periods are answerable: `createMeterRead`
 * stamps the code onto each read, so a re-rate reproduces the bill
 * from what was stamped rather than from today's mapping. Changing
 * this therefore changes future reads only, which is what makes it
 * safe to change at all.
 */
export async function assignTouPeriod(
  utilityId: string,
  actorId: string,
  actorName: string,
  registerId: string,
  peakCode: string | null,
) {
  const before = await prisma.meterRegister.findFirst({
    where: { id: registerId, utilityId },
  });
  if (!before) {
    throw Object.assign(new Error("Register not found."), {
      statusCode: 404,
      code: "REGISTER_NOT_FOUND",
    });
  }

  if (peakCode !== null) {
    /*
     * Against the tenant's periods, which is the whole list — a code
     * no period declares would stamp reads that no charge can price,
     * and `tou_period` raises at rating rather than billing a zero. The
     * refusal is cheaper here, where a person can read it.
     */
    const period = await prisma.touPeriod.findFirst({
      where: { utilityId, peakCode },
      select: { peakCode: true },
    });
    if (!period) {
      const known = await prisma.touPeriod.findMany({
        where: { utilityId },
        select: { peakCode: true },
        orderBy: { sortOrder: "asc" },
      });
      throw Object.assign(
        new Error(
          `"${peakCode}" is not one of this utility's TOU periods. ` +
            `They are: ${known.map((p) => p.peakCode).join(", ") || "none defined yet"}.`,
        ),
        { statusCode: 400, code: "PEAK_CODE_UNKNOWN" },
      );
    }

    /*
     * One register per period per meter — `meter_register_one_per_peak_code`
     * says the same thing in the database. Two registers claiming
     * on-peak would make the bucket depend on row order and the loader
     * sums, so the usage would be counted twice at the most expensive
     * rate. Said here first, naming the register already holding it.
     */
    const taken = await prisma.meterRegister.findFirst({
      where: { utilityId, meterId: before.meterId, peakCode, id: { not: registerId } },
      select: { registerNumber: true },
    });
    if (taken) {
      throw Object.assign(
        new Error(
          `Register ${taken.registerNumber} on this meter already counts "${peakCode}". ` +
            "Two registers counting one period would bill that usage twice.",
        ),
        { statusCode: 409, code: "PEAK_CODE_TAKEN" },
      );
    }
  }

  return auditUpdate(
    { utilityId, actorId, actorName, entityType: "MeterRegister" },
    EVENT_TYPES.METER_REGISTER_TOU_PERIOD_SET,
    before,
    (tx) =>
      tx.meterRegister.update({
        where: { id: registerId },
        data: { peakCode },
      }),
  );
}
