"use client";

import { useEffect } from "react";

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Log to console; a production app would also ship this to Sentry/Datadog.
    console.error("[route error]", error);
  }, [error]);

  return (
    <div
      role="alert"
      style={{
        padding: "48px 24px",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        textAlign: "center",
        minHeight: "60vh",
        gap: "16px",
      }}
    >
      <div
        aria-hidden="true"
        style={{
          width: "56px",
          height: "56px",
          borderRadius: "50%",
          background: "var(--danger-subtle)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          color: "var(--danger)",
          fontSize: "28px",
          fontWeight: 700,
        }}
      >
        !
      </div>
      <h1 style={{ margin: 0, fontSize: "20px", fontWeight: 600, color: "var(--text-primary)" }}>
        Something went wrong
      </h1>
      <p
        style={{
          margin: 0,
          maxWidth: "480px",
          color: "var(--text-secondary)",
          fontSize: "14px",
          lineHeight: 1.5,
        }}
      >
        The page couldn&apos;t be displayed. You can retry, or go back and try again. If this keeps
        happening, contact support with the reference below.
      </p>
      {error.digest && (
        <code
          style={{
            fontSize: "11px",
            color: "var(--text-muted, #94a3b8)",
            background: "var(--bg-elevated, #f1f5f9)",
            padding: "4px 8px",
            borderRadius: "4px",
          }}
        >
          ref: {error.digest}
        </code>
      )}
      <div style={{ display: "flex", gap: "10px", marginTop: "8px" }}>
        <button
          onClick={reset}
          style={{
            padding: "8px 18px",
            borderRadius: "var(--radius, 6px)",
            border: "none",
            background: "var(--accent-primary, #2563eb)",
            color: "#fff",
            fontSize: "13px",
            fontWeight: 500,
            cursor: "pointer",
          }}
        >
          Try again
        </button>
      </div>
    </div>
  );
}
