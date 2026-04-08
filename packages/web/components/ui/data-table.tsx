"use client";

import React from "react";

export interface Column<T> {
  key: string;
  header: string;
  render?: (row: T) => React.ReactNode;
  sortable?: boolean;
}

export interface DataTableMeta {
  total: number;
  page: number;
  limit: number;
  pages: number;
}

export interface DataTableProps<T> {
  columns: Column<T>[];
  data: T[];
  meta?: DataTableMeta;
  onPageChange?: (page: number) => void;
  onRowClick?: (row: T) => void;
  loading?: boolean;
}

const SKELETON_WIDTHS = [75, 60, 85, 70, 65, 80, 68, 72, 63, 78];

function SkeletonRow({ cols, rowIndex = 0 }: { cols: number; rowIndex?: number }) {
  return (
    <tr>
      {Array.from({ length: cols }).map((_, i) => (
        <td key={i} style={{ padding: "12px 16px", borderBottom: "1px solid var(--border)" }}>
          <div
            style={{
              height: "14px",
              borderRadius: "4px",
              background: "var(--bg-elevated)",
              width: `${SKELETON_WIDTHS[(rowIndex * cols + i) % SKELETON_WIDTHS.length]}%`,
              animation: "pulse 1.5s ease-in-out infinite",
            }}
          />
        </td>
      ))}
    </tr>
  );
}

export function DataTable<T extends Record<string, unknown>>({
  columns,
  data,
  meta,
  onPageChange,
  onRowClick,
  loading = false,
}: DataTableProps<T>) {
  const startItem = meta ? (meta.page - 1) * meta.limit + 1 : 1;
  const endItem = meta ? Math.min(meta.page * meta.limit, meta.total) : data.length;

  return (
    <div
      style={{
        background: "var(--bg-card)",
        border: "1px solid var(--border)",
        borderRadius: "var(--radius)",
        overflow: "hidden",
        minHeight: "480px",
        display: "flex",
        flexDirection: "column",
      }}
    >
      <div style={{ overflowX: "auto", flex: 1 }}>
        <table style={{ width: "100%", borderCollapse: "collapse", tableLayout: "fixed" }}>
          <thead>
            <tr style={{ background: "var(--bg-elevated)" }}>
              {columns.map((col) => (
                <th
                  key={col.key}
                  style={{
                    padding: "10px 16px",
                    textAlign: "left",
                    fontSize: "11px",
                    fontWeight: "600",
                    textTransform: "uppercase",
                    letterSpacing: "0.06em",
                    color: "var(--text-muted)",
                    borderBottom: "1px solid var(--border)",
                    whiteSpace: "nowrap",
                  }}
                >
                  {col.header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {loading ? (
              Array.from({ length: 8 }).map((_, i) => (
                <SkeletonRow key={i} cols={columns.length} rowIndex={i} />
              ))
            ) : data.length === 0 ? (
              <tr>
                <td
                  colSpan={columns.length}
                  style={{
                    padding: "48px 16px",
                    textAlign: "center",
                    color: "var(--text-muted)",
                    fontSize: "14px",
                  }}
                >
                  No records found
                </td>
              </tr>
            ) : (
              data.map((row, rowIndex) => (
                <tr
                  key={rowIndex}
                  onClick={onRowClick ? () => onRowClick(row) : undefined}
                  style={{
                    cursor: onRowClick ? "pointer" : "default",
                    transition: "background 0.1s ease",
                  }}
                  onMouseEnter={(e) => {
                    if (onRowClick) {
                      (e.currentTarget as HTMLTableRowElement).style.background = "var(--bg-hover)";
                    }
                  }}
                  onMouseLeave={(e) => {
                    (e.currentTarget as HTMLTableRowElement).style.background = "transparent";
                  }}
                >
                  {columns.map((col) => (
                    <td
                      key={col.key}
                      style={{
                        padding: "12px 16px",
                        fontSize: "13px",
                        color: "var(--text-primary)",
                        borderBottom: "1px solid var(--border-subtle)",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {col.render
                        ? col.render(row)
                        : (row[col.key] as React.ReactNode) ?? "—"}
                    </td>
                  ))}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* Pagination footer */}
      {meta && meta.pages > 0 && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "10px 16px",
            borderTop: "1px solid var(--border)",
            fontSize: "12px",
            color: "var(--text-secondary)",
          }}
        >
          <span>
            Showing{" "}
            <span style={{ color: "var(--text-primary)", fontWeight: "500" }}>
              {startItem}–{endItem}
            </span>{" "}
            of{" "}
            <span style={{ color: "var(--text-primary)", fontWeight: "500" }}>
              {meta.total}
            </span>
          </span>

          <div style={{ display: "flex", gap: "4px", alignItems: "center" }}>
            <PageButton
              label="← Prev"
              disabled={meta.page <= 1}
              onClick={() => onPageChange?.(meta.page - 1)}
            />

            {Array.from({ length: Math.min(meta.pages, 7) }).map((_, i) => {
              let page: number;
              if (meta.pages <= 7) {
                page = i + 1;
              } else if (meta.page <= 4) {
                page = i + 1;
              } else if (meta.page >= meta.pages - 3) {
                page = meta.pages - 6 + i;
              } else {
                page = meta.page - 3 + i;
              }
              return (
                <PageButton
                  key={page}
                  label={String(page)}
                  active={page === meta.page}
                  onClick={() => onPageChange?.(page)}
                />
              );
            })}

            <PageButton
              label="Next →"
              disabled={meta.page >= meta.pages}
              onClick={() => onPageChange?.(meta.page + 1)}
            />
          </div>
        </div>
      )}
    </div>
  );
}

function PageButton({
  label,
  active,
  disabled,
  onClick,
}: {
  label: string;
  active?: boolean;
  disabled?: boolean;
  onClick?: () => void;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        padding: "4px 10px",
        borderRadius: "6px",
        border: active ? "1px solid var(--accent-primary)" : "1px solid var(--border)",
        background: active ? "var(--accent-primary)" : "transparent",
        color: active ? "#fff" : disabled ? "var(--text-muted)" : "var(--text-secondary)",
        fontSize: "12px",
        cursor: disabled ? "not-allowed" : "pointer",
        transition: "all 0.15s ease",
        fontFamily: "inherit",
      }}
    >
      {label}
    </button>
  );
}
