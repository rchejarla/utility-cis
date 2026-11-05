import type { FastifyInstance } from "fastify";
import {
  assignTouPeriodSchema,
  createMeterSchema,
  updateMeterSchema,
  meterQuerySchema,
} from "@utility-cis/shared";
import {
  listMeters,
  getMeter,
  createMeter,
  updateMeter,
} from "../services/meter.service.js";
import { assignTouPeriod } from "../services/meter-register.service.js";
import { idParamSchema } from "../lib/route-schemas.js";
import { registerCrudRoutes } from "../lib/crud-routes.js";

export async function meterRoutes(app: FastifyInstance) {
  registerCrudRoutes(app, {
    basePath: "/api/v1/meters",
    module: "meters",
    // Mirrored from a legacy CIS in overlay mode, so staff writes are
    // refused there (spec 28, OVL-T-3). Reads and the overlay import
    // are untouched.
    mirroredFromLegacy: true,
    list: {
      querySchema: meterQuerySchema,
      service: (utilityId, query) => listMeters(utilityId, query as never),
    },
    get: getMeter,
    create: {
      bodySchema: createMeterSchema,
      service: (user, data) =>
        createMeter(user.utilityId, user.actorId, user.actorName, data as never),
    },
    update: {
      bodySchema: updateMeterSchema,
      service: (user, id, data) =>
        updateMeter(user.utilityId, user.actorId, user.actorName, id, data as never),
    },
  });

  /*
   * The register's one write (spec 26, TOU-UI-4).
   *
   * Deliberately not `refusedWhenMirrored`, unlike the meter writes
   * above: in overlay mode the legacy CIS owns the meter, but the TOU
   * mapping is an input to *our* rating and changes nothing in theirs.
   * Refusing it would leave a shadow-rated TOU meter unbucketable,
   * which is the one thing overlay mode exists to do.
   */
  app.put(
    "/api/v1/meter-registers/:id/tou-period",
    { config: { module: "meters", permission: "EDIT" } },
    async (request) => {
      const { utilityId, id: actorId, name: actorName } = request.user;
      const { id } = idParamSchema.parse(request.params);
      const { peakCode } = assignTouPeriodSchema.parse(request.body);
      return assignTouPeriod(utilityId, actorId, actorName, id, peakCode);
    },
  );
}
