"use client";

import { Suspense, useCallback, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { apiClient } from "@/lib/api-client";
import { PageHeader } from "@/components/ui/page-header";
import { SearchableEntitySelect } from "@/components/ui/searchable-entity-select";
import { useToast } from "@/components/ui/toast";
import { usePermission } from "@/lib/use-permission";
import { AccessDenied } from "@/components/ui/access-denied";
import { formatAgreementLabel } from "@utility-cis/shared";

interface AccountSummary {
  id: string;
  accountNumber: string;
  customer?: { name: string } | null;
  premiseId?: string | null;
}

interface AgreementSummary {
  id: string;
  agreementNumber: string;
  status: string;
  commodity?: { name: string } | null;
  premise?: { id: string; addressLine1: string; city?: string; state?: string } | null;
  premiseId?: string | null;
}

interface AccountDetail extends AccountSummary {
  serviceAgreements?: AgreementSummary[];
}

interface ServiceRequestTypeOption {
  code: string;
  label: string;
}

interface SlaRow {
  id: string;
  requestType: string;
  priority: string;
  responseHours: number;
  resolutionHours: number;
}

const PRIORITIES = ["EMERGENCY", "HIGH", "NORMAL", "LOW"] as const;
type Priority = (typeof PRIORITIES)[number];

// Same darker-bg input treatment used across detail/edit forms.
const inputStyle = {
  padding: "7px 10px",
  fontSize: "13px",
  background: "var(--bg-surface)",
  border: "1px solid var(--border)",
  borderRadius: "8px",
  color: "var(--text-primary)",
  fontFamily: "inherit",
  outline: "none",
  width: "100%",
  boxSizing: "border-box" as const,
};

const cardStyle = {
  background: "var(--bg-card)",
  border: "1px solid var(--border)",
  borderRadius: 10,
  padding: 16,
  marginBottom: 14,
};

const cardHeaderStyle = {
  margin: "0 0 12px",
  fontSize: 13,
  fontWeight: 600,
  color: "var(--text-primary)",
  letterSpacing: "-0.01em",
};

const labelStyle = {
  display: "block",
  fontSize: 11,
  fontWeight: 600,
  color: "var(--text-muted)",
  textTransform: "uppercase" as const,
  letterSpacing: "0.06em",
  marginBottom: 6,
  marginTop: 10,
};

// The form reads `?accountId=` via `useSearchParams`, which Next.js 15
// requires to be rendered inside a <Suspense> boundary during
// server-side prerender. Wrapping it here lets the build succeed
// without turning off static optimization for the whole route.
export default function NewServiceRequestPage() {
  return (
    <Suspense fallback={<div style={{ padding: 24, color: "var(--text-muted)" }}>Loading…</div>}>
      <NewServiceRequestForm />
    </Suspense>
  );
}

function NewServiceRequestForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { toast } = useToast();
  const { canView, canCreate } = usePermission("service_requests");

  const [types, setTypes] = useState<ServiceRequestTypeOption[]>([]);
  const [accountId, setAccountId] = useState<string | undefined>(undefined);
  const [account, setAccount] = useState<AccountDetail | null>(null);
  const [serviceAgreementId, setServiceAgreementId] = useState<string>("");
  const [premiseId, setPremiseId] = useState<string>("");
  const [requestType, setRequestType] = useState<string>("");
  const [priority, setPriority] = useState<Priority>("NORMAL");
  const [subtype, setSubtype] = useState<string>("");
  const [description, setDescription] = useState<string>("");
  const [slaPreview, setSlaPreview] = useState<SlaRow | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Load the list of available request types on mount, seeding the
  // initial value so the SLA preview can render something useful.
  useEffect(() => {
    apiClient
      .get<ServiceRequestTypeOption[]>("/api/v1/service-request-types")
      .then((res) => {
        const list = Array.isArray(res) ? res : [];
        setTypes(list);
        setRequestType((current) => current || list[0]?.code || "");
      })
      .catch((err) => console.error("Failed to load request types", err));
  }, []);

  // When accountId resolves (from user picking or a ?accountId= deep link),
  // fetch the full account so we know its premise + active agreements.
  const loadAccount = useCallback(async (id: string) => {
    try {
      const detail = await apiClient.get<AccountDetail>(`/api/v1/accounts/${id}`);
      setAccount(detail);
    } catch (err) {
      console.error("Failed to load account", err);
      setAccount(null);
    }
  }, []);

  useEffect(() => {
    if (!accountId) {
      setAccount(null);
      return;
    }
    loadAccount(accountId);
  }, [accountId, loadAccount]);

  // Deep link: /service-requests/new?accountId=... pre-loads the picker.
  useEffect(() => {
    const deepAccountId = searchParams?.get("accountId");
    if (deepAccountId && !accountId) {
      setAccountId(deepAccountId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Re-fetch the SLA row any time the chosen type/priority combo changes.
  useEffect(() => {
    if (!requestType) {
      setSlaPreview(null);
      return;
    }
    apiClient
      .get<SlaRow[] | { data: SlaRow[] }>("/api/v1/slas", { requestType })
      .then((res) => {
        const rows = Array.isArray(res) ? res : res.data ?? [];
        setSlaPreview(rows.find((s) => s.priority === priority) ?? null);
      })
      .catch(() => setSlaPreview(null));
  }, [requestType, priority]);

  const activeAgreements =
    account?.serviceAgreements?.filter((a) => a.status === "ACTIVE") ?? [];

  // Distinct premises across the account's active agreements. SRs
  // can optionally target a premise without an agreement, so the
  // premise dropdown is driven from this set.
  const premiseOptions = (() => {
    const seen = new Map<string, { id: string; label: string }>();
    for (const ag of activeAgreements) {
      const pid = ag.premise?.id ?? ag.premiseId;
      if (!pid || seen.has(pid)) continue;
      const p = ag.premise;
      const label = p?.addressLine1
        ? [p.addressLine1, p.city, p.state].filter(Boolean).join(", ")
        : pid;
      seen.set(pid, { id: pid, label });
    }
    return Array.from(seen.values());
  })();

  // When the account changes, auto-select the only active agreement if
  // there is exactly one; clear otherwise (user picks manually). Same
  // rule for premise — auto-select if exactly one distinct premise.
  useEffect(() => {
    if (activeAgreements.length === 1) setServiceAgreementId(activeAgreements[0].id);
    else setServiceAgreementId("");
    if (premiseOptions.length === 1) setPremiseId(premiseOptions[0].id);
    else setPremiseId("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [account?.id]);

  // If the user picks an agreement, slide the premise selection to that
  // agreement's premise — it's almost always the site of the work.
  useEffect(() => {
    if (!serviceAgreementId) return;
    const ag = activeAgreements.find((a) => a.id === serviceAgreementId);
    const pid = ag?.premise?.id ?? ag?.premiseId;
    if (pid) setPremiseId(pid);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serviceAgreementId]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!account || !requestType || !description.trim()) return;
    setSubmitting(true);
    try {
      const created = await apiClient.post<{ id: string }>(
        "/api/v1/service-requests",
        {
          accountId: account.id,
          premiseId: premiseId || null,
          serviceAgreementId: serviceAgreementId || null,
          requestType,
          requestSubtype: subtype.trim() ? subtype.trim() : null,
          priority,
          description: description.trim(),
        },
      );
      toast("Service request created", "success");
      router.push(`/service-requests/${created.id}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to create request";
      toast(msg, "error");
    } finally {
      setSubmitting(false);
    }
  }

  if (!canView) return <AccessDenied />;
  if (!canCreate) return <AccessDenied />;

  const submitDisabled =
    submitting || !account || !requestType || !description.trim();

  return (
    <form onSubmit={submit}>
      <PageHeader title="New Service Request" subtitle="Log a customer-initiated or internal work item" />

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "minmax(0, 1.5fr) minmax(0, 1fr)",
          gap: 18,
        }}
      >
        <div style={{ minWidth: 0 }}>
          <section style={cardStyle}>
            <h4 style={cardHeaderStyle}>Who / where</h4>

            <label style={{ ...labelStyle, marginTop: 0 }}>Account *</label>
            <SearchableEntitySelect<AccountSummary>
              value={accountId}
              onChange={(val) => setAccountId(val)}
              endpoint="/api/v1/accounts"
              mapOption={(a) => ({
                value: a.id,
                label: a.accountNumber,
                sublabel: a.customer?.name ?? undefined,
              })}
              placeholder="Search accounts by number or name..."
              label="Account"
            />

            {account && (
              <>
                <label style={labelStyle}>Premise</label>
                {premiseOptions.length > 0 ? (
                  <select
                    value={premiseId}
                    onChange={(e) => setPremiseId(e.target.value)}
                    style={inputStyle}
                  >
                    <option value="">— none —</option>
                    {premiseOptions.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.label}
                      </option>
                    ))}
                  </select>
                ) : (
                  <div style={{ fontSize: 12, color: "var(--text-muted)", padding: "7px 0" }}>
                    No premises on this account's active agreements.
                  </div>
                )}

                <label style={labelStyle}>Service agreement</label>
                {activeAgreements.length > 0 ? (
                  <select
                    value={serviceAgreementId}
                    onChange={(e) => setServiceAgreementId(e.target.value)}
                    style={inputStyle}
                  >
                    <option value="">— none —</option>
                    {activeAgreements.map((a) => (
                      <option key={a.id} value={a.id}>
                        {formatAgreementLabel(a)}
                      </option>
                    ))}
                  </select>
                ) : (
                  <div style={{ fontSize: 12, color: "var(--text-muted)", padding: "7px 0" }}>
                    No active agreements on this account.
                  </div>
                )}
              </>
            )}
          </section>

          <section style={cardStyle}>
            <h4 style={cardHeaderStyle}>Request details</h4>

            <label style={{ ...labelStyle, marginTop: 0 }}>Type *</label>
            <select
              value={requestType}
              onChange={(e) => setRequestType(e.target.value)}
              style={inputStyle}
            >
              {types.length === 0 && <option value="">(loading…)</option>}
              {types.map((t) => (
                <option key={t.code} value={t.code}>
                  {t.code} — {t.label}
                </option>
              ))}
            </select>

            <label style={labelStyle}>Subtype</label>
            <input
              type="text"
              value={subtype}
              onChange={(e) => setSubtype(e.target.value)}
              placeholder="Optional subtype tag"
              style={inputStyle}
            />

            <label style={labelStyle}>Priority *</label>
            <div style={{ display: "flex", gap: 6 }}>
              {PRIORITIES.map((p) => {
                const active = priority === p;
                return (
                  <button
                    key={p}
                    type="button"
                    onClick={() => setPriority(p)}
                    style={{
                      flex: 1,
                      padding: "8px 10px",
                      borderRadius: 8,
                      border: active
                        ? "1px solid var(--accent-primary)"
                        : "1px solid var(--border)",
                      background: active ? "var(--accent-primary)" : "var(--bg-surface)",
                      color: active ? "#fff" : "var(--text-primary)",
                      fontWeight: active ? 600 : 500,
                      fontSize: 12,
                      cursor: "pointer",
                      fontFamily: "inherit",
                      transition: "background 0.12s, color 0.12s",
                    }}
                  >
                    {p}
                  </button>
                );
              })}
            </div>

            <label style={labelStyle}>Description *</label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={5}
              placeholder="Describe the issue or work to be done"
              style={{ ...inputStyle, resize: "vertical", minHeight: 90 }}
            />
          </section>
        </div>

        <aside style={{ minWidth: 0 }}>
          <section style={cardStyle}>
            <h4 style={cardHeaderStyle}>SLA preview</h4>
            {slaPreview ? (
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "auto 1fr",
                  rowGap: 8,
                  columnGap: 12,
                  fontSize: 13,
                  color: "var(--text-primary)",
                }}
              >
                <span style={{ color: "var(--text-muted)", fontSize: 12 }}>Matching</span>
                <span>
                  {slaPreview.requestType} · {slaPreview.priority}
                </span>
                <span style={{ color: "var(--text-muted)", fontSize: 12 }}>Response</span>
                <span>{slaPreview.responseHours}h</span>
                <span style={{ color: "var(--text-muted)", fontSize: 12 }}>Resolution</span>
                <span>{slaPreview.resolutionHours}h</span>
                <span style={{ color: "var(--text-muted)", fontSize: 12 }}>Due at</span>
                <span>
                  {new Date(
                    Date.now() + slaPreview.resolutionHours * 3600 * 1000,
                  ).toLocaleString()}
                </span>
              </div>
            ) : (
              <div style={{ fontSize: 12, color: "var(--warning)" }}>
                No SLA configured for this type and priority.
              </div>
            )}
          </section>
        </aside>
      </div>

      <div
        style={{
          marginTop: 18,
          display: "flex",
          gap: 8,
          justifyContent: "flex-end",
        }}
      >
        <button
          type="button"
          onClick={() => router.back()}
          style={{
            padding: "8px 16px",
            fontSize: 13,
            background: "transparent",
            border: "1px solid var(--border)",
            borderRadius: "var(--radius)",
            color: "var(--text-secondary)",
            cursor: "pointer",
            fontFamily: "inherit",
          }}
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={submitDisabled}
          style={{
            padding: "8px 20px",
            fontSize: 13,
            background: submitDisabled ? "var(--bg-elevated)" : "var(--accent-primary)",
            color: submitDisabled ? "var(--text-muted)" : "#fff",
            border: "none",
            borderRadius: "var(--radius)",
            fontWeight: 600,
            cursor: submitDisabled ? "not-allowed" : "pointer",
            fontFamily: "inherit",
            opacity: submitting ? 0.7 : 1,
          }}
        >
          {submitting ? "Creating…" : "Create Request"}
        </button>
      </div>
    </form>
  );
}
