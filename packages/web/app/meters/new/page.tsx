"use client";

import { useEffect, useState } from "react";
import { DatePicker } from "@/components/ui/date-picker";
import {
  EntityFormPage,
  formInputStyle,
} from "@/components/ui/entity-form-page";
import { apiClient } from "@/lib/api-client";

interface MeterForm extends Record<string, unknown> {
  premiseId: string;
  meterNumber: string;
  commodityId: string;
  meterType: string;
  uomId: string;
  multiplier: string;
  installDate: string;
  notes: string;
}

interface UOM {
  id: string;
  name: string;
  code: string;
  commodityId: string;
}

const METER_TYPES = [
  "STANDARD",
  "SMART",
  "AMR",
  "AMI",
  "SUBMETER",
  "MASTER",
  "OTHER",
].map((t) => ({ value: t, label: t }));

export default function NewMeterPage() {
  // UOMs are loaded locally because the UOM dropdown must filter by the
  // currently-selected commodityId, which is a form-state dependency the
  // shell's static options system doesn't model. Premises and commodities
  // are loaded via the shell's dynamic options instead.
  const [allUoms, setAllUoms] = useState<UOM[]>([]);

  useEffect(() => {
    apiClient
      .get<{ data: UOM[] } | UOM[]>("/api/v1/uoms")
      .then((res) => setAllUoms(Array.isArray(res) ? res : res.data ?? []))
      .catch(console.error);
  }, []);

  return (
    <EntityFormPage<MeterForm>
      title="Add Meter"
      subtitle="Register a new meter at a premise"
      module="meters"
      endpoint="/api/v1/meters"
      returnTo="/meters"
      submitLabel="Create Meter"
      maxWidth="720px"
      initialValues={{
        premiseId: "",
        meterNumber: "",
        commodityId: "",
        meterType: "STANDARD",
        uomId: "",
        multiplier: "1",
        installDate: "",
        notes: "",
      }}
      fields={[
        {
          key: "premiseId",
          label: "Premise",
          type: "select",
          required: true,
          emptyOption: "Select a premise...",
          hint: "Meter is permanently tied to this premise (BR-MT-009)",
          options: {
            endpoint: "/api/v1/premises",
            params: { limit: "200" },
            mapOption: (p) => ({
              value: String(p.id),
              label: `${p.addressLine1}, ${p.city}, ${p.state}`,
            }),
          },
        },
        {
          key: "meterNumber",
          label: "Meter Number",
          type: "text",
          required: true,
          placeholder: "MTR-001234",
          tooltip: "Must be unique within the utility",
          tooltipRuleId: "BR-MT-002",
        },
        {
          row: [
            {
              key: "commodityId",
              label: "Commodity",
              type: "select",
              required: true,
              emptyOption: "Select commodity...",
              hint: "Must match one of the premise's commodities (BR-MT-003)",
              options: {
                endpoint: "/api/v1/commodities",
                mapOption: (c) => ({
                  value: String(c.id),
                  label: String(c.name),
                }),
              },
            },
            {
              key: "uomId",
              label: "Unit of Measure",
              type: "custom",
              render: ({ value, setValue, values }) => {
                const filtered = values.commodityId
                  ? allUoms.filter((u) => u.commodityId === values.commodityId)
                  : allUoms;
                return (
                  <select
                    style={formInputStyle}
                    value={String(value ?? "")}
                    onChange={(e) => setValue(e.target.value as never)}
                  >
                    <option value="">Select UOM...</option>
                    {filtered.map((u) => (
                      <option key={u.id} value={u.id}>
                        {u.name} ({u.code})
                      </option>
                    ))}
                  </select>
                );
              },
            },
          ],
        },
        {
          row: [
            {
              key: "meterType",
              label: "Meter Type",
              type: "select",
              required: true,
              options: METER_TYPES,
            },
            {
              key: "multiplier",
              label: "Multiplier",
              type: "number",
              step: "any",
              min: "0",
              placeholder: "1",
            },
          ],
        },
        {
          key: "installDate",
          label: "Install Date",
          type: "custom",
          render: ({ value, setValue }) => (
            <DatePicker
              value={String(value ?? "")}
              onChange={(v) => setValue(v as never)}
            />
          ),
        },
        {
          key: "notes",
          label: "Notes",
          type: "textarea",
          placeholder: "Optional notes...",
          rows: 4,
        },
      ]}
      toRequestBody={(form) => {
        const body: Record<string, unknown> = {
          premiseId: form.premiseId,
          meterNumber: form.meterNumber,
          commodityId: form.commodityId,
          meterType: form.meterType,
          multiplier: parseFloat(form.multiplier) || 1,
        };
        if (form.uomId) body.uomId = form.uomId;
        if (form.installDate) body.installDate = form.installDate;
        if (form.notes) body.notes = form.notes;
        return body;
      }}
    />
  );
}
