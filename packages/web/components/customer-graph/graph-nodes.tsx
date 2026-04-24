"use client";

import { memo } from "react";
import {
  Handle,
  Position,
  type Node,
  type NodeProps,
  type NodeTypes,
} from "@xyflow/react";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import type { IconDefinition } from "@fortawesome/fontawesome-svg-core";
import {
  faUser,
  faBuilding,
  faFileInvoice,
  faLocationDot,
  faFileContract,
  faGauge,
  faClipboardCheck,
} from "@fortawesome/pro-solid-svg-icons";
import type { GraphNodeType } from "@utility-cis/shared";

/**
 * Custom React Flow node components for the six entity types on the
 * customer graph. Each node is a small card with a colored left rail,
 * an entity-type label, a primary identifier, and one-line subtext.
 *
 * Closed / removed nodes (validTo !== null) render at 55% opacity with
 * a status suffix in the subtext, per spec §2.2.
 */

export interface CustomerGraphNodeData extends Record<string, unknown> {
  type: GraphNodeType;
  label: string;
  subtext?: string;
  data: Record<string, unknown>;
  validTo: string | null;
}

/**
 * React Flow generic type — binds a custom node's data payload to the
 * framework's Node<D, T> shape so NodeProps stays precisely typed.
 */
export type CustomerGraphFlowNode = Node<CustomerGraphNodeData, GraphNodeType>;

const CARD_WIDTH = 180;
const CARD_HEIGHT = 72;

interface AccentConfig {
  /** CSS color token for the left rail + selected outline. */
  color: string;
  /** Uppercase, letter-spaced label shown in the node header. */
  label: string;
  icon: IconDefinition;
}

function resolveAccent(data: CustomerGraphNodeData): AccentConfig {
  switch (data.type) {
    case "customer": {
      // Org customers pick up the building icon; individuals get the
      // person icon. Data discriminator lives on the server payload.
      const isOrg =
        (data.data as { customerType?: string })?.customerType === "ORGANIZATION";
      return {
        color: "var(--accent-primary)",
        label: "Customer",
        icon: isOrg ? faBuilding : faUser,
      };
    }
    case "account":
      return {
        color: "var(--accent-secondary)",
        label: "Account",
        icon: faFileInvoice,
      };
    case "premise":
      return {
        color: "var(--accent-tertiary)",
        label: "Premise",
        icon: faLocationDot,
      };
    case "agreement":
      return {
        color: "var(--info)",
        label: "Agreement",
        icon: faFileContract,
      };
    case "meter":
      return {
        color: "var(--success)",
        label: "Meter",
        icon: faGauge,
      };
    case "service_request": {
      // SLA breach flips the chrome to danger. slaBreached is optional
      // on the server payload — default to warning color.
      const breached = Boolean(
        (data.data as { slaBreached?: boolean })?.slaBreached,
      );
      return {
        color: breached ? "var(--danger)" : "var(--warning)",
        label: "Request",
        icon: faClipboardCheck,
      };
    }
  }
}

function closedSuffix(type: GraphNodeType): string {
  if (type === "meter") return "removed";
  return "closed";
}

function NodeCard({
  data,
  selected,
}: NodeProps<CustomerGraphFlowNode>) {
  // NodeProps.data is the full CustomerGraphNodeData payload we built
  // in the view — use it directly.
  const payload = data;
  const accent = resolveAccent(payload);
  const isClosed = payload.validTo !== null;
  const subtext = payload.subtext;
  const suffix = isClosed ? ` (${closedSuffix(payload.type)})` : "";

  return (
    <div
      style={{
        width: CARD_WIDTH,
        height: CARD_HEIGHT,
        position: "relative",
        display: "flex",
        alignItems: "stretch",
        background: selected ? "var(--bg-elevated)" : "var(--bg-card)",
        border: selected ? `1.5px solid ${accent.color}` : "1px solid var(--border)",
        borderRadius: "var(--radius)",
        boxShadow: selected
          ? `0 0 0 2px ${accent.color}22`
          : "0 1px 2px rgba(0, 0, 0, 0.15)",
        opacity: isClosed ? 0.55 : 1,
        overflow: "hidden",
        fontFamily: "inherit",
        cursor: "pointer",
        transition: "background 0.12s ease, border-color 0.12s ease",
      }}
    >
      {/* Colored left rail — 3px accent band */}
      <div
        aria-hidden
        style={{
          width: 3,
          flexShrink: 0,
          background: accent.color,
        }}
      />

      {/* Invisible React Flow handles — needed for smoothstep edge
          routing, but we don't want user-draggable connection dots. */}
      <Handle
        type="target"
        position={Position.Top}
        style={{ opacity: 0, pointerEvents: "none" }}
        isConnectable={false}
      />
      <Handle
        type="source"
        position={Position.Bottom}
        style={{ opacity: 0, pointerEvents: "none" }}
        isConnectable={false}
      />

      <div
        style={{
          flex: 1,
          padding: "8px 10px 8px 10px",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          minWidth: 0,
        }}
      >
        {/* Header row: icon + entity-type label */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            color: accent.color,
          }}
        >
          <FontAwesomeIcon
            icon={accent.icon}
            style={{ width: 11, height: 11 }}
          />
          <span
            style={{
              fontSize: 10,
              fontWeight: 700,
              letterSpacing: "0.08em",
              textTransform: "uppercase",
            }}
          >
            {accent.label}
          </span>
        </div>

        {/* Primary label — monospace for identifiers */}
        <div
          title={payload.label}
          style={{
            fontSize: 13,
            fontWeight: 600,
            color: "var(--text-primary)",
            fontFamily:
              payload.type === "customer" || payload.type === "premise"
                ? "inherit"
                : "'JetBrains Mono', 'Fira Code', monospace",
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
            lineHeight: 1.1,
          }}
        >
          {payload.label}
        </div>

        {/* Muted one-liner subtext */}
        <div
          title={subtext ? `${subtext}${suffix}` : suffix}
          style={{
            fontSize: 11,
            color: "var(--text-muted)",
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
            lineHeight: 1.2,
          }}
        >
          {subtext ?? ""}
          {suffix && (
            <span style={{ color: "var(--text-muted)", fontStyle: "italic" }}>
              {subtext ? " " : ""}
              {suffix.trim()}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

// One memoized component per entity type — React Flow keys node types
// by the string in nodeTypes, so it's cleanest to export distinct
// components even though the render is identical. The discriminator
// lives in payload.type.
export const CustomerNode = memo(NodeCard);
export const AccountNode = memo(NodeCard);
export const PremiseNode = memo(NodeCard);
export const AgreementNode = memo(NodeCard);
export const MeterNode = memo(NodeCard);
export const ServiceRequestNode = memo(NodeCard);

// Cast to NodeTypes — the framework's record type widens `data: any`,
// which our narrower CustomerGraphNodeData won't satisfy structurally.
// The cast is safe because our view only builds nodes with the typed
// payload.
export const nodeTypes: NodeTypes = {
  customer: CustomerNode,
  account: AccountNode,
  premise: PremiseNode,
  agreement: AgreementNode,
  meter: MeterNode,
  service_request: ServiceRequestNode,
} as unknown as NodeTypes;

/**
 * Edge styling per kind (spec §2.3). Exposed so the view component
 * can apply it via the `style` prop on each edge without introducing
 * custom React Flow edge types.
 */
export function edgeStyleFor(
  kind: string,
): { stroke: string; strokeWidth: number; strokeDasharray?: string } {
  switch (kind) {
    case "owns_account":
    case "owns_premise":
      return { stroke: "var(--accent-primary)", strokeWidth: 1.5 };
    case "has_agreement":
      return { stroke: "var(--info)", strokeWidth: 1.5 };
    case "at_premise":
      return {
        stroke: "var(--text-muted)",
        strokeWidth: 1,
        strokeDasharray: "4 4",
      };
    case "measured_by":
      return { stroke: "var(--success)", strokeWidth: 1.5 };
    case "filed_against":
    case "filed_at_premise":
      return {
        stroke: "var(--warning)",
        strokeWidth: 1,
        strokeDasharray: "4 4",
      };
    default:
      return { stroke: "var(--border)", strokeWidth: 1 };
  }
}

/**
 * Per-entity-type chip accent. Same palette as resolveAccent, but
 * exposed for the filter chip row and the timeline strip where we
 * only have the type discriminator, not a full node payload.
 */
export function accentForType(type: GraphNodeType): {
  color: string;
  label: string;
  icon: IconDefinition;
} {
  switch (type) {
    case "customer":
      return { color: "var(--accent-primary)", label: "Customer", icon: faUser };
    case "account":
      return { color: "var(--accent-secondary)", label: "Account", icon: faFileInvoice };
    case "premise":
      return { color: "var(--accent-tertiary)", label: "Premise", icon: faLocationDot };
    case "agreement":
      return { color: "var(--info)", label: "Agreement", icon: faFileContract };
    case "meter":
      return { color: "var(--success)", label: "Meter", icon: faGauge };
    case "service_request":
      return { color: "var(--warning)", label: "Request", icon: faClipboardCheck };
  }
}
