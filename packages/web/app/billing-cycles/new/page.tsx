"use client";

import { EntityFormPage } from "@/components/ui/entity-form-page";

interface BillingCycleForm extends Record<string, unknown> {
  name: string;
  cycleCode: string;
  billDayOfMonth: string;
  frequency: string;
}

const FREQUENCIES = ["MONTHLY", "BIMONTHLY", "QUARTERLY", "ANNUAL"].map((f) => ({
  value: f,
  label: f.charAt(0) + f.slice(1).toLowerCase(),
}));

export default function NewBillingCyclePage() {
  return (
    <EntityFormPage<BillingCycleForm>
      title="New Billing Cycle"
      subtitle="Define a billing cycle schedule"
      module="billing_cycles"
      endpoint="/api/v1/billing-cycles"
      returnTo="/billing-cycles"
      submitLabel="Create Billing Cycle"
      maxWidth="560px"
      initialValues={{
        name: "",
        cycleCode: "",
        billDayOfMonth: "",
        frequency: "MONTHLY",
      }}
      fields={[
        { key: "name", label: "Name", type: "text", required: true, placeholder: "Monthly — Cycle A" },
        {
          key: "cycleCode",
          label: "Cycle Code",
          type: "text",
          required: true,
          placeholder: "MON-A",
          hint: "BR-BC-005: Cannot be changed after creation",
        },
        { key: "frequency", label: "Frequency", type: "select", required: true, options: FREQUENCIES },
        {
          key: "billDayOfMonth",
          label: "Bill Day of Month",
          type: "number",
          min: "1",
          max: "31",
          placeholder: "25",
          hint: "1–28",
          tooltip: "Must be 1-28 to avoid month-length issues",
          tooltipRuleId: "BR-BC-001",
        },
      ]}
      toRequestBody={(form) => {
        const body: Record<string, unknown> = {
          name: form.name,
          cycleCode: form.cycleCode,
          frequency: form.frequency,
        };
        if (form.billDayOfMonth) body.billDayOfMonth = parseInt(form.billDayOfMonth, 10);
        return body;
      }}
    />
  );
}
