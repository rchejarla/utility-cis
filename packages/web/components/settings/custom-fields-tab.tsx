"use client";

import { useEffect, useState } from "react";
import {
  CUSTOM_FIELD_ENTITY_TYPES,
  isReservedFieldKey,
  type CustomFieldEntityType,
  type CustomFieldSchemaDTO,
  type FieldDefinition,
  type FieldType,
} from "@utility-cis/shared";
import { apiClient } from "@/lib/api-client";
import { useToast } from "@/components/ui/toast";
import { usePermission } from "@/lib/use-permission";

/**
 * Admin UI for tenant custom-field schemas.
 *
 * Provides:
 *   - Entity picker: which of the five extendable entity types to edit
 *   - Field list: all current fields (active + deprecated) with inline
 *     edit of label/required/searchable, plus a "Deprecate" action
 *   - Add-field form: key (immutable once created), label, type,
 *     required, searchable, enum options for type=enum
 *
 * Scope limits for v1:
 *   - No drag-and-drop reordering — admins type order numbers directly
 *   - No bulk import/export
 *   - No preview of how the field will render on the entity form
 *     (comes later when we have more visual polish budget)
 *
 * All mutations go through individual route calls (POST /fields,
 * PATCH /fields/:key, POST /fields/:key/deprecate) rather than a
 * bulk PUT so that optimistic concurrency and audit granularity stay
 * per-field.
 */

const ENTITY_LABELS: Record<CustomFieldEntityType, string> = {
  customer: "Customer",
  account: "Account",
  premise: "Premise",
  service_agreement: "Service Agreement",
  meter: "Meter",
};

const FIELD_TYPE_OPTIONS: Array<{ value: FieldType; label: string }> = [
  { value: "string", label: "String (text)" },
  { value: "number", label: "Number" },
  { value: "date", label: "Date" },
  { value: "boolean", label: "Boolean (yes/no)" },
  { value: "enum", label: "Enum (dropdown)" },
];

export function CustomFieldsTab() {
  const { canEdit } = usePermission("settings");
  const { toast } = useToast();

  const [entity, setEntity] = useState<CustomFieldEntityType>("customer");
  const [schema, setSchema] = useState<CustomFieldSchemaDTO | null>(null);
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);

  async function load(next: CustomFieldEntityType) {
    setLoading(true);
    try {
      const res = await apiClient.get<CustomFieldSchemaDTO>(
        `/api/v1/custom-fields/${next}`,
      );
      setSchema(res);
    } catch (err) {
      toast(err instanceof Error ? err.message : "Failed to load schema", "error");
      setSchema(null);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load(entity);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entity]);

  async function handleAdd(field: FieldDefinition) {
    try {
      const res = await apiClient.post<CustomFieldSchemaDTO>(
        `/api/v1/custom-fields/${entity}/fields`,
        field,
      );
      setSchema(res);
      setAdding(false);
      toast(`Added field "${field.key}"`, "success");
    } catch (err) {
      toast(err instanceof Error ? err.message : "Failed to add field", "error");
    }
  }

  async function handleUpdate(key: string, patch: Partial<FieldDefinition>) {
    try {
      const res = await apiClient.patch<CustomFieldSchemaDTO>(
        `/api/v1/custom-fields/${entity}/fields/${key}`,
        patch,
      );
      setSchema(res);
      toast(`Updated field "${key}"`, "success");
    } catch (err) {
      toast(err instanceof Error ? err.message : "Failed to update field", "error");
    }
  }

  async function handleDeprecate(key: string) {
    if (!confirm(`Deprecate field "${key}"? Existing stored values will be preserved but new forms will hide this field.`)) {
      return;
    }
    try {
      const res = await apiClient.post<CustomFieldSchemaDTO>(
        `/api/v1/custom-fields/${entity}/fields/${key}/deprecate`,
        {},
      );
      setSchema(res);
      toast(`Deprecated "${key}"`, "success");
    } catch (err) {
      toast(err instanceof Error ? err.message : "Failed to deprecate", "error");
    }
  }

  async function handleDelete(key: string) {
    // Two-phase confirmation:
    //   1. Initial confirm for intent.
    //   2. Try the default (safe) delete. If the backend returns
    //      CUSTOM_FIELD_HAS_DATA, ask a second time with the row
    //      count and retry with force=true.
    if (!confirm(`Delete field "${key}"? This is different from deprecating — it removes the field permanently from the schema.`)) {
      return;
    }
    try {
      const res = await apiClient.delete<CustomFieldSchemaDTO>(
        `/api/v1/custom-fields/${entity}/fields/${key}`,
      );
      setSchema(res);
      toast(`Deleted "${key}"`, "success");
      return;
    } catch (err) {
      // Normalize the error shape from apiClient — our error handler
      // surfaces statusCode and code via the thrown Error message or
      // a wrapped object depending on the fetch path. We parse the
      // message for the data-row count so the second confirm shows
      // a real number.
      const message = err instanceof Error ? err.message : String(err);
      const hasDataMatch = message.match(/(\d+)\s+\S+\s+row\(s\)/);
      if (!hasDataMatch) {
        toast(message || "Failed to delete", "error");
        return;
      }
      const rowCount = hasDataMatch[1];
      if (
        !confirm(
          `Warning: ${rowCount} row(s) contain data for "${key}". Continuing will permanently erase those values. This cannot be undone. Continue?`,
        )
      ) {
        return;
      }
      try {
        const res = await apiClient.delete<CustomFieldSchemaDTO>(
          `/api/v1/custom-fields/${entity}/fields/${key}?force=true`,
        );
        setSchema(res);
        toast(`Deleted "${key}" (scrubbed data from ${rowCount} row(s))`, "success");
      } catch (err2) {
        toast(err2 instanceof Error ? err2.message : "Failed to force delete", "error");
      }
    }
  }

  return (
    <div style={{ maxWidth: 880, display: "flex", flexDirection: "column", gap: 24 }}>
      <section>
        <h2
          style={{
            fontSize: 14,
            fontWeight: 700,
            letterSpacing: "0.04em",
            textTransform: "uppercase",
            marginTop: 0,
            marginBottom: 8,
          }}
        >
          Custom Fields
        </h2>
        <p style={{ fontSize: 13, color: "var(--text-secondary)", margin: 0, marginBottom: 16 }}>
          Add tenant-specific fields to core entities. Fields you add here appear in the entity's create/edit forms below the built-in fields. Values are stored in each entity's <code>custom_fields</code> JSONB column and validated on write against the schema.
        </p>

        <div style={{ display: "flex", gap: 8, marginBottom: 20, flexWrap: "wrap" }}>
          {CUSTOM_FIELD_ENTITY_TYPES.map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setEntity(t)}
              style={{
                padding: "8px 14px",
                background: entity === t ? "var(--accent-primary)" : "transparent",
                color: entity === t ? "white" : "var(--text-secondary)",
                border: `1px solid ${entity === t ? "var(--accent-primary)" : "var(--border)"}`,
                borderRadius: 6,
                fontSize: 12,
                fontWeight: 600,
                cursor: "pointer",
              }}
            >
              {ENTITY_LABELS[t]}
            </button>
          ))}
        </div>
      </section>

      {loading ? (
        <p style={{ color: "var(--text-muted)" }}>Loading…</p>
      ) : (
        <>
          <FieldList
            fields={schema?.fields ?? []}
            canEdit={canEdit}
            onUpdate={handleUpdate}
            onDeprecate={handleDeprecate}
            onDelete={handleDelete}
          />

          {canEdit && !adding && (
            <button
              type="button"
              onClick={() => setAdding(true)}
              style={{
                alignSelf: "flex-start",
                padding: "10px 16px",
                background: "transparent",
                border: "1px dashed var(--border)",
                color: "var(--accent-primary)",
                borderRadius: 6,
                fontSize: 13,
                fontWeight: 600,
                cursor: "pointer",
              }}
            >
              + Add Field
            </button>
          )}

          {canEdit && adding && (
            <AddFieldForm
              entityType={entity}
              existingKeys={(schema?.fields ?? []).map((f) => f.key)}
              onCancel={() => setAdding(false)}
              onAdd={handleAdd}
            />
          )}
        </>
      )}
    </div>
  );
}

// ─── Field list ─────────────────────────────────────────────────────

function FieldList({
  fields,
  canEdit,
  onUpdate,
  onDeprecate,
  onDelete,
}: {
  fields: FieldDefinition[];
  canEdit: boolean;
  onUpdate: (key: string, patch: Partial<FieldDefinition>) => void;
  onDeprecate: (key: string) => void;
  onDelete: (key: string) => void;
}) {
  if (fields.length === 0) {
    return (
      <p style={{ color: "var(--text-muted)", fontSize: 13 }}>
        No custom fields configured for this entity yet.
      </p>
    );
  }

  const sorted = [...fields].sort((a, b) => {
    if (a.deprecated !== b.deprecated) return a.deprecated ? 1 : -1;
    return a.order - b.order || a.key.localeCompare(b.key);
  });

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      {sorted.map((field) => (
        <FieldRow
          key={field.key}
          field={field}
          canEdit={canEdit}
          onUpdate={(patch) => onUpdate(field.key, patch)}
          onDeprecate={() => onDeprecate(field.key)}
          onDelete={() => onDelete(field.key)}
        />
      ))}
    </div>
  );
}

function FieldRow({
  field,
  canEdit,
  onUpdate,
  onDeprecate,
  onDelete,
}: {
  field: FieldDefinition;
  canEdit: boolean;
  onUpdate: (patch: Partial<FieldDefinition>) => void;
  onDeprecate: () => void;
  onDelete: () => void;
}) {
  return (
    <div
      style={{
        border: "1px solid var(--border)",
        borderRadius: 8,
        padding: 14,
        background: field.deprecated ? "var(--bg-elevated)" : "var(--bg-surface)",
        opacity: field.deprecated ? 0.7 : 1,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
        <div>
          <code style={{ fontSize: 12, color: "var(--accent-primary)", fontFamily: "'JetBrains Mono', monospace" }}>
            {field.key}
          </code>
          <span style={{ fontSize: 11, color: "var(--text-muted)", marginLeft: 10 }}>
            {field.type}
          </span>
          {field.deprecated && (
            <span
              style={{
                marginLeft: 10,
                fontSize: 10,
                fontWeight: 700,
                color: "var(--danger)",
                letterSpacing: "0.06em",
                textTransform: "uppercase",
              }}
            >
              Deprecated
            </span>
          )}
        </div>
        {canEdit && (
          <div style={{ display: "flex", gap: 6 }}>
            {!field.deprecated && (
              <button
                type="button"
                onClick={onDeprecate}
                style={{
                  background: "transparent",
                  border: "1px solid var(--border)",
                  color: "var(--text-muted)",
                  padding: "4px 10px",
                  fontSize: 10,
                  borderRadius: 4,
                  cursor: "pointer",
                  letterSpacing: "0.04em",
                  textTransform: "uppercase",
                }}
              >
                Deprecate
              </button>
            )}
            <button
              type="button"
              onClick={onDelete}
              style={{
                background: "transparent",
                border: "1px solid rgba(239,68,68,0.4)",
                color: "var(--danger)",
                padding: "4px 10px",
                fontSize: 10,
                borderRadius: 4,
                cursor: "pointer",
                letterSpacing: "0.04em",
                textTransform: "uppercase",
              }}
            >
              Delete
            </button>
          </div>
        )}
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr 1fr", gap: 12, alignItems: "flex-end" }}>
        <div>
          <label style={tinyLabelStyle}>Label</label>
          <input
            type="text"
            defaultValue={field.label}
            disabled={!canEdit || field.deprecated}
            onBlur={(e) => {
              if (e.target.value !== field.label) onUpdate({ label: e.target.value });
            }}
            style={inputStyle}
          />
        </div>
        <div>
          <label style={tinyLabelStyle}>Required</label>
          <input
            type="checkbox"
            checked={field.required}
            disabled={!canEdit || field.deprecated}
            onChange={(e) => onUpdate({ required: e.target.checked })}
            style={{ width: 18, height: 18, marginTop: 8 }}
          />
        </div>
        <div>
          <label style={tinyLabelStyle}>Searchable</label>
          <input
            type="checkbox"
            checked={field.searchable}
            disabled={!canEdit || field.deprecated}
            onChange={(e) => onUpdate({ searchable: e.target.checked })}
            style={{ width: 18, height: 18, marginTop: 8 }}
          />
        </div>
      </div>

      {field.description && (
        <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 8 }}>
          {field.description}
        </div>
      )}
    </div>
  );
}

// ─── Add-field form ─────────────────────────────────────────────────

function AddFieldForm({
  entityType,
  existingKeys,
  onCancel,
  onAdd,
}: {
  entityType: CustomFieldEntityType;
  existingKeys: string[];
  onCancel: () => void;
  onAdd: (field: FieldDefinition) => void;
}) {
  const [key, setKey] = useState("");
  const [label, setLabel] = useState("");
  const [type, setType] = useState<FieldType>("string");
  const [required, setRequired] = useState(false);
  const [searchable, setSearchable] = useState(false);
  const [description, setDescription] = useState("");
  const [enumOptions, setEnumOptions] = useState<Array<{ value: string; label: string }>>([
    { value: "", label: "" },
  ]);
  const [error, setError] = useState<string | null>(null);

  // Live reserved-key check so the admin sees the collision as soon
  // as they finish typing a bad key — no need to hit the server.
  // The server still enforces the same rule, so this is purely UX.
  const keyMatchesFormat = /^[a-z][a-z0-9_]*$/.test(key);
  const keyIsReserved = keyMatchesFormat && isReservedFieldKey(entityType, key);
  const keyAlreadyExists = keyMatchesFormat && existingKeys.includes(key);
  const liveKeyWarning = keyIsReserved
    ? `"${key}" is reserved — it matches a core column on ${entityType}. Pick a different key.`
    : keyAlreadyExists
      ? `"${key}" already exists on this entity.`
      : null;

  function validate(): FieldDefinition | null {
    setError(null);
    if (!/^[a-z][a-z0-9_]*$/.test(key)) {
      setError("Key must start with a lowercase letter and contain only lowercase letters, digits, and underscores");
      return null;
    }
    if (isReservedFieldKey(entityType, key)) {
      setError(
        `Key "${key}" is reserved — it matches a core column on ${entityType}. Pick a different key.`,
      );
      return null;
    }
    if (existingKeys.includes(key)) {
      setError(`Key "${key}" already exists`);
      return null;
    }
    if (!label.trim()) {
      setError("Label is required");
      return null;
    }
    const field: FieldDefinition = {
      key,
      label: label.trim(),
      type,
      required,
      searchable,
      order: 100,
      deprecated: false,
      description: description.trim() || undefined,
    };
    if (type === "enum") {
      const validOptions = enumOptions.filter((o) => o.value.trim() && o.label.trim());
      if (validOptions.length === 0) {
        setError("Enum fields need at least one option");
        return null;
      }
      field.enumOptions = validOptions;
    }
    return field;
  }

  function handleSubmit() {
    const field = validate();
    if (field) onAdd(field);
  }

  return (
    <div
      style={{
        border: "1px solid var(--accent-primary)",
        borderRadius: 8,
        padding: 18,
        background: "var(--bg-surface)",
      }}
    >
      <h3 style={{ fontSize: 13, fontWeight: 700, marginTop: 0, marginBottom: 14 }}>Add Field</h3>

      {error && (
        <div
          style={{
            padding: 10,
            background: "var(--danger-subtle)",
            color: "var(--danger)",
            fontSize: 12,
            borderRadius: 4,
            marginBottom: 14,
          }}
        >
          {error}
        </div>
      )}

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 12 }}>
        <div>
          <label style={tinyLabelStyle}>Key (immutable once saved)</label>
          <input
            type="text"
            value={key}
            onChange={(e) => setKey(e.target.value)}
            placeholder="membership_tier"
            style={{
              ...inputStyle,
              borderColor: liveKeyWarning ? "var(--danger)" : "var(--border)",
            }}
          />
          {liveKeyWarning && (
            <div style={{ fontSize: 11, color: "var(--danger)", marginTop: 4 }}>
              {liveKeyWarning}
            </div>
          )}
        </div>
        <div>
          <label style={tinyLabelStyle}>Label</label>
          <input
            type="text"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="Membership Tier"
            style={inputStyle}
          />
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr 1fr", gap: 12, marginBottom: 12 }}>
        <div>
          <label style={tinyLabelStyle}>Type</label>
          <select
            value={type}
            onChange={(e) => setType(e.target.value as FieldType)}
            style={inputStyle}
          >
            {FIELD_TYPE_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label style={tinyLabelStyle}>Required</label>
          <input
            type="checkbox"
            checked={required}
            onChange={(e) => setRequired(e.target.checked)}
            style={{ width: 18, height: 18, marginTop: 8 }}
          />
        </div>
        <div>
          <label style={tinyLabelStyle}>Searchable</label>
          <input
            type="checkbox"
            checked={searchable}
            onChange={(e) => setSearchable(e.target.checked)}
            style={{ width: 18, height: 18, marginTop: 8 }}
          />
        </div>
      </div>

      <div style={{ marginBottom: 12 }}>
        <label style={tinyLabelStyle}>Description (optional)</label>
        <input
          type="text"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Help text shown under the field"
          style={inputStyle}
        />
      </div>

      {type === "enum" && (
        <div style={{ marginBottom: 12 }}>
          <label style={tinyLabelStyle}>Options</label>
          {enumOptions.map((opt, idx) => (
            <div key={idx} style={{ display: "grid", gridTemplateColumns: "1fr 1fr auto", gap: 8, marginBottom: 6 }}>
              <input
                type="text"
                value={opt.value}
                onChange={(e) => {
                  const next = [...enumOptions];
                  next[idx] = { ...next[idx], value: e.target.value };
                  setEnumOptions(next);
                }}
                placeholder="GOLD"
                style={inputStyle}
              />
              <input
                type="text"
                value={opt.label}
                onChange={(e) => {
                  const next = [...enumOptions];
                  next[idx] = { ...next[idx], label: e.target.value };
                  setEnumOptions(next);
                }}
                placeholder="Gold Tier"
                style={inputStyle}
              />
              <button
                type="button"
                onClick={() => setEnumOptions(enumOptions.filter((_, i) => i !== idx))}
                style={{
                  background: "transparent",
                  border: "1px solid var(--border)",
                  color: "var(--text-muted)",
                  borderRadius: 4,
                  cursor: "pointer",
                  padding: "0 10px",
                }}
              >
                ×
              </button>
            </div>
          ))}
          <button
            type="button"
            onClick={() => setEnumOptions([...enumOptions, { value: "", label: "" }])}
            style={{
              background: "transparent",
              border: "1px dashed var(--border)",
              color: "var(--text-muted)",
              padding: "6px 10px",
              fontSize: 11,
              borderRadius: 4,
              cursor: "pointer",
            }}
          >
            + Add option
          </button>
        </div>
      )}

      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 16 }}>
        <button
          type="button"
          onClick={onCancel}
          style={{
            padding: "8px 14px",
            background: "transparent",
            border: "1px solid var(--border)",
            color: "var(--text-secondary)",
            borderRadius: 6,
            fontSize: 13,
            cursor: "pointer",
          }}
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={handleSubmit}
          style={{
            padding: "8px 16px",
            background: "var(--accent-primary)",
            color: "white",
            border: "none",
            borderRadius: 6,
            fontSize: 13,
            fontWeight: 600,
            cursor: "pointer",
          }}
        >
          Add Field
        </button>
      </div>
    </div>
  );
}

const tinyLabelStyle: React.CSSProperties = {
  display: "block",
  fontSize: 10,
  fontWeight: 700,
  letterSpacing: "0.06em",
  color: "var(--text-muted)",
  textTransform: "uppercase",
  marginBottom: 4,
};

const inputStyle: React.CSSProperties = {
  width: "100%",
  padding: "8px 10px",
  fontSize: 13,
  background: "var(--bg-elevated)",
  border: "1px solid var(--border)",
  borderRadius: 4,
  color: "var(--text-primary)",
  fontFamily: "inherit",
};
