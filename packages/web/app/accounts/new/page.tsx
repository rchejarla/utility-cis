"use client";

import { useEffect, useState } from "react";
import type { FieldDefinition } from "@utility-cis/shared";
import { EntityFormPage } from "@/components/ui/entity-form-page";
import { CustomFieldsSection } from "@/components/ui/custom-fields-section";
import { apiClient } from "@/lib/api-client";
import { useAccountTypes } from "@/lib/use-type-defs";

interface AccountForm extends Record<string, unknown> {
  accountNumber: string;
  accountType: string;
  creditRating: string;
  billingCycleId: string;
  depositAmount: string;
  depositTender: string;
  languagePref: string;
  customFields: Record<string, unknown>;
}

interface BillingCycle {
  id: string;
  name: string;
  cycleCode: string;
}

const CREDIT_RATINGS = [
  { value: "EXCELLENT", label: "EXCELLENT" },
  { value: "GOOD", label: "GOOD" },
  { value: "FAIR", label: "FAIR" },
  { value: "POOR", label: "POOR" },
  { value: "UNRATED", label: "UNRATED" },
];

/**
 * How an opening deposit arrived.
 *
 * A receipts tie-out groups the day's takings by tender, so a deposit
 * recorded without one cannot be matched against the bank slip it was
 * part of. Optional, because "unknown" is sometimes the truth.
 */
const DEPOSIT_TENDERS = [
  { value: "CASH", label: "Cash" },
  { value: "CHECK", label: "Check" },
  { value: "CARD", label: "Card" },
  { value: "ACH", label: "ACH" },
  { value: "LOCKBOX", label: "Lockbox" },
];

const LANGUAGE_PREFS = [
  { value: "en-US", label: "English" },
  { value: "es-US", label: "Spanish" },
  { value: "fr-CA", label: "French" },
  { value: "zh-CN", label: "Chinese" },
  { value: "vi-VN", label: "Vietnamese" },
];

export default function NewAccountPage() {
  // Tenant custom-field schema for accounts. Loaded once on mount;
  // when empty, the section renders nothing and the form is unchanged.
  const [customSchema, setCustomSchema] = useState<FieldDefinition[]>([]);
  const [billingCycles, setBillingCycles] = useState<BillingCycle[]>([]);
  const { types: accountTypes } = useAccountTypes();
  const accountTypeOptions = accountTypes.map((t) => ({ value: t.code, label: t.label }));
  useEffect(() => {
    (async () => {
      try {
        const res = await apiClient.get<{ fields: FieldDefinition[] }>(
          "/api/v1/custom-fields/account",
        );
        setCustomSchema(res.fields ?? []);
      } catch (err) {
        console.error("[accounts/new] failed to load custom field schema", err);
        setCustomSchema([]);
      }
    })();
    (async () => {
      try {
        const res = await apiClient.get<BillingCycle[] | { data: BillingCycle[] }>("/api/v1/billing-cycles");
        setBillingCycles(Array.isArray(res) ? res : (res as any).data ?? []);
      } catch (err) {
        console.error("[accounts/new] failed to load billing cycles", err);
        setBillingCycles([]);
      }
    })();
  }, []);
  const billingCycleOptions = billingCycles.map((bc) => ({ value: bc.id, label: `${bc.name} (${bc.cycleCode})` }));

  return (
    <EntityFormPage<AccountForm>
      title="Add Account"
      subtitle="Create a new customer account"
      module="accounts"
      endpoint="/api/v1/accounts"
      returnTo="/accounts"
      submitLabel="Create Account"
      initialValues={{
        accountNumber: "",
        accountType: "RESIDENTIAL",
        creditRating: "",
        billingCycleId: "",
        depositAmount: "",
        depositTender: "",
        languagePref: "en-US",
        customFields: {},
      }}
      fields={[
        {
          key: "accountNumber",
          label: "Account Number (optional)",
          type: "text",
          placeholder: "Auto-generate",
          tooltip: "Leave blank to auto-generate using the numbering template in Settings. Cannot be changed after creation.",
          tooltipRuleId: "BR-AC-005",
        },
        {
          key: "accountType",
          label: "Account Type",
          type: "select",
          required: true,
          options: accountTypeOptions,
          hint: "Determines default rate eligibility",
        },
        {
          key: "billingCycleId",
          label: "Billing Cycle",
          type: "select",
          required: true,
          options: billingCycleOptions,
          hint: "All service agreements on this account will bill on this cycle",
        },
        {
          row: [
            {
              key: "creditRating",
              label: "Credit Rating",
              type: "select",
              options: CREDIT_RATINGS,
              emptyOption: "None",
            },
            {
              key: "depositAmount",
              label: "Deposit Amount",
              type: "number",
              step: "0.01",
              min: "0",
              placeholder: "0.00",
              hint: "Optional security deposit",
              tooltip: "May be required for certain account types (e.g., renters)",
              tooltipRuleId: "BR-AC-008",
            },
            {
              key: "depositTender",
              label: "Deposit Tender",
              type: "select",
              options: DEPOSIT_TENDERS,
              emptyOption: "Unknown",
              hint: "How it arrived — needed to tie the day's receipts to the bank",
            },
          ],
        },
        {
          key: "languagePref",
          label: "Language Preference",
          type: "select",
          options: LANGUAGE_PREFS,
        },
        // Tenant-configurable custom fields appended to the bottom.
        // Renders nothing when the tenant has no schema configured.
        {
          key: "customFields",
          label: "",
          type: "custom",
          render: ({ value, setValue }) => (
            <CustomFieldsSection
              schema={customSchema}
              values={(value as Record<string, unknown>) ?? {}}
              onChange={(next) => setValue(next as never)}
            />
          ),
        },
      ]}
      toRequestBody={(form) => {
        const body: Record<string, unknown> = {
          accountType: form.accountType,
          billingCycleId: form.billingCycleId,
          languagePref: form.languagePref,
        };
        // Only include accountNumber when the user explicitly typed
        // one — the backend generates from the tenant template when
        // absent.
        if (form.accountNumber) body.accountNumber = form.accountNumber;
        if (form.creditRating) body.creditRating = form.creditRating;
        if (form.depositAmount) body.depositAmount = parseFloat(form.depositAmount);
        // Only when there is a deposit for it to describe: a tender on a
        // zero deposit would be a fact about money that never moved.
        if (form.depositAmount && form.depositTender) body.depositTender = form.depositTender;
        if (form.customFields && Object.keys(form.customFields).length > 0) {
          body.customFields = form.customFields;
        }
        return body;
      }}
    />
  );
}
