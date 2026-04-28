"use client";

import { useState, useEffect, useMemo, useRef, useCallback } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faMagnifyingGlass } from "@fortawesome/pro-solid-svg-icons";
import { PageHeader } from "./page-header";
import { FilterBar } from "./filter-bar";
import { DataTable, type Column } from "./data-table";
import { AccessDenied } from "./access-denied";
import { ListEmptyCta } from "./list-empty-cta";
import { SearchableSelect } from "./searchable-select";
import { apiClient } from "@/lib/api-client";
import { usePermission } from "@/lib/use-permission";
import { usePaginatedList } from "@/lib/use-paginated-list";

/**
 * Declarative list-page shell. Every list page in the app was hand-rolling
 * the same scaffolding — PageHeader + optional search + FilterBar + DataTable
 * + permission check + useState/useEffect/fetch cycle + filter-change-resets-
 * page logic. This component absorbs all of it behind a single config object,
 * so a list page now only declares: endpoint, columns, filters, and navigation.
 *
 * Pages with unusual requirements (extra header content, custom side-data
 * fetches, non-standard search) can pass `headerSlot` / `extraHeader` or
 * fall back to hand-rolling — this shell handles the 80% case.
 */

export interface FilterOption {
  label: string;
  value: string;
}

interface StaticFilter {
  key: string;
  label: string;
  options: FilterOption[];
}

interface DynamicFilter {
  key: string;
  label: string;
  /** Endpoint returning { data: T[] } or T[]. */
  optionsEndpoint: string;
  /** Maps a fetched row to a {label, value} option. */
  mapOption: (row: Record<string, unknown>) => FilterOption;
  /** Optional extra query params for the options fetch. */
  optionsParams?: Record<string, string>;
  /**
   * Render as a typeahead SearchableSelect instead of a pill dropdown.
   * Use when the option list is long enough that the pill's scrolled
   * menu becomes unusable (e.g. owner filter over 100+ customers).
   */
  searchable?: boolean;
  /** Placeholder text for searchable variant. Default: "Filter by {label}...". */
  searchablePlaceholder?: string;
  /** Clear-label text for searchable variant. Default: "All {label}". */
  searchableClearLabel?: string;
}

export type EntityListFilter = StaticFilter | DynamicFilter;

export interface EntityListSearch {
  /** Query param name to set when the user types (e.g. "search", "accountNumber"). */
  paramKey: string;
  placeholder?: string;
  /**
   * "prominent" renders a large hero search bar with an icon (customer-style).
   * "compact" renders a small inline input (account-style).
   */
  variant?: "prominent" | "compact";
  /** Debounce in ms. Default 300 for prominent, 0 for compact. */
  debounceMs?: number;
}

export interface EntityListPageProps<T extends { id: string }> {
  title: string;
  /** Word(s) used in the subtitle "N total {subject}". */
  subject: string;
  /** Permission module key. */
  module: string;
  /** API endpoint, e.g. "/api/v1/customers" */
  endpoint: string;
  /** Href pattern: receives row, returns path. */
  getDetailHref: (row: T) => string;
  /** Columns passed straight to DataTable. */
  columns: Column<T>[];
  /** Optional "Add" button config. */
  newAction?: {
    label: string;
    href: string;
  };
  /**
   * Optional href to a bulk-import page (e.g. "/customers/import").
   * Renders a secondary "Import" button next to the primary Add
   * button when the current user has CREATE permission. Use sparingly
   * — only entities that have a real import handler in the framework.
   */
  importHref?: string;
  /**
   * Optional copy shown inside the fresh-empty-state CTA. Only
   * consulted when the list has zero rows AND no filters/search are
   * applied. `headline` defaults to "No {subject}s yet"; set
   * `description` to add 1–2 teaching sentences for a new operator.
   */
  emptyState?: {
    headline?: string;
    description?: string;
  };
  /** Optional search input. */
  search?: EntityListSearch;
  /** Optional filter pills. Static or dynamic. */
  filters?: EntityListFilter[];
  /** Optional React node rendered between header and search (e.g. stat cards). */
  headerSlot?: React.ReactNode;
  /**
   * Optional node pinned to the right end of the filter row. Used for
   * page-level controls that belong visually alongside filters (e.g. a
   * Table ↔ Map view toggle) without consuming a separate row.
   */
  filtersRightSlot?: React.ReactNode;
  /**
   * Set to false when the endpoint returns a plain array (e.g. billing-cycles).
   * Default true.
   */
  paginated?: boolean;
}

function isDynamic(f: EntityListFilter): f is DynamicFilter {
  return "optionsEndpoint" in f;
}

function useDynamicFilterOptions(filters: EntityListFilter[] | undefined) {
  const [dynamicOptions, setDynamicOptions] = useState<Record<string, FilterOption[]>>({});

  useEffect(() => {
    if (!filters) return;
    const dyn = filters.filter(isDynamic);
    if (dyn.length === 0) return;
    let cancelled = false;
    Promise.all(
      dyn.map(async (f) => {
        try {
          const res = await apiClient.get<{ data: Record<string, unknown>[] } | Record<string, unknown>[]>(
            f.optionsEndpoint,
            f.optionsParams
          );
          const rows = Array.isArray(res) ? res : res.data ?? [];
          return [f.key, rows.map(f.mapOption)] as const;
        } catch (err) {
          console.error(`Failed to load options for filter "${f.key}"`, err);
          return [f.key, [] as FilterOption[]] as const;
        }
      })
    ).then((entries) => {
      if (cancelled) return;
      setDynamicOptions(Object.fromEntries(entries));
    });
    return () => {
      cancelled = true;
    };
  }, [filters]);

  return dynamicOptions;
}

export function EntityListPage<T extends { id: string }>(props: EntityListPageProps<T>) {
  const {
    title,
    subject,
    module,
    endpoint,
    getDetailHref,
    columns,
    newAction,
    importHref,
    emptyState,
    search,
    filters,
    headerSlot,
    filtersRightSlot,
    paginated = true,
  } = props;

  const router = useRouter();
  const { canView, canCreate } = usePermission(module);

  // Filter state — one entry per filter key. Uses a single record so
  // we can hand the whole thing to usePaginatedList as `params`.
  const [filterValues, setFilterValues] = useState<Record<string, string | undefined>>({});

  // Search state with optional debounce.
  const [searchInput, setSearchInput] = useState("");
  const [searchValue, setSearchValue] = useState("");
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const debounceMs = search?.debounceMs ?? (search?.variant === "compact" ? 0 : 300);

  const handleSearchChange = useCallback(
    (value: string) => {
      setSearchInput(value);
      if (debounceMs === 0) {
        setSearchValue(value);
        return;
      }
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => setSearchValue(value), debounceMs);
    },
    [debounceMs]
  );

  // Assemble the full param set fed to the list hook.
  const params = useMemo(() => {
    const p: Record<string, string | undefined> = { ...filterValues };
    if (search && searchValue) p[search.paramKey] = searchValue;
    return p;
  }, [filterValues, search, searchValue]);

  const { data, meta, loading, setPage } = usePaginatedList<T>({
    endpoint,
    params,
    paginated,
  });

  // Any filter / search change resets the page to 1.
  useEffect(() => {
    setPage(1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(filterValues), searchValue]);

  const dynamicOptions = useDynamicFilterOptions(filters);

  if (!canView) return <AccessDenied />;

  const handleFilterChange = (key: string) => (value: string | undefined) => {
    setFilterValues((prev) => ({ ...prev, [key]: value }));
  };

  // Split filters into two render buckets: pill-based (short static or
  // dynamic lists) and searchable (long dynamic lists). Pills live in
  // FilterBar; searchable ones render inline next to the bar as a
  // SearchableSelect so the user can type to narrow long option lists
  // (e.g. the owner filter on /premises over 500 customers).
  const pillFilters = (filters ?? []).filter(
    (f) => !(isDynamic(f) && f.searchable),
  );
  const searchableFilters = (filters ?? []).filter(
    (f): f is DynamicFilter => isDynamic(f) && !!f.searchable,
  );
  const filterConfigs = pillFilters.map((f) => {
    const options = isDynamic(f) ? dynamicOptions[f.key] ?? [] : f.options;
    return {
      key: f.key,
      label: f.label,
      options,
      value: filterValues[f.key],
      onChange: handleFilterChange(f.key),
    };
  });

  const subtitle = `${meta.total.toLocaleString()} total ${subject}`;

  // Fresh-empty = page loaded, zero rows, and the user hasn't narrowed
  // the set via filters or search. In that case skip the filter bar +
  // empty table and render a focused CTA instead — teaches new
  // operators what the page is for and how to start. When filters or
  // search are active, the zero-row case falls through to DataTable's
  // "No records found" message so the user can tell their filter
  // produced the emptiness, not the underlying data.
  const hasActiveFilter = Object.values(filterValues).some((v) => v !== undefined && v !== "");
  const hasActiveSearch = searchValue !== "";
  const showEmptyCta =
    !loading && data.length === 0 && !hasActiveFilter && !hasActiveSearch;

  return (
    <div>
      <PageHeader
        title={title}
        subtitle={subtitle}
        // When the empty-state CTA is rendered, suppress the header's
        // Add button — the centered CTA already owns the primary
        // action and two "Add" buttons in the same viewport reads as
        // redundant. Once data exists, the header button returns as
        // the quick-add shortcut next to the title.
        actions={
          canCreate && !showEmptyCta && (newAction || importHref) ? (
            <>
              {importHref && (
                <Link
                  href={importHref}
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
              )}
              {newAction && (
                <Link
                  href={newAction.href}
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
                  {newAction.label}
                </Link>
              )}
            </>
          ) : undefined
        }
      />

      {headerSlot}

      {!showEmptyCta && search && search.variant !== "compact" && (
        <div style={{ position: "relative", marginBottom: "12px" }}>
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
            placeholder={search.placeholder ?? "Search..."}
            value={searchInput}
            onChange={(e) => handleSearchChange(e.target.value)}
            onFocus={(e) => {
              e.currentTarget.style.borderColor = "var(--accent-primary)";
              e.currentTarget.style.boxShadow = "0 0 0 3px rgba(99, 102, 241, 0.15)";
            }}
            onBlur={(e) => {
              e.currentTarget.style.borderColor = "var(--border)";
              e.currentTarget.style.boxShadow = "none";
            }}
          />
        </div>
      )}

      {!showEmptyCta && search && search.variant === "compact" && (
        <div style={{ marginBottom: "8px" }}>
          <input
            style={{
              padding: "7px 12px",
              borderRadius: "var(--radius)",
              border: "1px solid var(--border)",
              background: "var(--bg-elevated)",
              color: "var(--text-primary)",
              fontSize: "13px",
              fontFamily: "inherit",
              outline: "none",
              width: "260px",
            }}
            placeholder={search.placeholder ?? "Search..."}
            value={searchInput}
            onChange={(e) => handleSearchChange(e.target.value)}
          />
        </div>
      )}

      {showEmptyCta ? (
        <ListEmptyCta
          subject={subject}
          headline={emptyState?.headline}
          description={emptyState?.description}
          action={canCreate && newAction ? newAction : undefined}
        />
      ) : (
        <>
          {(filterConfigs.length > 0 || searchableFilters.length > 0 || filtersRightSlot) && (
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: "12px",
                marginBottom: "16px",
                flexWrap: "wrap",
              }}
            >
              {filterConfigs.length > 0 && <FilterBar filters={filterConfigs} />}
              {searchableFilters.map((f) => (
                <div key={f.key} style={{ width: 220 }}>
                  <SearchableSelect
                    options={dynamicOptions[f.key] ?? []}
                    value={filterValues[f.key]}
                    onChange={handleFilterChange(f.key)}
                    placeholder={
                      f.searchablePlaceholder ?? `Filter by ${f.label.toLowerCase()}...`
                    }
                    clearLabel={f.searchableClearLabel ?? `All ${f.label.toLowerCase()}`}
                    compact
                  />
                </div>
              ))}
              {filtersRightSlot && (
                <div style={{ marginLeft: "auto", flexShrink: 0 }}>{filtersRightSlot}</div>
              )}
            </div>
          )}

          <DataTable
            columns={columns as Column<Record<string, unknown>>[]}
            data={data as unknown as Record<string, unknown>[]}
            meta={meta}
            loading={loading}
            onPageChange={setPage}
            onRowClick={(row) => router.push(getDetailHref(row as unknown as T))}
          />
        </>
      )}
    </div>
  );
}
