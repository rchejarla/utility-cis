import type { RateComponentSnapshot, ResolvedAssignment } from "../../types.js";

const SCHEDULE_ID = "rs-bozeman-water";
const EFF_DATE = new Date(2025, 8, 15);

export function bozemanWaterComponents(): RateComponentSnapshot[] {
  return [
    // 1. Service charge (lookup by meter size)
    {
      id: "c-service-charge",
      rateScheduleId: SCHEDULE_ID,
      kindCode: "service_charge",
      label: "Water Service Charge",
      sortOrder: 10,
      effectiveDate: EFF_DATE,
      expirationDate: null,
      predicate: {},
      quantitySource: { base: "fixed" },
      pricing: {
        type: "lookup",
        by: "meter_size",
        table: {
          '5/8"': 22.31,
          '1"': 29.56,
          '1.5"': 46.52,
          '2"': 67.64,
          '3"': 116.92,
          '4"': 187.5,
          '6"': 349.42,
          '8"': 552.48,
        },
      },
    },
    // 2. SFR consumption (4-tier inclining)
    {
      id: "c-consumption-sfr",
      rateScheduleId: SCHEDULE_ID,
      kindCode: "consumption",
      label: "Water Usage — Single Family",
      sortOrder: 20,
      effectiveDate: EFF_DATE,
      expirationDate: null,
      predicate: { class: "single_family" },
      quantitySource: { base: "metered" },
      pricing: {
        type: "tiered",
        tiers: [
          { to: 6, rate: 3.31 },
          { to: 25, rate: 4.58 },
          { to: 55, rate: 6.39 },
          { to: null, rate: 9.58 },
        ],
      },
    },
    // 3. Multi-Family consumption (flat)
    {
      id: "c-consumption-mf",
      rateScheduleId: SCHEDULE_ID,
      kindCode: "consumption",
      label: "Water Usage — Multi-Family",
      sortOrder: 21,
      effectiveDate: EFF_DATE,
      expirationDate: null,
      predicate: { class: "multi_family" },
      quantitySource: { base: "metered" },
      pricing: { type: "flat", rate: 3.01, unit: "HCF" },
    },
    // 4. Government, MSU, Commercial — same shape as Multi-Family
    {
      id: "c-consumption-gov",
      rateScheduleId: SCHEDULE_ID,
      kindCode: "consumption",
      label: "Water Usage — Government",
      sortOrder: 22,
      effectiveDate: EFF_DATE,
      expirationDate: null,
      predicate: { class: "government" },
      quantitySource: { base: "metered" },
      pricing: { type: "flat", rate: 5.74, unit: "HCF" },
    },
    {
      id: "c-consumption-msu",
      rateScheduleId: SCHEDULE_ID,
      kindCode: "consumption",
      label: "Water Usage — MSU",
      sortOrder: 23,
      effectiveDate: EFF_DATE,
      expirationDate: null,
      predicate: { class: "msu" },
      quantitySource: { base: "metered" },
      pricing: { type: "flat", rate: 3.77, unit: "HCF" },
    },
    {
      id: "c-consumption-com",
      rateScheduleId: SCHEDULE_ID,
      kindCode: "consumption",
      label: "Water Usage — Commercial",
      sortOrder: 24,
      effectiveDate: EFF_DATE,
      expirationDate: null,
      predicate: { class: "commercial" },
      quantitySource: { base: "metered" },
      pricing: { type: "flat", rate: 3.4, unit: "HCF" },
    },
    // 5. SFR minimum bill
    {
      id: "c-min-bill",
      rateScheduleId: SCHEDULE_ID,
      kindCode: "minimum_bill",
      label: "Water Minimum Bill",
      sortOrder: 90,
      effectiveDate: EFF_DATE,
      expirationDate: null,
      predicate: { class: "single_family" },
      quantitySource: { base: "fixed" },
      pricing: { type: "floor", amount: 6.62, applies_to_subtotal: true },
    },
    // 6. Drought reserve
    {
      id: "c-drought-reserve",
      rateScheduleId: SCHEDULE_ID,
      kindCode: "surcharge",
      label: "Drought Reserve",
      sortOrder: 80,
      effectiveDate: EFF_DATE,
      expirationDate: null,
      predicate: { drought_stage_active: true },
      quantitySource: { base: "metered" },
      pricing: { type: "flat", rate: 0.11, unit: "HCF" },
    },
    // 7. Drought stage surcharge (% of consumption)
    {
      id: "c-drought-surcharge",
      rateScheduleId: SCHEDULE_ID,
      kindCode: "surcharge",
      label: "Drought Stage Surcharge",
      sortOrder: 81,
      effectiveDate: EFF_DATE,
      expirationDate: null,
      predicate: { drought_stage_active: true },
      quantitySource: { base: "metered" },
      pricing: { type: "percent_of", selector: { kind: "consumption" }, percent: 25 },
    },
  ];
}

export function bozemanWaterAssignment(
  components: RateComponentSnapshot[],
): ResolvedAssignment {
  return {
    id: "a-bzn-water",
    rateScheduleId: SCHEDULE_ID,
    roleCode: "primary",
    effectiveDate: EFF_DATE,
    expirationDate: null,
    schedule: {
      id: SCHEDULE_ID,
      name: "Bozeman Water 2025-09",
      code: "BZN-WATER",
      version: 1,
      components,
    },
  };
}
