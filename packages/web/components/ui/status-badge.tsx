"use client";

interface StatusBadgeProps {
  status: string;
}

type Tone = "success" | "warning" | "danger" | "neutral";

/**
 * Maps a status string to a semantic tone. Tones resolve to CSS vars
 * (--success, --success-subtle, etc.) so the badge is theme-aware —
 * light mode uses dark-on-pale; dark mode uses vivid-on-translucent.
 */
function getTone(status: string): { tone: Tone; label: string } {
  const s = status?.toLowerCase() ?? "";
  const label = status ? status.charAt(0).toUpperCase() + status.slice(1).toLowerCase() : "";

  if (s === "active") return { tone: "success", label: label || "Active" };
  if (s === "inactive" || s === "pending") return { tone: "warning", label };
  if (s === "condemned" || s === "suspended") return { tone: "danger", label };
  // closed / final / unknown → neutral slate
  return { tone: "neutral", label };
}

const TONE_VARS: Record<Tone, { bg: string; fg: string; border: string }> = {
  success: { bg: "var(--success-subtle)", fg: "var(--success)", border: "var(--success)" },
  warning: { bg: "var(--warning-subtle)", fg: "var(--warning)", border: "var(--warning)" },
  danger: { bg: "var(--danger-subtle)", fg: "var(--danger)", border: "var(--danger)" },
  neutral: { bg: "var(--bg-elevated)", fg: "var(--text-secondary)", border: "var(--border)" },
};

export function StatusBadge({ status }: StatusBadgeProps) {
  const { tone, label } = getTone(status);
  const vars = TONE_VARS[tone];

  return (
    <span
      role="status"
      aria-label={`Status: ${label}`}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: "5px",
        padding: "2px 8px",
        borderRadius: "999px",
        background: vars.bg,
        border: `1px solid ${vars.border}`,
        fontSize: "11px",
        fontWeight: 600,
        color: vars.fg,
        whiteSpace: "nowrap",
        width: "fit-content",
        // Prevent CSS Grid from stretching the badge to fill its cell.
        justifySelf: "start",
      }}
    >
      <span
        aria-hidden="true"
        style={{
          width: "6px",
          height: "6px",
          borderRadius: "50%",
          background: vars.fg,
          flexShrink: 0,
        }}
      />
      {label}
    </span>
  );
}
