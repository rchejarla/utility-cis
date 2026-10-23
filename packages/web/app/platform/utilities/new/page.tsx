"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { PageHeader } from "@/components/ui/page-header";
import { FormField } from "@/components/ui/form-field";

/**
 * Provision a tenant.
 *
 * Its own page rather than a panel above the list, which is how every
 * other entity in this app is created. It is hand-composed rather than
 * built on `EntityFormPage` for one reason: that component gates on
 * `canCreate` for a **tenant** permission module, and this screen has no
 * tenant and no `AuthPermissionProvider` above it — the authority here
 * is being the platform actor (see platform-shell.tsx). So it borrows
 * the house furniture, `PageHeader` and `FormField`, and not the
 * machinery.
 *
 * Preview is the other reason. Provisioning can be run as a dry run that
 * meets the same constraints the real one will and then rolls back, so a
 * name already taken is refused before anybody commits to it. No shared
 * form component expresses a second, non-destructive submit.
 */

interface ProvisionResult {
  utilityId: string;
  created: boolean;
  modulesEnabled: number;
  rolesCreated: number;
  adminCreated: boolean;
}

const inputStyle: React.CSSProperties = {
  padding: "8px 10px",
  borderRadius: "var(--radius)",
  border: "1px solid var(--border)",
  background: "var(--bg-card)",
  color: "var(--text-primary)",
  fontSize: 13,
  fontFamily: "inherit",
  width: "100%",
  boxSizing: "border-box",
};

const btnStyle: React.CSSProperties = {
  padding: "8px 16px",
  borderRadius: "var(--radius)",
  fontSize: 13,
  fontWeight: 500,
  fontFamily: "inherit",
  cursor: "pointer",
  border: "1px solid var(--border)",
};

export default function NewPlatformTenantPage() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [adminEmail, setAdminEmail] = useState("");
  const [adminName, setAdminName] = useState("");
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<ProvisionResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  // The admin is optional, but it is one thing made of two fields: the
  // route requires both or neither, so a half-filled pair is a state the
  // form names rather than submits.
  const adminHalfFilled = Boolean(adminEmail.trim()) !== Boolean(adminName.trim());
  const pairError = adminHalfFilled ? "Email and name go together — fill both, or leave both empty." : undefined;
  const blocked = busy || !name.trim() || adminHalfFilled;

  async function submit(dryRun: boolean) {
    setBusy(true);
    setError(null);
    setPreview(null);
    try {
      const body: Record<string, unknown> = { name: name.trim(), dryRun };
      if (adminEmail.trim() && adminName.trim()) {
        body.firstAdmin = { email: adminEmail.trim(), name: adminName.trim() };
      }
      const { apiClient } = await import("@/lib/api-client");
      const result = await apiClient.post<ProvisionResult>("/api/v1/platform/utilities", body);
      if (dryRun) {
        setPreview(result);
      } else {
        router.push("/platform/utilities");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <PageHeader
        title="Provision a utility"
        subtitle="Creates the utility, enables every module, and adds the six preset roles. Optionally its first admin."
      />

      <div
        style={{
          background: "var(--bg-card)",
          border: "1px solid var(--border)",
          borderRadius: "var(--radius)",
          padding: 20,
          maxWidth: 640,
        }}
      >
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <FormField label="Utility name" required hint="Refused if another utility already holds it.">
            <input
              style={inputStyle}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="City of Example"
            />
          </FormField>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
            <FormField label="First admin email" error={pairError}>
              <input
                style={inputStyle}
                value={adminEmail}
                onChange={(e) => setAdminEmail(e.target.value)}
                placeholder="ops@example.gov"
              />
            </FormField>
            <FormField label="First admin name">
              <input
                style={inputStyle}
                value={adminName}
                onChange={(e) => setAdminName(e.target.value)}
                placeholder="Pat Admin"
              />
            </FormField>
          </div>

          <p style={{ fontSize: 12, color: "var(--text-muted)", margin: 0 }}>
            The admin pair is optional — fill both, or neither. A tenant can get its first admin
            later.
          </p>
        </div>

        {preview && (
          <div
            style={{
              marginTop: 16,
              padding: "11px 14px",
              borderRadius: "var(--radius)",
              background: "var(--bg-elevated)",
              border: "1px solid var(--border-subtle)",
              fontSize: 13,
            }}
          >
            <strong style={{ color: "var(--text-primary)" }}>Preview — nothing was written.</strong>
            <div style={{ color: "var(--text-secondary)", marginTop: 4 }}>
              {preview.created ? "Would create the utility" : "Utility already exists"} ·{" "}
              {preview.modulesEnabled} modules · {preview.rolesCreated} roles ·{" "}
              {preview.adminCreated ? "would create the admin" : "no admin created"}
            </div>
          </div>
        )}

        {error && (
          <div
            style={{
              marginTop: 16,
              padding: "11px 14px",
              borderRadius: "var(--radius)",
              border: "1px solid var(--danger)",
              color: "var(--danger)",
              fontSize: 13,
            }}
          >
            {error}
          </div>
        )}

        <div
          style={{
            display: "flex",
            gap: 8,
            alignItems: "center",
            marginTop: 20,
            paddingTop: 16,
            borderTop: "1px solid var(--border-subtle)",
          }}
        >
          <button
            onClick={() => submit(false)}
            disabled={blocked}
            style={{
              ...btnStyle,
              background: "var(--accent-primary)",
              color: "#fff",
              border: "none",
              cursor: blocked ? "not-allowed" : "pointer",
              opacity: blocked ? 0.55 : 1,
            }}
          >
            {busy ? "Working..." : "Create utility"}
          </button>
          <button
            onClick={() => submit(true)}
            disabled={blocked}
            style={{
              ...btnStyle,
              background: "transparent",
              color: "var(--text-secondary)",
              cursor: blocked ? "not-allowed" : "pointer",
              opacity: blocked ? 0.55 : 1,
            }}
          >
            Preview
          </button>
          <button
            onClick={() => router.push("/platform/utilities")}
            style={{ ...btnStyle, background: "transparent", color: "var(--text-muted)" }}
          >
            Cancel
          </button>
          {/*
            Beside the button rather than in a `title` on it: a title
            attribute becomes the element's accessible name, so screen
            readers announced this sentence in place of the word
            "Preview".
          */}
          <span style={{ fontSize: 12, color: "var(--text-muted)" }}>
            Preview does everything and writes nothing.
          </span>
        </div>
      </div>
    </div>
  );
}
