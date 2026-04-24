"use client";

import { useEffect, useState } from "react";
import {
  CUSTOM_FIELD_ENTITY_TYPES,
  CUSTOM_FIELD_KINDS,
  isReservedFieldKey,
  kindForField,
  type CustomFieldEntityType,
  type CustomFieldKind,
  type CustomFieldSchemaDTO,
  type FieldDefinition,
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


export function CustomFieldsTab() {
  const { canEdit } = usePermission("tenant_profile");
  const { toast } = useToast();

  const [entity, setEntity] = useState<CustomFieldEntityType>("customer");
  const [schema, setSchema] = useState<CustomFieldSchemaDTO | null>(null);
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);
  // Tracks which field's key is currently open in inline edit mode.
  // Null means no field is being edited. Switching entities clears it.
  const [editingKey, setEditingKey] = useState<string | null>(null);

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
    // Close any open edit form when the admin switches entity tabs
    // so state doesn't bleed across schemas.
    setEditingKey(null);
    setAdding(false);
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

  async function handleSaveEdit(key: string, next: FieldDefinition) {
    // Called from the inline edit form. Sends a full PATCH with
    // every editable property so the admin can change label, type
    // (same-dataType only), description, enum options, required,
    // and searchable in one round trip.
    try {
      const patch: Partial<FieldDefinition> = {
        label: next.label,
        description: next.description,
        displayType: next.displayType,
        required: next.required,
        searchable: next.searchable,
      };
      if (next.enumOptions !== undefined) {
        patch.enumOptions = next.enumOptions;
      }
      const res = await apiClient.patch<CustomFieldSchemaDTO>(
        `/api/v1/custom-fields/${entity}/fields/${key}`,
        patch,
      );
      setSchema(res);
      setEditingKey(null);
      toast(`Updated field "${key}"`, "success");
    } catch (err) {
      toast(err instanceof Error ? err.message : "Failed to save", "error");
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
            editingKey={editingKey}
            onStartEdit={(k) => setEditingKey(k)}
            onCancelEdit={() => setEditingKey(null)}
            onSaveEdit={handleSaveEdit}
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
            <FieldForm
              mode="create"
              entityType={entity}
              existingKeys={(schema?.fields ?? []).map((f) => f.key)}
              onCancel={() => setAdding(false)}
              onSave={handleAdd}
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
  editingKey,
  onStartEdit,
  onCancelEdit,
  onSaveEdit,
  onUpdate,
  onDeprecate,
  onDelete,
}: {
  fields: FieldDefinition[];
  canEdit: boolean;
  editingKey: string | null;
  onStartEdit: (key: string) => void;
  onCancelEdit: () => void;
  onSaveEdit: (key: string, next: FieldDefinition) => void;
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
      {sorted.map((field) => {
        // When this row is in edit mode, replace the standard
        // FieldRow with the shared form component in "edit"
        // mode (initialField supplied). Otherwise render the
        // compact summary row.
        if (editingKey === field.key) {
          return (
            <FieldForm
              key={field.key}
              mode="edit"
              initialField={field}
              existingKeys={[]}
              entityType={"customer" /* unused in edit mode; retained for API parity */ as any}
              onCancel={onCancelEdit}
              onSave={(next) => onSaveEdit(field.key, next)}
            />
          );
        }
        return (
          <FieldRow
            key={field.key}
            field={field}
            canEdit={canEdit}
            onStartEdit={() => onStartEdit(field.key)}
            onUpdate={(patch) => onUpdate(field.key, patch)}
            onDeprecate={() => onDeprecate(field.key)}
            onDelete={() => onDelete(field.key)}
          />
        );
      })}
    </div>
  );
}

function FieldRow({
  field,
  canEdit,
  onStartEdit,
  onUpdate,
  onDeprecate,
  onDelete,
}: {
  field: FieldDefinition;
  canEdit: boolean;
  onStartEdit: () => void;
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
            {kindForField(field).label}
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
              <>
                <button
                  type="button"
                  onClick={onStartEdit}
                  style={{
                    background: "transparent",
                    border: "1px solid var(--accent-primary)",
                    color: "var(--accent-primary)",
                    padding: "4px 10px",
                    fontSize: 10,
                    borderRadius: 4,
                    cursor: "pointer",
                    letterSpacing: "0.04em",
                    textTransform: "uppercase",
                  }}
                >
                  Edit
                </button>
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
              </>
            )}
            <button
              type="button"
              onClick={onDelete}
              style={{
                background: "transparent",
                border: "1px solid var(--danger)",
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

/**
 * Shared form for creating and editing custom field definitions.
 *
 * Modes:
 *   - create: key input is editable, Kind dropdown shows all kinds,
 *     reserved-key and duplicate-key checks run against existingKeys.
 *   - edit: key input is disabled (immutable), Kind dropdown is
 *     restricted to the field's current data type so the admin can
 *     switch display widgets (text↔textarea↔email) or (dropdown↔radio)
 *     without risking data migration. Changing the data type is
 *     blocked — admins must deprecate + re-add for that.
 *
 * The form seeds from initialField in edit mode and emits the full
 * FieldDefinition on save. The parent decides whether to POST or
 * PATCH; this component doesn't know about transport.
 */
function FieldForm({
  mode,
  initialField,
  entityType,
  existingKeys,
  onCancel,
  onSave,
}: {
  mode: "create" | "edit";
  initialField?: FieldDefinition;
  entityType: CustomFieldEntityType;
  existingKeys: string[];
  onCancel: () => void;
  onSave: (field: FieldDefinition) => void;
}) {
  const [key, setKey] = useState(initialField?.key ?? "");
  const [label, setLabel] = useState(initialField?.label ?? "");
  const [kindValue, setKindValue] = useState<string>(
    initialField ? kindForField(initialField).value : "text",
  );
  const [required, setRequired] = useState(initialField?.required ?? false);
  const [searchable, setSearchable] = useState(initialField?.searchable ?? false);
  const [description, setDescription] = useState(initialField?.description ?? "");
  const [enumOptions, setEnumOptions] = useState<Array<{ value: string; label: string }>>(
    initialField?.enumOptions && initialField.enumOptions.length > 0
      ? initialField.enumOptions.map((o) => ({ value: o.value, label: o.label }))
      : [{ value: "", label: "" }],
  );
  const [error, setError] = useState<string | null>(null);

  const isEdit = mode === "edit";
  const keyLocked = isEdit; // Key is immutable on existing fields

  // In edit mode, restrict the Kind dropdown to alternatives within
  // the same data type. Changing the data type would require migrating
  // every stored value — out of scope for inline edit. Same-dataType
  // changes (text ↔ textarea ↔ email, dropdown ↔ radio, etc.) are
  // safe because storage shape doesn't change.
  const availableKinds = isEdit && initialField
    ? CUSTOM_FIELD_KINDS.filter((k) => k.dataType === initialField.type)
    : CUSTOM_FIELD_KINDS;

  // Look up the full Kind record whenever kindValue changes so the
  // form can conditionally show the enum-options editor and the
  // save path knows which (dataType, displayType) to persist.
  const kind: CustomFieldKind =
    CUSTOM_FIELD_KINDS.find((k) => k.value === kindValue) ?? CUSTOM_FIELD_KINDS[0];

  // Live reserved-key check so the admin sees the collision as soon
  // as they finish typing a bad key — no need to hit the server.
  // Skipped in edit mode because the key is locked.
  const keyMatchesFormat = /^[a-z][a-z0-9_]*$/.test(key);
  const keyIsReserved = !isEdit && keyMatchesFormat && isReservedFieldKey(entityType, key);
  const keyAlreadyExists = !isEdit && keyMatchesFormat && existingKeys.includes(key);
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
    // Reserved/duplicate checks only apply on create — the key is
    // immutable on edit so it's known-valid.
    if (!isEdit && isReservedFieldKey(entityType, key)) {
      setError(
        `Key "${key}" is reserved — it matches a core column on ${entityType}. Pick a different key.`,
      );
      return null;
    }
    if (!isEdit && existingKeys.includes(key)) {
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
      type: kind.dataType,
      displayType: kind.displayType,
      required,
      searchable,
      // Preserve the existing order on edit so re-saving doesn't
      // accidentally reshuffle the admin's field list.
      order: initialField?.order ?? 100,
      deprecated: initialField?.deprecated ?? false,
      description: description.trim() || undefined,
    };
    if (kind.hasOptions) {
      const validOptions = enumOptions.filter((o) => o.value.trim() && o.label.trim());
      if (validOptions.length === 0) {
        setError(`${kind.label} needs at least one option in the list of values`);
        return null;
      }
      field.enumOptions = validOptions;
    }
    return field;
  }

  function handleSubmit() {
    const field = validate();
    if (field) onSave(field);
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
      <h3 style={{ fontSize: 13, fontWeight: 700, marginTop: 0, marginBottom: 14 }}>
        {isEdit ? `Edit "${initialField?.key}"` : "Add Field"}
      </h3>

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
          <label style={tinyLabelStyle}>
            Key <RequiredMark />
            {keyLocked && <span style={{ marginLeft: 6, color: "var(--text-muted)", fontSize: 9 }}>(locked)</span>}
            {!keyLocked && <span style={{ marginLeft: 6, color: "var(--text-muted)", fontSize: 9 }}>(immutable once saved)</span>}
          </label>
          <input
            type="text"
            value={key}
            onChange={(e) => setKey(e.target.value)}
            disabled={keyLocked}
            placeholder="membership_tier"
            style={{
              ...inputStyle,
              borderColor: liveKeyWarning ? "var(--danger)" : "var(--border)",
              opacity: keyLocked ? 0.6 : 1,
              cursor: keyLocked ? "not-allowed" : "text",
            }}
          />
          {liveKeyWarning && (
            <div style={{ fontSize: 11, color: "var(--danger)", marginTop: 4 }}>
              {liveKeyWarning}
            </div>
          )}
        </div>
        <div>
          <label style={tinyLabelStyle}>
            Label <RequiredMark />
          </label>
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
          <label style={tinyLabelStyle}>
            Type <RequiredMark />
          </label>
          <select
            value={kindValue}
            onChange={(e) => setKindValue(e.target.value)}
            style={inputStyle}
          >
            {availableKinds.map((k) => (
              <option key={k.value} value={k.value}>
                {k.label}
              </option>
            ))}
          </select>
          {isEdit && (
            <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 4 }}>
              Limited to same data type. Changing data type requires deprecating and recreating the field.
            </div>
          )}
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

      {kind.hasOptions && (
        <div style={{ marginBottom: 12 }}>
          <label style={tinyLabelStyle}>
            List of Values <RequiredMark />
          </label>
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
          {isEdit ? "Save Changes" : "Add Field"}
        </button>
      </div>
    </div>
  );
}

// Tiny reusable red asterisk for required-field indicators on
// admin form labels. Matches the visual used by CustomFieldsSection
// for end-user forms so the whole app renders required markers the
// same way.
function RequiredMark() {
  return (
    <span
      style={{
        color: "var(--danger)",
        fontWeight: 700,
        marginLeft: 2,
      }}
    >
      *
    </span>
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
