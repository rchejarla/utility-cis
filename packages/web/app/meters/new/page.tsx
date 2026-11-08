"use client";

import { useEffect, useState } from "react";
import { METER_TYPES, type FieldDefinition, type MeterType } from "@utility-cis/shared";
import { DatePicker } from "@/components/ui/date-picker";
import {
  EntityFormPage,
  formInputStyle,
} from "@/components/ui/entity-form-page";
import { CustomFieldsSection } from "@/components/ui/custom-fields-section";
import { apiClient } from "@/lib/api-client";

interface MeterForm extends Record<string, unknown> {
  premiseId: string;
  meterNumber: string;
  commodityId: string;
  /**
   * A kind the API accepts, or blank until the clerk picks one.
   *
   * `string` is what let this form open on `"STANDARD"` — a value
   * `meter_type` has never had. The select's options come from
   * `METER_TYPES`, so nothing could *choose* it; it was simply what the
   * field held until somebody touched the dropdown, and leaving it
   * alone sent it. `required` did not catch that, because a wrong value
   * is not an empty one, so the clerk got a 400 the page cannot explain.
   */
  meterType: MeterType | "";
  uomId: string;
  multiplier: string;
  installDate: string;
  customFields: Record<string, unknown>;
}

interface UOM {
  id: string;
  name: string;
  code: string;
  commodityId: string;
}

/*
 * The shared list, shaped for this form's option objects.
 *
 * Its own copy read STANDARD, SMART, AMR, AMI, SUBMETER, MASTER, OTHER
 * — five values the API has never accepted, and no `MANUAL`, which is
 * what most water meters are. So the one form for adding a meter could
 * not add the commonest kind of meter, and offered five that would be
 * refused on submit.
 */
const METER_TYPE_OPTIONS = METER_TYPES.map((t) => ({ value: t, label: t }));

export default function NewMeterPage() {
  // UOMs are loaded locally because the UOM dropdown must filter by the
  // currently-selected commodityId, which is a form-state dependency the
  // shell's static options system doesn't model. Premises and commodities
  // are loaded via the shell's dynamic options instead.
  const [allUoms, setAllUoms] = useState<UOM[]>([]);
  const [customSchema, setCustomSchema] = useState<FieldDefinition[]>([]);

  useEffect(() => {
    apiClient
      .get<{ data: UOM[] } | UOM[]>("/api/v1/uoms")
      .then((res) => setAllUoms(Array.isArray(res) ? res : res.data ?? []))
      .catch(console.error);
  }, []);

  useEffect(() => {
    (async () => {
      try {
        const res = await apiClient.get<{ fields: FieldDefinition[] }>(
          "/api/v1/custom-fields/meter",
        );
        setCustomSchema(res.fields ?? []);
      } catch (err) {
        console.error("[meters/new] failed to load custom field schema", err);
        setCustomSchema([]);
      }
    })();
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
        meterType: "",
        uomId: "",
        multiplier: "1",
        installDate: "",
        customFields: {},
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
              /*
               * Blank first, like the premise, commodity and UOM
               * selects above. How a meter is read is a fact about the
               * device, and a form that pre-answers it records whatever
               * the default happened to be — for every meter whose
               * installer never looked at this field.
               */
              emptyOption: "Select meter type...",
              options: METER_TYPE_OPTIONS,
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
        // Tenant-configurable custom fields. Renders nothing when no
        // schema is configured.
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
          premiseId: form.premiseId,
          meterNumber: form.meterNumber,
          commodityId: form.commodityId,
          meterType: form.meterType,
          multiplier: parseFloat(form.multiplier) || 1,
        };
        if (form.uomId) body.uomId = form.uomId;
        if (form.installDate) body.installDate = form.installDate;
        if (form.customFields && Object.keys(form.customFields).length > 0) {
          body.customFields = form.customFields;
        }
        return body;
      }}
    />
  );
}
