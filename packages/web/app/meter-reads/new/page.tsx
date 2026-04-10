"use client";

import { EntityFormPage } from "@/components/ui/entity-form-page";

interface MeterReadForm extends Record<string, unknown> {
  meterId: string;
  serviceAgreementId: string;
  readDate: string;
  readDatetime: string;
  reading: string;
  readType: string;
  readSource: string;
  exceptionNotes: string;
}

const READ_TYPES = [
  { value: "ACTUAL", label: "Actual" },
  { value: "ESTIMATED", label: "Estimated" },
  { value: "FINAL", label: "Final" },
];

const READ_SOURCES = [
  { value: "MANUAL", label: "Manual entry" },
  { value: "AMR", label: "AMR drive-by" },
  { value: "CUSTOMER_SELF", label: "Customer self-read" },
];

export default function NewMeterReadPage() {
  const today = new Date().toISOString().slice(0, 10);
  const nowIso = new Date().toISOString();

  return (
    <EntityFormPage<MeterReadForm>
      title="Record Meter Read"
      subtitle="Enter a manual read for an active service agreement"
      module="meter_reads"
      endpoint="/api/v1/meter-reads"
      returnTo="/meter-reads"
      submitLabel="Record Read"
      maxWidth="640px"
      initialValues={{
        meterId: "",
        serviceAgreementId: "",
        readDate: today,
        readDatetime: nowIso,
        reading: "",
        readType: "ACTUAL",
        readSource: "MANUAL",
        exceptionNotes: "",
      }}
      fields={[
        {
          key: "meterId",
          label: "Meter",
          type: "select",
          required: true,
          emptyOption: "Select meter...",
          hint: "Must be ACTIVE and assigned to a service agreement",
          options: {
            endpoint: "/api/v1/meters",
            params: { limit: "500" },
            mapOption: (m) => ({
              value: String(m.id),
              label: String(m.meterNumber),
            }),
          },
        },
        {
          key: "serviceAgreementId",
          label: "Service Agreement",
          type: "select",
          required: true,
          emptyOption: "Select agreement...",
          options: {
            endpoint: "/api/v1/service-agreements",
            params: { limit: "500" },
            mapOption: (a) => ({
              value: String(a.id),
              label: String(a.agreementNumber),
            }),
          },
        },
        {
          row: [
            {
              key: "readDate",
              label: "Read Date",
              type: "date",
              required: true,
            },
            {
              key: "reading",
              label: "Reading",
              type: "number",
              required: true,
              step: "any",
              min: "0",
              placeholder: "12345.67",
            },
          ],
        },
        {
          row: [
            {
              key: "readType",
              label: "Read Type",
              type: "select",
              required: true,
              options: READ_TYPES,
            },
            {
              key: "readSource",
              label: "Source",
              type: "select",
              required: true,
              options: READ_SOURCES,
            },
          ],
        },
        {
          key: "exceptionNotes",
          label: "Notes",
          type: "textarea",
          placeholder: "Optional notes from the field reader...",
          rows: 3,
        },
      ]}
      toRequestBody={(form) => ({
        meterId: form.meterId,
        serviceAgreementId: form.serviceAgreementId,
        readDate: form.readDate,
        readDatetime: new Date(form.readDate).toISOString(),
        reading: parseFloat(form.reading),
        readType: form.readType,
        readSource: form.readSource,
        ...(form.exceptionNotes ? { exceptionNotes: form.exceptionNotes } : {}),
      })}
    />
  );
}
