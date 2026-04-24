/**
 * Shared types for the customer graph endpoint. Documented in
 * docs/superpowers/specs/2026-04-24-customer-graph-view.md.
 *
 * Every node and edge carries validFrom / validTo so the v2 time-
 * scrubber renderer can filter the graph by `asOf` without touching
 * the server. v1 ignores the validity window and shows everything.
 */

export type GraphNodeType =
  | "customer"
  | "account"
  | "premise"
  | "agreement"
  | "meter"
  | "service_request";

export type GraphEdgeKind =
  // Primary spanning-tree edges (parent → child in the dominant
  // hierarchy Customer → Premise/Account → Agreement/Meter/SR).
  | "owns_account"
  | "owns_premise"
  | "premise_has_agreement"
  | "premise_has_meter"
  | "premise_has_service_request"
  // Secondary cross-link edges — the same entity is also related to
  // another part of the tree (billing / measurement). Rendered in a
  // dashed secondary style so they read as "also relates to" rather
  // than a parent-child link.
  | "agreement_billed_by_account"
  | "agreement_uses_meter"
  | "service_request_on_account";

export interface GraphNode {
  id: string;
  type: GraphNodeType;
  label: string;
  subtext?: string;
  /**
   * Raw row data for the right-side preview drawer. Shape depends on
   * node `type`; the client narrows by the discriminator.
   */
  data: Record<string, unknown>;
  validFrom: string;
  validTo: string | null;
}

export interface GraphEdge {
  id: string;
  from: string;
  to: string;
  kind: GraphEdgeKind;
  validFrom: string;
  validTo: string | null;
}

export interface TimelineEvent {
  id: string;
  occurredAt: string;
  kind: string;
  label: string;
  /**
   * Node IDs this event affects. Hovering the event highlights these
   * nodes; clicking centers the graph on the first one.
   */
  relatedNodeIds: string[];
}

export interface CustomerGraphDTO {
  customerId: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
  events: TimelineEvent[];
  /**
   * True when the graph exceeded the server-side node cap (200 in v1)
   * and some nodes were dropped. Client can surface a banner.
   */
  truncated: boolean;
}
