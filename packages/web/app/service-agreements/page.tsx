"use client";

import { StatusBadge } from "@/components/ui/status-badge";
import { CommodityBadge } from "@/components/ui/commodity-badge";
import { EntityListPage } from "@/components/ui/entity-list-page";
import { PageDescription } from "@/components/ui/page-description";
import type { Column } from "@/components/ui/data-table";

interface ServiceAgreement {
  id: string;
  agreementNumber: string;
  status: string;
  startDate: string;
  account?: { accountNumber: string };
  premise?: { addressLine1: string; city: string; state: string };
  commodity?: { name: string };
}

const STATUS_OPTIONS = [
  { label: "Pending", value: "PENDING" },
  { label: "Active", value: "ACTIVE" },
  { label: "Inactive", value: "INACTIVE" },
  { label: "Closed", value: "CLOSED" },
];

const columns: Column<ServiceAgreement>[] = [
  {
    key: "agreementNumber",
    header: "Agreement Number",
    render: (row) => (
      <span style={{ fontFamily: "monospace", fontSize: "12px", fontWeight: 600 }}>
        {row.agreementNumber}
      </span>
    ),
  },
  {
    key: "account",
    header: "Account",
    render: (row) => (
      <span style={{ fontSize: "12px" }}>{row.account?.accountNumber ?? "—"}</span>
    ),
  },
  {
    key: "premise",
    header: "Premise",
    render: (row) =>
      row.premise ? (
        <span style={{ fontSize: "12px" }}>
          {row.premise.addressLine1}, {row.premise.city}
        </span>
      ) : (
        <span style={{ color: "var(--text-muted)", fontSize: "12px" }}>—</span>
      ),
  },
  {
    key: "commodity",
    header: "Commodity",
    render: (row) => <CommodityBadge commodity={row.commodity?.name ?? ""} />,
  },
  {
    key: "status",
    header: "Status",
    render: (row) => <StatusBadge status={row.status} />,
  },
  {
    key: "startDate",
    header: "Start Date",
    render: (row) => (
      <span style={{ fontSize: "12px" }}>{row.startDate?.slice(0, 10) ?? "—"}</span>
    ),
  },
];

export default function ServiceAgreementsPage() {
  return (
    <EntityListPage<ServiceAgreement>
      title="Service Agreements"
      subject="agreements"
      module="agreements"
      endpoint="/api/v1/service-agreements"
      getDetailHref={(row) => `/service-agreements/${row.id}`}
      columns={columns}
      newAction={{ label: "Add Agreement", href: "/service-agreements/new" }}
      emptyState={{
        headline: "No service agreements yet",
        description:
          "A service agreement ties an account to a premise and a commodity on a specific rate schedule. Sign one up to start metering and billing a service at a location.",
      }}
      headerSlot={
        <PageDescription storageKey="service-agreements">
          A <b>service agreement</b> is the billable relationship for one
          commodity at one premise — it binds an account to a rate schedule
          and a billing cycle, and points at the meters that measure
          consumption. An account typically has multiple agreements (one per
          commodity: water, sewer, electric) all at the same location. The
          <b> status</b> (PENDING → ACTIVE → CLOSED) controls whether reads
          on its meters are billed.
        </PageDescription>
      }
      filters={[
        { key: "status", label: "Status", options: STATUS_OPTIONS },
        {
          key: "accountId",
          label: "Account",
          optionsEndpoint: "/api/v1/accounts",
          optionsParams: { limit: "200" },
          mapOption: (a) => ({ label: String(a.accountNumber), value: String(a.id) }),
        },
      ]}
    />
  );
}
