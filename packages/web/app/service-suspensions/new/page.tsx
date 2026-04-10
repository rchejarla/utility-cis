"use client";

import { EntityFormPage } from "@/components/ui/entity-form-page";

interface SuspensionForm extends Record<string, unknown> {
  serviceAgreementId: string;
  suspensionType: string;
  startDate: string;
  endDate: string;
  reason: string;
}

const TYPES = [
  { value: "VACATION_HOLD", label: "Vacation hold" },
  { value: "SEASONAL", label: "Seasonal suspension" },
  { value: "TEMPORARY", label: "Temporary" },
  { value: "DISPUTE", label: "Dispute hold" },
];

export default function NewSuspensionPage() {
  return (
    <EntityFormPage<SuspensionForm>
      title="Create Service Hold"
      subtitle="Pause service and billing on an agreement for a defined period"
      module="service_suspensions"
      endpoint="/api/v1/service-suspensions"
      returnTo="/service-suspensions"
      submitLabel="Create Hold"
      maxWidth="580px"
      initialValues={{
        serviceAgreementId: "",
        suspensionType: "VACATION_HOLD",
        startDate: new Date().toISOString().slice(0, 10),
        endDate: "",
        reason: "",
      }}
      fields={[
        {
          key: "serviceAgreementId",
          label: "Service Agreement",
          type: "select",
          required: true,
          emptyOption: "Select agreement...",
          options: {
            endpoint: "/api/v1/service-agreements",
            params: { limit: "500", status: "ACTIVE" },
            mapOption: (a) => ({
              value: String(a.id),
              label: String(a.agreementNumber),
            }),
          },
        },
        {
          key: "suspensionType",
          label: "Hold Type",
          type: "select",
          required: true,
          options: TYPES,
        },
        {
          row: [
            { key: "startDate", label: "Start Date", type: "date", required: true },
            { key: "endDate", label: "End Date (optional)", type: "date" },
          ],
        },
        {
          key: "reason",
          label: "Reason",
          type: "textarea",
          placeholder: "Customer heading out of town, etc.",
          rows: 3,
        },
      ]}
      toRequestBody={(form) => {
        const body: Record<string, unknown> = {
          serviceAgreementId: form.serviceAgreementId,
          suspensionType: form.suspensionType,
          startDate: form.startDate,
          billingSuspended: true,
          prorateOnStart: true,
          prorateOnEnd: true,
        };
        if (form.endDate) body.endDate = form.endDate;
        if (form.reason) body.reason = form.reason;
        return body;
      }}
    />
  );
}
