"use client";

import Link from "next/link";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faXmark, faArrowRight } from "@fortawesome/pro-solid-svg-icons";
import type { GraphNode, GraphNodeType } from "@utility-cis/shared";
import { accentForType } from "./graph-nodes";

interface NodeDrawerProps {
  node: GraphNode | null;
  onClose: () => void;
}

/**
 * Maps an entity type to the detail-page route segment. Kept next to
 * the drawer because the drawer is the only place where we build this
 * link from a raw node (double-click nav also uses it via the parent
 * view).
 */
export function detailHrefFor(type: GraphNodeType, id: string): string {
  switch (type) {
    case "customer":
      return `/customers/${id}`;
    case "account":
      return `/accounts/${id}`;
    case "premise":
      return `/premises/${id}`;
    case "agreement":
      return `/service-agreements/${id}`;
    case "meter":
      return `/meters/${id}`;
    case "service_request":
      return `/service-requests/${id}`;
  }
}

interface Field {
  label: string;
  value: string;
  mono?: boolean;
}

/**
 * Per-type field pickers. Each returns 3–5 labeled rows that matter
 * most for that entity. `data` is the raw row payload from the DTO;
 * we coerce loosely and fall back to em-dash on missing values.
 */
function fieldsForNode(node: GraphNode): Field[] {
  const d = node.data as Record<string, unknown>;

  const str = (k: string): string => {
    const v = d[k];
    if (v === null || v === undefined || v === "") return "—";
    return String(v);
  };

  switch (node.type) {
    case "customer":
      return [
        { label: "Type", value: str("customerType") },
        { label: "Status", value: str("status") },
        { label: "Email", value: str("email") },
        { label: "Phone", value: str("phone"), mono: true },
      ];
    case "account": {
      const balRaw = d["balance"];
      const balance =
        typeof balRaw === "number"
          ? `$${balRaw.toFixed(2)}`
          : balRaw
            ? String(balRaw)
            : "—";
      return [
        { label: "Number", value: str("accountNumber"), mono: true },
        { label: "Type", value: str("accountType") },
        { label: "Status", value: str("status") },
        { label: "Balance", value: balance, mono: true },
      ];
    }
    case "premise":
      return [
        { label: "Address", value: str("addressLine1") },
        { label: "City", value: str("city") },
        { label: "Type", value: str("premiseType") },
        { label: "Status", value: str("status") },
      ];
    case "agreement":
      return [
        { label: "Number", value: str("agreementNumber"), mono: true },
        { label: "Commodity", value: str("commodity") },
        { label: "Rate", value: str("rateSchedule"), mono: true },
        { label: "Start", value: formatDate(d["startDate"]) },
        { label: "End", value: formatDate(d["endDate"]) },
      ];
    case "meter":
      return [
        { label: "Number", value: str("meterNumber"), mono: true },
        { label: "Commodity", value: str("commodity") },
        { label: "Status", value: str("status") },
        { label: "Last Read", value: formatDate(d["lastReadAt"]) },
      ];
    case "service_request":
      return [
        { label: "Number", value: str("requestNumber"), mono: true },
        { label: "Type", value: str("requestType") },
        { label: "Status", value: str("status") },
        { label: "SLA", value: str("slaStatus") },
      ];
  }
}

function formatDate(v: unknown): string {
  if (!v || typeof v !== "string") return "—";
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return String(v);
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export function NodeDrawer({ node, onClose }: NodeDrawerProps) {
  if (!node) return null;

  const accent = accentForType(node.type);
  const fields = fieldsForNode(node);
  const isClosed = node.validTo !== null;

  return (
    <aside
      style={{
        width: 300,
        flexShrink: 0,
        background: "var(--bg-card)",
        border: "1px solid var(--border)",
        borderRadius: "var(--radius)",
        padding: "14px 16px",
        display: "flex",
        flexDirection: "column",
        gap: 12,
        alignSelf: "stretch",
        overflow: "auto",
      }}
    >
      {/* Entity-type pill + close */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 8,
        }}
      >
        <span
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            padding: "3px 10px",
            borderRadius: 999,
            background: "var(--bg-elevated)",
            border: `1px solid ${accent.color}`,
            color: accent.color,
            fontSize: 10,
            fontWeight: 700,
            letterSpacing: "0.1em",
            textTransform: "uppercase",
          }}
        >
          <FontAwesomeIcon icon={accent.icon} style={{ width: 10, height: 10 }} />
          {accent.label}
        </span>

        <button
          type="button"
          onClick={onClose}
          aria-label="Close drawer"
          style={{
            background: "transparent",
            border: "none",
            color: "var(--text-muted)",
            cursor: "pointer",
            padding: 4,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontFamily: "inherit",
          }}
        >
          <FontAwesomeIcon icon={faXmark} style={{ width: 14, height: 14 }} />
        </button>
      </div>

      {/* Primary label */}
      <h3
        style={{
          fontSize: 16,
          fontWeight: 600,
          color: "var(--text-primary)",
          margin: 0,
          lineHeight: 1.3,
          wordBreak: "break-word",
        }}
      >
        {node.label}
        {isClosed && (
          <span
            style={{
              marginLeft: 6,
              fontSize: 11,
              fontWeight: 500,
              color: "var(--text-muted)",
              fontStyle: "italic",
            }}
          >
            (inactive)
          </span>
        )}
      </h3>

      {node.subtext && (
        <div
          style={{
            fontSize: 12,
            color: "var(--text-secondary)",
            marginTop: -6,
          }}
        >
          {node.subtext}
        </div>
      )}

      {/* Key fields */}
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 0,
          marginTop: 2,
        }}
      >
        {fields.map((f) => (
          <div
            key={f.label}
            style={{
              display: "grid",
              gridTemplateColumns: "90px 1fr",
              gap: 8,
              padding: "8px 0",
              borderBottom: "1px solid var(--border-subtle)",
              alignItems: "start",
            }}
          >
            <span
              style={{
                fontSize: 11,
                color: "var(--text-muted)",
                fontWeight: 500,
              }}
            >
              {f.label}
            </span>
            <span
              style={{
                fontSize: 12,
                color: "var(--text-primary)",
                fontFamily: f.mono
                  ? "'JetBrains Mono', 'Fira Code', monospace"
                  : "inherit",
                wordBreak: "break-word",
              }}
            >
              {f.value}
            </span>
          </div>
        ))}
      </div>

      {/* Detail-page link */}
      <Link
        href={detailHrefFor(node.type, node.id)}
        style={{
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          gap: 6,
          padding: "8px 14px",
          borderRadius: "var(--radius)",
          background: "var(--accent-primary)",
          color: "#fff",
          fontSize: 13,
          fontWeight: 500,
          textDecoration: "none",
          marginTop: "auto",
        }}
      >
        Open full page
        <FontAwesomeIcon icon={faArrowRight} style={{ width: 11, height: 11 }} />
      </Link>
    </aside>
  );
}
