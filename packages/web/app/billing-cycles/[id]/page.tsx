"use client";

import { useState, useEffect, use } from "react";
import { PageHeader } from "@/components/ui/page-header";
import { Tabs } from "@/components/ui/tabs";
import { StatusBadge } from "@/components/ui/status-badge";
import { apiClient } from "@/lib/api-client";

interface BillingCycle {
  id: string;
  name: string;
  cycleCode: string;
  readDayOfMonth: number;
  billDayOfMonth: number;
  frequency: string;
  active: boolean;
}

const fieldStyle = {
  display: "grid" as const,
  gridTemplateColumns: "180px 1fr",
  gap: "8px",
  padding: "10px 0",
  borderBottom: "1px solid var(--border-subtle)",
  alignItems: "start" as const,
};
const labelStyle = { fontSize: "12px", color: "var(--text-muted)", fontWeight: "500" as const };
const valueStyle = { fontSize: "13px", color: "var(--text-primary)" };

export default function BillingCycleDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [cycle, setCycle] = useState<BillingCycle | null>(null);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState("overview");

  useEffect(() => {
    apiClient
      .get<BillingCycle>(`/api/v1/billing-cycles/${id}`)
      .then((data) => setCycle(data))
      .catch(console.error)
      .finally(() => setLoading(false));
  }, [id]);

  if (loading) {
    return <div style={{ color: "var(--text-muted)", fontSize: "14px", padding: "40px 0" }}>Loading...</div>;
  }
  if (!cycle) {
    return <div style={{ color: "var(--text-muted)", fontSize: "14px", padding: "40px 0" }}>Billing cycle not found.</div>;
  }

  return (
    <div>
      <PageHeader
        title={cycle.name}
        subtitle={`Cycle Code: ${cycle.cycleCode}`}
      />

      <Tabs
        tabs={[{ key: "overview", label: "Overview" }]}
        activeTab={activeTab}
        onTabChange={setActiveTab}
      >
        {activeTab === "overview" && (
          <div
            style={{
              background: "var(--bg-card)",
              border: "1px solid var(--border)",
              borderRadius: "var(--radius)",
              padding: "20px 24px",
            }}
          >
            <div style={fieldStyle}>
              <span style={labelStyle}>Status</span>
              <StatusBadge status={cycle.active ? "ACTIVE" : "INACTIVE"} />
            </div>
            <div style={fieldStyle}>
              <span style={labelStyle}>Cycle Code</span>
              <span style={{ ...valueStyle, fontFamily: "monospace" }}>{cycle.cycleCode}</span>
            </div>
            <div style={fieldStyle}>
              <span style={labelStyle}>Read Day of Month</span>
              <span style={valueStyle}>{cycle.readDayOfMonth}</span>
            </div>
            <div style={fieldStyle}>
              <span style={labelStyle}>Bill Day of Month</span>
              <span style={valueStyle}>{cycle.billDayOfMonth}</span>
            </div>
            <div style={fieldStyle}>
              <span style={labelStyle}>Frequency</span>
              <span style={valueStyle}>{cycle.frequency}</span>
            </div>
            <div style={{ ...fieldStyle, borderBottom: "none" }}>
              <span style={labelStyle}>Cycle ID</span>
              <span style={{ ...valueStyle, fontFamily: "monospace", fontSize: "11px", color: "var(--text-muted)" }}>
                {cycle.id}
              </span>
            </div>
          </div>
        )}
      </Tabs>
    </div>
  );
}
