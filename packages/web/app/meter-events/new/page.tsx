"use client";

import { EntityFormPage } from "@/components/ui/entity-form-page";

interface MeterEventForm extends Record<string, unknown> {
  meterId: string;
  eventType: string;
  severity: string;
  eventDatetime: string;
  source: string;
  description: string;
}

const EVENT_TYPES = [
  { value: "LEAK", label: "Leak" },
  { value: "TAMPER", label: "Tamper" },
  { value: "REVERSE_FLOW", label: "Reverse flow" },
  { value: "HIGH_USAGE", label: "High usage" },
  { value: "NO_SIGNAL", label: "No signal" },
  { value: "BATTERY_LOW", label: "Battery low" },
  { value: "COVER_OPEN", label: "Cover open" },
  { value: "BURST_PIPE", label: "Burst pipe" },
  { value: "FREEZE", label: "Freeze" },
  { value: "OTHER", label: "Other" },
];

export default function NewMeterEventPage() {
  return (
    <EntityFormPage<MeterEventForm>
      title="Log Meter Event"
      subtitle="Record a field-reported or system-generated meter event"
      module="meter_events"
      endpoint="/api/v1/meter-events"
      returnTo="/meter-events"
      submitLabel="Log Event"
      maxWidth="560px"
      initialValues={{
        meterId: "",
        eventType: "LEAK",
        severity: "2",
        eventDatetime: new Date().toISOString(),
        source: "MANUAL",
        description: "",
      }}
      fields={[
        {
          key: "meterId",
          label: "Meter",
          type: "select",
          required: true,
          emptyOption: "Select meter...",
          options: {
            endpoint: "/api/v1/meters",
            params: { limit: "500" },
            mapOption: (m) => ({ value: String(m.id), label: String(m.meterNumber) }),
          },
        },
        {
          row: [
            { key: "eventType", label: "Event Type", type: "select", required: true, options: EVENT_TYPES },
            {
              key: "severity",
              label: "Severity",
              type: "select",
              required: true,
              options: [
                { value: "1", label: "Low" },
                { value: "2", label: "Medium" },
                { value: "3", label: "High" },
              ],
            },
          ],
        },
        {
          key: "description",
          label: "Description",
          type: "textarea",
          placeholder: "What was observed?",
          rows: 4,
        },
      ]}
      toRequestBody={(form) => ({
        meterId: form.meterId,
        eventType: form.eventType,
        severity: parseInt(form.severity, 10),
        eventDatetime: form.eventDatetime,
        source: form.source,
        ...(form.description ? { description: form.description } : {}),
      })}
    />
  );
}
