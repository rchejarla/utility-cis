"use client";

import { useRouter } from "next/navigation";
import { StatusBadge } from "@/components/ui/status-badge";
import { CommodityBadge } from "@/components/ui/commodity-badge";

interface MapPopupProps {
  premiseId: string;
  address: string;
  premiseType: string;
  status: string;
  commodityIds: string[];
  onClose: () => void;
  onViewDetails: () => void;
}

export function MapPopup({
  premiseId,
  address,
  premiseType,
  status,
  commodityIds,
  onClose,
  onViewDetails,
}: MapPopupProps) {
  return (
    <div
      style={{
        background: "var(--bg-card)",
        border: "1px solid var(--border)",
        borderRadius: "var(--radius)",
        padding: "14px 16px",
        minWidth: "240px",
        maxWidth: "300px",
        boxShadow: "0 4px 20px rgba(0,0,0,0.4)",
        fontFamily: "inherit",
      }}
    >
      {/* Header */}
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "flex-start",
          marginBottom: "10px",
          gap: "8px",
        }}
      >
        <div style={{ flex: 1 }}>
          <div
            style={{
              fontSize: "13px",
              fontWeight: "600",
              color: "var(--text-primary)",
              lineHeight: "1.4",
            }}
          >
            {address}
          </div>
          <div
            style={{
              fontSize: "11px",
              color: "var(--text-muted)",
              marginTop: "2px",
              textTransform: "capitalize",
            }}
          >
            {premiseType.charAt(0) + premiseType.slice(1).toLowerCase()}
          </div>
        </div>
        <button
          onClick={onClose}
          style={{
            background: "transparent",
            border: "none",
            cursor: "pointer",
            color: "var(--text-muted)",
            fontSize: "16px",
            lineHeight: 1,
            padding: "0 2px",
            flexShrink: 0,
          }}
          aria-label="Close popup"
        >
          ×
        </button>
      </div>

      {/* Status */}
      <div style={{ marginBottom: "10px" }}>
        <StatusBadge status={status} />
      </div>

      {/* Commodities */}
      {commodityIds.length > 0 && (
        <div style={{ display: "flex", gap: "4px", flexWrap: "wrap", marginBottom: "12px" }}>
          {commodityIds.map((id) => (
            <CommodityBadge key={id} commodity={id} />
          ))}
        </div>
      )}

      {/* Actions */}
      <div style={{ display: "flex", gap: "8px" }}>
        <button
          onClick={onViewDetails}
          style={{
            flex: 1,
            padding: "6px 12px",
            fontSize: "12px",
            fontWeight: "500",
            background: "var(--accent-primary)",
            color: "#fff",
            border: "none",
            borderRadius: "var(--radius)",
            cursor: "pointer",
            fontFamily: "inherit",
          }}
        >
          View Details
        </button>
        <button
          onClick={onClose}
          style={{
            padding: "6px 12px",
            fontSize: "12px",
            fontWeight: "500",
            background: "transparent",
            color: "var(--text-secondary)",
            border: "1px solid var(--border)",
            borderRadius: "var(--radius)",
            cursor: "pointer",
            fontFamily: "inherit",
          }}
        >
          Close
        </button>
      </div>
    </div>
  );
}
