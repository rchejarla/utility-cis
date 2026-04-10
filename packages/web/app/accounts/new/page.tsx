"use client";

import { EntityFormPage } from "@/components/ui/entity-form-page";

interface AccountForm extends Record<string, unknown> {
  accountNumber: string;
  accountType: string;
  creditRating: string;
  depositAmount: string;
  languagePref: string;
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
      }}
      fields={[
        {
          key: "accountNumber",
          label: "Account Number",
          type: "text",
          required: true,
          placeholder: "ACC-000001",
          tooltip: "Cannot be changed after creation",
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
      ]}
      toRequestBody={(form) => {
        const body: Record<string, unknown> = {
          accountNumber: form.accountNumber,
          accountType: form.accountType,
          languagePref: form.languagePref,
        };
        if (form.creditRating) body.creditRating = form.creditRating;
        if (form.depositAmount) body.depositAmount = parseFloat(form.depositAmount);
        return body;
      }}
    />
  );
}
