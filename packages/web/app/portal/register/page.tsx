"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

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
} as const;

export default function PortalRegisterPage() {
  const router = useRouter();
  const [accountNumber, setAccountNumber] = useState("");
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);

    try {
      const res = await fetch("http://localhost:3001/portal/api/auth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accountNumber, email, name }),
      });
      const data = await res.json();

      if (!res.ok) {
        setError(data.error?.message ?? "Registration failed");
        return;
      }

      localStorage.setItem("portal_token", data.token);
      localStorage.setItem("portal_user", JSON.stringify(data.user));
      router.push("/portal/dashboard");
    } catch (err) {
      setError("Network error — is the API server running?");
    } finally {
      setLoading(false);
    }
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
          maxWidth: 400,
          background: "var(--bg-card)",
          border: "1px solid var(--border)",
          borderRadius: "var(--radius)",
          padding: "40px 32px",
        }}
      >
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
            Create Portal Account
          </h1>
          <p style={{ fontSize: 14, color: "var(--text-secondary)", margin: 0 }}>
            Link your utility account to access bills, usage, and more
          </p>
        </div>

        <form onSubmit={handleSubmit} style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <div>
            <label style={{ fontSize: 12, color: "var(--text-muted)", fontWeight: 500, display: "block", marginBottom: 6 }}>
              Account number
            </label>
            <input
              type="text"
              required
              style={inputStyle}
              value={accountNumber}
              onChange={(e) => setAccountNumber(e.target.value)}
              placeholder="AC-00001"
              autoFocus
            />
          </div>

          <div>
            <label style={{ fontSize: 12, color: "var(--text-muted)", fontWeight: 500, display: "block", marginBottom: 6 }}>
              Email address on file
            </label>
            <input
              type="email"
              required
              style={inputStyle}
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
            />
          </div>

          <div>
            <label style={{ fontSize: 12, color: "var(--text-muted)", fontWeight: 500, display: "block", marginBottom: 6 }}>
              Your name
            </label>
            <input
              type="text"
              required
              style={inputStyle}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Jane Doe"
            />
          </div>

          {error && (
            <div
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
              padding: "10px 20px",
              background: "var(--accent-primary)",
              color: "#fff",
              border: "none",
              borderRadius: "var(--radius)",
              fontSize: 14,
              fontWeight: 600,
              cursor: loading ? "not-allowed" : "pointer",
              opacity: loading ? 0.7 : 1,
              fontFamily: "inherit",
            }}
          >
            {loading ? "Registering…" : "Register"}
          </button>
        </form>

        <p
          style={{
            marginTop: 20,
            textAlign: "center",
            fontSize: 13,
            color: "var(--text-muted)",
          }}
        >
          Already registered?{" "}
          <Link href="/portal/login" style={{ color: "var(--accent-primary)" }}>
            Sign in
          </Link>
        </p>
      </div>
    </div>
  );
}
