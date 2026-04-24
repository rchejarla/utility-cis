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
  // Primary spanning-tree edges in the three-row layout:
  //   row 1 Customer
  //   row 2 Premises | Meters | Agreements | Accounts
  //   row 3 Service Requests
  // Customer reaches down to premises (col 1) and accounts (col 4);
  // each premise owns its meters (col 2); each account owns its
  // agreements (col 3); service requests connect up to their
  // premise and account.
  | "owns_account"
  | "owns_premise"
  | "premise_has_meter"
  | "premise_has_service_request"
  | "agreement_billed_by_account"
  | "service_request_on_account"
  // Cross-link (dashed): the agreement ↔ meter binding — an
  // agreement (col 3) uses a meter (col 2) to measure service.
  // This is the physical ↔ billing bridge that makes the graph
  // meaningful.
  | "agreement_uses_meter";

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

export interface CustomerGraphDTO {
  customerId: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
  /**
   * True when the graph exceeded the server-side node cap (200 in v1)
   * and some nodes were dropped. Client can surface a banner.
   */
  truncated: boolean;
}
