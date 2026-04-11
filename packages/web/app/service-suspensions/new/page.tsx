"use client";

import { EntityFormPage } from "@/components/ui/entity-form-page";

interface SuspensionForm extends Record<string, unknown> {
  serviceAgreementId: string;
  suspensionType: string;
  startDate: string;
  endDate: string;
  reason: string;
  billingSuspended: boolean;
  prorateOnStart: boolean;
  prorateOnEnd: boolean;
}

export default function NewSuspensionPage() {
  return (
    <EntityFormPage<SuspensionForm>
      title="Create Service Hold"
      subtitle="Pause service and billing on an agreement for a defined period"
      module="service_suspensions"
      endpoint="/api/v1/service-suspensions"
      returnTo="/service-suspensions"
      submitLabel="Create Hold"
      maxWidth="640px"
      initialValues={{
        serviceAgreementId: "",
        suspensionType: "",
        startDate: new Date().toISOString().slice(0, 10),
        endDate: "",
        reason: "",
        billingSuspended: true,
        prorateOnStart: true,
        prorateOnEnd: true,
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
          // Dynamic options fetched from the reference table. Replaces
          // the previous hardcoded TYPES const so utility admins can
          // add their own codes without a code change.
          key: "suspensionType",
          label: "Hold Type",
          type: "select",
          required: true,
          emptyOption: "Select type...",
          options: {
            endpoint: "/api/v1/suspension-types",
            mapOption: (t) => ({
              value: String(t.code),
              label: String(t.label),
            }),
          },
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
        // Billing options. EntityFormPage has no native checkbox field
        // type, so these use `type: "custom"` with an inline render.
        // Previously all three flags were hardcoded to true server-side
        // and invisible to users; surfacing them lets operators opt a
        // hold out of billing suspension (e.g. a dispute hold where
        // the meter is still being read but billing is paused
        // separately).
        {
          key: "billingSuspended",
          label: "Suspend billing during hold",
          type: "custom",
          render: ({ value, setValue }) => (
            <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13 }}>
              <input
                type="checkbox"
                checked={Boolean(value)}
                onChange={(e) => setValue(e.target.checked as never)}
              />
              <span>
                When off, meter readings still generate charges even though the hold is active.
              </span>
            </label>
          ),
        },
        {
          row: [
            {
              key: "prorateOnStart",
              label: "Prorate start date",
              type: "custom",
              render: ({ value, setValue }) => (
                <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13 }}>
                  <input
                    type="checkbox"
                    checked={Boolean(value)}
                    onChange={(e) => setValue(e.target.checked as never)}
                  />
                  <span>Partial-day billing on start</span>
                </label>
              ),
            },
            {
              key: "prorateOnEnd",
              label: "Prorate end date",
              type: "custom",
              render: ({ value, setValue }) => (
                <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13 }}>
                  <input
                    type="checkbox"
                    checked={Boolean(value)}
                    onChange={(e) => setValue(e.target.checked as never)}
                  />
                  <span>Partial-day billing on end</span>
                </label>
              ),
            },
          ],
        },
      ]}
      toRequestBody={(form) => {
        const body: Record<string, unknown> = {
          serviceAgreementId: form.serviceAgreementId,
          suspensionType: form.suspensionType,
          startDate: form.startDate,
          billingSuspended: form.billingSuspended,
          prorateOnStart: form.prorateOnStart,
          prorateOnEnd: form.prorateOnEnd,
        };
        if (form.endDate) body.endDate = form.endDate;
        if (form.reason) body.reason = form.reason;
        return body;
      }}
    />
  );
}
