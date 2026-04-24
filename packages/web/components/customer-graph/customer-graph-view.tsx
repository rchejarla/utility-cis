"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  Background,
  BackgroundVariant,
  Controls,
  ReactFlow,
  ReactFlowProvider,
  type Edge,
  type ReactFlowInstance,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faExpand, faCompress } from "@fortawesome/pro-solid-svg-icons";
import type {
  CustomerGraphDTO,
  GraphEdge,
  GraphNode,
} from "@utility-cis/shared";
import Link from "next/link";
import { AccessDenied } from "@/components/ui/access-denied";
import { apiClient } from "@/lib/api-client";
import { usePermission } from "@/lib/use-permission";
import {
  edgeStyleFor,
  nodeTypes,
  type CustomerGraphFlowNode,
} from "./graph-nodes";
import { TimelineStrip } from "./timeline-strip";
import { NodeDrawer, detailHrefFor } from "./node-drawer";
import { TrunkEdge } from "./trunk-edge";

// Custom edge types. `trunk` draws the customer → premise / customer
// → account edges along a shared vertical spine behind each outer
// column; everything else uses React Flow's built-in smoothstep.
const edgeTypes = { trunk: TrunkEdge };

interface CustomerGraphViewProps {
  customerId: string;
}

// Node footprint — our cards are ~180×72; extra padding leaves room
// between columns and rows.
const NODE_W = 200;
const NODE_H = 90;
const ROW_H = NODE_H + 20;      // vertical space per "row slot"
const COL_X = [0, 300, 600, 900] as const; // premises / meters / agreements / accounts

// Shared vertical trunk lines for the customer→premise and
// customer→account edges. Positioned just outside each outer column
// so every edge of the same kind shares one visible spine.
const PREMISE_TRUNK_X = COL_X[0] - 30;
const ACCOUNT_TRUNK_X = COL_X[3] + NODE_W + 30;
// How far the edge descends below the customer before turning onto
// the trunk — keeps the "T" top short but clear of the customer card.
const TRUNK_DESCEND = 60;

/**
 * Three-row grid layout.
 *
 *  Row 1                  Customer (horizontally centered)
 *  Row 2   Premises │ Meters  │ Agreements │ Accounts
 *  Row 3                  Service Requests (spread)
 *
 * Meters fan symmetrically around their premise's y (the premise y
 * is the midpoint of its meters' y spread). Same rule for
 * agreements around their account. Customer is centered across the
 * canvas width; service requests spread along the bottom, each
 * connecting up to its premise (left) and account (right).
 */
function threeRowLayout(
  nodes: GraphNode[],
  edges: GraphEdge[],
): Map<string, { x: number; y: number }> {
  const positions = new Map<string, { x: number; y: number }>();

  // Index children by their primary parent.
  const metersByPremise = new Map<string, string[]>();
  const agreementsByAccount = new Map<string, string[]>();
  for (const e of edges) {
    if (e.kind === "premise_has_meter") {
      const arr = metersByPremise.get(e.from) ?? [];
      arr.push(e.to);
      metersByPremise.set(e.from, arr);
    }
    if (e.kind === "agreement_billed_by_account") {
      const arr = agreementsByAccount.get(e.to) ?? [];
      arr.push(e.from);
      agreementsByAccount.set(e.to, arr);
    }
  }

  // Premises come first, sorted by meter count DESC so the busiest
  // physical site floats to the top. Tie-break by id so the order
  // stays stable across renders.
  const premises = nodes
    .filter((n) => n.type === "premise")
    .sort((a, b) => {
      const ma = metersByPremise.get(a.id)?.length ?? 0;
      const mb = metersByPremise.get(b.id)?.length ?? 0;
      if (mb !== ma) return mb - ma;
      return a.id.localeCompare(b.id);
    });

  // Build ordinal map so we can sort accounts to line up with the
  // premise their agreements serve.
  const premiseOrdinal = new Map<string, number>();
  premises.forEach((p, i) => premiseOrdinal.set(p.id, i));

  // For each account, find the premise(s) its agreements serve,
  // then sort by the topmost (lowest-ordinal) of those premises
  // so accounts line up with their primary premise on the left.
  // Accounts without any agreement-linked premise fall to the end.
  const accountPremiseIndex = (accountId: string): number => {
    const agIds = agreementsByAccount.get(accountId) ?? [];
    const premiseIdxs = agIds
      .map((agId) => nodes.find((n) => n.id === agId)?.data?.premiseId as string | null | undefined)
      .filter((pid): pid is string => typeof pid === "string")
      .map((pid) => premiseOrdinal.get(pid))
      .filter((o): o is number => typeof o === "number");
    return premiseIdxs.length > 0 ? Math.min(...premiseIdxs) : Number.POSITIVE_INFINITY;
  };

  const accounts = nodes
    .filter((n) => n.type === "account")
    .sort((a, b) => {
      const ia = accountPremiseIndex(a.id);
      const ib = accountPremiseIndex(b.id);
      if (ia !== ib) return ia - ib;
      return a.id.localeCompare(b.id);
    });

  const srs = nodes
    .filter((n) => n.type === "service_request")
    .sort((a, b) => a.id.localeCompare(b.id));

  const customer = nodes.find((n) => n.type === "customer");

  const row2TopY = 200;
  const blockGap = 40;

  // Left side — stack each premise with its meters fanned around
  // it. First meter's y ≤ premise's y (equal only when n == 1).
  let y = row2TopY;
  for (const p of premises) {
    const meters = metersByPremise.get(p.id) ?? [];
    const n = Math.max(1, meters.length);
    const blockTop = y;
    const premiseY = blockTop + ((n - 1) / 2) * ROW_H;
    positions.set(p.id, { x: COL_X[0], y: premiseY });
    meters.forEach((mId, i) => {
      positions.set(mId, { x: COL_X[1], y: blockTop + i * ROW_H });
    });
    y = blockTop + n * ROW_H + blockGap;
  }
  const leftBottomY = y;

  // Right side — same shape for accounts and their agreements.
  y = row2TopY;
  for (const acc of accounts) {
    const ags = agreementsByAccount.get(acc.id) ?? [];
    const n = Math.max(1, ags.length);
    const blockTop = y;
    const accountY = blockTop + ((n - 1) / 2) * ROW_H;
    positions.set(acc.id, { x: COL_X[3], y: accountY });
    ags.forEach((aId, i) => {
      positions.set(aId, { x: COL_X[2], y: blockTop + i * ROW_H });
    });
    y = blockTop + n * ROW_H + blockGap;
  }
  const rightBottomY = y;

  // Row 1 — customer horizontally centered across the whole canvas
  // width (includes node footprint so visual centering holds).
  const leftEdge = COL_X[0];
  const rightEdge = COL_X[3] + NODE_W;
  const customerX = (leftEdge + rightEdge) / 2 - NODE_W / 2;
  if (customer) positions.set(customer.id, { x: customerX, y: 0 });

  // Row 3 — service requests spread horizontally along the bottom.
  const row3Y = Math.max(leftBottomY, rightBottomY, row2TopY) + 40;
  if (srs.length > 0) {
    const totalWidth = rightEdge - leftEdge;
    const spacing = (totalWidth - srs.length * NODE_W) / (srs.length + 1);
    srs.forEach((sr, i) => {
      const x = leftEdge + (i + 1) * spacing + i * NODE_W;
      positions.set(sr.id, { x, y: row3Y });
    });
  }

  return positions;
}

/**
 * Pick the correct source / target handle IDs for an edge based on
 * its semantic direction in the three-row layout. Without these
 * hints React Flow would connect handles on default sides and
 * produce awkwardly-routed lines.
 */
function handlesFor(kind: GraphEdge["kind"]): {
  sourceHandle: string;
  targetHandle: string;
} {
  switch (kind) {
    // Customer (row 1) reaches down and then along a shared trunk
    // into each premise from its LEFT side, and into each account
    // from its RIGHT side — draws an org-chart spine behind the
    // outer columns.
    case "owns_premise":
      return { sourceHandle: "b-source", targetHandle: "l-target" };
    case "owns_account":
      return { sourceHandle: "b-source", targetHandle: "r-target" };
    // Row 2 left half: premise → meter (rightward).
    case "premise_has_meter":
      return { sourceHandle: "r-source", targetHandle: "l-target" };
    // Row 2 right half: account → agreement (leftward from account's
    // perspective — source is on the account's left side).
    case "agreement_billed_by_account":
      // edge is from=agreement → to=account; we want it rendered as
      // a horizontal line agreement.right ↔ account.left.
      return { sourceHandle: "r-source", targetHandle: "l-target" };
    // Cross-link: agreement (row 2 col 3) ← meter (row 2 col 2).
    // edge from=agreement → to=meter. Agreement's left side sends to
    // meter's right side. Both on the inner edge of their cards.
    case "agreement_uses_meter":
      return { sourceHandle: "l-source", targetHandle: "r-target" };
    // Service requests (row 3) reach up to their premise / account.
    case "premise_has_service_request":
      // edge from=premise → to=service_request; render vertical
      // from premise's bottom to SR's top.
      return { sourceHandle: "b-source", targetHandle: "t-target" };
    case "service_request_on_account":
      // edge from=service_request → to=account; SR's top → account's
      // bottom.
      return { sourceHandle: "t-source", targetHandle: "b-target" };
    default:
      return { sourceHandle: "b-source", targetHandle: "t-target" };
  }
}

function CustomerGraphViewInner({ customerId }: CustomerGraphViewProps) {
  const router = useRouter();
  const { canView } = usePermission("customers");
  const [graph, setGraph] = useState<CustomerGraphDTO | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [highlightedIds, setHighlightedIds] = useState<Set<string>>(new Set());
  const rfInstance = useRef<ReactFlowInstance<CustomerGraphFlowNode, Edge> | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const data = await apiClient.get<CustomerGraphDTO>(
          `/api/v1/customers/${customerId}/graph`,
        );
        if (!cancelled) setGraph(data);
      } catch (err) {
        if (!cancelled) {
          setError(
            err instanceof Error ? err.message : "Failed to load customer graph",
          );
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [customerId]);

  // Positions from the three-row grid layout — recomputed only when
  // the raw node/edge list changes.
  const positions = useMemo(() => {
    if (!graph) return new Map<string, { x: number; y: number }>();
    return threeRowLayout(graph.nodes, graph.edges);
  }, [graph]);

  const flowNodes: CustomerGraphFlowNode[] = useMemo(() => {
    if (!graph) return [];
    return graph.nodes.map<CustomerGraphFlowNode>((n) => ({
      id: n.id,
      type: n.type,
      position: positions.get(n.id) ?? { x: 0, y: 0 },
      selected: n.id === selectedNodeId,
      data: {
        type: n.type,
        label: n.label,
        subtext: n.subtext,
        data: n.data,
        validTo: n.validTo,
      },
      className: highlightedIds.has(n.id)
        ? "customer-graph-node-highlighted"
        : undefined,
    }));
  }, [graph, positions, selectedNodeId, highlightedIds]);

  const flowEdges: Edge[] = useMemo(() => {
    if (!graph) return [];
    return graph.edges.map((e) => {
      const { sourceHandle, targetHandle } = handlesFor(e.kind);
      const isTrunk = e.kind === "owns_premise" || e.kind === "owns_account";
      const trunkX =
        e.kind === "owns_premise"
          ? PREMISE_TRUNK_X
          : e.kind === "owns_account"
            ? ACCOUNT_TRUNK_X
            : undefined;
      return {
        id: e.id,
        source: e.from,
        target: e.to,
        sourceHandle,
        targetHandle,
        type: isTrunk ? "trunk" : "smoothstep",
        style: edgeStyleFor(e.kind),
        data: isTrunk
          ? {
              trunkX,
              descend: TRUNK_DESCEND,
              title: `${e.kind} since ${e.validFrom.slice(0, 10)}`,
            }
          : { title: `${e.kind} since ${e.validFrom.slice(0, 10)}` },
      };
    });
  }, [graph]);

  const selectedNode = useMemo(() => {
    if (!graph || !selectedNodeId) return null;
    return graph.nodes.find((n) => n.id === selectedNodeId) ?? null;
  }, [graph, selectedNodeId]);

  const customerName = useMemo(() => {
    return graph?.nodes.find((n) => n.type === "customer")?.label ?? null;
  }, [graph]);

  const handleNodeClick = useCallback(
    (_: unknown, node: CustomerGraphFlowNode) => {
      setSelectedNodeId(node.id);
    },
    [],
  );

  const handleNodeDoubleClick = useCallback(
    (_: unknown, node: CustomerGraphFlowNode) => {
      if (!graph) return;
      const match = graph.nodes.find((n) => n.id === node.id);
      if (match) router.push(detailHrefFor(match.type, match.id));
    },
    [graph, router],
  );

  const handleTimelineHover = useCallback(
    (ids: string[] | null) => {
      setHighlightedIds(ids ? new Set(ids) : new Set());
    },
    [],
  );

  const handleTimelineClick = useCallback(
    (ids: string[]) => {
      if (ids.length === 0 || !rfInstance.current) return;
      const first = ids[0];
      const pos = positions.get(first);
      if (!pos) return;
      rfInstance.current.setCenter(pos.x, pos.y, { zoom: 1.3, duration: 400 });
      setSelectedNodeId(first);
    },
    [positions],
  );

  // ─── Fullscreen toggle ──────────────────────────────────────────
  // Use the browser Fullscreen API on the canvas container so the
  // graph can take over the whole viewport. Works on all modern
  // browsers and exits cleanly on Escape.
  const fullscreenRef = useRef<HTMLDivElement | null>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);

  const toggleFullscreen = useCallback(() => {
    const el = fullscreenRef.current;
    if (!el) return;
    if (document.fullscreenElement === el) {
      document.exitFullscreen().catch(() => {});
    } else {
      el.requestFullscreen().catch(() => {});
    }
  }, []);

  useEffect(() => {
    function onFsChange() {
      setIsFullscreen(document.fullscreenElement === fullscreenRef.current);
    }
    document.addEventListener("fullscreenchange", onFsChange);
    return () => document.removeEventListener("fullscreenchange", onFsChange);
  }, []);

  if (!canView) return <AccessDenied />;

  return (
    <div
      ref={fullscreenRef}
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 14,
        // Fill the app's main content area exactly — no page-level
        // scroll. Pills + back link sit at the top, timeline at the
        // bottom, canvas flexes to whatever's left between. In
        // fullscreen the container paints the CIS surface colour
        // behind us (otherwise the browser's default black would
        // bleed through) and explicitly uses the whole viewport.
        height: isFullscreen ? "100vh" : "100%",
        overflow: "hidden",
        ...(isFullscreen
          ? {
              padding: 20,
              background: "var(--bg-deep)",
            }
          : {}),
      }}
    >
      {/* Module-scoped styling. Kept inline because it's the only
          global-ish CSS the graph view needs and the inline/styled
          convention runs throughout the rest of the app. */}
      <style jsx global>{`
        .customer-graph-node-highlighted {
          outline: 2px solid var(--accent-primary);
          outline-offset: 2px;
          border-radius: var(--radius);
          animation: cg-pulse 1.2s ease-in-out infinite;
        }
        @keyframes cg-pulse {
          0%, 100% { outline-color: var(--accent-primary); }
          50% { outline-color: var(--accent-secondary); }
        }
        /* React Flow zoom controls — paint them onto the CIS surface
           so the default white buttons don't clash with the dark
           canvas. Only +/− buttons remain after dropping FitView. */
        .react-flow__controls {
          background: var(--bg-card);
          border: 1px solid var(--border);
          border-radius: var(--radius);
          overflow: hidden;
        }
        .react-flow__controls-button {
          background: var(--bg-card) !important;
          border-bottom: 1px solid var(--border-subtle) !important;
          color: var(--text-secondary) !important;
          fill: var(--text-secondary) !important;
        }
        .react-flow__controls-button:hover {
          background: var(--bg-hover) !important;
        }
        .react-flow__attribution {
          background: transparent !important;
          color: var(--text-muted) !important;
        }
      `}</style>

      {/* Top row — customer name on the left, Back-to-detail link on
          the right. The row exists to anchor the back link and to tell
          users which customer they're looking at; category filter chips
          were dropped because hiding types only clutters a graph that
          already fits on one screen. */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          flexWrap: "wrap",
        }}
      >
        <div
          style={{
            flex: 1,
            minWidth: 0,
            display: "flex",
            alignItems: "baseline",
            gap: 8,
            overflow: "hidden",
          }}
        >
          <span
            style={{
              fontSize: 10,
              fontWeight: 700,
              letterSpacing: "0.08em",
              textTransform: "uppercase",
              color: "var(--text-muted)",
              flexShrink: 0,
            }}
          >
            Customer
          </span>
          <span
            title={customerName ?? undefined}
            style={{
              fontSize: 15,
              fontWeight: 600,
              color: "var(--text-primary)",
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
              minWidth: 0,
            }}
          >
            {customerName ?? " "}
          </span>
        </div>
        <Link
          href={`/customers/${customerId}`}
          style={{
            flexShrink: 0,
            padding: "6px 12px",
            fontSize: 12,
            fontWeight: 500,
            background: "transparent",
            border: "1px solid var(--border)",
            borderRadius: "var(--radius)",
            color: "var(--text-secondary)",
            textDecoration: "none",
            fontFamily: "inherit",
          }}
        >
          ← Back to detail
        </Link>
      </div>

      {graph?.truncated && (
        <div
          style={{
            padding: "8px 12px",
            background: "var(--warning-subtle)",
            border: "1px solid var(--warning)",
            borderRadius: "var(--radius)",
            color: "var(--warning)",
            fontSize: 12,
          }}
        >
          Showing the first 200 nodes. Filter by category to narrow further.
        </div>
      )}

      {error && (
        <div
          style={{
            padding: "10px 14px",
            background: "var(--danger-subtle)",
            border: "1px solid var(--danger)",
            borderRadius: "var(--radius)",
            color: "var(--danger)",
            fontSize: 13,
          }}
        >
          {error}
        </div>
      )}

      {/* Canvas + drawer row */}
      <div
        style={{
          // Canvas row fills whatever vertical space is left after
          // the top pills row and bottom timeline strip. minHeight:0
          // is required so this flex child can shrink — without it
          // React Flow's intrinsic sizing would force the whole
          // column to overflow and show a page-level scrollbar.
          flex: 1,
          minHeight: 0,
          display: "flex",
          gap: 14,
          alignItems: "stretch",
        }}
      >
        <div
          style={{
            flex: 1,
            minWidth: 0,
            height: "100%",
            background: "var(--bg-deep)",
            border: "1px solid var(--border)",
            borderRadius: "var(--radius)",
            overflow: "hidden",
            position: "relative",
          }}
        >
          {/* Floating fullscreen toggle — always in the top-right of
              the canvas. Uses the browser Fullscreen API so the graph
              container (including filter chips + drawer + timeline)
              takes over the whole viewport. Escape exits. */}
          <button
            type="button"
            onClick={toggleFullscreen}
            title={isFullscreen ? "Exit full screen" : "Full screen"}
            style={{
              position: "absolute",
              top: 12,
              right: 12,
              zIndex: 5,
              width: 34,
              height: 34,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              background: "var(--bg-card)",
              border: "1px solid var(--border)",
              borderRadius: "var(--radius)",
              color: "var(--text-secondary)",
              cursor: "pointer",
              fontFamily: "inherit",
            }}
          >
            <FontAwesomeIcon
              icon={isFullscreen ? faCompress : faExpand}
              style={{ width: 14, height: 14 }}
            />
          </button>
          {loading ? (
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                height: "100%",
                color: "var(--text-muted)",
                fontSize: 13,
              }}
            >
              Loading graph...
            </div>
          ) : graph && graph.nodes.length > 0 ? (
            <ReactFlow
              nodes={flowNodes}
              edges={flowEdges}
              nodeTypes={nodeTypes}
              edgeTypes={edgeTypes}
              onInit={(instance) => {
                rfInstance.current = instance;
              }}
              onNodeClick={handleNodeClick}
              onNodeDoubleClick={handleNodeDoubleClick}
              onPaneClick={() => setSelectedNodeId(null)}
              fitView
              // Tighter padding + higher fit-view cap so small /
              // medium customers land at a readable zoom on load.
              // Big industrial customers still fit-to-screen because
              // fit-view uses whichever zoom fits their bounding box.
              fitViewOptions={{ padding: 0.08, maxZoom: 1.6 }}
              minZoom={0.3}
              maxZoom={2}
              proOptions={{ hideAttribution: true }}
              nodesDraggable={false}
              nodesConnectable={false}
              elementsSelectable
              style={{ background: "var(--bg-deep)" }}
            >
              <Background
                variant={BackgroundVariant.Dots}
                gap={22}
                size={1}
                color="var(--border)"
              />
              {/* Zoom +/- only — the fit-view button's 4-corner
                  icon was getting confused with the top-right
                  fullscreen toggle, so it's off. The lock button
                  (interactive toggle) is off too since nodes are
                  already non-draggable. MiniMap removed. */}
              <Controls
                position="bottom-left"
                showFitView={false}
                showInteractive={false}
              />
            </ReactFlow>
          ) : (
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                height: "100%",
                color: "var(--text-muted)",
                fontSize: 13,
              }}
            >
              No graph data available for this customer.
            </div>
          )}
        </div>

        {selectedNode && (
          <NodeDrawer
            node={selectedNode}
            onClose={() => setSelectedNodeId(null)}
          />
        )}
      </div>

      {/* Timeline strip */}
      {graph && (
        <TimelineStrip
          events={graph.events}
          nodes={graph.nodes}
          onEventHover={handleTimelineHover}
          onEventClick={handleTimelineClick}
        />
      )}
    </div>
  );
}

export function CustomerGraphView(props: CustomerGraphViewProps) {
  // React Flow's Provider is required when we call useReactFlow /
  // hold an instance ref across callbacks. Wrapping at this level
  // keeps the provider local to the feature.
  return (
    <ReactFlowProvider>
      <CustomerGraphViewInner {...props} />
    </ReactFlowProvider>
  );
}
