"use client";

import { useEffect, useState } from "react";
import type { FieldDefinition } from "@utility-cis/shared";
import { EntityFormPage } from "@/components/ui/entity-form-page";
import { CustomFieldsSection } from "@/components/ui/custom-fields-section";
import { apiClient } from "@/lib/api-client";

interface AccountForm extends Record<string, unknown> {
  accountNumber: string;
  accountType: string;
  creditRating: string;
  depositAmount: string;
  languagePref: string;
  customFields: Record<string, unknown>;
}

const ACCOUNT_TYPES = [
  { value: "RESIDENTIAL", label: "Residential" },
  { value: "COMMERCIAL", label: "Commercial" },
  { value: "INDUSTRIAL", label: "Industrial" },
  { value: "MUNICIPAL", label: "Municipal" },
];

const CREDIT_RATINGS = [
  { value: "EXCELLENT", label: "EXCELLENT" },
  { value: "GOOD", label: "GOOD" },
  { value: "FAIR", label: "FAIR" },
  { value: "POOR", label: "POOR" },
  { value: "UNRATED", label: "UNRATED" },
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
  }, []);

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
        depositAmount: "",
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
          options: ACCOUNT_TYPES,
          hint: "Determines default rate eligibility",
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
          languagePref: form.languagePref,
        };
        // Only include accountNumber when the user explicitly typed
        // one — the backend generates from the tenant template when
        // absent.
        if (form.accountNumber) body.accountNumber = form.accountNumber;
        if (form.creditRating) body.creditRating = form.creditRating;
        if (form.depositAmount) body.depositAmount = parseFloat(form.depositAmount);
        if (form.customFields && Object.keys(form.customFields).length > 0) {
          body.customFields = form.customFields;
        }
        return body;
      }}
    />
  );
}
