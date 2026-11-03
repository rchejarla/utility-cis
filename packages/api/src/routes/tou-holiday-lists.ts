import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { resolveHolidays, type HolidayObservance, type HolidayRule, type IsoWeekday } from "../lib/rate-engine/holidays.js";
import { registerCrudRoutes } from "../lib/crud-routes.js";
import { idParamSchema } from "../lib/route-schemas.js";

/**
 * A tenant's holiday lists and the dates their rules resolve to
 * (spec 26, TOU-UI-2 and TOU-UI-2a).
 *
 * **A list is shared across calendars**, with each calendar naming the
 * one it uses: a utility's holidays do not vary by tariff, and per
 * calendar, adding a holiday would mean editing three and missing one.
 *
 * Read only for now — the rules are still inserted by hand. What is
 * here is the half that cannot wait: **the resolved dates beside the
 * rule that produced them**. A rule nobody can see the output of is a
 * rule nobody will trust, and the observance rules are where the
 * surprises live — a Saturday holiday observed on the Friday moves a
 * peak day, and that is not visible from "4 July, nearest weekday".
 */

const listQuerySchema = z
  .object({
    page: z.coerce.number().int().positive().default(1),
    limit: z.coerce.number().int().positive().max(500).default(100),
    sort: z.enum(["name", "createdAt"]).default("name"),
    order: z.enum(["asc", "desc"]).default("asc"),
  })
  .strict();

/** Current year and the next two (TOU-UI-2). */
const resolvedQuerySchema = z
  .object({ fromYear: z.coerce.number().int().min(1970).max(2200).optional() })
  .strict();

const RULE_ORDER = [{ month: "asc" as const }, { code: "asc" as const }];

export async function touHolidayListRoutes(app: FastifyInstance) {
  registerCrudRoutes(app, {
    basePath: "/api/v1/tou-holiday-lists",
    module: "rate_schedules",
    list: {
      querySchema: listQuerySchema,
      service: async (utilityId, query) => {
        const q = query as z.infer<typeof listQuerySchema>;
        const where = { utilityId };
        const [rows, total] = await Promise.all([
          prisma.touHolidayList.findMany({
            where,
            include: { _count: { select: { rules: true } } },
            orderBy: { [q.sort]: q.order },
            skip: (q.page - 1) * q.limit,
            take: q.limit,
          }),
          prisma.touHolidayList.count({ where }),
        ]);
        return { data: rows, pagination: { page: q.page, limit: q.limit, total } };
      },
    },
    get: async (id, utilityId) =>
      prisma.touHolidayList.findFirstOrThrow({
        where: { id, utilityId },
        include: { rules: { orderBy: RULE_ORDER } },
      }),
  });

  /**
   * Each rule with the dates it produces over three years, and whether
   * the observance rule moved them.
   */
  app.get(
    "/api/v1/tou-holiday-lists/:id/resolved",
    { config: { module: "rate_schedules", permission: "VIEW" } },
    async (request, reply) => {
      const { utilityId } = request.user;
      const { id } = idParamSchema.parse(request.params);
      const { fromYear } = resolvedQuerySchema.parse(request.query);

      const list = await prisma.touHolidayList.findFirstOrThrow({
        where: { id, utilityId },
        include: { rules: { orderBy: RULE_ORDER } },
      });

      const rules: HolidayRule[] = list.rules.map((r) => ({
        code: r.code,
        label: r.label,
        kind: r.kind as HolidayRule["kind"],
        month: r.month,
        day: r.day ?? undefined,
        weekday: (r.weekday ?? undefined) as IsoWeekday | undefined,
        nth: r.nth ?? undefined,
        observance: r.observance as HolidayObservance,
      }));

      const start = fromYear ?? new Date().getUTCFullYear();
      const resolved = resolveHolidays(rules, start, start + 2).map((r) => {
        const actual = r.actual.toISOString().slice(0, 10);
        const observed = r.observed.toISOString().slice(0, 10);
        return {
          code: r.code,
          label: r.label,
          year: r.year,
          actual,
          observed,
          /*
           * The two facts an operator is checking for. `moved` is the
           * one that changes a bill: the day the utility treats as the
           * holiday is not the day the rule names, so a peak weekday
           * becomes off-peak and a weekend day stops mattering.
           */
          moved: actual !== observed,
          sharesObservedDate: r.sharesObservedDate,
        };
      });

      return reply.status(200).send({
        id: list.id,
        name: list.name,
        fromYear: start,
        toYear: start + 2,
        rules: list.rules,
        resolved,
      });
    },
  );
}
