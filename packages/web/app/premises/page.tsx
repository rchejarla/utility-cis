"use client";

import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import { PageHeader } from "@/components/ui/page-header";
import { StatCard } from "@/components/ui/stat-card";
import { FilterBar } from "@/components/ui/filter-bar";
import { DataTable } from "@/components/ui/data-table";
import { StatusBadge } from "@/components/ui/status-badge";
import { CommodityBadge } from "@/components/ui/commodity-badge";
import { apiClient } from "@/lib/api-client";
import { MapView } from "@/components/premises/map-view";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { usePermission } from "@/lib/use-permission";
import { AccessDenied } from "@/components/ui/access-denied";

interface Customer {
  id: string;
  customerType: string;
  firstName?: string;
  lastName?: string;
  organizationName?: string;
}

interface Premise {
  id: string;
  addressLine1: string;
  addressLine2?: string;
  city: string;
  state: string;
  zip: string;
  premiseType: string;
  status: string;
  owner?: Customer;
  commodities?: Array<{ commodity: { name: string } }>;
  meters?: Array<unknown>;
}

interface PremisesResponse {
  data: Premise[];
  meta: { total: number; page: number; limit: number; pages: number };
}

const PREMISE_TYPE_OPTIONS = [
  { label: "Residential", value: "RESIDENTIAL" },
  { label: "Commercial", value: "COMMERCIAL" },
  { label: "Industrial", value: "INDUSTRIAL" },
  { label: "Agricultural", value: "AGRICULTURAL" },
];

const STATUS_OPTIONS = [
  { label: "Active", value: "ACTIVE" },
  { label: "Inactive", value: "INACTIVE" },
  { label: "Condemned", value: "CONDEMNED" },
];

export default function PremisesPage() {
  const router = useRouter();
  const { canView, canCreate } = usePermission("premises");
  if (!canView) return <AccessDenied />;

  const [data, setData] = useState<Premise[]>([]);
  const [meta, setMeta] = useState({ total: 0, page: 1, limit: 20, pages: 0 });
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState<"table" | "map">("table");
  const [premiseType, setPremiseType] = useState<string | undefined>(undefined);
  const [status, setStatus] = useState<string | undefined>(undefined);
  const [ownerId, setOwnerId] = useState<string | undefined>(undefined);
  const [search, setSearch] = useState("");
  const [searchDebounced, setSearchDebounced] = useState("");
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [page, setPage] = useState(1);
  const [stats, setStats] = useState({ total: 0, active: 0, inactive: 0, condemned: 0 });

  // Debounce search
  useEffect(() => {
    const t = setTimeout(() => setSearchDebounced(search), 300);
    return () => clearTimeout(t);
  }, [search]);

  // Fetch customers for filter dropdown
  useEffect(() => {
    apiClient
      .get<Customer[] | { data: Customer[] }>("/api/v1/customers", { limit: "500" })
      .then((res) => setCustomers(Array.isArray(res) ? res : res.data ?? []))
      .catch(console.error);
  }, []);

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const params: Record<string, string> = { page: String(page), limit: "20" };
      if (premiseType) params.premiseType = premiseType;
      if (status) params.status = status;
      if (ownerId) params.ownerId = ownerId;
      if (searchDebounced) params.search = searchDebounced;

      const res = await apiClient.get<PremisesResponse & { stats?: { active: number; inactive: number; condemned: number } }>("/api/v1/premises", params);
      setData(res.data);
      setMeta(res.meta);
      if (res.stats) {
        setStats({ total: res.meta.total, active: res.stats.active, inactive: res.stats.inactive, condemned: res.stats.condemned });
      }
    } catch (err) {
      console.error("Failed to fetch premises", err);
    } finally {
      setLoading(false);
    }
  }, [page, premiseType, status, ownerId, searchDebounced]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const columns = [
    {
      key: "address",
      header: "Address",
      render: (row: Premise) => (
        <div>
          <div style={{ fontWeight: 500, color: "var(--text-primary)" }}>{row.addressLine1}</div>
          <div style={{ fontSize: "11px", color: "var(--text-muted)" }}>
            {row.city}, {row.state} {row.zip}
          </div>
        </div>
      ),
    },
    {
      key: "premiseType",
      header: "Type",
      render: (row: Premise) => (
        <span style={{ fontSize: "12px", color: "var(--text-secondary)" }}>{row.premiseType}</span>
      ),
    },
    {
      key: "commodities",
      header: "Commodities",
      render: (row: Premise) => (
        <div style={{ display: "flex", gap: "4px", flexWrap: "wrap" }}>
          {row.commodities && row.commodities.length > 0 ? (
            row.commodities.map((c, i) => (
              <CommodityBadge key={i} commodity={c.commodity?.name ?? ""} />
            ))
          ) : (
            <span style={{ color: "var(--text-muted)", fontSize: "12px" }}>—</span>
          )}
        </div>
      ),
    },
    {
      key: "owner",
      header: "Owner",
      render: (row: Premise) => (
        <span style={{ fontSize: "12px", color: "var(--text-secondary)" }}>
          {row.owner
            ? row.owner.customerType === "ORGANIZATION"
              ? row.owner.organizationName
              : `${row.owner.firstName} ${row.owner.lastName}`
            : "—"}
        </span>
      ),
    },
    {
      key: "meters",
      header: "Meters",
      render: (row: Premise) => (
        <span style={{ fontFamily: "monospace", fontSize: "12px" }}>{row.meters?.length ?? 0}</span>
      ),
    },
    {
      key: "status",
      header: "Status",
      render: (row: Premise) => <StatusBadge status={row.status} />,
    },
  ];

  return (
    <div>
      <PageHeader
        title="Premises"
        subtitle={`${meta.total.toLocaleString()} total premises`}
        action={canCreate ? { label: "Add Premise", href: "/premises/new" } : undefined}
      />

      <div style={{ display: "flex", gap: "12px", marginBottom: "20px", flexWrap: "wrap" }}>
        <StatCard label="Total" value={stats.total} icon="🏠" />
        <StatCard label="Active" value={stats.active} icon="✅" />
        <StatCard label="Inactive" value={stats.inactive} icon="⏸" />
        <StatCard label="Condemned" value={stats.condemned} icon="⛔" />
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: "12px", marginBottom: "8px" }}>
        <div
          style={{
            display: "flex",
            border: "1px solid var(--border)",
            borderRadius: "var(--radius)",
            overflow: "hidden",
          }}
        >
          {(["table", "map"] as const).map((v) => (
            <button
              key={v}
              onClick={() => setView(v)}
              style={{
                padding: "5px 14px",
                fontSize: "12px",
                fontWeight: "500",
                background: view === v ? "var(--accent-primary)" : "transparent",
                color: view === v ? "#fff" : "var(--text-secondary)",
                border: "none",
                cursor: "pointer",
                transition: "all 0.15s ease",
                fontFamily: "inherit",
                textTransform: "capitalize",
              }}
            >
              {v === "table" ? "⊞ Table" : "🗺 Map"}
            </button>
          ))}
        </div>
      </div>

      {/* Search bar */}
      <div style={{ marginBottom: "12px" }}>
        <input
          type="text"
          placeholder="Search by address, city, or zip..."
          value={search}
          onChange={(e) => { setSearch(e.target.value); setPage(1); }}
          style={{
            width: "100%",
            padding: "10px 14px",
            fontSize: "14px",
            background: "var(--bg-card)",
            border: "1px solid var(--border)",
            borderRadius: "var(--radius)",
            color: "var(--text-primary)",
            fontFamily: "inherit",
            outline: "none",
          }}
        />
      </div>

      <div style={{ display: "flex", alignItems: "flex-start", gap: "12px", marginBottom: "16px", flexWrap: "wrap" }}>
        <FilterBar
          filters={[
            {
              key: "premiseType",
              label: "Type",
              options: PREMISE_TYPE_OPTIONS,
              value: premiseType,
              onChange: (v) => {
                setPremiseType(v);
                setPage(1);
              },
            },
            {
              key: "status",
              label: "Status",
              options: STATUS_OPTIONS,
              value: status,
              onChange: (v) => {
                setStatus(v);
                setPage(1);
              },
            },
          ]}
        />
        <div style={{ width: "240px" }}>
          <SearchableSelect
            options={customers.map((c) => ({
              label: c.customerType === "ORGANIZATION"
                ? c.organizationName ?? ""
                : `${c.firstName} ${c.lastName}`,
              value: c.id,
            }))}
            value={ownerId}
            onChange={(v) => { setOwnerId(v); setPage(1); }}
            placeholder="Filter by owner..."
            clearLabel="All owners"
          />
        </div>
      </div>

      {view === "map" ? (
        <div style={{ display: "flex", flex: 1, minHeight: "560px" }}>
          <MapView onPremiseClick={(id) => router.push(`/premises/${id}`)} />
        </div>
      ) : (
        <DataTable
          columns={columns as any}
          data={data as any}
          meta={meta}
          loading={loading}
          onPageChange={setPage}
          onRowClick={(row: any) => router.push(`/premises/${row.id}`)}
        />
      )}
    </div>
  );
}
