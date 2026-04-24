"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { PageHeader } from "@/components/ui/page-header";
import { StatCard } from "@/components/ui/stat-card";
import { StatusBadge } from "@/components/ui/status-badge";
import { CommodityBadge } from "@/components/ui/commodity-badge";
import { EntityListPage } from "@/components/ui/entity-list-page";
import { MapView } from "@/components/premises/map-view";
import { apiClient } from "@/lib/api-client";
import { usePermission } from "@/lib/use-permission";
import { AccessDenied } from "@/components/ui/access-denied";
import type { Column } from "@/components/ui/data-table";

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

const columns: Column<Premise>[] = [
  {
    key: "address",
    header: "Address",
    render: (row) => (
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
    render: (row) => (
      <span style={{ fontSize: "12px", color: "var(--text-secondary)" }}>{row.premiseType}</span>
    ),
  },
  {
    key: "commodities",
    header: "Commodities",
    render: (row) => (
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
    render: (row) => (
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
    render: (row) => (
      <span style={{ fontFamily: "monospace", fontSize: "12px" }}>{row.meters?.length ?? 0}</span>
    ),
  },
  {
    key: "status",
    header: "Status",
    render: (row) => <StatusBadge status={row.status} />,
  },
];

interface PremisesStats {
  total: number;
  active: number;
  inactive: number;
  condemned: number;
}

/**
 * Premises landing — thin wrapper around EntityListPage for table
 * mode; keeps the custom map view selectable via a Table/Map toggle
 * that lives on the filter row. Stats are fetched once on mount and
 * shown in both modes. Pagination, filtering, and permission gating
 * all flow through EntityListPage so /premises inherits the
 * fresh-empty-state CTA and other list-page patterns.
 */
export default function PremisesPage() {
  const router = useRouter();
  const { canView } = usePermission("premises");
  const [view, setView] = useState<"table" | "map">("table");
  const [stats, setStats] = useState<PremisesStats>({ total: 0, active: 0, inactive: 0, condemned: 0 });

  // Stats come from the list endpoint's aggregate payload; fetch a
  // tiny page once on mount rather than relying on the paginated
  // hook's meta, which only surfaces the total count.
  const fetchStats = useCallback(async () => {
    try {
      const res = await apiClient.get<{
        meta: { total: number };
        stats?: { active: number; inactive: number; condemned: number };
      }>("/api/v1/premises", { page: "1", limit: "1" });
      setStats({
        total: res.meta.total,
        active: res.stats?.active ?? 0,
        inactive: res.stats?.inactive ?? 0,
        condemned: res.stats?.condemned ?? 0,
      });
    } catch {
      // Stats are best-effort — the list itself still renders.
    }
  }, []);

  useEffect(() => {
    fetchStats();
  }, [fetchStats]);

  if (!canView) return <AccessDenied />;

  const statTiles = (
    <div
      style={{
        display: "flex",
        gap: "12px",
        marginBottom: "20px",
        flexWrap: "wrap",
      }}
    >
      <StatCard label="Total" value={stats.total} icon="🏠" />
      <StatCard label="Active" value={stats.active} icon="✅" accent="success" />
      <StatCard label="Inactive" value={stats.inactive} icon="⏸" accent="warning" />
      <StatCard label="Condemned" value={stats.condemned} icon="⛔" accent="danger" />
    </div>
  );

  const viewToggle = (
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
            fontWeight: 500,
            background: view === v ? "var(--accent-primary)" : "transparent",
            color: view === v ? "#fff" : "var(--text-secondary)",
            border: "none",
            cursor: "pointer",
            fontFamily: "inherit",
            textTransform: "capitalize",
          }}
        >
          {v === "table" ? "⊞ Table" : "🗺 Map"}
        </button>
      ))}
    </div>
  );

  if (view === "map") {
    // Map view renders a minimal shell with the same chrome
    // EntityListPage would render — header, stats, view toggle — but
    // swaps the table + filters out for the full-bleed MapView. No
    // filter bar in map mode; panning/zoom is the filter.
    return (
      <div>
        <PageHeader
          title="Premises"
          subtitle={`${stats.total.toLocaleString()} total premises`}
        />
        {statTiles}
        <div
          style={{
            display: "flex",
            justifyContent: "flex-end",
            marginBottom: "16px",
          }}
        >
          {viewToggle}
        </div>
        <div style={{ display: "flex", flex: 1, minHeight: "560px" }}>
          <MapView onPremiseClick={(id) => router.push(`/premises/${id}`)} />
        </div>
      </div>
    );
  }

  return (
    <EntityListPage<Premise>
      title="Premises"
      subject="premises"
      module="premises"
      endpoint="/api/v1/premises"
      getDetailHref={(row) => `/premises/${row.id}`}
      columns={columns}
      newAction={{ label: "Add Premise", href: "/premises/new" }}
      emptyState={{
        headline: "No premises yet",
        description:
          "A premise is the physical location where service is delivered. Every account is tied to exactly one.",
      }}
      headerSlot={statTiles}
      filtersRightSlot={viewToggle}
      search={{
        paramKey: "search",
        placeholder: "Search by address, city, or zip...",
        variant: "prominent",
      }}
      filters={[
        { key: "premiseType", label: "Type", options: PREMISE_TYPE_OPTIONS },
        { key: "status", label: "Status", options: STATUS_OPTIONS },
        {
          key: "ownerId",
          label: "Owner",
          optionsEndpoint: "/api/v1/customers",
          optionsParams: { limit: "500" },
          mapOption: (c) => ({
            value: String(c.id),
            label:
              c.customerType === "ORGANIZATION"
                ? String(c.organizationName ?? "")
                : `${c.firstName ?? ""} ${c.lastName ?? ""}`.trim(),
          }),
          searchable: true,
          searchablePlaceholder: "Filter by owner...",
          searchableClearLabel: "All owners",
        },
      ]}
    />
  );
}
