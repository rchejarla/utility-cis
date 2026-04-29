import { EVENT_TYPES } from "@utility-cis/shared";
import { writeAuditRow } from "../../lib/audit-wrap.js";
import { prisma } from "../../lib/prisma.js";
import { registerImportKind } from "../registry.js";
import type { ImportKindHandler } from "../types.js";

/**
 * Premise import kind handler. Used for GIS sync re-loads, legacy
 * migrations, and bulk service-territory expansion.
 *
 * Per-row pipeline (within the framework-supplied tx):
 *   1. Optionally resolve `ownerEmail` → ownerId via the customer
 *      lookup map built in prepareBatch.
 *   2. Optionally resolve a comma-separated `commodityCodes` list
 *      (e.g. "WATER,SEWER") → uuid[] via the commodity lookup map.
 *   3. Insert one Premise row.
 *   4. Emit audit row.
 *
 * Owner is optional — premises can be unowned (e.g., greenfield builds
 * before customer assignment). An ownerEmail that doesn't match an
 * existing customer is recorded as a row error rather than creating
 * the premise unowned, because silent FK drops mask data quality
 * problems operators want to see.
 */

const PREMISE_TYPES = ["RESIDENTIAL", "COMMERCIAL", "INDUSTRIAL", "MUNICIPAL"] as const;
const PREMISE_STATUSES = ["ACTIVE", "INACTIVE", "CONDEMNED"] as const;
type PremiseType = (typeof PREMISE_TYPES)[number];
type PremiseStatus = (typeof PREMISE_STATUSES)[number];

interface PremiseRow {
  addressLine1: string;
  addressLine2?: string;
  city: string;
  state: string;
  zip: string;
  premiseType: PremiseType;
  ownerEmail?: string;
  commodityCodes?: string[];
  serviceTerritory?: string;
  municipalityCode?: string;
  status?: PremiseStatus;
  geoLat?: number;
  geoLng?: number;
}

interface BatchData {
  /** Lower-cased email → customer id, populated once per batch. */
  customerByEmail: Map<string, string>;
  /** Upper-cased commodity code → commodity id, populated once. */
  commodityByCode: Map<string, string>;
}

const handler: ImportKindHandler<PremiseRow, BatchData> = {
  kind: "premise",
  label: "Premises",
  module: "premises",
  permission: "CREATE",

  canonicalFields: [
    {
      name: "addressLine1",
      label: "Address line 1",
      required: true,
      example: "742 Evergreen Terrace",
      aliases: ["^addressline1$", "^address1$", "^address$", "^street$", "^streetaddress$"],
    },
    {
      name: "addressLine2",
      label: "Address line 2",
      required: false,
      example: "Apt 3B",
      aliases: ["^addressline2$", "^address2$", "^unit$", "^suite$", "^apartment$"],
    },
    {
      name: "city",
      label: "City",
      required: true,
      example: "Springfield",
      aliases: ["^city$", "^town$"],
    },
    {
      name: "state",
      label: "State",
      required: true,
      description: "Two-letter state code.",
      example: "IL",
      aliases: ["^state$", "^province$", "^statecode$"],
    },
    {
      name: "zip",
      label: "ZIP",
      required: true,
      example: "62704",
      aliases: ["^zip$", "^zipcode$", "^postal$", "^postalcode$"],
    },
    {
      name: "premiseType",
      label: "Premise type",
      required: true,
      description: "RESIDENTIAL, COMMERCIAL, INDUSTRIAL, or MUNICIPAL.",
      example: "RESIDENTIAL",
      aliases: ["^premisetype$", "^type$", "^propertytype$"],
    },
    {
      name: "ownerEmail",
      label: "Owner email",
      required: false,
      description: "Resolves to an existing customer by email. Unmatched → row error.",
      example: "owner@example.com",
      aliases: ["^owneremail$", "^customeremail$"],
    },
    {
      name: "commodityCodes",
      label: "Commodity codes",
      required: false,
      description: "Comma-separated list, e.g. \"WATER,SEWER\".",
      example: "WATER,SEWER",
      aliases: ["^commoditycodes$", "^commodities$", "^services$"],
    },
    {
      name: "serviceTerritory",
      label: "Service territory",
      required: false,
      example: "ST-NORTH",
      aliases: ["^serviceterritory$", "^territory$"],
    },
    {
      name: "municipalityCode",
      label: "Municipality code",
      required: false,
      example: "SPRINGFIELD-IL",
      aliases: ["^municipalitycode$", "^municipality$", "^muni$"],
    },
    {
      name: "status",
      label: "Status",
      required: false,
      description: "ACTIVE (default), INACTIVE, or CONDEMNED.",
      example: "ACTIVE",
      aliases: ["^status$", "^state$"],
    },
    {
      name: "geoLat",
      label: "Latitude",
      required: false,
      example: "39.7817",
      aliases: ["^geolat$", "^latitude$", "^lat$"],
    },
    {
      name: "geoLng",
      label: "Longitude",
      required: false,
      example: "-89.6501",
      aliases: ["^geolng$", "^geolon$", "^longitude$", "^lng$", "^lon$"],
    },
  ],

  templateRows: [
    {
      addressLine1: "742 Evergreen Terrace",
      addressLine2: "",
      city: "Springfield",
      state: "IL",
      zip: "62704",
      premiseType: "RESIDENTIAL",
      ownerEmail: "owner@example.com",
      commodityCodes: "WATER,SEWER",
      serviceTerritory: "ST-NORTH",
      municipalityCode: "SPRINGFIELD-IL",
      status: "ACTIVE",
      geoLat: "39.7817",
      geoLng: "-89.6501",
    },
  ],

  parseRow: (raw) => {
    const addr1 = (raw.addressLine1 ?? "").trim();
    if (!addr1) {
      return { ok: false, code: "MISSING_ADDRESS", message: "address_line1 is required" };
    }
    const city = (raw.city ?? "").trim();
    if (!city) return { ok: false, code: "MISSING_CITY", message: "city is required" };
    const state = (raw.state ?? "").trim().toUpperCase();
    if (!state || state.length !== 2) {
      return {
        ok: false,
        code: "INVALID_STATE",
        message: `state "${raw.state}" must be a two-letter code`,
      };
    }
    const zip = (raw.zip ?? "").trim();
    if (!zip) return { ok: false, code: "MISSING_ZIP", message: "zip is required" };

    const ptRaw = (raw.premiseType ?? "").trim().toUpperCase();
    if (!PREMISE_TYPES.includes(ptRaw as PremiseType)) {
      return {
        ok: false,
        code: "INVALID_PREMISE_TYPE",
        message: `premise_type "${raw.premiseType}" must be one of ${PREMISE_TYPES.join(", ")}`,
      };
    }
    const premiseType = ptRaw as PremiseType;

    const statusRaw = (raw.status ?? "").trim().toUpperCase();
    let status: PremiseStatus | undefined;
    if (statusRaw) {
      if (!PREMISE_STATUSES.includes(statusRaw as PremiseStatus)) {
        return {
          ok: false,
          code: "INVALID_STATUS",
          message: `status "${raw.status}" must be one of ${PREMISE_STATUSES.join(", ")}`,
        };
      }
      status = statusRaw as PremiseStatus;
    }

    // commodity codes: comma-separated, normalised upper-case.
    const commodityCodes = (raw.commodityCodes ?? "")
      .split(",")
      .map((s) => s.trim().toUpperCase())
      .filter(Boolean);

    // Numeric coords — only validate if provided.
    let geoLat: number | undefined;
    let geoLng: number | undefined;
    if ((raw.geoLat ?? "").trim()) {
      const n = Number(raw.geoLat);
      if (!Number.isFinite(n) || n < -90 || n > 90) {
        return {
          ok: false,
          code: "INVALID_LAT",
          message: `geo_lat "${raw.geoLat}" must be a number between -90 and 90`,
        };
      }
      geoLat = n;
    }
    if ((raw.geoLng ?? "").trim()) {
      const n = Number(raw.geoLng);
      if (!Number.isFinite(n) || n < -180 || n > 180) {
        return {
          ok: false,
          code: "INVALID_LNG",
          message: `geo_lng "${raw.geoLng}" must be a number between -180 and 180`,
        };
      }
      geoLng = n;
    }

    return {
      ok: true,
      row: {
        addressLine1: addr1,
        addressLine2: ((raw.addressLine2 ?? "").trim()) || undefined,
        city,
        state,
        zip,
        premiseType,
        ownerEmail: ((raw.ownerEmail ?? "").trim().toLowerCase()) || undefined,
        commodityCodes: commodityCodes.length > 0 ? commodityCodes : undefined,
        serviceTerritory: ((raw.serviceTerritory ?? "").trim()) || undefined,
        municipalityCode: ((raw.municipalityCode ?? "").trim()) || undefined,
        status,
        geoLat,
        geoLng,
      },
    };
  },

  async prepareBatch(ctx, rows) {
    // Owner-email → customer id. One query, used per row.
    const emails = new Set<string>();
    const codes = new Set<string>();
    for (const r of rows) {
      if (r.ownerEmail) emails.add(r.ownerEmail);
      if (r.commodityCodes) for (const c of r.commodityCodes) codes.add(c);
    }
    const customerByEmail = new Map<string, string>();
    if (emails.size > 0) {
      const customers = await prisma.customer.findMany({
        where: { utilityId: ctx.utilityId, email: { in: [...emails] } },
        select: { id: true, email: true },
      });
      for (const c of customers) {
        if (c.email) customerByEmail.set(c.email.toLowerCase(), c.id);
      }
    }
    const commodityByCode = new Map<string, string>();
    if (codes.size > 0) {
      const commodities = await prisma.commodity.findMany({
        where: { utilityId: ctx.utilityId, code: { in: [...codes] } },
        select: { id: true, code: true },
      });
      for (const c of commodities) commodityByCode.set(c.code.toUpperCase(), c.id);
    }
    return { customerByEmail, commodityByCode };
  },

  async processRow(ctx, row, batch) {
    let ownerId: string | null = null;
    if (row.ownerEmail) {
      const id = batch.customerByEmail.get(row.ownerEmail);
      if (!id) {
        return {
          ok: false,
          code: "OWNER_NOT_FOUND",
          message: `No customer with email "${row.ownerEmail}"`,
        };
      }
      ownerId = id;
    }

    let commodityIds: string[] = [];
    if (row.commodityCodes) {
      for (const code of row.commodityCodes) {
        const id = batch.commodityByCode.get(code);
        if (!id) {
          return {
            ok: false,
            code: "COMMODITY_NOT_FOUND",
            message: `No commodity with code "${code}"`,
          };
        }
        commodityIds.push(id);
      }
    }

    const created = await ctx.tx.premise.create({
      data: {
        utilityId: ctx.utilityId,
        addressLine1: row.addressLine1,
        addressLine2: row.addressLine2 ?? null,
        city: row.city,
        state: row.state,
        zip: row.zip,
        premiseType: row.premiseType,
        ownerId,
        commodityIds,
        serviceTerritoryId: null, // serviceTerritory string would need its own lookup; defer
        municipalityCode: row.municipalityCode ?? null,
        status: row.status ?? "ACTIVE",
        geoLat: row.geoLat ?? null,
        geoLng: row.geoLng ?? null,
      },
    });

    await writeAuditRow(
      ctx.tx,
      {
        utilityId: ctx.utilityId,
        actorId: ctx.actorId,
        actorName: ctx.actorName,
        entityType: "Premise",
      },
      EVENT_TYPES.PREMISE_CREATED,
      created.id,
      null,
      created,
    );

    return { ok: true, entityId: created.id };
  },
};

registerImportKind(handler);
