"use client";

import React from "react";

interface FormFieldProps {
  label: string;
  error?: string;
  children: React.ReactNode;
  required?: boolean;
  hint?: string;
}

export function FormField({ label, error, children, required, hint }: FormFieldProps) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
      <label
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
          <span style={{ color: "#ef4444", fontSize: "14px", lineHeight: 1 }}>*</span>
        )}
      </label>

      {children}

      {hint && !error && (
        <span style={{ fontSize: "11px", color: "var(--text-muted)" }}>{hint}</span>
      )}

      {error && (
        <span
          style={{
            fontSize: "12px",
            color: "#f87171",
            display: "flex",
            alignItems: "center",
            gap: "4px",
          }}
        >
          <span style={{ fontSize: "13px" }}>⚠</span>
          {error}
        </span>
      )}
    </div>
  );
}
