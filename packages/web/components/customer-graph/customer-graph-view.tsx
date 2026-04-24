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
import dagre from "@dagrejs/dagre";
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

// Rough node footprint used by dagre to reserve space. Our node
// cards are ~180×72 — a little padding keeps edges from hugging
// other cards.
const NODE_W = 200;
const NODE_H = 90;

/**
 * Top-down hierarchical layout via dagre.
 *
 * Customer sits at the top; accounts + any customer-owned premises
 * fan out below it; agreements below their account; meters + service
 * requests + the agreement's premise sit at the bottom. Dagre
 * minimises edge crossings between layers, which is the thing the
 * previous hand-rolled radial layout couldn't do.
 *
 * Pure function of nodes + edges — same input shape produces the
 * same positions, so refresh doesn't reshuffle the graph.
 */
function layoutWithDagre(
  nodes: GraphNode[],
  edges: GraphEdge[],
): Map<string, { x: number; y: number }> {
  const g = new dagre.graphlib.Graph();
  g.setGraph({
    rankdir: "TB",        // top → bottom
    ranksep: 80,          // vertical gap between layers
    nodesep: 40,          // horizontal gap between siblings
    edgesep: 20,          // gap between parallel edges
    marginx: 40,
    marginy: 40,
  });
  g.setDefaultEdgeLabel(() => ({}));

  for (const n of nodes) {
    g.setNode(n.id, { width: NODE_W, height: NODE_H });
  }
  for (const e of edges) {
    g.setEdge(e.from, e.to);
  }
  dagre.layout(g);

  const positions = new Map<string, { x: number; y: number }>();
  for (const n of nodes) {
    const p = g.node(n.id);
    if (!p) continue;
    // dagre gives the node's centre; React Flow wants the top-left,
    // so shift by half the footprint.
    positions.set(n.id, { x: p.x - NODE_W / 2, y: p.y - NODE_H / 2 });
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

  // Positions from dagre — recomputed only when the raw node/edge
  // list changes. Filter toggles don't re-layout; they hide via the
  // flow nodes/edges props below.
  const positions = useMemo(() => {
    if (!graph) return new Map<string, { x: number; y: number }>();
    return layoutWithDagre(graph.nodes, graph.edges);
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
