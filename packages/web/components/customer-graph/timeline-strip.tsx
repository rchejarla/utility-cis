"use client";

import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import type { GraphNode, GraphNodeType, TimelineEvent } from "@utility-cis/shared";
import { accentForType } from "./graph-nodes";

interface TimelineStripProps {
  events: TimelineEvent[];
  nodes: GraphNode[];
  hiddenTypes: Set<GraphNodeType>;
  onEventHover: (relatedNodeIds: string[] | null) => void;
  onEventClick: (relatedNodeIds: string[]) => void;
}

/**
 * Formats an ISO timestamp as "Apr 23, 2026". Guards against invalid
 * dates by falling back to the raw string — no throwing from inside a
 * render loop.
 */
function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

/**
 * Finds the dominant node type for an event by looking at its first
 * related node. Timeline pills inherit their accent from that node's
 * type so users can visually match an event to its region of the graph.
 *
 * Falls back to "customer" (the center node) when nothing matches.
 */
function typeForEvent(
  event: TimelineEvent,
  nodesById: Map<string, GraphNode>,
): GraphNodeType {
  for (const id of event.relatedNodeIds) {
    const n = nodesById.get(id);
    if (n) return n.type;
  }
  return "customer";
}

export function TimelineStrip({
  events,
  nodes,
  hiddenTypes,
  onEventHover,
  onEventClick,
}: TimelineStripProps) {
  const nodesById = new Map(nodes.map((n) => [n.id, n]));

  // Sort oldest → newest. Stable sort on same-day events — pure by
  // the event id once the occurredAt tie breaks.
  const sorted = [...events].sort((a, b) => {
    const ta = new Date(a.occurredAt).getTime();
    const tb = new Date(b.occurredAt).getTime();
    if (ta !== tb) return ta - tb;
    return a.id.localeCompare(b.id);
  });

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 6,
        padding: "10px 12px 12px",
        background: "var(--bg-surface)",
        border: "1px solid var(--border)",
        borderRadius: "var(--radius)",
      }}
    >
      <div
        style={{
          fontSize: 10,
          fontWeight: 700,
          letterSpacing: "0.08em",
          textTransform: "uppercase",
          color: "var(--text-muted)",
        }}
      >
        Timeline ({sorted.length})
      </div>

      {sorted.length === 0 ? (
        <div
          style={{
            fontSize: 12,
            color: "var(--text-muted)",
            padding: "8px 4px",
          }}
        >
          No events recorded.
        </div>
      ) : (
        <div
          style={{
            display: "flex",
            gap: 8,
            overflowX: "auto",
            overflowY: "hidden",
            paddingBottom: 6,
          }}
        >
          {sorted.map((event) => {
            const type = typeForEvent(event, nodesById);
            const accent = accentForType(type);
            // An event is "dimmed" when every one of its related nodes
            // is in a hidden category — the user has opted out of
            // seeing this type. Don't hide the pill entirely; just fade
            // it so the chronology remains intact.
            const allHidden =
              event.relatedNodeIds.length > 0 &&
              event.relatedNodeIds.every((id) => {
                const n = nodesById.get(id);
                return n ? hiddenTypes.has(n.type) : false;
              });

            return (
              <button
                key={event.id}
                type="button"
                onMouseEnter={() => onEventHover(event.relatedNodeIds)}
                onMouseLeave={() => onEventHover(null)}
                onClick={() => onEventClick(event.relatedNodeIds)}
                title={`${event.kind} — ${formatDate(event.occurredAt)}`}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 8,
                  padding: "6px 12px",
                  borderRadius: 999,
                  border: `1px solid ${accent.color}`,
                  background: "var(--bg-card)",
                  color: "var(--text-primary)",
                  fontSize: 12,
                  fontFamily: "inherit",
                  cursor: "pointer",
                  opacity: allHidden ? 0.4 : 1,
                  flexShrink: 0,
                  whiteSpace: "nowrap",
                  transition: "background 0.12s ease, opacity 0.12s ease",
                }}
                onMouseOver={(e) =>
                  ((e.currentTarget as HTMLButtonElement).style.background =
                    "var(--bg-hover)")
                }
                onMouseOut={(e) =>
                  ((e.currentTarget as HTMLButtonElement).style.background =
                    "var(--bg-card)")
                }
              >
                <FontAwesomeIcon
                  icon={accent.icon}
                  style={{ width: 11, height: 11, color: accent.color }}
                />
                <span
                  style={{
                    fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
                    fontSize: 11,
                    color: "var(--text-muted)",
                  }}
                >
                  {formatDate(event.occurredAt)}
                </span>
                <span style={{ color: "var(--text-secondary)" }}>
                  {event.label}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
