"use client";

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="en">
      <body
        style={{
          fontFamily:
            "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
          margin: 0,
          padding: 0,
          background: "#0f172a",
          color: "#f8fafc",
          minHeight: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <div
          role="alert"
          style={{
            maxWidth: "480px",
            padding: "32px",
            textAlign: "center",
            display: "flex",
            flexDirection: "column",
            gap: "16px",
          }}
        >
          <h1 style={{ margin: 0, fontSize: "22px", fontWeight: 600 }}>
            Application error
          </h1>
          <p style={{ margin: 0, color: "#94a3b8", fontSize: "14px" }}>
            A critical error prevented the app from loading. Please retry.
          </p>
          {error.digest && (
            <code
              style={{
                fontSize: "11px",
                color: "#64748b",
                background: "#1e293b",
                padding: "4px 8px",
                borderRadius: "4px",
              }}
            >
              ref: {error.digest}
            </code>
          )}
          <button
            onClick={reset}
            style={{
              marginTop: "8px",
              padding: "10px 20px",
              borderRadius: "6px",
              border: "none",
              background: "#2563eb",
              color: "#fff",
              fontSize: "14px",
              cursor: "pointer",
            }}
          >
            Reload
          </button>
        </div>
      </body>
    </html>
  );
}
