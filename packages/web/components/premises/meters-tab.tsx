"use client";

import { useState, useEffect } from "react";
import { DataTable } from "@/components/ui/data-table";
import { StatusBadge } from "@/components/ui/status-badge";
import { CommodityBadge } from "@/components/ui/commodity-badge";
import { apiClient } from "@/lib/api-client";
import { useToast } from "@/components/ui/toast";

interface Commodity {
  id: string;
  code: string;
  name: string;
}

interface Uom {
  id: string;
  code: string;
  name: string;
  commodityId: string;
}

interface Premise {
  id: string;
  commodityIds?: string[];
  meters?: Array<{
    id: string;
    meterNumber: string;
    meterType: string;
    status: string;
    commodity?: { name: string };
  }>;
}

interface MetersTabProps {
  premise: Premise;
  onMeterAdded: () => void;
  onRowClick: (id: string) => void;
}

const METER_TYPES = ["MANUAL", "AMR", "AMI", "SMART"];

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

export function MetersTab({ premise, onMeterAdded, onRowClick }: MetersTabProps) {
  const { toast } = useToast();
  const [showForm, setShowForm] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [commodities, setCommodities] = useState<Commodity[]>([]);
  const [uoms, setUoms] = useState<Uom[]>([]);

  const [form, setForm] = useState({
    meterNumber: "",
    commodityId: "",
    meterType: "MANUAL",
    uomId: "",
    multiplier: "1",
    installDate: new Date().toISOString().slice(0, 10),
    notes: "",
  });

  // Fetch commodities and UOMs when form opens
  useEffect(() => {
    if (!showForm) return;
    Promise.all([
      apiClient.get<Commodity[] | { data: Commodity[] }>("/api/v1/commodities"),
      apiClient.get<Uom[] | { data: Uom[] }>("/api/v1/uom"),
    ]).then(([cRes, uRes]) => {
      const cList = Array.isArray(cRes) ? cRes : cRes.data ?? [];
      const uList = Array.isArray(uRes) ? uRes : uRes.data ?? [];
      // Filter commodities to those available at this premise
      if (premise.commodityIds && premise.commodityIds.length > 0) {
        setCommodities(cList.filter((c) => premise.commodityIds!.includes(c.id)));
      } else {
        setCommodities(cList);
      }
      setUoms(uList);
    }).catch(console.error);
  }, [showForm, premise.commodityIds]);

  // Filter UOMs by selected commodity
  const filteredUoms = form.commodityId
    ? uoms.filter((u) => u.commodityId === form.commodityId)
    : [];

  // Auto-select first UOM when commodity changes
  useEffect(() => {
    if (filteredUoms.length > 0 && !filteredUoms.find((u) => u.id === form.uomId)) {
      setForm((f) => ({ ...f, uomId: filteredUoms[0].id }));
    }
  }, [form.commodityId, filteredUoms]);

  const handleSubmit = async () => {
    if (!form.meterNumber || !form.commodityId || !form.uomId) {
      toast("Please fill in all required fields", "error");
      return;
    }
    setSubmitting(true);
    try {
      await apiClient.post("/api/v1/meters", {
        premiseId: premise.id,
        meterNumber: form.meterNumber,
        commodityId: form.commodityId,
        meterType: form.meterType,
        uomId: form.uomId,
        multiplier: parseFloat(form.multiplier) || 1,
        installDate: form.installDate,
        notes: form.notes || undefined,
        status: "ACTIVE",
      });
      toast("Meter added successfully", "success");
      setShowForm(false);
      setForm({ meterNumber: "", commodityId: "", meterType: "MANUAL", uomId: "", multiplier: "1", installDate: new Date().toISOString().slice(0, 10), notes: "" });
      onMeterAdded();
    } catch (err: any) {
      toast(err.message || "Failed to add meter", "error");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div>
      {/* Header with Add button */}
      <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: "12px" }}>
        {!showForm && (
          <button
            onClick={() => setShowForm(true)}
            style={{ ...btnStyle, background: "var(--accent-primary)", color: "#fff" }}
          >
            + Add Meter
          </button>
        )}
      </div>

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
          <div style={{ fontSize: "14px", fontWeight: 600, color: "var(--text-primary)", marginBottom: "16px" }}>
            Install New Meter
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: "12px" }}>
            {/* Meter Number */}
            <div>
              <div style={{ fontSize: "11px", color: "var(--text-muted)", marginBottom: "4px", fontWeight: 500 }}>
                Meter Number *
              </div>
              <input
                style={inputStyle}
                value={form.meterNumber}
                onChange={(e) => setForm({ ...form, meterNumber: e.target.value })}
                placeholder="e.g. WM-007"
              />
            </div>

            {/* Commodity */}
            <div>
              <div style={{ fontSize: "11px", color: "var(--text-muted)", marginBottom: "4px", fontWeight: 500 }}>
                Commodity *
              </div>
              <select
                style={inputStyle}
                value={form.commodityId}
                onChange={(e) => setForm({ ...form, commodityId: e.target.value, uomId: "" })}
              >
                <option value="">Select commodity...</option>
                {commodities.map((c) => (
                  <option key={c.id} value={c.id}>{c.name} ({c.code})</option>
                ))}
              </select>
            </div>

            {/* Meter Type */}
            <div>
              <div style={{ fontSize: "11px", color: "var(--text-muted)", marginBottom: "4px", fontWeight: 500 }}>
                Meter Type *
              </div>
              <select
                style={inputStyle}
                value={form.meterType}
                onChange={(e) => setForm({ ...form, meterType: e.target.value })}
              >
                {METER_TYPES.map((t) => (
                  <option key={t} value={t}>{t}</option>
                ))}
              </select>
            </div>

            {/* Unit of Measure */}
            <div>
              <div style={{ fontSize: "11px", color: "var(--text-muted)", marginBottom: "4px", fontWeight: 500 }}>
                Unit of Measure *
              </div>
              <select
                style={inputStyle}
                value={form.uomId}
                onChange={(e) => setForm({ ...form, uomId: e.target.value })}
                disabled={!form.commodityId}
              >
                <option value="">{form.commodityId ? "Select UOM..." : "Select commodity first"}</option>
                {filteredUoms.map((u) => (
                  <option key={u.id} value={u.id}>{u.name} ({u.code})</option>
                ))}
              </select>
            </div>

            {/* Install Date */}
            <div>
              <div style={{ fontSize: "11px", color: "var(--text-muted)", marginBottom: "4px", fontWeight: 500 }}>
                Install Date *
              </div>
              <input
                style={inputStyle}
                type="date"
                value={form.installDate}
                onChange={(e) => setForm({ ...form, installDate: e.target.value })}
              />
            </div>
          </div>

          {/* Notes */}
          <div style={{ marginTop: "12px" }}>
            <div style={{ fontSize: "11px", color: "var(--text-muted)", marginBottom: "4px", fontWeight: 500 }}>
              Notes
            </div>
            <input
              style={inputStyle}
              value={form.notes}
              onChange={(e) => setForm({ ...form, notes: e.target.value })}
              placeholder="Optional notes..."
            />
          </div>

          {/* Advanced */}
          <div style={{ marginTop: "12px" }}>
            <button
              type="button"
              onClick={() => setShowAdvanced((v) => !v)}
              style={{
                background: "none",
                border: "none",
                color: "var(--text-muted)",
                fontSize: "12px",
                cursor: "pointer",
                fontFamily: "inherit",
                padding: 0,
                display: "flex",
                alignItems: "center",
                gap: "4px",
              }}
            >
              <span style={{ fontSize: "10px" }}>{showAdvanced ? "▼" : "▶"}</span>
              Advanced
            </button>

            {showAdvanced && (
              <div style={{ marginTop: "10px", display: "flex", alignItems: "flex-end", gap: "12px" }}>
                <div style={{ width: "200px" }}>
                  <div style={{ fontSize: "11px", color: "var(--text-muted)", marginBottom: "4px", fontWeight: 500, display: "flex", alignItems: "center", gap: "6px" }}>
                    Multiplier
                    <span
                      title="Conversion factor applied to raw meter readings. For example, a CT electric meter with a 200:5 ratio uses multiplier 40. Most residential meters use 1.0 (no conversion)."
                      style={{
                        display: "inline-flex",
                        alignItems: "center",
                        justifyContent: "center",
                        width: "14px",
                        height: "14px",
                        borderRadius: "50%",
                        background: "var(--bg-elevated)",
                        border: "1px solid var(--border)",
                        fontSize: "9px",
                        fontWeight: 700,
                        color: "var(--text-muted)",
                        cursor: "help",
                      }}
                    >
                      ?
                    </span>
                  </div>
                  <input
                    style={inputStyle}
                    type="number"
                    step="0.0001"
                    value={form.multiplier}
                    onChange={(e) => setForm({ ...form, multiplier: e.target.value })}
                  />
                </div>
                <div style={{ fontSize: "11px", color: "var(--text-muted)", paddingBottom: "8px" }}>
                  Default is 1.0 — only change for CT meters, pressure correction, or unit conversion.
                </div>
              </div>
            )}
          </div>

          {/* Actions */}
          <div style={{ display: "flex", justifyContent: "flex-end", gap: "8px", marginTop: "16px" }}>
            <button
              onClick={() => setShowForm(false)}
              style={{ ...btnStyle, background: "transparent", color: "var(--text-secondary)", border: "1px solid var(--border)" }}
            >
              Cancel
            </button>
            <button
              onClick={handleSubmit}
              disabled={submitting}
              style={{ ...btnStyle, background: "var(--accent-primary)", color: "#fff", opacity: submitting ? 0.7 : 1 }}
            >
              {submitting ? "Adding..." : "Add Meter"}
            </button>
          </div>
        </div>
      )}

      {/* Meters Table */}
      <DataTable
        columns={[
          { key: "meterNumber", header: "Meter Number" },
          {
            key: "commodity",
            header: "Commodity",
            render: (row: any) => <CommodityBadge commodity={row.commodity?.name ?? ""} />,
          },
          { key: "meterType", header: "Type" },
          {
            key: "status",
            header: "Status",
            render: (row: any) => <StatusBadge status={row.status} />,
          },
        ]}
        data={(premise.meters ?? []) as any}
        onRowClick={(row: any) => onRowClick(row.id)}
      />
    </div>
  );
}
