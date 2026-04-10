"use client";

import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faBuilding, faUser } from "@fortawesome/pro-solid-svg-icons";

interface TypeBadgeProps {
  type: string;
  /** "compact" for list rows (dot + label), "detail" for detail pages (icon + label) */
  variant?: "compact" | "detail";
}

export function TypeBadge({ type, variant = "compact" }: TypeBadgeProps) {
  const isOrg = type === "ORGANIZATION";
  const label = isOrg ? "Organization" : "Individual";
  const tone = isOrg ? "warning" : "info";

  return (
    <span
      role="img"
      aria-label={`Customer type: ${label}`}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: "5px",
        padding: variant === "detail" ? "2px 10px" : "2px 8px",
        borderRadius: "999px",
        background: `var(--${tone}-subtle)`,
        border: `1px solid var(--${tone})`,
        fontSize: variant === "detail" ? "12px" : "11px",
        fontWeight: 600,
        color: `var(--${tone})`,
        whiteSpace: "nowrap",
        width: "fit-content",
        justifySelf: "start",
      }}
    >
      {variant === "detail" ? (
        <FontAwesomeIcon icon={isOrg ? faBuilding : faUser} style={{ width: 11, height: 11 }} />
      ) : (
        <span
          aria-hidden="true"
          style={{
            width: "5px",
            height: "5px",
            borderRadius: "50%",
            background: `var(--${tone})`,
            flexShrink: 0,
          }}
        />
      )}
      {label}
    </span>
  );
}
