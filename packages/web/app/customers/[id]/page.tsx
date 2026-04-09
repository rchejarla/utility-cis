"use client";

import { useState, useEffect, use } from "react";
import { useRouter } from "next/navigation";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import {
  faEnvelope,
  faPhone,
  faBuilding,
  faUser,
} from "@fortawesome/pro-solid-svg-icons";
import { PageHeader } from "@/components/ui/page-header";
import { Tabs } from "@/components/ui/tabs";
import { StatusBadge } from "@/components/ui/status-badge";
import { DataTable } from "@/components/ui/data-table";
import { apiClient } from "@/lib/api-client";

interface Contact {
  id: string;
  role?: string;
  firstName?: string;
  lastName?: string;
  email?: string;
  phone?: string;
  account?: { id: string; accountNumber: string };
}

interface Account {
  id: string;
  accountNumber: string;
  accountType: string;
  status: string;
  serviceAgreements?: Array<unknown>;
}

interface Premise {
  id: string;
  addressLine1: string;
  city: string;
  state?: string;
  postalCode?: string;
  premiseType?: string;
  status?: string;
}

interface Customer {
  id: string;
  customerType: string;
  status: string;
  firstName?: string;
  lastName?: string;
  organizationName?: string;
  email?: string;
  phone?: string;
  altPhone?: string;
  dateOfBirth?: string;
  driversLicense?: string;
  taxId?: string;
  accounts?: Account[];
  contacts?: Contact[];
  ownedPremises?: Premise[];
  createdAt?: string;
  updatedAt?: string;
}

const fieldStyle = {
  display: "grid" as const,
  gridTemplateColumns: "180px 1fr",
  gap: "8px",
  padding: "10px 0",
  borderBottom: "1px solid var(--border-subtle, var(--border))",
  alignItems: "start" as const,
};
const labelStyle = { fontSize: "12px", color: "var(--text-muted)", fontWeight: "500" as const };
const valueStyle = { fontSize: "13px", color: "var(--text-primary)" };

function TypeBadge({ type }: { type: string }) {
  const isOrg = type === "ORGANIZATION";
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: "5px",
        padding: "2px 10px",
        borderRadius: "999px",
        background: isOrg ? "rgba(245,158,11,0.12)" : "rgba(59,130,246,0.12)",
        fontSize: "12px",
        fontWeight: "500",
        color: isOrg ? "#fbbf24" : "#60a5fa",
        whiteSpace: "nowrap",
      }}
    >
      <FontAwesomeIcon
        icon={isOrg ? faBuilding : faUser}
        style={{ width: 11, height: 11 }}
      />
      {isOrg ? "Organization" : "Individual"}
    </span>
  );
}

function ContactInfoItem({
  icon,
  value,
  mono,
}: {
  icon: typeof faEnvelope;
  value?: string;
  mono?: boolean;
}) {
  if (!value) return null;
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: "8px",
        color: "var(--text-secondary)",
        fontSize: "13px",
      }}
    >
      <FontAwesomeIcon icon={icon} style={{ width: 13, height: 13, color: "var(--text-muted)" }} />
      <span style={mono ? { fontFamily: "monospace" } : undefined}>{value}</span>
    </div>
  );
}

function QuickStat({ label, value }: { label: string; value: number }) {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        padding: "12px 20px",
        background: "var(--bg-elevated)",
        borderRadius: "var(--radius)",
        border: "1px solid var(--border)",
        minWidth: "80px",
      }}
    >
      <span
        style={{
          fontSize: "24px",
          fontWeight: "700",
          color: "var(--text-primary)",
          fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
          lineHeight: 1.1,
        }}
      >
        {value}
      </span>
      <span style={{ fontSize: "11px", color: "var(--text-muted)", marginTop: "4px", whiteSpace: "nowrap" }}>
        {label}
      </span>
    </div>
  );
}

export default function CustomerDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();
  const [customer, setCustomer] = useState<Customer | null>(null);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState("overview");

  useEffect(() => {
    apiClient
      .get<Customer>(`/api/v1/customers/${id}`)
      .then((data) => setCustomer(data))
      .catch(console.error)
      .finally(() => setLoading(false));
  }, [id]);

  if (loading) {
    return <div style={{ color: "var(--text-muted)", padding: "40px 0" }}>Loading...</div>;
  }
  if (!customer) {
    return <div style={{ color: "var(--text-muted)", padding: "40px 0" }}>Customer not found.</div>;
  }

  const displayName =
    customer.customerType === "ORGANIZATION"
      ? (customer.organizationName ?? "Unknown Organization")
      : `${customer.firstName ?? ""} ${customer.lastName ?? ""}`.trim() || "Unknown Customer";

  const accounts = customer.accounts ?? [];
  const contacts = customer.contacts ?? [];
  const ownedPremises = customer.ownedPremises ?? [];
  const activeAgreements = accounts.reduce(
    (acc, a) => acc + (a.serviceAgreements?.length ?? 0),
    0
  );

  return (
    <div>
      {/* Command center header */}
      <div
        style={{
          background: "var(--bg-card)",
          border: "1px solid var(--border)",
          borderRadius: "var(--radius)",
          padding: "24px 28px",
          marginBottom: "20px",
        }}
      >
        {/* Name + badges */}
        <div style={{ display: "flex", alignItems: "flex-start", gap: "12px", marginBottom: "14px", flexWrap: "wrap" }}>
          <h1
            style={{
              fontSize: "26px",
              fontWeight: "700",
              color: "var(--text-primary)",
              margin: 0,
              lineHeight: "1.2",
              flex: 1,
              minWidth: 0,
            }}
          >
            {displayName}
          </h1>
          <div style={{ display: "flex", gap: "8px", alignItems: "center", flexShrink: 0, paddingTop: "4px" }}>
            <TypeBadge type={customer.customerType} />
            <StatusBadge status={customer.status} />
          </div>
        </div>

        {/* Contact row */}
        <div style={{ display: "flex", gap: "20px", flexWrap: "wrap", marginBottom: "20px" }}>
          <ContactInfoItem icon={faEnvelope} value={customer.email} />
          <ContactInfoItem icon={faPhone} value={customer.phone} mono />
          {customer.altPhone && (
            <ContactInfoItem icon={faPhone} value={`Alt: ${customer.altPhone}`} mono />
          )}
        </div>

        {/* Quick stats */}
        <div style={{ display: "flex", gap: "10px", flexWrap: "wrap" }}>
          <QuickStat label="Accounts" value={accounts.length} />
          <QuickStat label="Premises Owned" value={ownedPremises.length} />
          <QuickStat label="Active Agreements" value={activeAgreements} />
          <QuickStat label="Contacts" value={contacts.length} />
        </div>
      </div>

      {/* Customer ID chip */}
      <div style={{ marginBottom: "16px" }}>
        <span
          style={{
            fontSize: "11px",
            color: "var(--text-muted)",
            fontFamily: "monospace",
            background: "var(--bg-elevated)",
            border: "1px solid var(--border)",
            borderRadius: "4px",
            padding: "3px 8px",
          }}
        >
          ID: {customer.id}
        </span>
      </div>

      <Tabs
        tabs={[
          { key: "overview", label: "Overview" },
          { key: "accounts", label: `Accounts (${accounts.length})` },
          { key: "premises", label: `Owned Premises (${ownedPremises.length})` },
          { key: "contacts", label: `Contacts (${contacts.length})` },
        ]}
        activeTab={activeTab}
        onTabChange={setActiveTab}
      >
        {/* Overview tab */}
        {activeTab === "overview" && (
          <div
            style={{
              background: "var(--bg-card)",
              border: "1px solid var(--border)",
              borderRadius: "var(--radius)",
              padding: "20px 24px",
            }}
          >
            <div
              style={{
                fontSize: "11px",
                fontWeight: "600",
                color: "var(--text-muted)",
                textTransform: "uppercase",
                letterSpacing: "0.08em",
                marginBottom: "4px",
              }}
            >
              {customer.customerType === "ORGANIZATION" ? "Organization Details" : "Personal Details"}
            </div>

            {customer.customerType === "INDIVIDUAL" && (
              <>
                <div style={fieldStyle}>
                  <span style={labelStyle}>First Name</span>
                  <span style={valueStyle}>{customer.firstName ?? "—"}</span>
                </div>
                <div style={fieldStyle}>
                  <span style={labelStyle}>Last Name</span>
                  <span style={valueStyle}>{customer.lastName ?? "—"}</span>
                </div>
                {customer.dateOfBirth && (
                  <div style={fieldStyle}>
                    <span style={labelStyle}>Date of Birth</span>
                    <span style={valueStyle}>{customer.dateOfBirth.slice(0, 10)}</span>
                  </div>
                )}
                {customer.driversLicense && (
                  <div style={fieldStyle}>
                    <span style={labelStyle}>Driver&apos;s License</span>
                    <span style={{ ...valueStyle, fontFamily: "monospace" }}>
                      {customer.driversLicense}
                    </span>
                  </div>
                )}
              </>
            )}

            {customer.customerType === "ORGANIZATION" && (
              <>
                <div style={fieldStyle}>
                  <span style={labelStyle}>Organization Name</span>
                  <span style={valueStyle}>{customer.organizationName ?? "—"}</span>
                </div>
                {customer.taxId && (
                  <div style={fieldStyle}>
                    <span style={labelStyle}>Tax ID / EIN</span>
                    <span style={{ ...valueStyle, fontFamily: "monospace" }}>{customer.taxId}</span>
                  </div>
                )}
              </>
            )}

            {/* Contact section */}
            <div
              style={{
                fontSize: "11px",
                fontWeight: "600",
                color: "var(--text-muted)",
                textTransform: "uppercase",
                letterSpacing: "0.08em",
                marginTop: "20px",
                marginBottom: "4px",
              }}
            >
              Contact
            </div>

            <div style={fieldStyle}>
              <span style={labelStyle}>Email</span>
              <span style={valueStyle}>{customer.email ?? "—"}</span>
            </div>
            <div style={fieldStyle}>
              <span style={labelStyle}>Phone</span>
              <span style={{ ...valueStyle, fontFamily: "monospace" }}>{customer.phone ?? "—"}</span>
            </div>
            <div style={fieldStyle}>
              <span style={labelStyle}>Alt Phone</span>
              <span style={{ ...valueStyle, fontFamily: "monospace" }}>{customer.altPhone ?? "—"}</span>
            </div>

            {/* System section */}
            <div
              style={{
                fontSize: "11px",
                fontWeight: "600",
                color: "var(--text-muted)",
                textTransform: "uppercase",
                letterSpacing: "0.08em",
                marginTop: "20px",
                marginBottom: "4px",
              }}
            >
              System
            </div>

            <div style={fieldStyle}>
              <span style={labelStyle}>Status</span>
              <StatusBadge status={customer.status} />
            </div>
            {customer.createdAt && (
              <div style={fieldStyle}>
                <span style={labelStyle}>Created</span>
                <span style={valueStyle}>{new Date(customer.createdAt).toLocaleDateString()}</span>
              </div>
            )}
            {customer.updatedAt && (
              <div style={{ ...fieldStyle, borderBottom: "none" }}>
                <span style={labelStyle}>Last Updated</span>
                <span style={valueStyle}>{new Date(customer.updatedAt).toLocaleString()}</span>
              </div>
            )}
          </div>
        )}

        {/* Accounts tab */}
        {activeTab === "accounts" && (
          <DataTable
            columns={[
              {
                key: "accountNumber",
                header: "Account Number",
                render: (row: any) => (
                  <span style={{ fontFamily: "monospace", fontSize: "12px", fontWeight: 600 }}>
                    {row.accountNumber}
                  </span>
                ),
              },
              {
                key: "accountType",
                header: "Type",
                render: (row: any) => (
                  <span style={{ fontSize: "12px", color: "var(--text-secondary)" }}>
                    {row.accountType}
                  </span>
                ),
              },
              {
                key: "agreements",
                header: "Agreements",
                render: (row: any) => (
                  <span style={{ fontFamily: "monospace", fontSize: "12px" }}>
                    {row.serviceAgreements?.length ?? 0}
                  </span>
                ),
              },
              {
                key: "status",
                header: "Status",
                render: (row: any) => <StatusBadge status={row.status} />,
              },
            ]}
            data={accounts as any}
            onRowClick={(row: any) => router.push(`/accounts/${row.id}`)}
          />
        )}

        {/* Owned Premises tab */}
        {activeTab === "premises" && (
          <DataTable
            columns={[
              {
                key: "address",
                header: "Address",
                render: (row: any) => (
                  <span style={{ fontWeight: 500, color: "var(--text-primary)", fontSize: "13px" }}>
                    {row.addressLine1}
                    {row.city ? `, ${row.city}` : ""}
                    {row.state ? `, ${row.state}` : ""}
                    {row.postalCode ? ` ${row.postalCode}` : ""}
                  </span>
                ),
              },
              {
                key: "premiseType",
                header: "Type",
                render: (row: any) => (
                  <span style={{ fontSize: "12px", color: "var(--text-secondary)" }}>
                    {row.premiseType ?? "—"}
                  </span>
                ),
              },
              {
                key: "status",
                header: "Status",
                render: (row: any) => row.status ? <StatusBadge status={row.status} /> : <span style={{ color: "var(--text-muted)", fontSize: "12px" }}>—</span>,
              },
            ]}
            data={ownedPremises as any}
            onRowClick={(row: any) => router.push(`/premises/${row.id}`)}
          />
        )}

        {/* Contacts tab */}
        {activeTab === "contacts" && (
          <div>
            <div
              style={{
                display: "flex",
                justifyContent: "flex-end",
                marginBottom: "12px",
              }}
            >
              <button
                style={{
                  padding: "7px 16px",
                  borderRadius: "var(--radius)",
                  border: "none",
                  background: "var(--accent-primary)",
                  color: "#fff",
                  fontSize: "13px",
                  fontWeight: "500",
                  cursor: "pointer",
                  fontFamily: "inherit",
                }}
                onClick={() => {
                  // Navigate to add contact — link to first account if available
                  if (accounts.length > 0) {
                    router.push(`/accounts/${accounts[0].id}?tab=contacts`);
                  }
                }}
              >
                + Add Contact
              </button>
            </div>
            <DataTable
              columns={[
                {
                  key: "account",
                  header: "Account",
                  render: (row: any) => (
                    <span style={{ fontFamily: "monospace", fontSize: "12px", fontWeight: 600 }}>
                      {row.account?.accountNumber ?? "—"}
                    </span>
                  ),
                },
                {
                  key: "role",
                  header: "Role",
                  render: (row: any) => (
                    <span style={{ fontSize: "12px", color: "var(--text-secondary)" }}>
                      {row.role ?? "—"}
                    </span>
                  ),
                },
                {
                  key: "name",
                  header: "Name",
                  render: (row: any) => (
                    <span style={{ fontWeight: 500, color: "var(--text-primary)", fontSize: "13px" }}>
                      {`${row.firstName ?? ""} ${row.lastName ?? ""}`.trim() || "—"}
                    </span>
                  ),
                },
                {
                  key: "email",
                  header: "Email",
                  render: (row: any) => (
                    <span style={{ fontSize: "12px", color: "var(--text-secondary)" }}>
                      {row.email ?? "—"}
                    </span>
                  ),
                },
                {
                  key: "phone",
                  header: "Phone",
                  render: (row: any) => (
                    <span style={{ fontFamily: "monospace", fontSize: "12px", color: "var(--text-secondary)" }}>
                      {row.phone ?? "—"}
                    </span>
                  ),
                },
              ]}
              data={contacts as any}
            />
          </div>
        )}
      </Tabs>
    </div>
  );
}
