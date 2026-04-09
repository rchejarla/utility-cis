"use client";

import { useState, useEffect } from "react";
import { DataTable } from "@/components/ui/data-table";
import { StatusBadge } from "@/components/ui/status-badge";
import { CommodityBadge } from "@/components/ui/commodity-badge";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { DatePicker } from "@/components/ui/date-picker";
import { apiClient } from "@/lib/api-client";
import { useToast } from "@/components/ui/toast";

interface Commodity {
  id: string;
  code: string;
  name: string;
}

interface Account {
  id: string;
  accountNumber: string;
  customer?: {
    firstName?: string;
    lastName?: string;
    organizationName?: string;
    customerType?: string;
  };
}

interface RateSchedule {
  id: string;
  name: string;
  code: string;
  commodityId: string;
}

interface BillingCycle {
  id: string;
  name: string;
  cycleCode: string;
}

interface PremiseMeter {
  id: string;
  meterNumber: string;
  meterType: string;
  status: string;
  commodityId?: string;
  commodity?: { id: string; name: string };
}

interface ServiceAgreement {
  id: string;
  agreementNumber: string;
  status: string;
  startDate: string;
  account?: { accountNumber: string };
  commodity?: { id: string; name: string };
}

interface Premise {
  id: string;
  commodityIds?: string[];
  meters?: PremiseMeter[];
  serviceAgreements?: ServiceAgreement[];
}

interface AgreementsTabProps {
  premise: Premise;
  onAgreementAdded: () => void;
  onRowClick: (id: string) => void;
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

const hintStyle = {
  fontSize: "11px",
  color: "var(--text-muted)",
  marginTop: "4px",
};

export function AgreementsTab({
  premise,
  onAgreementAdded,
  onRowClick,
  showForm: showFormProp,
  onShowFormChange,
}: AgreementsTabProps) {
  const { toast } = useToast();
  const [showFormLocal, setShowFormLocal] = useState(false);
  const showForm = showFormProp ?? showFormLocal;
  const setShowForm = (v: boolean) => {
    setShowFormLocal(v);
    onShowFormChange?.(v);
  };

  const [submitting, setSubmitting] = useState(false);
  const [commodities, setCommodities] = useState<Commodity[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [rateSchedules, setRateSchedules] = useState<RateSchedule[]>([]);
  const [billingCycles, setBillingCycles] = useState<BillingCycle[]>([]);

  const [form, setForm] = useState({
    agreementNumber: "",
    commodityId: "",
    accountId: "",
    rateScheduleId: "",
    billingCycleId: "",
    startDate: new Date().toISOString().slice(0, 10),
    selectedMeterIds: [] as string[],
  });

  // Fetch commodities, accounts, and billing cycles when form opens
  useEffect(() => {
    if (!showForm) return;

    Promise.all([
      apiClient.get<Commodity[] | { data: Commodity[] }>("/api/v1/commodities"),
      apiClient.get<{ data: Account[] }>("/api/v1/accounts", { limit: "500" }),
      apiClient.get<BillingCycle[] | { data: BillingCycle[] }>("/api/v1/billing-cycles"),
    ])
      .then(([cRes, aRes, bcRes]) => {
        const cList = Array.isArray(cRes) ? cRes : (cRes as any).data ?? [];
        const aList = aRes.data ?? [];
        const bcList = Array.isArray(bcRes) ? bcRes : (bcRes as any).data ?? [];

        // Filter commodities to those available at this premise
        if (premise.commodityIds && premise.commodityIds.length > 0) {
          setCommodities(cList.filter((c: Commodity) => premise.commodityIds!.includes(c.id)));
        } else {
          setCommodities(cList);
        }
        setAccounts(aList);
        setBillingCycles(bcList);
      })
      .catch(console.error);
  }, [showForm, premise.commodityIds]);

  // Fetch rate schedules when commodity changes
  useEffect(() => {
    if (!form.commodityId) {
      setRateSchedules([]);
      return;
    }
    apiClient
      .get<RateSchedule[] | { data: RateSchedule[] }>("/api/v1/rate-schedules", {
        commodityId: form.commodityId,
        active: "true",
      })
      .then((res) => {
        const list = Array.isArray(res) ? res : (res as any).data ?? [];
        setRateSchedules(list);
      })
      .catch(console.error);
  }, [form.commodityId]);

  // When commodity changes, clear meter selection and rate schedule
  const handleCommodityChange = (commodityId: string) => {
    setForm((f) => ({
      ...f,
      commodityId,
      rateScheduleId: "",
      selectedMeterIds: [],
    }));
  };

  // Meters at this premise matching selected commodity
  const availableMeters = form.commodityId
    ? (premise.meters ?? []).filter(
        (m) =>
          (m.commodityId === form.commodityId ||
            m.commodity?.id === form.commodityId) &&
          m.status === "ACTIVE"
      )
    : [];

  const toggleMeter = (meterId: string) => {
    setForm((f) => {
      const current = f.selectedMeterIds;
      if (current.includes(meterId)) {
        return { ...f, selectedMeterIds: current.filter((id) => id !== meterId) };
      } else {
        return { ...f, selectedMeterIds: [...current, meterId] };
      }
    });
  };

  const handleSubmit = async () => {
    if (!form.agreementNumber) {
      toast("Agreement Number is required", "error");
      return;
    }
    if (!form.commodityId) {
      toast("Commodity is required", "error");
      return;
    }
    if (!form.accountId) {
      toast("Account is required", "error");
      return;
    }
    if (!form.rateScheduleId) {
      toast("Rate Schedule is required", "error");
      return;
    }
    if (!form.billingCycleId) {
      toast("Billing Cycle is required", "error");
      return;
    }
    if (!form.startDate) {
      toast("Start Date is required", "error");
      return;
    }
    if (form.selectedMeterIds.length === 0) {
      toast("At least one meter must be selected (BR-SA-005)", "error");
      return;
    }

    // Build meters payload — first selected is primary (BR-SA-005)
    const meters = form.selectedMeterIds.map((meterId, idx) => ({
      meterId,
      isPrimary: idx === 0,
    }));

    setSubmitting(true);
    try {
      await apiClient.post("/api/v1/service-agreements", {
        agreementNumber: form.agreementNumber,
        accountId: form.accountId,
        premiseId: premise.id,
        commodityId: form.commodityId,
        rateScheduleId: form.rateScheduleId,
        billingCycleId: form.billingCycleId,
        startDate: form.startDate,
        meters,
      });
      toast("Agreement added successfully", "success");
      setShowForm(false);
      setForm({
        agreementNumber: "",
        commodityId: "",
        accountId: "",
        rateScheduleId: "",
        billingCycleId: "",
        startDate: new Date().toISOString().slice(0, 10),
        selectedMeterIds: [],
      });
      onAgreementAdded();
    } catch (err: any) {
      toast(err.message || "Failed to add agreement", "error");
    } finally {
      setSubmitting(false);
    }
  };

  // Build account options for SearchableSelect
  const accountOptions = accounts.map((a) => {
    const customerName = a.customer
      ? a.customer.customerType === "ORGANIZATION"
        ? a.customer.organizationName ?? ""
        : `${a.customer.firstName ?? ""} ${a.customer.lastName ?? ""}`.trim()
      : "";
    return {
      value: a.id,
      label: customerName ? `${a.accountNumber} — ${customerName}` : a.accountNumber,
    };
  });

  return (
    <div>
      {/* Inline Add Agreement Form */}
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
              marginBottom: "16px",
            }}
          >
            New Service Agreement
          </div>

          {/* Row 1: Agreement Number, Commodity, Account */}
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "1fr 1fr 1fr",
              gap: "12px",
              marginBottom: "12px",
            }}
          >
            {/* Agreement Number */}
            <div>
              <div
                style={{
                  fontSize: "11px",
                  color: "var(--text-muted)",
                  marginBottom: "4px",
                  fontWeight: 500,
                }}
              >
                Agreement Number *
              </div>
              <input
                style={inputStyle}
                value={form.agreementNumber}
                onChange={(e) =>
                  setForm((f) => ({ ...f, agreementNumber: e.target.value }))
                }
                placeholder="e.g. SA-0011"
              />
            </div>

            {/* Commodity */}
            <div>
              <div
                style={{
                  fontSize: "11px",
                  color: "var(--text-muted)",
                  marginBottom: "4px",
                  fontWeight: 500,
                }}
              >
                Commodity *
              </div>
              <select
                style={inputStyle}
                value={form.commodityId}
                onChange={(e) => handleCommodityChange(e.target.value)}
              >
                <option value="">Select commodity...</option>
                {commodities.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name} ({c.code})
                  </option>
                ))}
              </select>
              <div style={hintStyle}>
                All meters must match this commodity (BR-SA-003)
              </div>
            </div>

            {/* Account */}
            <div>
              <div
                style={{
                  fontSize: "11px",
                  color: "var(--text-muted)",
                  marginBottom: "4px",
                  fontWeight: 500,
                }}
              >
                Account *
              </div>
              <SearchableSelect
                options={accountOptions}
                value={form.accountId || undefined}
                onChange={(v) =>
                  setForm((f) => ({ ...f, accountId: v ?? "" }))
                }
                placeholder="Search accounts..."
              />
              <div style={hintStyle}>
                Account can exist without agreements (BR-AC-003)
              </div>
            </div>
          </div>

          {/* Row 2: Rate Schedule, Billing Cycle, Start Date */}
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "1fr 1fr 1fr",
              gap: "12px",
              marginBottom: "12px",
            }}
          >
            {/* Rate Schedule */}
            <div>
              <div
                style={{
                  fontSize: "11px",
                  color: "var(--text-muted)",
                  marginBottom: "4px",
                  fontWeight: 500,
                }}
              >
                Rate Schedule *
              </div>
              <select
                style={inputStyle}
                value={form.rateScheduleId}
                onChange={(e) =>
                  setForm((f) => ({ ...f, rateScheduleId: e.target.value }))
                }
                disabled={!form.commodityId}
              >
                <option value="">
                  {form.commodityId
                    ? "Select rate schedule..."
                    : "Select commodity first"}
                </option>
                {rateSchedules.map((rs) => (
                  <option key={rs.id} value={rs.id}>
                    {rs.name} ({rs.code})
                  </option>
                ))}
              </select>
            </div>

            {/* Billing Cycle */}
            <div>
              <div
                style={{
                  fontSize: "11px",
                  color: "var(--text-muted)",
                  marginBottom: "4px",
                  fontWeight: 500,
                }}
              >
                Billing Cycle *
              </div>
              <select
                style={inputStyle}
                value={form.billingCycleId}
                onChange={(e) =>
                  setForm((f) => ({ ...f, billingCycleId: e.target.value }))
                }
              >
                <option value="">Select billing cycle...</option>
                {billingCycles.map((bc) => (
                  <option key={bc.id} value={bc.id}>
                    {bc.name} ({bc.cycleCode})
                  </option>
                ))}
              </select>
            </div>

            {/* Start Date */}
            <div>
              <div
                style={{
                  fontSize: "11px",
                  color: "var(--text-muted)",
                  marginBottom: "4px",
                  fontWeight: 500,
                }}
              >
                Start Date *
              </div>
              <DatePicker
                value={form.startDate}
                onChange={(v) => setForm((f) => ({ ...f, startDate: v }))}
                placeholder="Select start date..."
              />
            </div>
          </div>

          {/* Row 3: Meters */}
          <div style={{ marginBottom: "4px" }}>
            <div
              style={{
                fontSize: "11px",
                color: "var(--text-muted)",
                marginBottom: "8px",
                fontWeight: 500,
              }}
            >
              Meters *
            </div>

            {!form.commodityId ? (
              <div
                style={{
                  fontSize: "12px",
                  color: "var(--text-muted)",
                  fontStyle: "italic",
                  padding: "8px 0",
                }}
              >
                Select a commodity to see available meters.
              </div>
            ) : availableMeters.length === 0 ? (
              <div
                style={{
                  fontSize: "12px",
                  color: "var(--text-muted)",
                  fontStyle: "italic",
                  padding: "8px 0",
                }}
              >
                No active meters at this premise for the selected commodity.
              </div>
            ) : (
              <div
                style={{
                  display: "flex",
                  flexWrap: "wrap",
                  gap: "8px",
                }}
              >
                {availableMeters.map((meter, idx) => {
                  const isSelected = form.selectedMeterIds.includes(meter.id);
                  const selectedIdx = form.selectedMeterIds.indexOf(meter.id);
                  const isPrimary = selectedIdx === 0;

                  return (
                    <label
                      key={meter.id}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: "8px",
                        padding: "6px 12px",
                        background: isSelected
                          ? "var(--bg-elevated)"
                          : "var(--bg-deep)",
                        border: isSelected
                          ? "1px solid var(--accent-primary)"
                          : "1px solid var(--border)",
                        borderRadius: "var(--radius, 10px)",
                        cursor: "pointer",
                        fontSize: "13px",
                        color: "var(--text-primary)",
                        userSelect: "none",
                      }}
                    >
                      <input
                        type="checkbox"
                        checked={isSelected}
                        onChange={() => toggleMeter(meter.id)}
                        style={{ accentColor: "var(--accent-primary)" }}
                      />
                      <span>
                        {meter.meterNumber}
                        <span
                          style={{
                            color: "var(--text-muted)",
                            fontSize: "11px",
                            marginLeft: "6px",
                          }}
                        >
                          {meter.meterType}
                        </span>
                      </span>
                      {isSelected && isPrimary && (
                        <span
                          style={{
                            fontSize: "10px",
                            fontWeight: 600,
                            color: "var(--accent-primary)",
                            background: "rgba(var(--accent-primary-rgb, 99,102,241), 0.12)",
                            padding: "1px 6px",
                            borderRadius: "4px",
                          }}
                        >
                          Primary
                        </span>
                      )}
                    </label>
                  );
                })}
              </div>
            )}

            <div style={hintStyle}>
              At least one meter required. First selected is primary (BR-SA-005)
            </div>
          </div>

          {/* Actions */}
          <div
            style={{
              display: "flex",
              justifyContent: "flex-end",
              gap: "8px",
              marginTop: "20px",
            }}
          >
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
            <button
              onClick={handleSubmit}
              disabled={submitting}
              style={{
                ...btnStyle,
                background: "var(--accent-primary)",
                color: "#fff",
                opacity: submitting ? 0.7 : 1,
              }}
            >
              {submitting ? "Adding..." : "Add Agreement"}
            </button>
          </div>
        </div>
      )}

      {/* Agreements Table */}
      <DataTable
        columns={[
          { key: "agreementNumber", header: "Agreement Number" },
          {
            key: "account",
            header: "Account",
            render: (row: any) => row.account?.accountNumber ?? "—",
          },
          {
            key: "commodity",
            header: "Commodity",
            render: (row: any) =>
              row.commodity ? (
                <CommodityBadge commodity={row.commodity?.name ?? ""} />
              ) : (
                "—"
              ),
          },
          {
            key: "status",
            header: "Status",
            render: (row: any) => <StatusBadge status={row.status} />,
          },
          {
            key: "startDate",
            header: "Start Date",
            render: (row: any) => row.startDate?.slice(0, 10) ?? "—",
          },
        ]}
        data={(premise.serviceAgreements ?? []) as any}
        onRowClick={(row: any) => onRowClick(row.id)}
      />
    </div>
  );
}
