"use client";

import { useState, useEffect } from "react";
import { StatusBadge } from "@/components/ui/status-badge";
import { TypeBadge } from "@/components/ui/type-badge";
import { StatCard } from "@/components/ui/stat-card";
import { EntityListPage } from "@/components/ui/entity-list-page";
import type { Column } from "@/components/ui/data-table";
import { apiClient } from "@/lib/api-client";

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

interface CountEnvelope {
  meta?: { total?: number };
}

const CUSTOMER_TYPE_OPTIONS = [
  { label: "Individual", value: "INDIVIDUAL" },
  { label: "Organization", value: "ORGANIZATION" },
];

const STATUS_OPTIONS = [
  { label: "Active", value: "ACTIVE" },
  { label: "Inactive", value: "INACTIVE" },
];

const columns: Column<Customer>[] = [
  {
    key: "name",
    header: "Name",
    render: (row) => (
      <span style={{ fontWeight: 600, color: "var(--text-primary)", fontSize: "13px" }}>
        {row.customerType === "ORGANIZATION"
          ? row.organizationName ?? "—"
          : `${row.firstName ?? ""} ${row.lastName ?? ""}`.trim() || "—"}
      </span>
    ),
  },
  {
    key: "customerType",
    header: "Type",
    render: (row) => <TypeBadge type={row.customerType} />,
  },
  {
    key: "email",
    header: "Email",
    render: (row) => (
      <span style={{ fontSize: "12px", color: "var(--text-secondary)" }}>{row.email ?? "—"}</span>
    ),
  },
  {
    key: "phone",
    header: "Phone",
    render: (row) => (
      <span style={{ fontFamily: "monospace", fontSize: "12px", color: "var(--text-secondary)" }}>
        {row.phone ?? "—"}
      </span>
    ),
  },
  {
    key: "accounts",
    header: "Accounts",
    render: (row) => (
      <span style={{ fontFamily: "monospace", fontSize: "12px" }}>
        {row.accounts?.length ?? 0}
      </span>
    ),
  },
  {
    key: "status",
    header: "Status",
    render: (row) => <StatusBadge status={row.status} />,
  },
];

function CustomerStats() {
  const [stats, setStats] = useState({ total: 0, individuals: 0, organizations: 0, active: 0 });

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      apiClient.get<CountEnvelope>("/api/v1/customers", { page: "1", limit: "1" }),
      apiClient.get<CountEnvelope>("/api/v1/customers", {
        page: "1",
        limit: "1",
        customerType: "INDIVIDUAL",
      }),
      apiClient.get<CountEnvelope>("/api/v1/customers", {
        page: "1",
        limit: "1",
        customerType: "ORGANIZATION",
      }),
      apiClient.get<CountEnvelope>("/api/v1/customers", {
        page: "1",
        limit: "1",
        status: "ACTIVE",
      }),
    ])
      .then(([all, indiv, orgs, active]) => {
        if (cancelled) return;
        setStats({
          total: all.meta?.total ?? 0,
          individuals: indiv.meta?.total ?? 0,
          organizations: orgs.meta?.total ?? 0,
          active: active.meta?.total ?? 0,
        });
      })
      .catch((err) => console.error("Failed to fetch customer stats", err));
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div style={{ display: "flex", gap: "12px", marginBottom: "20px", flexWrap: "wrap" }}>
      <StatCard label="Total Customers" value={stats.total} icon="👥" />
      <StatCard label="Individuals" value={stats.individuals} icon="👤" />
      <StatCard label="Organizations" value={stats.organizations} icon="🏢" />
      <StatCard label="Active" value={stats.active} icon="✓" />
    </div>
  );
}

export default function CustomersPage() {
  return (
    <EntityListPage<Customer>
      title="Customers"
      subject="customers"
      module="customers"
      endpoint="/api/v1/customers"
      getDetailHref={(row) => `/customers/${row.id}`}
      columns={columns}
      newAction={{ label: "Add Customer", href: "/customers/new" }}
      emptyState={{
        headline: "No customers yet",
        description:
          "Customers are the people and organizations you bill — each one can own multiple accounts across different services.",
      }}
      headerSlot={<CustomerStats />}
      search={{
        paramKey: "search",
        placeholder: "Search by name, email, or phone...",
        variant: "prominent",
      }}
      filters={[
        { key: "customerType", label: "Type", options: CUSTOMER_TYPE_OPTIONS },
        { key: "status", label: "Status", options: STATUS_OPTIONS },
      ]}
    />
  );
}
