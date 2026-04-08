"use client";

import { useState, useEffect, use } from "react";
import { useRouter } from "next/navigation";
import { PageHeader } from "@/components/ui/page-header";
import { Tabs } from "@/components/ui/tabs";
import { StatusBadge } from "@/components/ui/status-badge";
import { CommodityBadge } from "@/components/ui/commodity-badge";
import { DataTable } from "@/components/ui/data-table";
import { apiClient } from "@/lib/api-client";

interface Meter {
  id: string;
  meterNumber: string;
  meterType: string;
  status: string;
  multiplier?: number;
  installDate?: string;
  notes?: string;
  premise?: { id: string; addressLine1: string; city: string; state: string };
  commodity?: { name: string };
  uom?: { name: string; code: string };
  serviceAgreementMeters?: Array<{
    id: string;
    isPrimary: boolean;
    serviceAgreement: {
      id: string;
      agreementNumber: string;
      status: string;
      startDate: string;
    };
  }>;
}

const fieldStyle = {
  display: "grid" as const,
  gridTemplateColumns: "160px 1fr",
  gap: "8px",
  padding: "10px 0",
  borderBottom: "1px solid var(--border-subtle)",
  alignItems: "start" as const,
};
const labelStyle = { fontSize: "12px", color: "var(--text-muted)", fontWeight: "500" as const };
const valueStyle = { fontSize: "13px", color: "var(--text-primary)" };

export default function MeterDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();
  const [meter, setMeter] = useState<Meter | null>(null);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState("overview");

  useEffect(() => {
    apiClient
      .get<Meter>(`/api/v1/meters/${id}`)
      .then((data) => setMeter(data))
      .catch(console.error)
      .finally(() => setLoading(false));
  }, [id]);

  if (loading) {
    return <div style={{ color: "var(--text-muted)", fontSize: "14px", padding: "40px 0" }}>Loading...</div>;
  }
  if (!meter) {
    return <div style={{ color: "var(--text-muted)", fontSize: "14px", padding: "40px 0" }}>Meter not found.</div>;
  }

  return (
    <div>
      <PageHeader
        title={meter.meterNumber}
        subtitle={meter.premise ? `${meter.premise.addressLine1}, ${meter.premise.city}` : "No premise"}
      />

      <Tabs
        tabs={[
          { key: "overview", label: "Overview" },
          { key: "agreements", label: `Agreements (${meter.serviceAgreementMeters?.length ?? 0})` },
        ]}
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
              <StatusBadge status={meter.status} />
            </div>
            <div style={fieldStyle}>
              <span style={labelStyle}>Meter Number</span>
              <span style={{ ...valueStyle, fontFamily: "monospace" }}>{meter.meterNumber}</span>
            </div>
            <div style={fieldStyle}>
              <span style={labelStyle}>Meter Type</span>
              <span style={valueStyle}>{meter.meterType}</span>
            </div>
            <div style={fieldStyle}>
              <span style={labelStyle}>Commodity</span>
              <CommodityBadge commodity={meter.commodity?.name ?? ""} />
            </div>
            <div style={fieldStyle}>
              <span style={labelStyle}>Unit of Measure</span>
              <span style={valueStyle}>
                {meter.uom ? `${meter.uom.name} (${meter.uom.code})` : "—"}
              </span>
            </div>
            <div style={fieldStyle}>
              <span style={labelStyle}>Multiplier</span>
              <span style={valueStyle}>{meter.multiplier ?? 1}</span>
            </div>
            {meter.installDate && (
              <div style={fieldStyle}>
                <span style={labelStyle}>Install Date</span>
                <span style={valueStyle}>{meter.installDate.slice(0, 10)}</span>
              </div>
            )}
            {meter.premise && (
              <div style={fieldStyle}>
                <span style={labelStyle}>Premise</span>
                <button
                  onClick={() => router.push(`/premises/${meter.premise!.id}`)}
                  style={{
                    background: "none",
                    border: "none",
                    color: "var(--accent-primary)",
                    fontSize: "13px",
                    cursor: "pointer",
                    padding: 0,
                    textDecoration: "underline",
                    fontFamily: "inherit",
                  }}
                >
                  {meter.premise.addressLine1}, {meter.premise.city}
                </button>
              </div>
            )}
            {meter.notes && (
              <div style={fieldStyle}>
                <span style={labelStyle}>Notes</span>
                <span style={valueStyle}>{meter.notes}</span>
              </div>
            )}
            <div style={{ ...fieldStyle, borderBottom: "none" }}>
              <span style={labelStyle}>Meter ID</span>
              <span style={{ ...valueStyle, fontFamily: "monospace", fontSize: "11px", color: "var(--text-muted)" }}>
                {meter.id}
              </span>
            </div>
          </div>
        )}

        {activeTab === "agreements" && (
          <DataTable
            columns={[
              { key: "agreementNumber", header: "Agreement Number", render: (row: any) => row.serviceAgreement.agreementNumber },
              { key: "isPrimary", header: "Primary", render: (row: any) => row.isPrimary ? "Yes" : "No" },
              { key: "startDate", header: "Start Date", render: (row: any) => row.serviceAgreement.startDate?.slice(0, 10) ?? "—" },
              { key: "status", header: "Status", render: (row: any) => <StatusBadge status={row.serviceAgreement.status} /> },
            ]}
            data={(meter.serviceAgreementMeters ?? []) as any}
            onRowClick={(row: any) => router.push(`/service-agreements/${row.serviceAgreement.id}`)}
          />
        )}
      </Tabs>
    </div>
  );
}
