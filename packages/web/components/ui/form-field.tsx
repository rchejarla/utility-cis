"use client";

import React, { useId } from "react";
import { HelpTooltip } from "./tooltip";

interface FormFieldProps {
  label: string;
  error?: string;
  children: React.ReactNode;
  required?: boolean;
  hint?: string;
  tooltip?: string;
  tooltipRuleId?: string;
}

export function FormField({
  label,
  error,
  children,
  required,
  hint,
  tooltip,
  tooltipRuleId,
}: FormFieldProps) {
  const reactId = useId();
  const inputId = `ff-${reactId}`;
  const hintId = hint ? `${inputId}-hint` : undefined;
  const errorId = error ? `${inputId}-error` : undefined;
  const describedBy = [hintId, errorId].filter(Boolean).join(" ") || undefined;

  // Inject a11y props into the first child input/select/textarea. If the
  // child already sets one of these, preserve the caller's value.
  let wrappedChildren: React.ReactNode = children;
  if (React.isValidElement(children)) {
    const child = children as React.ReactElement<{
      id?: string;
      "aria-invalid"?: boolean | "true" | "false";
      "aria-describedby"?: string;
      "aria-required"?: boolean | "true" | "false";
    }>;
    wrappedChildren = React.cloneElement(child, {
      id: child.props.id ?? inputId,
      "aria-invalid": child.props["aria-invalid"] ?? (error ? "true" : undefined),
      "aria-describedby": child.props["aria-describedby"] ?? describedBy,
      "aria-required": child.props["aria-required"] ?? (required ? "true" : undefined),
    });
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
      <label
        htmlFor={inputId}
        style={{
          fontSize: "13px",
          fontWeight: "500",
          color: "var(--text-secondary)",
          display: "flex",
          alignItems: "center",
          gap: "4px",
        }}
      >
        {label}
        {required && (
          <span aria-hidden="true" style={{ color: "var(--danger)", fontSize: "14px", lineHeight: 1 }}>
            *
          </span>
        )}
        {required && <span className="sr-only">(required)</span>}
        {tooltip && <HelpTooltip text={tooltip} ruleId={tooltipRuleId} />}
      </label>

      {wrappedChildren}

      {hint && !error && (
        <span id={hintId} style={{ fontSize: "11px", color: "var(--text-muted)" }}>
          {hint}
        </span>
      )}

      {error && (
        <span
          id={errorId}
          role="alert"
          style={{
            fontSize: "12px",
            color: "var(--danger)",
            display: "flex",
            alignItems: "center",
            gap: "4px",
          }}
        >
          <span aria-hidden="true" style={{ fontSize: "13px" }}>
            ⚠
          </span>
          {error}
        </span>
      )}
    </div>
  );
}
