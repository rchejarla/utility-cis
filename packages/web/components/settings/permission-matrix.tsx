"use client";

import React from "react";
import { MODULES, PERMISSIONS, MODULE_META } from "@utility-cis/shared";

export interface PermissionMatrixProps {
  permissions: Record<string, string[]>;
  onChange: (permissions: Record<string, string[]>) => void;
  readOnly?: boolean;
}

const PERM_LABELS: Record<string, string> = {
  VIEW: "View",
  CREATE: "Create",
  EDIT: "Edit",
  DELETE: "Delete",
};

export function PermissionMatrix({ permissions, onChange, readOnly = false }: PermissionMatrixProps) {
  const hasPermission = (module: string, perm: string) =>
    (permissions[module] ?? []).includes(perm);

  const handleCheck = (module: string, perm: string, checked: boolean) => {
    if (readOnly) return;
    const current = permissions[module] ?? [];

    let updated: string[];
    if (checked) {
      // BR-RB-004: CREATE/EDIT/DELETE auto-check VIEW
      if (perm !== "VIEW") {
        updated = Array.from(new Set([...current, perm, "VIEW"]));
      } else {
        updated = Array.from(new Set([...current, perm]));
      }
    } else {
      if (perm === "VIEW") {
        // Unchecking VIEW removes all permissions for this module
        updated = [];
      } else {
        updated = current.filter((p) => p !== perm);
      }
    }

    onChange({ ...permissions, [module]: updated });
  };

  const handleSelectAllColumn = (perm: string) => {
    if (readOnly) return;
    const updated = { ...permissions };
    for (const module of MODULES) {
      const current = updated[module] ?? [];
      if (perm !== "VIEW") {
        updated[module] = Array.from(new Set([...current, perm, "VIEW"]));
      } else {
        updated[module] = Array.from(new Set([...current, perm]));
      }
    }
    onChange(updated);
  };

  const handleRowAll = (module: string) => {
    if (readOnly) return;
    onChange({ ...permissions, [module]: [...PERMISSIONS] });
  };

  const handleRowNone = (module: string) => {
    if (readOnly) return;
    onChange({ ...permissions, [module]: [] });
  };

  const thStyle: React.CSSProperties = {
    padding: "8px 12px",
    textAlign: "center",
    fontSize: "11px",
    fontWeight: 600,
    textTransform: "uppercase",
    letterSpacing: "0.06em",
    color: "var(--text-muted)",
    borderBottom: "1px solid var(--border)",
    whiteSpace: "nowrap",
  };

  const tdStyle: React.CSSProperties = {
    padding: "8px 12px",
    textAlign: "center",
    borderBottom: "1px solid var(--border-subtle)",
    verticalAlign: "middle",
  };

  const moduleTdStyle: React.CSSProperties = {
    padding: "8px 14px",
    textAlign: "left",
    borderBottom: "1px solid var(--border-subtle)",
    fontSize: "13px",
    color: "var(--text-primary)",
    fontWeight: 500,
    whiteSpace: "nowrap",
    verticalAlign: "middle",
  };

  const miniBtn: React.CSSProperties = {
    padding: "2px 8px",
    fontSize: "11px",
    border: "1px solid var(--border)",
    borderRadius: "4px",
    background: "transparent",
    color: "var(--text-secondary)",
    cursor: readOnly ? "default" : "pointer",
    fontFamily: "inherit",
    lineHeight: "1.4",
    transition: "all 0.12s ease",
  };

  const selectAllBtn: React.CSSProperties = {
    display: "block",
    margin: "4px auto 0",
    padding: "2px 8px",
    fontSize: "10px",
    border: "1px solid var(--border)",
    borderRadius: "4px",
    background: "transparent",
    color: "var(--text-muted)",
    cursor: readOnly ? "default" : "pointer",
    fontFamily: "inherit",
    whiteSpace: "nowrap",
    transition: "all 0.12s ease",
  };

  return (
    <div
      style={{
        background: "var(--bg-card)",
        border: "1px solid var(--border)",
        borderRadius: "var(--radius)",
        overflow: "hidden",
      }}
    >
      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", tableLayout: "auto" }}>
          <thead>
            <tr style={{ background: "var(--bg-elevated)" }}>
              <th
                style={{
                  ...thStyle,
                  textAlign: "left",
                  paddingLeft: "14px",
                  minWidth: "160px",
                }}
              >
                Module
              </th>
              {PERMISSIONS.map((perm) => (
                <th key={perm} style={{ ...thStyle, minWidth: "90px" }}>
                  {PERM_LABELS[perm]}
                  {!readOnly && (
                    <button
                      style={selectAllBtn}
                      onClick={() => handleSelectAllColumn(perm)}
                      onMouseEnter={(e) => {
                        (e.currentTarget as HTMLButtonElement).style.color = "var(--text-primary)";
                        (e.currentTarget as HTMLButtonElement).style.borderColor = "var(--accent-primary)";
                      }}
                      onMouseLeave={(e) => {
                        (e.currentTarget as HTMLButtonElement).style.color = "var(--text-muted)";
                        (e.currentTarget as HTMLButtonElement).style.borderColor = "var(--border)";
                      }}
                    >
                      All
                    </button>
                  )}
                </th>
              ))}
              <th style={{ ...thStyle, minWidth: "110px" }}>Row</th>
            </tr>
          </thead>
          <tbody>
            {MODULES.map((module, idx) => {
              const meta = MODULE_META[module];
              const rowPerms = permissions[module] ?? [];
              const allChecked = PERMISSIONS.every((p) => rowPerms.includes(p));
              const noneChecked = rowPerms.length === 0;

              return (
                <tr
                  key={module}
                  style={{
                    background: idx % 2 === 0 ? "transparent" : "rgba(255,255,255,0.015)",
                  }}
                >
                  <td style={moduleTdStyle}>
                    {meta.label}
                    {module === "audit_log" && (
                      <span
                        style={{
                          marginLeft: "6px",
                          fontSize: "10px",
                          color: "var(--text-muted)",
                          fontWeight: 400,
                        }}
                      >
                        (View only)
                      </span>
                    )}
                  </td>

                  {PERMISSIONS.map((perm) => {
                    const checked = rowPerms.includes(perm);
                    // audit_log only supports VIEW
                    const isDisabled = readOnly || (module === "audit_log" && perm !== "VIEW");

                    return (
                      <td key={perm} style={tdStyle}>
                        {readOnly ? (
                          <span
                            style={{
                              fontSize: "14px",
                              color: checked ? "var(--accent-primary)" : "var(--text-muted)",
                              fontWeight: checked ? 600 : 400,
                            }}
                          >
                            {checked ? "✓" : "—"}
                          </span>
                        ) : (
                          <input
                            type="checkbox"
                            checked={checked}
                            disabled={isDisabled}
                            onChange={(e) => handleCheck(module, perm, e.target.checked)}
                            style={{
                              width: "15px",
                              height: "15px",
                              cursor: isDisabled ? "not-allowed" : "pointer",
                              accentColor: "var(--accent-primary)",
                            }}
                          />
                        )}
                      </td>
                    );
                  })}

                  <td style={{ ...tdStyle, textAlign: "center" }}>
                    {readOnly ? (
                      <span style={{ fontSize: "11px", color: "var(--text-muted)" }}>
                        {allChecked ? "Full" : noneChecked ? "None" : "Custom"}
                      </span>
                    ) : (
                      <div style={{ display: "flex", gap: "4px", justifyContent: "center" }}>
                        <button
                          style={{
                            ...miniBtn,
                            opacity: allChecked ? 0.5 : 1,
                          }}
                          disabled={allChecked}
                          onClick={() => handleRowAll(module)}
                          onMouseEnter={(e) => {
                            if (!allChecked) {
                              (e.currentTarget as HTMLButtonElement).style.color = "var(--text-primary)";
                              (e.currentTarget as HTMLButtonElement).style.borderColor = "var(--accent-primary)";
                            }
                          }}
                          onMouseLeave={(e) => {
                            (e.currentTarget as HTMLButtonElement).style.color = "var(--text-secondary)";
                            (e.currentTarget as HTMLButtonElement).style.borderColor = "var(--border)";
                          }}
                        >
                          All
                        </button>
                        <button
                          style={{
                            ...miniBtn,
                            opacity: noneChecked ? 0.5 : 1,
                          }}
                          disabled={noneChecked}
                          onClick={() => handleRowNone(module)}
                          onMouseEnter={(e) => {
                            if (!noneChecked) {
                              (e.currentTarget as HTMLButtonElement).style.color = "var(--text-primary)";
                              (e.currentTarget as HTMLButtonElement).style.borderColor = "var(--accent-primary)";
                            }
                          }}
                          onMouseLeave={(e) => {
                            (e.currentTarget as HTMLButtonElement).style.color = "var(--text-secondary)";
                            (e.currentTarget as HTMLButtonElement).style.borderColor = "var(--border)";
                          }}
                        >
                          None
                        </button>
                      </div>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
