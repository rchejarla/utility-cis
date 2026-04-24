"use client";

import type { CSSProperties } from "react";
import { BaseEdge } from "@xyflow/react";

export interface TrunkEdgeData {
  /** Shared x for the vertical segment. All edges of the same kind
   *  pass through the same trunkX so the trunks look like one line. */
  trunkX: number;
  /** How far below the source to descend before turning toward the
   *  trunk. Keeps the initial segment short so the "T" isn't too
   *  deep. */
  descend: number;
  /** Label shown in the edge's SVG `<title>` tooltip. */
  title?: string;
}

/**
 * Custom edge that draws the classic org-chart trunk path:
 *
 *   source ──► (down a bit)
 *              │
 *              └──► (over to trunkX)
 *                   │
 *                   └──► (down along trunk to target y)
 *                        │
 *                        └──► (horizontally into target)
 *
 * Used for the Customer → Premise and Customer → Account edges so
 * every edge with the same `trunkX` shares a single visible vertical
 * spine behind the premises or accounts column.
 *
 * Typed loosely because React Flow v12's EdgeProps generic doesn't
 * propagate arbitrary data shapes cleanly; we accept the subset of
 * the edge props we need and coerce the data field.
 */
interface TrunkEdgeProps {
  sourceX: number;
  sourceY: number;
  targetX: number;
  targetY: number;
  data?: TrunkEdgeData;
  style?: CSSProperties;
  markerEnd?: string;
}

export function TrunkEdge({
  sourceX,
  sourceY,
  targetX,
  targetY,
  data,
  style,
  markerEnd,
}: TrunkEdgeProps) {
  const trunkX = data?.trunkX ?? (sourceX + targetX) / 2;
  const descendY = sourceY + (data?.descend ?? 40);
  const path =
    `M ${sourceX} ${sourceY}` +
    ` V ${descendY}` +
    ` H ${trunkX}` +
    ` V ${targetY}` +
    ` H ${targetX}`;
  return <BaseEdge path={path} style={style} markerEnd={markerEnd} />;
}
