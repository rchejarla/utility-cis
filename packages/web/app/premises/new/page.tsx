"use client";

import { useEffect, useState } from "react";
import type { FieldDefinition } from "@utility-cis/shared";
import { EntityFormPage } from "@/components/ui/entity-form-page";
import { CustomFieldsSection } from "@/components/ui/custom-fields-section";
import { apiClient } from "@/lib/api-client";

interface PremiseForm extends Record<string, unknown> {
  addressLine1: string;
  addressLine2: string;
  city: string;
  state: string;
  zip: string;
  geoLat: string;
  geoLng: string;
  premiseType: string;
  commodityIds: string[];
  serviceTerritoryId: string;
  municipalityCode: string;
  ownerId: string;
  customFields: Record<string, unknown>;
}

interface Commodity {
  id: string;
  name: string;
  code: string;
}

const US_STATES = [
  "AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DE", "FL", "GA", "HI", "ID", "IL",
  "IN", "IA", "KS", "KY", "LA", "ME", "MD", "MA", "MI", "MN", "MS", "MO", "MT",
  "NE", "NV", "NH", "NJ", "NM", "NY", "NC", "ND", "OH", "OK", "OR", "PA", "RI",
  "SC", "SD", "TN", "TX", "UT", "VT", "VA", "WA", "WV", "WI", "WY",
].map((s) => ({ value: s, label: s }));

const PREMISE_TYPES = [
  "RESIDENTIAL",
  "COMMERCIAL",
  "INDUSTRIAL",
  "AGRICULTURAL",
  "OTHER",
].map((t) => ({
  value: t,
  label: t.charAt(0) + t.slice(1).toLowerCase(),
}));

export default function NewPremisePage() {
  // Commodities are loaded locally because the commodity-toggle field
  // is a multi-select pill UI that doesn't fit the stock select type;
  // we need the full list accessible to the custom render closure.
  const [commodities, setCommodities] = useState<Commodity[]>([]);
  // Tenant custom-field schema for premises.
  const [customSchema, setCustomSchema] = useState<FieldDefinition[]>([]);

  useEffect(() => {
    apiClient
      .get<Commodity[] | { data: Commodity[] }>("/api/v1/commodities")
      .then((res) => setCommodities(Array.isArray(res) ? res : res.data ?? []))
      .catch(console.error);
  }, []);

  useEffect(() => {
    (async () => {
      try {
        const res = await apiClient.get<{ fields: FieldDefinition[] }>(
          "/api/v1/custom-fields/premise",
        );
        setCustomSchema(res.fields ?? []);
      } catch (err) {
        console.error("[premises/new] failed to load custom field schema", err);
        setCustomSchema([]);
      }
    })();
  }, []);

  return (
    <EntityFormPage<PremiseForm>
      title="Add Premise"
      subtitle="Create a new service premise"
      module="premises"
      endpoint="/api/v1/premises"
      returnTo="/premises"
      submitLabel="Create Premise"
      maxWidth="720px"
      initialValues={{
        addressLine1: "",
        addressLine2: "",
        city: "",
        state: "CA",
        zip: "",
        geoLat: "",
        geoLng: "",
        premiseType: "RESIDENTIAL",
        commodityIds: [],
        serviceTerritoryId: "",
        municipalityCode: "",
        ownerId: "",
        customFields: {},
      }}
      fields={[
        {
          key: "addressLine1",
          label: "Address Line 1",
          type: "text",
          required: true,
          placeholder: "123 Main St",
        },
        {
          key: "addressLine2",
          label: "Address Line 2",
          type: "text",
          placeholder: "Apt 4B (optional)",
        },
        {
          row: [
            { key: "city", label: "City", type: "text", required: true, placeholder: "Springfield" },
            {
              key: "state",
              label: "State",
              type: "select",
              required: true,
              options: US_STATES,
              hint: "2-letter state code",
            },
            { key: "zip", label: "ZIP Code", type: "text", required: true, placeholder: "90210" },
          ],
        },
        {
          key: "premiseType",
          label: "Premise Type",
          type: "select",
          required: true,
          options: PREMISE_TYPES,
        },
        {
          key: "commodityIds",
          label: "Commodities",
          type: "custom",
          tooltip: "At least one commodity required",
          tooltipRuleId: "BR-PR-003",
          render: ({ value, setValue }) => {
            const selectedIds = (value as string[]) ?? [];
            const toggle = (id: string) => {
              setValue(
                (selectedIds.includes(id)
                  ? selectedIds.filter((c) => c !== id)
                  : [...selectedIds, id]) as never,
              );
            };
            return (
              <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
                {commodities.map((c) => {
                  const selected = selectedIds.includes(c.id);
                  return (
                    <button
                      key={c.id}
                      type="button"
                      onClick={() => toggle(c.id)}
                      style={{
                        padding: "5px 14px",
                        borderRadius: "999px",
                        border: selected
                          ? "1px solid var(--accent-primary)"
                          : "1px solid var(--border)",
                        background: selected
                          ? "var(--accent-primary-subtle)"
                          : "transparent",
                        color: selected
                          ? "var(--accent-primary)"
                          : "var(--text-secondary)",
                        fontSize: "12px",
                        fontWeight: 500,
                        cursor: "pointer",
                        fontFamily: "inherit",
                        transition: "all 0.15s ease",
                      }}
                    >
                      {c.name}
                    </button>
                  );
                })}
                {commodities.length === 0 && (
                  <span style={{ fontSize: "12px", color: "var(--text-muted)" }}>
                    Loading commodities...
                  </span>
                )}
              </div>
            );
          },
        },
        {
          row: [
            {
              key: "geoLat",
              label: "Latitude",
              type: "number",
              step: "any",
              placeholder: "34.0522",
              hint: "Optional — for map view",
            },
            {
              key: "geoLng",
              label: "Longitude",
              type: "number",
              step: "any",
              placeholder: "-118.2437",
              hint: "Optional — for map view",
            },
          ],
        },
        {
          row: [
            {
              key: "serviceTerritoryId",
              label: "Service Territory ID",
              type: "text",
              placeholder: "Optional",
            },
            {
              key: "municipalityCode",
              label: "Municipality Code",
              type: "text",
              placeholder: "Optional",
            },
          ],
        },
        {
          key: "ownerId",
          label: "Property Owner",
          type: "select",
          emptyOption: "No owner assigned",
          tooltip:
            "Property owner may differ from the service account holder (landlord/tenant)",
          tooltipRuleId: "BR-PR-002",
          options: {
            endpoint: "/api/v1/customers",
            params: { limit: "500" },
            mapOption: (c) => ({
              value: String(c.id),
              label:
                c.customerType === "ORGANIZATION"
                  ? String(c.organizationName ?? "")
                  : `${String(c.firstName ?? "")} ${String(c.lastName ?? "")}`,
            }),
          },
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
          addressLine1: form.addressLine1,
          city: form.city,
          state: form.state,
          zip: form.zip,
          premiseType: form.premiseType,
          commodityIds: form.commodityIds,
        };
        if (form.addressLine2) body.addressLine2 = form.addressLine2;
        if (form.geoLat) body.geoLat = parseFloat(form.geoLat);
        if (form.geoLng) body.geoLng = parseFloat(form.geoLng);
        if (form.serviceTerritoryId) body.serviceTerritoryId = form.serviceTerritoryId;
        if (form.municipalityCode) body.municipalityCode = form.municipalityCode;
        if (form.ownerId) body.ownerId = form.ownerId;
        if (form.customFields && Object.keys(form.customFields).length > 0) {
          body.customFields = form.customFields;
        }
        return body;
      }}
    />
  );
}
