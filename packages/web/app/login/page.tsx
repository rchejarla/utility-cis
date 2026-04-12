"use client";

import { useState, useEffect } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { API_URL, setAuthToken } from "@/lib/api-client";

const inputStyle = {
  padding: "10px 14px",
  fontSize: 14,
  background: "var(--bg-deep)",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius)",
  color: "var(--text-primary)",
  fontFamily: "inherit",
  outline: "none",
  width: "100%",
  boxSizing: "border-box" as const,
};

export default function LoginPage() {
  const router = useRouter();
  const params = useSearchParams();
  const [email, setEmail] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const presetEmail = params.get("email");
  useEffect(() => {
    if (presetEmail) {
      setEmail(presetEmail);
      doLogin(presetEmail);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [presetEmail]);

  async function doLogin(loginEmail: string) {
    setError("");
    setLoading(true);
    try {
      const res = await fetch(`${API_URL}/api/v1/auth/dev-login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: loginEmail }),
      });
      const data = await res.json();

      if (!res.ok) {
        setError(data.error?.message ?? "Login failed");
        setLoading(false);
        return;
      }

      setAuthToken(data.token, data.user);

      if (data.isPortal) {
        localStorage.setItem("portal_token", data.token);
        localStorage.setItem("portal_user", JSON.stringify(data.user));
      }

      router.push(data.redirectTo ?? "/premises");
    } catch {
      setError("Network error — is the API server running?");
      setLoading(false);
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    await doLogin(email);
  }

  return (
    <div
      style={{
        minHeight: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "var(--bg-deep)",
        padding: 24,
      }}
    >
      <div
        style={{
          width: "100%",
          maxWidth: 420,
          background: "var(--bg-card)",
          border: "1px solid var(--border)",
          borderRadius: "var(--radius)",
          padding: "40px 32px",
        }}
      >
        {/* Logo */}
        <div style={{ textAlign: "center", marginBottom: 32 }}>
          <div
            style={{
              width: 48,
              height: 48,
              borderRadius: 12,
              background: "var(--accent-primary)",
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              color: "#fff",
              fontWeight: 700,
              fontSize: 20,
              marginBottom: 16,
            }}
          >
            U
          </div>
          <h1
            style={{
              fontSize: 22,
              fontWeight: 600,
              color: "var(--text-primary)",
              margin: "0 0 4px",
            }}
          >
            Utility CIS
          </h1>
          <p style={{ fontSize: 14, color: "var(--text-secondary)", margin: 0 }}>
            Sign in to continue
          </p>
        </div>

        {/* Form */}
        <form onSubmit={handleSubmit} style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <div>
            <label
              htmlFor="email"
              style={{
                display: "block",
                marginBottom: 6,
                fontSize: 13,
                fontWeight: 500,
                color: "var(--text-secondary)",
              }}
            >
              Email
            </label>
            <input
              id="email"
              type="email"
              required
              autoComplete="email"
              placeholder="you@utility.com"
              style={inputStyle}
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoFocus={!presetEmail}
            />
          </div>

          {error && (
            <div
              role="alert"
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

          <button
            type="submit"
            disabled={loading}
            style={{
              padding: "11px 16px",
              background: loading ? "var(--bg-elevated)" : "var(--accent-primary)",
              color: loading ? "var(--text-muted)" : "#fff",
              border: "none",
              borderRadius: "var(--radius)",
              fontSize: 14,
              fontWeight: 600,
              cursor: loading ? "not-allowed" : "pointer",
              fontFamily: "inherit",
              marginTop: 4,
            }}
          >
            {loading ? "Signing in…" : "Sign in"}
          </button>
        </form>

        {/* Quick-login pills for dev testing */}
        <div
          style={{
            marginTop: 28,
            paddingTop: 20,
            borderTop: "1px solid var(--border-subtle)",
          }}
        >
          <p style={{ fontSize: 11, color: "var(--text-muted)", margin: "0 0 10px", textAlign: "center", letterSpacing: "0.06em", textTransform: "uppercase", fontWeight: 600 }}>
            Dev quick login
          </p>

          <div style={{ fontSize: 10, color: "var(--text-muted)", textAlign: "center", marginBottom: 10, letterSpacing: "0.04em", textTransform: "uppercase" }}>
            Staff
          </div>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", justifyContent: "center", marginBottom: 12 }}>
            <QuickBtn label="System Admin" email="sysadmin@utility.com" color="#ef4444" onClick={doLogin} />
            <QuickBtn label="Utility Admin" email="admin@utility.com" color="#f59e0b" onClick={doLogin} />
            <QuickBtn label="CSR" email="csr@utility.com" color="#3b82f6" onClick={doLogin} />
            <QuickBtn label="Field Tech" email="tech@utility.com" color="#22c55e" onClick={doLogin} />
            <QuickBtn label="Read-Only" email="viewer@utility.com" color="#8b5cf6" onClick={doLogin} />
          </div>

          <div style={{ fontSize: 10, color: "var(--text-muted)", textAlign: "center", marginBottom: 10, letterSpacing: "0.04em", textTransform: "uppercase" }}>
            Portal customers
          </div>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", justifyContent: "center" }}>
            <QuickBtn label="Jane Smith" email="jane.smith@example.com" color="#f59e0b" onClick={doLogin} />
            <QuickBtn label="Robert Johnson" email="robert.j@example.com" color="#f59e0b" onClick={doLogin} />
          </div>
        </div>
      </div>
    </div>
  );
}

function QuickBtn({
  label,
  email,
  color,
  onClick,
}: {
  label: string;
  email: string;
  color: string;
  onClick: (email: string) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onClick(email)}
      title={email}
      style={{
        padding: "4px 10px",
        fontSize: 11,
        fontWeight: 600,
        background: `${color}18`,
        color,
        border: `1px solid ${color}40`,
        borderRadius: 999,
        cursor: "pointer",
        fontFamily: "inherit",
      }}
    >
      {label}
    </button>
  );
}
