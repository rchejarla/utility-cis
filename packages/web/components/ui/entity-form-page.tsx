"use client";

import { useEffect, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { PageHeader } from "./page-header";
import { FormField } from "./form-field";
import { AccessDenied } from "./access-denied";
import { apiClient } from "@/lib/api-client";
import { usePermission } from "@/lib/use-permission";
import { useEntityForm } from "@/lib/use-entity-form";

/**
 * Declarative "create entity" page shell. Owns form state, submit
 * lifecycle (loading / error), permission gating, layout (card +
 * field grid + button row), and all the shared styles. Callers
 * supply a field spec and an optional body transform; anything
 * non-standard (commodity-toggle, SearchableSelect, conditional
 * sections) drops into the `render` escape hatch on a field or the
 * `extraSlot` prop on the page.
 *
 * Deliberate non-goals:
 *   - No edit-mode support yet. Every /new page in the app is
 *     strictly POST. When an /edit page appears, add `method` and
 *     `initialValuesFetch` props rather than cramming it in later.
 *   - No Zod integration. Validation still runs on the API side and
 *     error messages come back in the response. Client-side field
 *     validation would be a follow-up.
 */

export type FormOption = { value: string; label: string };

type DynamicOptions = {
  endpoint: string;
  /** Maps a fetched row to an option. */
  mapOption: (row: Record<string, unknown>) => FormOption;
  /** Optional query params for the options fetch. */
  params?: Record<string, string>;
};

interface FormFieldSpecBase<T> {
  key: keyof T & string;
  label: string;
  required?: boolean;
  hint?: string;
  tooltip?: string;
  tooltipRuleId?: string;
  /** Show the field only when this predicate returns true. */
  visibleWhen?: (values: T) => boolean;
}

type TextFieldSpec<T> = FormFieldSpecBase<T> & {
  type: "text";
  placeholder?: string;
};

type NumberFieldSpec<T> = FormFieldSpecBase<T> & {
  type: "number";
  placeholder?: string;
  step?: string;
  min?: string;
  max?: string;
};

type DateFieldSpec<T> = FormFieldSpecBase<T> & {
  type: "date";
  placeholder?: string;
};

type TextareaFieldSpec<T> = FormFieldSpecBase<T> & {
  type: "textarea";
  placeholder?: string;
  rows?: number;
};

type SelectFieldSpec<T> = FormFieldSpecBase<T> & {
  type: "select";
  options: FormOption[] | DynamicOptions;
  /** Show an empty "None" option with this label. */
  emptyOption?: string;
};

type CustomFieldSpec<T> = FormFieldSpecBase<T> & {
  type: "custom";
  /**
   * Render the field yourself. Receives the current value plus a
   * typed setter. Useful for commodity toggles, searchable selects,
   * multi-check lists, or anything that doesn't fit the stock types.
   */
  render: (args: {
    value: T[keyof T & string];
    setValue: (value: T[keyof T & string]) => void;
    values: T;
  }) => ReactNode;
};

export type FormFieldSpec<T> =
  | TextFieldSpec<T>
  | NumberFieldSpec<T>
  | DateFieldSpec<T>
  | TextareaFieldSpec<T>
  | SelectFieldSpec<T>
  | CustomFieldSpec<T>;

export type FormRow<T> = { row: FormFieldSpec<T>[] };
export type FormFieldOrRow<T> = FormFieldSpec<T> | FormRow<T>;

function isRow<T>(entry: FormFieldOrRow<T>): entry is FormRow<T> {
  return "row" in entry;
}

export interface EntityFormPageProps<T extends Record<string, unknown>> {
  title: string;
  subtitle?: string;
  /** Permission module key; `canCreate` on this module is required. */
  module: string;
  /** API endpoint to POST to. */
  endpoint: string;
  /** Path to navigate to when the user clicks Cancel. Also the default post-submit destination. */
  returnTo: string;
  /** Submit button label (e.g. "Create Account"). */
  submitLabel: string;
  /** Label shown while the request is in flight. Defaults to "Creating...". */
  submittingLabel?: string;
  /** Label on the cancel button. Defaults to "Cancel". */
  cancelLabel?: string;
  /** Initial form state. */
  initialValues: T;
  /** Ordered list of fields (or rows of fields) to render. */
  fields: FormFieldOrRow<T>[];
  /**
   * Transforms the form state into the POST body. Use this to drop
   * empty strings, parse numbers, or build nested shapes.
   */
  toRequestBody?: (values: T) => Record<string, unknown>;
  /**
   * Called after a successful POST. Return a path string to redirect
   * somewhere other than `returnTo` (e.g. to the newly-created entity's
   * detail page via `/customers/${response.id}`).
   */
  onSuccess?: (response: unknown) => string | void;
  /**
   * Arbitrary React node rendered below the fields and above the
   * error banner. Use this for meter-assignment lists, rate config
   * builders, or anything that doesn't fit the field spec.
   */
  extraSlot?: (args: {
    values: T;
    setValue: <K extends keyof T>(key: K, value: T[K]) => void;
    setValues: (updater: (prev: T) => T) => void;
  }) => ReactNode;
  /** Card max-width in px (default "640px"). */
  maxWidth?: string;
}

/**
 * Exported so that pages using the `type: "custom"` escape hatch can
 * match the shell's look-and-feel without re-declaring these properties.
 */
export const formInputStyle = {
  padding: "8px 12px",
  borderRadius: "var(--radius)",
  border: "1px solid var(--border)",
  background: "var(--bg-elevated)",
  color: "var(--text-primary)",
  fontSize: "13px",
  fontFamily: "inherit",
  outline: "none",
  width: "100%",
  boxSizing: "border-box" as const,
};

const inputStyle = formInputStyle;

function useDynamicOptions<T>(fields: FormFieldOrRow<T>[]): Record<string, FormOption[]> {
  const [dynamicOptions, setDynamicOptions] = useState<Record<string, FormOption[]>>({});

  useEffect(() => {
    const toFetch: Array<{ key: string; spec: DynamicOptions }> = [];
    const walk = (entries: FormFieldOrRow<T>[]) => {
      for (const entry of entries) {
        const items = isRow(entry) ? entry.row : [entry];
        for (const field of items) {
          if (
            field.type === "select" &&
            field.options &&
            !Array.isArray(field.options)
          ) {
            toFetch.push({ key: field.key, spec: field.options });
          }
        }
      }
    };
    walk(fields);

    if (toFetch.length === 0) return;

    let cancelled = false;
    Promise.all(
      toFetch.map(async ({ key, spec }) => {
        try {
          const res = await apiClient.get<
            { data: Record<string, unknown>[] } | Record<string, unknown>[]
          >(spec.endpoint, spec.params);
          const rows = Array.isArray(res) ? res : res.data ?? [];
          return [key, rows.map(spec.mapOption)] as const;
        } catch (err) {
          console.error(`Failed to load options for field "${key}"`, err);
          return [key, [] as FormOption[]] as const;
        }
      })
    ).then((entries) => {
      if (cancelled) return;
      setDynamicOptions(Object.fromEntries(entries));
    });
    return () => {
      cancelled = true;
    };
    // We intentionally run this once per mount; field spec is static
    // for the lifetime of the page.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return dynamicOptions;
}

export function EntityFormPage<T extends Record<string, unknown>>(
  props: EntityFormPageProps<T>,
) {
  const {
    title,
    subtitle,
    module,
    endpoint,
    returnTo,
    submitLabel,
    submittingLabel = "Creating...",
    cancelLabel = "Cancel",
    initialValues,
    fields,
    toRequestBody,
    onSuccess,
    extraSlot,
    maxWidth = "640px",
  } = props;

  const router = useRouter();
  const { canCreate } = usePermission(module);
  const { values, setValue, setValues, submitting, error, submit } =
    useEntityForm<T>({
      endpoint,
      initialValues,
      toRequestBody,
      onSuccess,
    });

  const dynamicOptions = useDynamicOptions<T>(fields);

  if (!canCreate) return <AccessDenied />;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const result = await submit();
    if (result.ok) {
      router.push(result.nextPath ?? returnTo);
    }
  };

  const renderField = (field: FormFieldSpec<T>): ReactNode => {
    if (field.visibleWhen && !field.visibleWhen(values)) return null;

    const rawValue = values[field.key];
    const stringValue = rawValue == null ? "" : String(rawValue);

    const common = {
      label: field.label,
      required: field.required,
      hint: field.hint,
      tooltip: field.tooltip,
      tooltipRuleId: field.tooltipRuleId,
    };

    if (field.type === "custom") {
      return (
        <FormField key={field.key} {...common}>
          {field.render({
            value: rawValue as T[keyof T & string],
            setValue: (v) => setValue(field.key, v as T[keyof T & string]),
            values,
          })}
        </FormField>
      );
    }

    if (field.type === "select") {
      const options = Array.isArray(field.options)
        ? field.options
        : dynamicOptions[field.key] ?? [];
      return (
        <FormField key={field.key} {...common}>
          <select
            style={inputStyle}
            value={stringValue}
            onChange={(e) =>
              setValue(field.key, e.target.value as T[keyof T & string])
            }
            required={field.required}
          >
            {field.emptyOption !== undefined && (
              <option value="">{field.emptyOption}</option>
            )}
            {options.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </FormField>
      );
    }

    if (field.type === "textarea") {
      return (
        <FormField key={field.key} {...common}>
          <textarea
            style={{
              ...inputStyle,
              minHeight: `${(field.rows ?? 4) * 20}px`,
              resize: "vertical",
            }}
            value={stringValue}
            onChange={(e) =>
              setValue(field.key, e.target.value as T[keyof T & string])
            }
            placeholder={field.placeholder}
            required={field.required}
            rows={field.rows}
          />
        </FormField>
      );
    }

    return (
      <FormField key={field.key} {...common}>
        <input
          style={inputStyle}
          type={field.type}
          value={stringValue}
          onChange={(e) =>
            setValue(field.key, e.target.value as T[keyof T & string])
          }
          placeholder={field.type !== "date" ? field.placeholder : undefined}
          required={field.required}
          {...(field.type === "number"
            ? { step: field.step, min: field.min, max: field.max }
            : {})}
        />
      </FormField>
    );
  };

  return (
    <div style={{ maxWidth }}>
      <PageHeader title={title} subtitle={subtitle} />

      <form onSubmit={handleSubmit}>
        <div
          style={{
            background: "var(--bg-card)",
            border: "1px solid var(--border)",
            borderRadius: "var(--radius)",
            padding: "24px",
            display: "flex",
            flexDirection: "column",
            gap: "20px",
          }}
        >
          {fields.map((entry, idx) => {
            if (isRow(entry)) {
              const visibleFields = entry.row.filter(
                (f) => !f.visibleWhen || f.visibleWhen(values),
              );
              if (visibleFields.length === 0) return null;
              return (
                <div
                  key={`row-${idx}`}
                  style={{
                    display: "grid",
                    gridTemplateColumns: `repeat(${visibleFields.length}, 1fr)`,
                    gap: "12px",
                  }}
                >
                  {visibleFields.map((f) => renderField(f))}
                </div>
              );
            }
            return renderField(entry);
          })}

          {extraSlot?.({ values, setValue, setValues })}

          {error && (
            <div
              role="alert"
              style={{
                padding: "10px 14px",
                borderRadius: "var(--radius)",
                background: "rgba(239,68,68,0.1)",
                border: "1px solid rgba(239,68,68,0.3)",
                color: "var(--danger)",
                fontSize: "13px",
              }}
            >
              {error}
            </div>
          )}

          <div style={{ display: "flex", gap: "10px", justifyContent: "flex-end" }}>
            <button
              type="button"
              onClick={() => router.push(returnTo)}
              style={{
                padding: "8px 20px",
                borderRadius: "var(--radius)",
                border: "1px solid var(--border)",
                background: "transparent",
                color: "var(--text-secondary)",
                fontSize: "13px",
                cursor: "pointer",
                fontFamily: "inherit",
              }}
            >
              {cancelLabel}
            </button>
            <button
              type="submit"
              disabled={submitting}
              style={{
                padding: "8px 20px",
                borderRadius: "var(--radius)",
                border: "none",
                background: "var(--accent-primary)",
                color: "#fff",
                fontSize: "13px",
                fontWeight: 500,
                cursor: submitting ? "not-allowed" : "pointer",
                opacity: submitting ? 0.7 : 1,
                fontFamily: "inherit",
              }}
            >
              {submitting ? submittingLabel : submitLabel}
            </button>
          </div>
        </div>
      </form>
    </div>
  );
}
