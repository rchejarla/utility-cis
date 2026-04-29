"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faTableList, faMap, faMagnifyingGlass } from "@fortawesome/pro-solid-svg-icons";
import { PageHeader } from "@/components/ui/page-header";
import { StatCard } from "@/components/ui/stat-card";
import { StatusBadge } from "@/components/ui/status-badge";
import { CommodityBadge } from "@/components/ui/commodity-badge";
import { FilterBar } from "@/components/ui/filter-bar";
import { DataTable, type Column } from "@/components/ui/data-table";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { ListEmptyCta } from "@/components/ui/list-empty-cta";
import { AccessDenied } from "@/components/ui/access-denied";
import { MapView } from "@/components/premises/map-view";
import { apiClient } from "@/lib/api-client";
import { usePermission } from "@/lib/use-permission";
import { usePaginatedList } from "@/lib/use-paginated-list";
import { usePremiseTypes } from "@/lib/use-type-defs";

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
  active: number;
  inactive: number;
  condemned: number;
}

/**
 * Premises landing. This page has too many bespoke concerns to live
 * inside EntityListPage cleanly — Table/Map view toggle, stat cards,
 * and filter state that persists across view switches. Instead it
 * composes the lower-level primitives directly: PageHeader, StatCard,
 * FilterBar, SearchableSelect, DataTable, ListEmptyCta, MapView.
 */
export default function PremisesPage() {
  const router = useRouter();
  const { canView, canCreate } = usePermission("premises");
  const { types: premiseTypes } = usePremiseTypes();
  const PREMISE_TYPE_OPTIONS = premiseTypes.map((t) => ({ label: t.label, value: t.code }));

  const [view, setView] = useState<"table" | "map">("table");
  const [premiseType, setPremiseType] = useState<string | undefined>();
  const [status, setStatus] = useState<string | undefined>();
  const [ownerId, setOwnerId] = useState<string | undefined>();
  const [searchInput, setSearchInput] = useState("");
  const [searchValue, setSearchValue] = useState("");
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [stats, setStats] = useState<PremisesStats>({ active: 0, inactive: 0, condemned: 0 });

  // Debounce the search input so we don't thrash the API as the user types.
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onSearchChange = useCallback((value: string) => {
    setSearchInput(value);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => setSearchValue(value), 300);
  }, []);

  // Owner option list — fetched once and reused for both view modes.
  useEffect(() => {
    apiClient
      .get<Customer[] | { data: Customer[] }>("/api/v1/customers", { limit: "500" })
      .then((res) => setCustomers(Array.isArray(res) ? res : res.data ?? []))
      .catch(() => {});
  }, []);

  const params = useMemo(
    () => ({
      premiseType,
      status,
      ownerId,
      ...(searchValue ? { search: searchValue } : {}),
    }),
    [premiseType, status, ownerId, searchValue],
  );

  const { data, meta, loading, setPage } = usePaginatedList<Premise>({
    endpoint: "/api/v1/premises",
    params,
    enabled: canView && view === "table",
  });

  // Pull aggregate stats from the same endpoint. Fetched independently
  // so a stat refresh doesn't wait on the list render.
  useEffect(() => {
    if (!canView) return;
    apiClient
      .get<{ stats?: { active: number; inactive: number; condemned: number } }>(
        "/api/v1/premises",
        { page: "1", limit: "1" },
      )
      .then((res) => {
        if (res.stats) {
          setStats({
            active: res.stats.active,
            inactive: res.stats.inactive,
            condemned: res.stats.condemned,
          });
        }
      })
      .catch(() => {});
  }, [canView]);

  // Reset pagination to page 1 on any filter / search change.
  useEffect(() => {
    setPage(1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [premiseType, status, ownerId, searchValue]);

  const hasActiveFilter = Boolean(premiseType || status || ownerId || searchValue);
  const showEmptyCta = view === "table" && !loading && data.length === 0 && !hasActiveFilter;

  if (!canView) return <AccessDenied />;

  const ownerOptions = customers.map((c) => ({
    value: String(c.id),
    label:
      c.customerType === "ORGANIZATION"
        ? String(c.organizationName ?? "")
        : `${c.firstName ?? ""} ${c.lastName ?? ""}`.trim(),
  }));

  const statTiles = (
    <div
      style={{
        display: "flex",
        gap: "12px",
        marginBottom: "20px",
        flexWrap: "wrap",
      }}
    >
      <StatCard label="Total" value={meta.total} icon="🏠" />
      <StatCard label="Active" value={stats.active} icon="✅" accent="success" />
      <StatCard label="Inactive" value={stats.inactive} icon="⏸" accent="warning" />
      <StatCard label="Condemned" value={stats.condemned} icon="⛔" accent="danger" />
    </div>
  );

  const searchBar = (
    <div style={{ position: "relative", marginBottom: 12 }}>
      <div
        style={{
          position: "absolute",
          left: 16,
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
          fontSize: 14,
          fontFamily: "inherit",
          outline: "none",
          boxSizing: "border-box",
        }}
        placeholder="Search by address, city, or zip..."
        value={searchInput}
        onChange={(e) => onSearchChange(e.target.value)}
      />
    </div>
  );

  const viewToggleButton = (v: "table" | "map", icon: typeof faTableList, label: string) => (
    <button
      key={v}
      onClick={() => setView(v)}
      title={label}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        padding: "5px 12px",
        fontSize: "12px",
        fontWeight: 500,
        background: view === v ? "var(--accent-primary)" : "transparent",
        color: view === v ? "#fff" : "var(--text-secondary)",
        border: "none",
        cursor: "pointer",
        fontFamily: "inherit",
      }}
    >
      <FontAwesomeIcon icon={icon} style={{ width: 12, height: 12 }} />
      {label}
    </button>
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
      {viewToggleButton("table", faTableList, "Table")}
      {viewToggleButton("map", faMap, "Map")}
    </div>
  );

  const filterRow = (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: "12px",
        marginBottom: "16px",
        flexWrap: "wrap",
      }}
    >
      <FilterBar
        filters={[
          {
            key: "premiseType",
            label: "Type",
            options: PREMISE_TYPE_OPTIONS,
            value: premiseType,
            onChange: setPremiseType,
          },
          {
            key: "status",
            label: "Status",
            options: STATUS_OPTIONS,
            value: status,
            onChange: setStatus,
          },
        ]}
      />
      <div style={{ width: 220 }}>
        <SearchableSelect
          options={ownerOptions}
          value={ownerId}
          onChange={setOwnerId}
          placeholder="Filter by owner..."
          clearLabel="All owners"
          compact
        />
      </div>
      <div style={{ marginLeft: "auto", flexShrink: 0 }}>{viewToggle}</div>
    </div>
  );

  return (
    <div>
      <PageHeader
        title="Premises"
        subtitle={`${meta.total.toLocaleString()} total premises`}
        actions={
          canCreate && !showEmptyCta ? (
            <>
              <Link
                href="/premises/import"
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  padding: "8px 16px",
                  borderRadius: "var(--radius)",
                  background: "transparent",
                  color: "var(--accent-primary)",
                  border: "1px solid var(--accent-primary)",
                  fontSize: "13px",
                  fontWeight: 500,
                  textDecoration: "none",
                  whiteSpace: "nowrap",
                }}
              >
                Import
              </Link>
              <Link
                href="/premises/new"
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  padding: "8px 16px",
                  borderRadius: "var(--radius)",
                  background: "var(--accent-primary)",
                  color: "#fff",
                  fontSize: "13px",
                  fontWeight: 500,
                  textDecoration: "none",
                  whiteSpace: "nowrap",
                }}
              >
                Add Premise
              </Link>
            </>
          ) : undefined
        }
      />
      {statTiles}

      {showEmptyCta ? (
        <ListEmptyCta
          subject="premise"
          headline="No premises yet"
          description="A premise is the physical location where service is delivered. Every account is tied to exactly one."
          action={
            canCreate ? { label: "Add Premise", href: "/premises/new" } : undefined
          }
        />
      ) : (
        <>
          {searchBar}
          {filterRow}
          {view === "table" ? (
            <DataTable
              columns={columns as unknown as Column<Record<string, unknown>>[]}
              data={data as unknown as Record<string, unknown>[]}
              meta={meta}
              loading={loading}
              onPageChange={setPage}
              onRowClick={(row) => router.push(`/premises/${(row as unknown as Premise).id}`)}
            />
          ) : (
            <div style={{ display: "flex", flex: 1, minHeight: "560px" }}>
              <MapView onPremiseClick={(id) => router.push(`/premises/${id}`)} />
            </div>
          )}
        </>
      )}
    </div>
  );
}
