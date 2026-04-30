"use client";

import { StatusBadge } from "@/components/ui/status-badge";
import { EntityListPage } from "@/components/ui/entity-list-page";
import { useAccountTypes } from "@/lib/use-type-defs";
import type { Column } from "@/components/ui/data-table";

interface Account {
  id: string;
  accountNumber: string;
  accountType: string;
  status: string;
  creditRating?: string;
  customer?: {
    id: string;
    customerType: "INDIVIDUAL" | "ORGANIZATION";
    firstName?: string | null;
    lastName?: string | null;
    organizationName?: string | null;
  } | null;
  /** Hydrated by listAccounts: the most-recent SA's premise via its
   *  service point. An account serves one premise; this is that premise. */
  serviceAgreements?: Array<{
    servicePoints?: Array<{
      premise?: {
        id: string;
        addressLine1: string;
        city: string;
        state: string;
      } | null;
    }>;
  }>;
  _count?: { serviceAgreements: number };
}

function customerName(c: Account["customer"]): string {
  if (!c) return "—";
  if (c.customerType === "ORGANIZATION") return c.organizationName ?? "—";
  return `${c.firstName ?? ""} ${c.lastName ?? ""}`.trim() || "—";
}

function premiseLabel(row: Account): string {
  const p = row.serviceAgreements?.[0]?.servicePoints?.[0]?.premise;
  if (!p) return "—";
  return `${p.addressLine1}, ${p.city}`;
}

const STATUS_OPTIONS = [
  { label: "Active", value: "ACTIVE" },
  { label: "Inactive", value: "INACTIVE" },
  { label: "Suspended", value: "SUSPENDED" },
  { label: "Closed", value: "CLOSED" },
];

const columns: Column<Account>[] = [
  {
    key: "accountNumber",
    header: "Account Number",
    render: (row) => (
      <span style={{ fontFamily: "monospace", fontSize: "12px", fontWeight: 600 }}>
        {row.accountNumber}
      </span>
    ),
  },
  {
    key: "customer",
    header: "Customer",
    render: (row) => (
      <span style={{ fontSize: "13px", color: "var(--text-primary)" }}>{customerName(row.customer)}</span>
    ),
  },
  {
    key: "premise",
    header: "Premise",
    render: (row) => (
      <span style={{ fontSize: "12px", color: "var(--text-secondary)" }}>{premiseLabel(row)}</span>
    ),
  },
  {
    key: "accountType",
    header: "Type",
    render: (row) => (
      <span style={{ fontSize: "12px", color: "var(--text-secondary)" }}>{row.accountType}</span>
    ),
  },
  {
    key: "status",
    header: "Status",
    render: (row) => <StatusBadge status={row.status} />,
  },
  {
    key: "creditRating",
    header: "Credit Rating",
    render: (row) => <span style={{ fontSize: "12px" }}>{row.creditRating ?? "—"}</span>,
  },
  {
    key: "agreements",
    header: "Agreements",
    render: (row) => (
      <span style={{ fontFamily: "monospace", fontSize: "12px" }}>
        {row._count?.serviceAgreements ?? 0}
      </span>
    ),
  },
];

export default function AccountsPage() {
  const { types: accountTypes } = useAccountTypes();
  const ACCOUNT_TYPE_OPTIONS = accountTypes.map((t) => ({ label: t.label, value: t.code }));
  return (
    <EntityListPage<Account>
      title="Accounts"
      subject="accounts"
      module="accounts"
      endpoint="/api/v1/accounts"
      getDetailHref={(row) => `/accounts/${row.id}`}
      columns={columns}
      newAction={{ label: "Add Account", href: "/accounts/new" }}
      importHref="/accounts/import"
      emptyState={{
        headline: "No accounts yet",
        description:
          "An account is the billing relationship for one premise — it holds the balance, service agreements, and contact info. Create a customer first if you haven't.",
      }}
      search={{
        paramKey: "search",
        placeholder: "Search by account number or premise address...",
        variant: "compact",
      }}
      filters={[
        { key: "accountType", label: "Type", options: ACCOUNT_TYPE_OPTIONS },
        { key: "status", label: "Status", options: STATUS_OPTIONS },
        {
          key: "customerId",
          label: "Customer",
          optionsEndpoint: "/api/v1/customers",
          optionsParams: { limit: "500" },
          mapOption: (c) => {
            const customerType = String(c.customerType ?? "");
            const label =
              customerType === "ORGANIZATION"
                ? String(c.organizationName ?? "")
                : `${c.firstName ?? ""} ${c.lastName ?? ""}`.trim();
            return { label: label || "(unnamed)", value: String(c.id) };
          },
          searchable: true,
          searchablePlaceholder: "Filter by customer...",
          searchableClearLabel: "All customers",
        },
      ]}
    />
  );
}
