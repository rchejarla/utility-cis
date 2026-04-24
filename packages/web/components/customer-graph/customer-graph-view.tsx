"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  type Edge,
  type ReactFlowInstance,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import type {
  CustomerGraphDTO,
  GraphEdge,
  GraphNode,
  GraphNodeType,
} from "@utility-cis/shared";
import { PageHeader } from "@/components/ui/page-header";
import { AccessDenied } from "@/components/ui/access-denied";
import { apiClient } from "@/lib/api-client";
import { usePermission } from "@/lib/use-permission";
import {
  accentForType,
  edgeStyleFor,
  nodeTypes,
  type CustomerGraphFlowNode,
} from "./graph-nodes";
import { TimelineStrip } from "./timeline-strip";
import { NodeDrawer, detailHrefFor } from "./node-drawer";

interface CustomerGraphViewProps {
  customerId: string;
}

/** Deterministic hash of a string to a float in [0, 1). Used to give
 *  nodes without an explicit edge-back-to-customer a stable angle. */
function hashToUnit(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  // Unsigned 32-bit → [0, 1)
  return ((h >>> 0) % 10000) / 10000;
}

/**
 * Seeded radial layout. Customer fixed at origin. Direct neighbors
 * (first hop) positioned at radius 300 around it; second-hop nodes
 * (meters via agreement, SRs via account) at radius 520 aligned with
 * their parent's angle.
 *
 * Groups by type into half-plane clusters so categories stay visually
 * distinct without running a force pass: accounts top half, premises
 * bottom half, agreements middle band.
 *
 * Pure function of the graph shape — same input → same positions, so
 * refreshing doesn't reshuffle.
 */
function seedPositions(
  nodes: GraphNode[],
  edges: GraphEdge[],
  customerId: string,
): Map<string, { x: number; y: number }> {
  const positions = new Map<string, { x: number; y: number }>();
  positions.set(customerId, { x: 0, y: 0 });

  // Group direct neighbors by type so angle assignment is stable per
  // category. Half-plane hints: accounts go upper (angles in [-π, 0]
  // i.e. top half in screen space with y growing down), premises go
  // lower, agreements span the sides.
  const directNeighbors: GraphNode[] = nodes.filter((n) =>
    edges.some(
      (e) =>
        (e.from === customerId && e.to === n.id) ||
        (e.to === customerId && e.from === n.id),
    ),
  );

  const byType: Record<GraphNodeType, GraphNode[]> = {
    customer: [],
    account: [],
    premise: [],
    agreement: [],
    meter: [],
    service_request: [],
  };
  for (const n of directNeighbors) byType[n.type].push(n);

  // Deterministic ordering inside each bucket — sort by id so layout
  // doesn't depend on the server's row order.
  const sortById = (a: GraphNode, b: GraphNode) => a.id.localeCompare(b.id);
  Object.values(byType).forEach((arr) => arr.sort(sortById));

  // Angle ranges in radians (canvas convention: 0 = +x, grows CCW with
  // screen y flipped). Screen-space top half = negative y = angles in
  // (π, 2π) aka negative sines. We pick explicit ranges per cluster.
  //
  // Accounts: upper half, spread from ~200° to ~340°
  // Premises: lower half, from ~20° to ~160°
  // Agreements: side band, 350°…10° plus 170°…190°
  // Service requests: scattered in the upper-right quadrant
  // Meters: typically 2-hop, handled below, but direct meters go right.
  const clusters: Record<
    GraphNodeType,
    { startDeg: number; endDeg: number } | null
  > = {
    customer: null,
    account: { startDeg: 200, endDeg: 340 },
    premise: { startDeg: 20, endDeg: 160 },
    agreement: { startDeg: 170, endDeg: 190 },
    service_request: { startDeg: 340, endDeg: 380 },
    meter: { startDeg: 350, endDeg: 370 },
  };

  const directRadius = 300;
  const secondRadius = 520;

  for (const type of Object.keys(byType) as GraphNodeType[]) {
    const bucket = byType[type];
    const cluster = clusters[type];
    if (!cluster || bucket.length === 0) continue;
    const span = cluster.endDeg - cluster.startDeg;
    bucket.forEach((node, i) => {
      // Evenly spaced, but offset by 0.5 so a single node sits in the
      // middle of its cluster's arc.
      const t = bucket.length === 1 ? 0.5 : i / (bucket.length - 1);
      const deg = cluster.startDeg + t * span;
      const rad = (deg * Math.PI) / 180;
      positions.set(node.id, {
        x: Math.cos(rad) * directRadius,
        y: Math.sin(rad) * directRadius,
      });
    });
  }

  // Second-hop nodes: anything not yet positioned. Anchor each to its
  // first parent that already has a position; if none, fall back to
  // a deterministic angle from the node id hash.
  const remaining = nodes.filter(
    (n) => !positions.has(n.id) && n.id !== customerId,
  );
  // Iterate until stable — simple fixed-point so a chain of 3+ hops
  // eventually resolves. Bounded at nodes.length iterations to avoid
  // any pathological case (shouldn't happen with v1's 2-hop graph).
  for (let iter = 0; iter < nodes.length && remaining.length > 0; iter++) {
    for (let i = remaining.length - 1; i >= 0; i--) {
      const n = remaining[i];
      const parentEdge = edges.find(
        (e) =>
          (e.to === n.id && positions.has(e.from) && e.from !== customerId) ||
          (e.from === n.id && positions.has(e.to) && e.to !== customerId),
      );
      const parentId = parentEdge
        ? parentEdge.from === n.id
          ? parentEdge.to
          : parentEdge.from
        : null;

      if (parentId && positions.has(parentId)) {
        const p = positions.get(parentId)!;
        const parentAngle = Math.atan2(p.y, p.x);
        // Nudge each child off the parent's exact radial with a hash-
        // based angular offset in ±15°, so siblings don't stack.
        const offsetDeg = (hashToUnit(n.id) - 0.5) * 30;
        const angle = parentAngle + (offsetDeg * Math.PI) / 180;
        positions.set(n.id, {
          x: Math.cos(angle) * secondRadius,
          y: Math.sin(angle) * secondRadius,
        });
        remaining.splice(i, 1);
      }
    }
    if (remaining.every((n) => !edges.some((e) => e.from === n.id || e.to === n.id))) {
      break;
    }
  }

  // Orphans — no path back to a positioned node. Scatter deterministically.
  for (const n of remaining) {
    const angle = hashToUnit(n.id) * 2 * Math.PI;
    positions.set(n.id, {
      x: Math.cos(angle) * secondRadius,
      y: Math.sin(angle) * secondRadius,
    });
  }

  return positions;
}

const ENTITY_TYPES: GraphNodeType[] = [
  "customer",
  "account",
  "premise",
  "agreement",
  "meter",
  "service_request",
];

function EntityFilterChips({
  counts,
  hiddenTypes,
  onToggle,
}: {
  counts: Record<GraphNodeType, number>;
  hiddenTypes: Set<GraphNodeType>;
  onToggle: (type: GraphNodeType) => void;
}) {
  return (
    <div
      style={{
        display: "flex",
        gap: 6,
        flexWrap: "wrap",
        alignItems: "center",
      }}
    >
      <span
        style={{
          fontSize: 12,
          color: "var(--text-muted)",
          fontWeight: 500,
          marginRight: 4,
        }}
      >
        Show:
      </span>
      {ENTITY_TYPES.map((type) => {
        const accent = accentForType(type);
        const hidden = hiddenTypes.has(type);
        const count = counts[type] ?? 0;
        return (
          <button
            key={type}
            type="button"
            onClick={() => onToggle(type)}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              padding: "5px 12px",
              borderRadius: 999,
              border: hidden
                ? "1px solid var(--border)"
                : `1px solid ${accent.color}`,
              background: hidden ? "var(--bg-card)" : "var(--bg-elevated)",
              color: hidden ? "var(--text-muted)" : accent.color,
              fontSize: 12,
              fontWeight: 500,
              cursor: "pointer",
              fontFamily: "inherit",
              transition: "all 0.12s ease",
            }}
          >
            <FontAwesomeIcon
              icon={accent.icon}
              style={{ width: 11, height: 11 }}
            />
            {accent.label} ({count})
          </button>
        );
      })}
    </div>
  );
}

function CustomerGraphViewInner({ customerId }: CustomerGraphViewProps) {
  const router = useRouter();
  const { canView } = usePermission("customers");
  const [graph, setGraph] = useState<CustomerGraphDTO | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [hiddenTypes, setHiddenTypes] = useState<Set<GraphNodeType>>(new Set());
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

  // Seeded positions — recomputed only when the raw node/edge list
  // changes. Filter toggles don't re-seed; they hide via the flow
  // nodes/edges props below.
  const positions = useMemo(() => {
    if (!graph) return new Map<string, { x: number; y: number }>();
    return seedPositions(graph.nodes, graph.edges, graph.customerId);
  }, [graph]);

  const counts = useMemo(() => {
    const c: Record<GraphNodeType, number> = {
      customer: 0,
      account: 0,
      premise: 0,
      agreement: 0,
      meter: 0,
      service_request: 0,
    };
    if (graph) {
      for (const n of graph.nodes) c[n.type]++;
    }
    return c;
  }, [graph]);

  const flowNodes: CustomerGraphFlowNode[] = useMemo(() => {
    if (!graph) return [];
    return graph.nodes
      .filter((n) => !hiddenTypes.has(n.type))
      .map<CustomerGraphFlowNode>((n) => ({
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
  }, [graph, hiddenTypes, positions, selectedNodeId, highlightedIds]);

  const flowEdges: Edge[] = useMemo(() => {
    if (!graph) return [];
    const visibleNodeIds = new Set(
      graph.nodes.filter((n) => !hiddenTypes.has(n.type)).map((n) => n.id),
    );
    return graph.edges
      .filter((e) => visibleNodeIds.has(e.from) && visibleNodeIds.has(e.to))
      .map((e) => ({
        id: e.id,
        source: e.from,
        target: e.to,
        type: "smoothstep",
        style: edgeStyleFor(e.kind),
        // Hover tooltip on the edge path. React Flow spreads this to
        // the edge's container element, which includes a <title>-able
        // <path>.
        data: {
          title: `${e.kind} since ${e.validFrom.slice(0, 10)}`,
        },
      }));
  }, [graph, hiddenTypes]);

  const selectedNode = useMemo(() => {
    if (!graph || !selectedNodeId) return null;
    return graph.nodes.find((n) => n.id === selectedNodeId) ?? null;
  }, [graph, selectedNodeId]);

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

  const toggleType = useCallback((type: GraphNodeType) => {
    setHiddenTypes((prev) => {
      const next = new Set(prev);
      if (next.has(type)) next.delete(type);
      else next.add(type);
      return next;
    });
  }, []);

  if (!canView) return <AccessDenied />;

  const customerLabel =
    graph?.nodes.find((n) => n.type === "customer")?.label ?? "Customer";

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <PageHeader
        title={loading ? "Loading graph..." : `${customerLabel} — Graph`}
        action={{
          label: "Back to detail",
          href: `/customers/${customerId}`,
        }}
      />

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
        /* React Flow control panel: match the CIS surface treatment
           so the default white controls don't clash with the dark
           canvas background. */
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
        .react-flow__minimap {
          background: var(--bg-surface) !important;
          border: 1px solid var(--border);
          border-radius: var(--radius);
        }
        .react-flow__attribution {
          background: transparent !important;
          color: var(--text-muted) !important;
        }
      `}</style>

      {/* Filter chips row */}
      {graph && (
        <EntityFilterChips
          counts={counts}
          hiddenTypes={hiddenTypes}
          onToggle={toggleType}
        />
      )}

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
          display: "flex",
          gap: 14,
          alignItems: "stretch",
          minHeight: "70vh",
        }}
      >
        <div
          style={{
            flex: 1,
            minWidth: 0,
            height: "70vh",
            background: "var(--bg-deep)",
            border: "1px solid var(--border)",
            borderRadius: "var(--radius)",
            overflow: "hidden",
            position: "relative",
          }}
        >
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
              onInit={(instance) => {
                rfInstance.current = instance;
              }}
              onNodeClick={handleNodeClick}
              onNodeDoubleClick={handleNodeDoubleClick}
              onPaneClick={() => setSelectedNodeId(null)}
              fitView
              fitViewOptions={{ padding: 0.2, maxZoom: 1.2 }}
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
              <Controls showInteractive={false} position="bottom-left" />
              <MiniMap
                position="bottom-right"
                pannable
                zoomable
                nodeColor={(n) => {
                  const nodeType = (n.type ?? "customer") as GraphNodeType;
                  // MiniMap renders into an SVG — the React Flow
                  // library strips CSS variables, so resolve to a
                  // neutral fill and let our border carry accent.
                  switch (nodeType) {
                    case "customer":
                      return "#6366f1";
                    case "account":
                      return "#22d3ee";
                    case "premise":
                      return "#c084fc";
                    case "agreement":
                      return "#60a5fa";
                    case "meter":
                      return "#4ade80";
                    case "service_request":
                      return "#fbbf24";
                    default:
                      return "#4a5a73";
                  }
                }}
                maskColor="rgba(6, 8, 13, 0.7)"
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
          hiddenTypes={hiddenTypes}
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
