"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { useRouter } from "next/navigation";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faMagnifyingGlass } from "@fortawesome/pro-solid-svg-icons";
import { PageHeader } from "@/components/ui/page-header";
import { FilterBar } from "@/components/ui/filter-bar";
import { DataTable } from "@/components/ui/data-table";
import { StatusBadge } from "@/components/ui/status-badge";
import { StatCard } from "@/components/ui/stat-card";
import { apiClient } from "@/lib/api-client";
import { usePermission } from "@/lib/use-permission";
import { AccessDenied } from "@/components/ui/access-denied";

interface Customer {
  id: string;
  customerType: string;
  status: string;
  firstName?: string;
  lastName?: string;
  organizationName?: string;
  email?: string;
  phone?: string;
  accounts?: Array<unknown>;
}

interface CustomersResponse {
  data: Customer[];
  meta: { total: number; page: number; limit: number; pages: number };
}

const CUSTOMER_TYPE_OPTIONS = [
  { label: "Individual", value: "INDIVIDUAL" },
  { label: "Organization", value: "ORGANIZATION" },
];

const STATUS_OPTIONS = [
  { label: "Active", value: "ACTIVE" },
  { label: "Inactive", value: "INACTIVE" },
];

function TypeBadge({ type }: { type: string }) {
  const isOrg = type === "ORGANIZATION";
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: "5px",
        padding: "2px 8px",
        borderRadius: "999px",
        background: isOrg ? "rgba(245,158,11,0.12)" : "rgba(59,130,246,0.12)",
        fontSize: "11px",
        fontWeight: "500",
        color: isOrg ? "#fbbf24" : "#60a5fa",
        whiteSpace: "nowrap",
      }}
    >
      <span
        style={{
          width: "5px",
          height: "5px",
          borderRadius: "50%",
          background: isOrg ? "#f59e0b" : "#3b82f6",
          flexShrink: 0,
        }}
      />
      {isOrg ? "Organization" : "Individual"}
    </span>
  );
}

export default function CustomersPage() {
  const router = useRouter();
  const { canView, canCreate } = usePermission("customers");
  if (!canView) return <AccessDenied />;
  const [data, setData] = useState<Customer[]>([]);
  const [meta, setMeta] = useState({ total: 0, page: 1, limit: 20, pages: 0 });
  const [loading, setLoading] = useState(true);
  const [customerType, setCustomerType] = useState<string | undefined>(undefined);
  const [status, setStatus] = useState<string | undefined>(undefined);
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Stats derived from current data — supplement with a separate all-customers fetch
  const [stats, setStats] = useState({ total: 0, individuals: 0, organizations: 0, active: 0 });

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const params: Record<string, string> = { page: String(page), limit: "20" };
      if (customerType) params.customerType = customerType;
      if (status) params.status = status;
      if (search) params.search = search;
      const res = await apiClient.get<CustomersResponse>("/api/v1/customers", params);
      setData(res.data);
      setMeta(res.meta);
    } catch (err) {
      console.error("Failed to fetch customers", err);
    } finally {
      setLoading(false);
    }
  }, [page, customerType, status, search]);

  const fetchStats = useCallback(async () => {
    try {
      const [all, indiv, orgs, active] = await Promise.all([
        apiClient.get<CustomersResponse>("/api/v1/customers", { page: "1", limit: "1" }),
        apiClient.get<CustomersResponse>("/api/v1/customers", { page: "1", limit: "1", customerType: "INDIVIDUAL" }),
        apiClient.get<CustomersResponse>("/api/v1/customers", { page: "1", limit: "1", customerType: "ORGANIZATION" }),
        apiClient.get<CustomersResponse>("/api/v1/customers", { page: "1", limit: "1", status: "ACTIVE" }),
      ]);
      setStats({
        total: all.meta?.total ?? 0,
        individuals: indiv.meta?.total ?? 0,
        organizations: orgs.meta?.total ?? 0,
        active: active.meta?.total ?? 0,
      });
    } catch (err) {
      console.error("Failed to fetch stats", err);
    }
  }, []);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  useEffect(() => {
    fetchStats();
  }, [fetchStats]);

  const handleSearchChange = (value: string) => {
    setSearchInput(value);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      setSearch(value);
      setPage(1);
    }, 300);
  };

  const columns = [
    {
      key: "name",
      header: "Name",
      render: (row: Customer) => (
        <span style={{ fontWeight: 600, color: "var(--text-primary)", fontSize: "13px" }}>
          {row.customerType === "ORGANIZATION"
            ? (row.organizationName ?? "—")
            : `${row.firstName ?? ""} ${row.lastName ?? ""}`.trim() || "—"}
        </span>
      ),
    },
    {
      key: "customerType",
      header: "Type",
      render: (row: Customer) => <TypeBadge type={row.customerType} />,
    },
    {
      key: "email",
      header: "Email",
      render: (row: Customer) => (
        <span style={{ fontSize: "12px", color: "var(--text-secondary)" }}>{row.email ?? "—"}</span>
      ),
    },
    {
      key: "phone",
      header: "Phone",
      render: (row: Customer) => (
        <span style={{ fontFamily: "monospace", fontSize: "12px", color: "var(--text-secondary)" }}>
          {row.phone ?? "—"}
        </span>
      ),
    },
    {
      key: "accounts",
      header: "Accounts",
      render: (row: Customer) => (
        <span style={{ fontFamily: "monospace", fontSize: "12px" }}>
          {row.accounts?.length ?? 0}
        </span>
      ),
    },
    {
      key: "status",
      header: "Status",
      render: (row: Customer) => <StatusBadge status={row.status} />,
    },
  ];

  return (
    <div>
      <PageHeader
        title="Customers"
        subtitle={`${meta.total.toLocaleString()} total customers`}
        action={canCreate ? { label: "Add Customer", href: "/customers/new" } : undefined}
      />

      {/* Stat cards */}
      <div style={{ display: "flex", gap: "12px", marginBottom: "20px", flexWrap: "wrap" }}>
        <StatCard label="Total Customers" value={stats.total} icon="👥" />
        <StatCard label="Individuals" value={stats.individuals} icon="👤" />
        <StatCard label="Organizations" value={stats.organizations} icon="🏢" />
        <StatCard label="Active" value={stats.active} icon="✓" />
      </div>

      {/* Prominent search bar */}
      <div
        style={{
          position: "relative",
          marginBottom: "12px",
        }}
      >
        <div
          style={{
            position: "absolute",
            left: "16px",
            top: "50%",
            transform: "translateY(-50%)",
            color: "var(--text-muted)",
            pointerEvents: "none",
            display: "flex",
            alignItems: "center",
          }}
        >
          <FontAwesomeIcon icon={faMagnifyingGlass} style={{ width: 16, height: 16 }} />
        </div>
        <input
          style={{
            width: "100%",
            padding: "12px 16px 12px 44px",
            borderRadius: "var(--radius)",
            border: "1px solid var(--border)",
            background: "var(--bg-elevated)",
            color: "var(--text-primary)",
            fontSize: "14px",
            fontFamily: "inherit",
            outline: "none",
            boxSizing: "border-box",
            transition: "border-color 0.15s ease, box-shadow 0.15s ease",
          }}
          placeholder="Search by name, email, or phone..."
          value={searchInput}
          onChange={(e) => handleSearchChange(e.target.value)}
          onFocus={(e) => {
            e.currentTarget.style.borderColor = "var(--accent-primary)";
            e.currentTarget.style.boxShadow = "0 0 0 3px rgba(59,130,246,0.15)";
          }}
          onBlur={(e) => {
            e.currentTarget.style.borderColor = "var(--border)";
            e.currentTarget.style.boxShadow = "none";
          }}
        />
      </div>

      <FilterBar
        filters={[
          {
            key: "customerType",
            label: "Type",
            options: CUSTOMER_TYPE_OPTIONS,
            value: customerType,
            onChange: (v) => { setCustomerType(v); setPage(1); },
          },
          {
            key: "status",
            label: "Status",
            options: STATUS_OPTIONS,
            value: status,
            onChange: (v) => { setStatus(v); setPage(1); },
          },
        ]}
      />

      <DataTable
        columns={columns as any}
        data={data as any}
        meta={meta}
        loading={loading}
        onPageChange={setPage}
        onRowClick={(row: any) => router.push(`/customers/${row.id}`)}
      />
    </div>
  );
}
