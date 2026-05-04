import type { Decimal } from "./decimal.js";

export type VariableKey = string;
export type VariableValue = unknown;

export interface ServiceAgreementSnapshot {
  id: string;
  utilityId: string;
  accountId: string;
  premiseId: string;
  commodityId: string;
  rateServiceClassCode?: string;
}

export interface AccountSnapshot {
  id: string;
  accountNumber: string;
  customerType?: string;
}

export interface PremiseSnapshot {
  id: string;
  premiseType: string;
  eruCount: Decimal | null;
  hasStormwaterInfra: boolean;
  [k: string]: unknown;
}

export interface RateComponentSnapshot {
  id: string;
  rateScheduleId: string;
  kindCode: string;
  label: string;
  predicate: unknown;
  quantitySource: unknown;
  pricing: unknown;
  sortOrder: number;
  effectiveDate: Date;
  expirationDate: Date | null;
}

export interface ResolvedAssignment {
  id: string;
  rateScheduleId: string;
  roleCode: string;
  effectiveDate: Date;
  expirationDate: Date | null;
  schedule: {
    id: string;
    name: string;
    code: string;
    version: number;
    components: RateComponentSnapshot[];
  };
}

export interface BaseContext {
  sa: ServiceAgreementSnapshot;
  account: AccountSnapshot;
  premise: PremiseSnapshot;
  period: { startDate: Date; endDate: Date };
  assignments: ResolvedAssignment[];
}

export interface RatingContext {
  base: BaseContext;
  vars: Map<VariableKey, VariableValue>;
}

export interface LineItem {
  label: string;
  amount: Decimal;
  kindCode: string;
  sourceScheduleId: string;
  sourceComponentId: string;
  quantity?: Decimal;
  rate?: unknown;
}

export interface ComponentTrace {
  componentId: string;
  fired: boolean;
  skipReason?: "predicate_false" | "selector_empty" | "zero_amount" | "silent_minimum" | "unsupported_in_slice_3";
  evaluatedQuantity?: Decimal;
  evaluatedRate?: unknown;
  evaluatedAmount?: Decimal;
  variableKeysUsed?: VariableKey[];
}

export interface RatingResult {
  lines: LineItem[];
  totals: {
    subtotal: Decimal;
    taxes: Decimal;
    credits: Decimal;
    minimumFloorApplied: boolean;
    total: Decimal;
  };
  trace: ComponentTrace[];
}

export interface CycleReport {
  cycle: string[];
}

export class UnsupportedInSlice3Error extends Error {
  constructor(feature: string) {
    super(`${feature} is not implemented in Slice 3 of the rate engine`);
    this.name = "UnsupportedInSlice3Error";
  }
}
