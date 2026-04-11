"use client";

import type { FieldDefinition } from "@utility-cis/shared";

/**
 * Renders the "Custom Fields" section for an entity form.
 *
 * Consumes a tenant's field schema (FieldDefinition[] loaded from
 * /api/v1/custom-fields/:entity) plus a values object keyed by field
 * key. Emits onChange with a new values object whenever any input
 * changes.
 *
 * Rendering behavior:
 *   - Fields are sorted by their `order` property then by key.
 *   - Deprecated fields are hidden UNLESS the values object has a
 *     non-null value for that field, in which case they render as
 *     read-only so the user can see what's stored but can't edit.
 *   - The component returns null entirely if there are no active
 *     fields and no deprecated-with-value fields — keeps the form
 *     clean for tenants who haven't configured anything.
 *
 * This is a "dumb" controlled component: it doesn't own its state,
 * doesn't fetch anything, and doesn't know about forms. The parent
 * manages the values in its own state and hands them back on submit.
 */

export interface CustomFieldsSectionProps {
  /** Field definitions from the tenant schema. */
  schema: FieldDefinition[];
  /** Current values keyed by field key. */
  values: Record<string, unknown>;
  /** Called with the new values object whenever any input changes. */
  onChange: (next: Record<string, unknown>) => void;
  /** If true, all inputs render read-only. */
  disabled?: boolean;
  /**
   * Override the default input style — lets a host page pass its own
   * background/padding/border so the custom-fields inputs visually
   * match the surrounding form. Without this, the section uses a
   * neutral default (bg-elevated) that matches EntityFormPage. Detail
   * pages that use a darker bg-deep for inline edits pass that shape
   * here to avoid a visual mismatch.
   */
  inputStyle?: React.CSSProperties;
  /**
   * Override the per-field wrapper style. Controls the layout of
   * label vs input. The default is a vertical stack (flex column,
   * label on top) matching EntityFormPage's form-shell aesthetic.
   * Hosts like the customer detail page pass a 2-column CSS grid
   * (`display: grid, gridTemplateColumns: "180px 1fr"`) to render
   * label-on-left like the core inline-edit fields on the same page.
   */
  fieldStyle?: React.CSSProperties;
  /** Override the per-field label style (font, color, weight, etc.). */
  labelStyle?: React.CSSProperties;
  /**
   * When true, the component does not render its own "Custom Fields"
   * section heading. Hosts that provide their own section header
   * (e.g. the customer detail page, which matches its local section
   * header style) pass this to avoid a duplicate heading. Defaults
   * to false so form-shell hosts like /customers/new still get an
   * automatic heading without extra wiring.
   */
  hideHeader?: boolean;
}

export function CustomFieldsSection({
  schema,
  values,
  onChange,
  disabled,
  inputStyle,
  fieldStyle,
  labelStyle,
  hideHeader,
}: CustomFieldsSectionProps) {
  // Split fields into "active" (editable) and "deprecated-with-data"
  // (read-only legacy display). Deprecated-with-no-data is dropped.
  const active: FieldDefinition[] = [];
  const legacy: FieldDefinition[] = [];
  for (const field of schema) {
    if (!field.deprecated) {
      active.push(field);
    } else if (values[field.key] !== undefined && values[field.key] !== null) {
      legacy.push(field);
    }
  }

  if (active.length === 0 && legacy.length === 0) {
    return null;
  }

  active.sort((a, b) => a.order - b.order || a.key.localeCompare(b.key));
  legacy.sort((a, b) => a.order - b.order || a.key.localeCompare(b.key));

  function update(key: string, value: unknown): void {
    const next = { ...values, [key]: value };
    onChange(next);
  }

  return (
    <section
      style={{
        // When a host provides its own section header, drop the top
        // border + padding so the component blends into the parent's
        // section rhythm instead of creating a double-separator.
        marginTop: hideHeader ? 0 : 24,
        paddingTop: hideHeader ? 0 : 20,
        borderTop: hideHeader ? "none" : "1px solid var(--border)",
        display: "flex",
        flexDirection: "column",
        gap: 16,
      }}
    >
      {!hideHeader && (
        <div
          style={{
            fontSize: 11,
            fontWeight: 700,
            letterSpacing: "0.06em",
            textTransform: "uppercase",
            color: "var(--text-muted)",
          }}
        >
          Custom Fields
        </div>
      )}

      {active.map((field) => (
        <FieldInput
          key={field.key}
          field={field}
          value={values[field.key]}
          onChange={(v) => update(field.key, v)}
          disabled={disabled}
          inputStyle={inputStyle}
          fieldStyle={fieldStyle}
          labelStyle={labelStyle}
        />
      ))}

      {legacy.length > 0 && (
        <div
          style={{
            marginTop: 8,
            paddingTop: 12,
            borderTop: "1px dashed var(--border)",
            display: "flex",
            flexDirection: "column",
            gap: 8,
          }}
        >
          <div
            style={{
              fontSize: 10,
              color: "var(--text-muted)",
              letterSpacing: "0.06em",
              textTransform: "uppercase",
            }}
          >
            Deprecated — Read Only
          </div>
          {legacy.map((field) => (
            <LegacyDisplay key={field.key} field={field} value={values[field.key]} />
          ))}
        </div>
      )}
    </section>
  );
}

// ─── Input dispatch ────────────────────────────────────────────────

// Defaults matching the stacked form-shell layout EntityFormPage uses.
// Hosts can override either or both via props for a different layout.
const DEFAULT_FIELD_STYLE: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
};

const DEFAULT_LABEL_STYLE: React.CSSProperties = {
  display: "block",
  fontSize: 12,
  fontWeight: 500,
  color: "var(--text-muted)",
  marginBottom: 6,
};

function FieldInput({
  field,
  value,
  onChange,
  disabled,
  inputStyle,
  fieldStyle,
  labelStyle,
}: {
  field: FieldDefinition;
  value: unknown;
  onChange: (v: unknown) => void;
  disabled?: boolean;
  inputStyle?: React.CSSProperties;
  fieldStyle?: React.CSSProperties;
  labelStyle?: React.CSSProperties;
}) {
  // The wrapper uses whatever layout the host asks for — flex column
  // (default) for stacked, or CSS grid for label-on-left. The label
  // and the input+description wrapper are both direct children so
  // either layout works. When the host supplies its own fieldStyle,
  // they're passing a full replacement (not merge) so their layout
  // fully overrides the default — this matches how Prisma's
  // formInputStyle override works elsewhere in the codebase.
  const wrapperStyle = fieldStyle ?? DEFAULT_FIELD_STYLE;
  const labelStyleResolved = labelStyle ?? DEFAULT_LABEL_STYLE;

  return (
    <div style={wrapperStyle}>
      <label style={labelStyleResolved}>
        {field.label}
        {field.required && <span style={{ color: "var(--danger)", marginLeft: 4 }}>*</span>}
      </label>
      <div>
        {renderControl(field, value, onChange, disabled, inputStyle)}
        {field.description && (
          <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 4 }}>
            {field.description}
          </div>
        )}
      </div>
    </div>
  );
}

// Default input style when the host doesn't pass one. Matches
// EntityFormPage's formInputStyle so /customers/new (and any other
// form-shell host) looks uniform with the rest of its inputs.
const DEFAULT_INPUT_STYLE: React.CSSProperties = {
  width: "100%",
  padding: "9px 12px",
  fontSize: 13,
  background: "var(--bg-elevated)",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius)",
  color: "var(--text-primary)",
  fontFamily: "inherit",
};

function renderControl(
  field: FieldDefinition,
  value: unknown,
  onChange: (v: unknown) => void,
  disabled?: boolean,
  overrideStyle?: React.CSSProperties,
): React.ReactNode {
  const commonStyle: React.CSSProperties = {
    ...DEFAULT_INPUT_STYLE,
    ...overrideStyle,
  };

  switch (field.type) {
    case "string":
      return (
        <input
          type="text"
          value={(value as string | null | undefined) ?? ""}
          onChange={(e) => onChange(e.target.value || null)}
          disabled={disabled}
          style={commonStyle}
        />
      );
    case "number":
      return (
        <input
          type="number"
          value={value === null || value === undefined ? "" : String(value)}
          onChange={(e) => {
            const raw = e.target.value;
            if (raw === "") return onChange(null);
            const n = Number(raw);
            onChange(Number.isFinite(n) ? n : null);
          }}
          disabled={disabled}
          style={commonStyle}
        />
      );
    case "date":
      return (
        <input
          type="date"
          value={(value as string | null | undefined) ?? ""}
          onChange={(e) => onChange(e.target.value || null)}
          disabled={disabled}
          style={commonStyle}
        />
      );
    case "boolean":
      return (
        <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13 }}>
          <input
            type="checkbox"
            checked={Boolean(value)}
            onChange={(e) => onChange(e.target.checked)}
            disabled={disabled}
          />
          <span>Yes</span>
        </label>
      );
    case "enum":
      return (
        <select
          value={(value as string | null | undefined) ?? ""}
          onChange={(e) => onChange(e.target.value || null)}
          disabled={disabled}
          style={commonStyle}
        >
          <option value="">Select...</option>
          {field.enumOptions?.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
      );
  }
}

function LegacyDisplay({ field, value }: { field: FieldDefinition; value: unknown }) {
  return (
    <div style={{ fontSize: 12 }}>
      <span style={{ color: "var(--text-muted)", marginRight: 8 }}>{field.label}:</span>
      <span style={{ color: "var(--text-secondary)" }}>{formatLegacy(field, value)}</span>
    </div>
  );
}

function formatLegacy(field: FieldDefinition, value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (field.type === "boolean") return value ? "Yes" : "No";
  if (field.type === "enum") {
    const match = field.enumOptions?.find((o) => o.value === value);
    return match?.label ?? String(value);
  }
  return String(value);
}
