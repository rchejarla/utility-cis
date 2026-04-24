"use client";

import { EntityListPage } from "@/components/ui/entity-list-page";
import type { Column } from "@/components/ui/data-table";

interface Container {
  id: string;
  containerType: string;
  sizeGallons: number;
  quantity: number;
  status: string;
  deliveryDate: string;
  serialNumber?: string | null;
  ramsContainerId?: string | null;
  premise?: { addressLine1: string; city: string; state: string };
}

const TYPE_OPTIONS = [
  { value: "CART_GARBAGE", label: "Garbage" },
  { value: "CART_RECYCLING", label: "Recycling" },
  { value: "CART_ORGANICS", label: "Organics" },
  { value: "CART_YARD_WASTE", label: "Yard waste" },
  { value: "DUMPSTER", label: "Dumpster" },
  { value: "ROLL_OFF", label: "Roll-off" },
];

const STATUS_OPTIONS = [
  { value: "ACTIVE", label: "Active" },
  { value: "SUSPENDED", label: "Suspended" },
  { value: "RETURNED", label: "Returned" },
  { value: "LOST", label: "Lost" },
  { value: "DAMAGED", label: "Damaged" },
];

const typeColor: Record<string, string> = {
  CART_GARBAGE: "var(--text-secondary)",
  CART_RECYCLING: "var(--info)",
  CART_ORGANICS: "var(--success)",
  CART_YARD_WASTE: "var(--warning)",
  DUMPSTER: "var(--accent-tertiary)",
  ROLL_OFF: "var(--accent-primary)",
};

const columns: Column<Container>[] = [
  {
    key: "containerType",
    header: "Type",
    render: (row) => (
      <span
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: "6px",
          fontSize: "11px",
          fontWeight: 700,
          color: typeColor[row.containerType] ?? "var(--text-secondary)",
        }}
      >
        <span
          style={{
            width: "8px",
            height: "8px",
            borderRadius: "2px",
            background: typeColor[row.containerType] ?? "var(--text-secondary)",
          }}
        />
        {row.containerType.replace("CART_", "").replace("_", " ")}
      </span>
    ),
  },
  {
    key: "size",
    header: "Size",
    render: (row) => (
      <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: "12px", fontWeight: 600 }}>
        {row.sizeGallons} gal{row.quantity > 1 && ` × ${row.quantity}`}
      </span>
    ),
  },
  {
    key: "premise",
    header: "Location",
    render: (row) =>
      row.premise ? (
        <span style={{ fontSize: "12px" }}>
          {row.premise.addressLine1}, {row.premise.city}
        </span>
      ) : (
        <span style={{ color: "var(--text-muted)" }}>—</span>
      ),
  },
  {
    key: "serial",
    header: "Serial / RAMS",
    render: (row) => (
      <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: "11px", color: "var(--text-muted)" }}>
        {row.serialNumber ?? row.ramsContainerId ?? "—"}
      </span>
    ),
  },
  {
    key: "deliveryDate",
    header: "Delivered",
    render: (row) => (
      <span style={{ fontSize: "11px" }}>{row.deliveryDate?.slice(0, 10) ?? "—"}</span>
    ),
  },
  {
    key: "status",
    header: "Status",
    render: (row) => (
      <span
        style={{
          display: "inline-flex",
          padding: "2px 8px",
          borderRadius: "999px",
          fontSize: "10px",
          fontWeight: 700,
          letterSpacing: "0.04em",
          background: row.status === "ACTIVE" ? "var(--success-subtle)" : "var(--bg-elevated)",
          color: row.status === "ACTIVE" ? "var(--success)" : "var(--text-secondary)",
          border:
            row.status === "ACTIVE"
              ? "1px solid var(--success)"
              : "1px solid var(--border)",
          width: "fit-content",
        }}
      >
        {row.status}
      </span>
    ),
  },
];

export default function ContainersPage() {
  return (
    <EntityListPage<Container>
      title="Containers"
      subject="containers"
      module="containers"
      endpoint="/api/v1/containers"
      getDetailHref={(row) => `/containers/${row.id}`}
      columns={columns}
      newAction={{ label: "+ Assign Container", href: "/containers/new" }}
      emptyState={{
        headline: "No solid-waste containers",
        description:
          "Containers (carts, dumpsters, rolloffs) are the physical waste receptacles at each premise. RAMS field events are recorded against them.",
      }}
      search={{
        paramKey: "search",
        placeholder: "Search by serial, RFID, or RAMS id...",
        variant: "compact",
      }}
      filters={[
        { key: "containerType", label: "Type", options: TYPE_OPTIONS },
        { key: "status", label: "Status", options: STATUS_OPTIONS },
      ]}
    />
  );
}
