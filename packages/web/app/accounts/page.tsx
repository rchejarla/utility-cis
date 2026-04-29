"use client";

import { StatusBadge } from "@/components/ui/status-badge";
import { EntityListPage } from "@/components/ui/entity-list-page";
import type { Column } from "@/components/ui/data-table";

interface Account {
  id: string;
  accountNumber: string;
  accountType: string;
  status: string;
  creditRating?: string;
  serviceAgreements?: Array<unknown>;
}

const ACCOUNT_TYPE_OPTIONS = [
  { label: "Residential", value: "RESIDENTIAL" },
  { label: "Commercial", value: "COMMERCIAL" },
  { label: "Industrial", value: "INDUSTRIAL" },
  { label: "Government", value: "GOVERNMENT" },
];

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
        {row.serviceAgreements?.length ?? 0}
      </span>
    ),
  },
];

export default function AccountsPage() {
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
        paramKey: "accountNumber",
        placeholder: "Search by account number...",
        variant: "compact",
      }}
      filters={[
        { key: "accountType", label: "Type", options: ACCOUNT_TYPE_OPTIONS },
        { key: "status", label: "Status", options: STATUS_OPTIONS },
      ]}
    />
  );
}
