"use client";

import { useState } from "react";

interface TooltipProps {
  text: string;
  ruleId?: string;
}

export function HelpTooltip({ text, ruleId }: TooltipProps) {
  const [show, setShow] = useState(false);

  return (
    <span
      style={{ position: "relative", display: "inline-flex", marginLeft: "6px", flexShrink: 0 }}
      onMouseEnter={() => setShow(true)}
      onMouseLeave={() => setShow(false)}
      onClick={() => setShow((v) => !v)}
    >
      <span
        style={{
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          width: "16px",
          height: "16px",
          borderRadius: "50%",
          background: "var(--bg-elevated)",
          border: "1px solid var(--border)",
          fontSize: "10px",
          fontWeight: 700,
          color: "var(--accent-primary)",
          cursor: "help",
        }}
      >
        ?
      </span>

      {show && (
        <div
          style={{
            position: "absolute",
            bottom: "calc(100% + 8px)",
            left: "50%",
            transform: "translateX(-50%)",
            background: "var(--bg-card)",
            border: "1px solid var(--border)",
            borderRadius: "8px",
            padding: "10px 14px",
            boxShadow: "0 8px 24px rgba(0,0,0,0.4)",
            zIndex: 60,
            width: "280px",
            pointerEvents: "none",
          }}
        >
          {ruleId && (
            <div
              style={{
                fontSize: "10px",
                fontWeight: 600,
                color: "var(--accent-primary)",
                fontFamily: "monospace",
                marginBottom: "4px",
                letterSpacing: "0.03em",
              }}
            >
              {ruleId}
            </div>
          )}
          <div
            style={{
              fontSize: "12px",
              lineHeight: 1.5,
              color: "var(--text-secondary)",
            }}
          >
            {text}
          </div>
          {/* Arrow */}
          <div
            style={{
              position: "absolute",
              bottom: "-5px",
              left: "50%",
              transform: "translateX(-50%) rotate(45deg)",
              width: "10px",
              height: "10px",
              background: "var(--bg-card)",
              borderRight: "1px solid var(--border)",
              borderBottom: "1px solid var(--border)",
            }}
          />
        </div>
      )}
    </span>
  );
}
