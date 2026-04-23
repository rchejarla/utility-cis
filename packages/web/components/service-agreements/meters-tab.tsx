"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { DataTable } from "@/components/ui/data-table";
import { StatusBadge } from "@/components/ui/status-badge";
import { CommodityBadge } from "@/components/ui/commodity-badge";
import { apiClient } from "@/lib/api-client";
import { useToast } from "@/components/ui/toast";

interface Meter {
  id: string;
  meterNumber: string;
  meterType: string;
  status: string;
  commodity?: { id: string; name: string };
  uom?: { code: string };
}

interface ServiceAgreementMeter {
  id: string;
  meterId: string;
  isPrimary: boolean;
  addedDate: string;
  removedDate?: string | null;
  meter: {
    id: string;
    meterNumber: string;
    meterType: string;
    status: string;
    commodity?: { name: string };
    uom?: { code: string };
  };
}

interface MeterManagementTabProps {
  agreementId: string;
  premiseId: string;
  commodityId: string;
  meters: ServiceAgreementMeter[];
  onMetersChanged: () => void;
  showForm?: boolean;
  onShowFormChange?: (show: boolean) => void;
}

const inputStyle = {
  padding: "6px 10px",
  fontSize: "13px",
  background: "var(--bg-deep)",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius, 10px)",
  color: "var(--text-primary)",
  fontFamily: "inherit",
  outline: "none",
  width: "100%",
};

const btnStyle = {
  padding: "6px 14px",
  fontSize: "12px",
  fontWeight: 500 as const,
  border: "none",
  borderRadius: "var(--radius, 10px)",
  cursor: "pointer",
  fontFamily: "inherit",
};

export function MeterManagementTab({
  agreementId,
  premiseId,
  commodityId,
  meters,
  onMetersChanged,
  showForm: showFormProp,
  onShowFormChange,
}: MeterManagementTabProps) {
  const router = useRouter();
  const { toast } = useToast();

  const [showFormLocal, setShowFormLocal] = useState(false);
  const showForm = showFormProp ?? showFormLocal;
  const setShowForm = (v: boolean) => {
    setShowFormLocal(v);
    onShowFormChange?.(v);
  };

  const [availableMeters, setAvailableMeters] = useState<Meter[]>([]);
  const [selectedMeterId, setSelectedMeterId] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [removingId, setRemovingId] = useState<string | null>(null);

  // Fetch available meters at the same premise + commodity when form opens
  useEffect(() => {
    if (!showForm) return;

    apiClient
      .get<{ data: Meter[] }>("/api/v1/meters", {
        premiseId,
        commodityId,
        status: "ACTIVE",
        limit: "200",
      })
      .then((res) => {
        const all = res.data ?? [];
        // Filter out meters already on this agreement (active assignments)
        const assignedMeterIds = new Set(meters.map((sam) => sam.meterId));
        setAvailableMeters(all.filter((m) => !assignedMeterIds.has(m.id)));
        setSelectedMeterId("");
      })
      .catch(console.error);
  }, [showForm, premiseId, commodityId, meters]);

  const handleAdd = async () => {
    if (!selectedMeterId) {
      toast("Please select a meter to add", "error");
      return;
    }
    setSubmitting(true);
    try {
      await apiClient.post(`/api/v1/service-agreements/${agreementId}/meters`, {
        meterId: selectedMeterId,
      });
      toast("Meter added to agreement", "success");
      setShowForm(false);
      setSelectedMeterId("");
      onMetersChanged();
    } catch (err: any) {
      toast(err.message || "Failed to add meter", "error");
    } finally {
      setSubmitting(false);
    }
  };

  const handleRemove = async (sam: ServiceAgreementMeter) => {
    if (!confirm(`Remove meter ${sam.meter.meterNumber} from this agreement?`)) return;
    setRemovingId(sam.id);
    try {
      await apiClient.patch(`/api/v1/service-agreements/${agreementId}/meters/${sam.id}`, {});
      toast("Meter removed from agreement", "success");
      onMetersChanged();
    } catch (err: any) {
      toast(err.message || "Failed to remove meter", "error");
    } finally {
      setRemovingId(null);
    }
  };

  return (
    <div>
      {/* Inline Add Meter Form */}
      {showForm && (
        <div
          style={{
            background: "var(--bg-card)",
            border: "1px solid var(--accent-primary)",
            borderRadius: "var(--radius, 10px)",
            padding: "20px",
            marginBottom: "16px",
          }}
        >
          <div
            style={{
              fontSize: "14px",
              fontWeight: 600,
              color: "var(--text-primary)",
              marginBottom: "4px",
            }}
          >
            Add Meter to Agreement
          </div>
          <div
            style={{
              fontSize: "11px",
              color: "var(--text-muted)",
              marginBottom: "16px",
            }}
          >
            BR-SA-004: A meter can only be in one active agreement per commodity
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "1fr auto", gap: "12px", alignItems: "flex-end" }}>
            <div>
              <div
                style={{
                  fontSize: "11px",
                  color: "var(--text-muted)",
                  marginBottom: "4px",
                  fontWeight: 500,
                }}
              >
                Select Meter *
              </div>
              {availableMeters.length === 0 ? (
                <div
                  style={{
                    fontSize: "12px",
                    color: "var(--text-muted)",
                    fontStyle: "italic",
                    padding: "8px 0",
                  }}
                >
                  No available meters at this premise for this commodity.
                </div>
              ) : (
                <select
                  style={inputStyle}
                  value={selectedMeterId}
                  onChange={(e) => setSelectedMeterId(e.target.value)}
                >
                  <option value="">Select a meter...</option>
                  {availableMeters.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.meterNumber} — {m.meterType}
                      {m.uom ? ` (${m.uom.code})` : ""}
                    </option>
                  ))}
                </select>
              )}
            </div>

            <div style={{ display: "flex", gap: "8px", paddingBottom: availableMeters.length === 0 ? "0" : "0" }}>
              <button
                onClick={() => setShowForm(false)}
                style={{
                  ...btnStyle,
                  background: "transparent",
                  color: "var(--text-secondary)",
                  border: "1px solid var(--border)",
                }}
              >
                Cancel
              </button>
              {availableMeters.length > 0 && (
                <button
                  onClick={handleAdd}
                  disabled={submitting || !selectedMeterId}
                  style={{
                    ...btnStyle,
                    background: "var(--accent-primary)",
                    color: "#fff",
                    opacity: submitting || !selectedMeterId ? 0.6 : 1,
                    cursor: submitting || !selectedMeterId ? "not-allowed" : "pointer",
                  }}
                >
                  {submitting ? "Adding..." : "Add Meter"}
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Meters Table */}
      <DataTable
        columns={[
          {
            key: "meterNumber",
            header: "Meter Number",
            render: (row: any) => (
              <span style={{ fontFamily: "monospace", fontSize: "12px", fontWeight: 600 }}>
                {row.meter?.meterNumber}
              </span>
            ),
          },
          {
            key: "meterType",
            header: "Type",
            render: (row: any) => row.meter?.meterType ?? "—",
          },
          {
            key: "commodity",
            header: "Commodity",
            render: (row: any) => <CommodityBadge commodity={row.meter?.commodity?.name ?? ""} />,
          },
          {
            key: "isPrimary",
            header: "Primary",
            render: (row: any) =>
              row.isPrimary ? (
                <span style={{ color: "#22c55e", fontSize: "12px", fontWeight: 600 }}>Primary</span>
              ) : (
                <span style={{ color: "var(--text-muted)", fontSize: "12px" }}>—</span>
              ),
          },
          {
            key: "addedDate",
            header: "Added Date",
            render: (row: any) => row.addedDate?.slice(0, 10) ?? "—",
          },
          {
            key: "status",
            header: "Meter Status",
            render: (row: any) => <StatusBadge status={row.meter?.status ?? ""} />,
          },
          {
            key: "actions",
            header: "Actions",
            render: (row: any) =>
              !row.removedDate ? (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    handleRemove(row);
                  }}
                  disabled={removingId === row.id}
                  style={{
                    padding: "3px 10px",
                    fontSize: "11px",
                    fontWeight: 500,
                    background: "transparent",
                    border: "1px solid var(--danger)",
                    borderRadius: "var(--radius, 10px)",
                    color: "var(--danger)",
                    cursor: removingId === row.id ? "not-allowed" : "pointer",
                    fontFamily: "inherit",
                    opacity: removingId === row.id ? 0.6 : 1,
                  }}
                >
                  {removingId === row.id ? "Removing..." : "Remove"}
                </button>
              ) : (
                <span style={{ fontSize: "11px", color: "var(--text-muted)" }}>
                  Removed {row.removedDate?.slice(0, 10)}
                </span>
              ),
          },
        ]}
        data={(meters ?? []) as any}
        onRowClick={(row: any) => router.push(`/meters/${row.meter?.id}`)}
      />
    </div>
  );
}
