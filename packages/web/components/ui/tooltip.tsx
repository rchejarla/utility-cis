"use client";

interface TooltipProps {
  text: string;
  ruleId?: string;
}

export function HelpTooltip({ text, ruleId }: TooltipProps) {
  return (
    <span
      title={ruleId ? `${ruleId}: ${text}` : text}
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        width: "14px",
        height: "14px",
        borderRadius: "50%",
        background: "var(--bg-elevated)",
        border: "1px solid var(--border)",
        fontSize: "9px",
        fontWeight: 700,
        color: "var(--text-muted)",
        cursor: "help",
        marginLeft: "6px",
        flexShrink: 0,
      }}
    >
      ?
    </span>
  );
}
