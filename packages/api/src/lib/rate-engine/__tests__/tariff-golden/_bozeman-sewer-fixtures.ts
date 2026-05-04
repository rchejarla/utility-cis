import type { RateComponentSnapshot, ResolvedAssignment } from "../../types.js";

const SCHEDULE_ID = "rs-bozeman-sewer";
const EFF_DATE = new Date(2025, 8, 15);

// Linked-commodity components reference the upstream water commodity ID by
// convention. Tests must seed `linked:<LINKED_COMMODITY_ID>:current_period`.
export const LINKED_COMMODITY_ID = "c-water";

export function bozemanSewerComponents(): RateComponentSnapshot[] {
  return [
    // ── Service charges (3 separate components covering all classes) ──
    {
      id: "c-sewer-svc-residential",
      rateScheduleId: SCHEDULE_ID,
      kindCode: "service_charge",
      label: "Sewer Service Charge — Residential",
      sortOrder: 10,
      effectiveDate: EFF_DATE,
      expirationDate: null,
      predicate: { class: "residential" },
      quantitySource: { base: "fixed" },
      pricing: { type: "flat", rate: 24.65 },
    },
    {
      id: "c-sewer-svc-mid",
      rateScheduleId: SCHEDULE_ID,
      kindCode: "service_charge",
      label: "Sewer Service Charge — Mid-Class Group",
      sortOrder: 11,
      effectiveDate: EFF_DATE,
      expirationDate: null,
      predicate: { class_in: ["multi_family", "commercial", "government", "msu"] },
      quantitySource: { base: "fixed" },
      pricing: { type: "flat", rate: 25.26 },
    },
    {
      id: "c-sewer-svc-industrial",
      rateScheduleId: SCHEDULE_ID,
      kindCode: "service_charge",
      label: "Sewer Service Charge — Industrial",
      sortOrder: 12,
      effectiveDate: EFF_DATE,
      expirationDate: null,
      predicate: { class: "industrial" },
      quantitySource: { base: "fixed" },
      pricing: { type: "flat", rate: 49.06 },
    },

    // ── Derived consumption — WQA-based (Residential + MSU) ──
    {
      id: "c-sewer-derived-residential",
      rateScheduleId: SCHEDULE_ID,
      kindCode: "derived_consumption",
      label: "Sewer Usage — Residential (WQA)",
      sortOrder: 20,
      effectiveDate: EFF_DATE,
      expirationDate: null,
      predicate: { class: "residential" },
      quantitySource: { base: "wqa" },
      pricing: { type: "flat", rate: 4.12, unit: "HCF" },
    },
    {
      id: "c-sewer-derived-msu",
      rateScheduleId: SCHEDULE_ID,
      kindCode: "derived_consumption",
      label: "Sewer Usage — MSU (WQA)",
      sortOrder: 21,
      effectiveDate: EFF_DATE,
      expirationDate: null,
      predicate: { class: "msu" },
      quantitySource: { base: "wqa" },
      pricing: { type: "flat", rate: 4.92, unit: "HCF" },
    },

    // ── Derived consumption — linked-commodity-based (4 classes) ──
    {
      id: "c-sewer-derived-multi-family",
      rateScheduleId: SCHEDULE_ID,
      kindCode: "derived_consumption",
      label: "Sewer Usage — Multi-Family (Linked)",
      sortOrder: 22,
      effectiveDate: EFF_DATE,
      expirationDate: null,
      predicate: { class: "multi_family" },
      quantitySource: { base: "linked_commodity" },
      pricing: { type: "flat", rate: 4.62, unit: "HCF" },
    },
    {
      id: "c-sewer-derived-commercial",
      rateScheduleId: SCHEDULE_ID,
      kindCode: "derived_consumption",
      label: "Sewer Usage — Commercial (Linked)",
      sortOrder: 23,
      effectiveDate: EFF_DATE,
      expirationDate: null,
      predicate: { class: "commercial" },
      quantitySource: { base: "linked_commodity" },
      pricing: { type: "flat", rate: 5.13, unit: "HCF" },
    },
    {
      id: "c-sewer-derived-government",
      rateScheduleId: SCHEDULE_ID,
      kindCode: "derived_consumption",
      label: "Sewer Usage — Government (Linked)",
      sortOrder: 24,
      effectiveDate: EFF_DATE,
      expirationDate: null,
      predicate: { class: "government" },
      quantitySource: { base: "linked_commodity" },
      pricing: { type: "flat", rate: 5.13, unit: "HCF" },
    },
    {
      id: "c-sewer-derived-industrial",
      rateScheduleId: SCHEDULE_ID,
      kindCode: "derived_consumption",
      label: "Sewer Usage — Industrial (Linked)",
      sortOrder: 25,
      effectiveDate: EFF_DATE,
      expirationDate: null,
      predicate: { class: "industrial" },
      quantitySource: { base: "linked_commodity" },
      pricing: { type: "flat", rate: 6.18, unit: "HCF" },
    },
  ];
}

export function bozemanSewerAssignment(
  components: RateComponentSnapshot[],
): ResolvedAssignment {
  return {
    id: "a-bzn-sewer",
    rateScheduleId: SCHEDULE_ID,
    roleCode: "primary",
    effectiveDate: EFF_DATE,
    expirationDate: null,
    schedule: {
      id: SCHEDULE_ID,
      name: "Bozeman Sewer 2025-09",
      code: "BZN-SEWER",
      version: 1,
      components,
    },
  };
}
