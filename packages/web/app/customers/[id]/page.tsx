"use client";

import { useState, useEffect, use } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faEnvelope, faPhone } from "@fortawesome/pro-solid-svg-icons";
import type { FieldDefinition } from "@utility-cis/shared";
import { PageHeader } from "@/components/ui/page-header";
import { Tabs } from "@/components/ui/tabs";
import { StatusBadge } from "@/components/ui/status-badge";
import { TypeBadge } from "@/components/ui/type-badge";
import { DataTable } from "@/components/ui/data-table";
import { DatePicker } from "@/components/ui/date-picker";
import { AccountsTab } from "@/components/customers/accounts-tab";
import { AttachmentsTab } from "@/components/ui/attachments-tab";
import { CustomerBillsTab } from "@/components/billing/customer-bills-tab";
import { CustomFieldsSection } from "@/components/ui/custom-fields-section";
import { apiClient } from "@/lib/api-client";
import { useToast } from "@/components/ui/toast";
import { usePermission } from "@/lib/use-permission";
import { AccessDenied } from "@/components/ui/access-denied";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";

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
  _count?: { serviceAgreements: number };
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
  customFields?: Record<string, unknown>;
  accounts?: Account[];
  contacts?: Contact[];
  ownedPremises?: Premise[];
  createdAt?: string;
  updatedAt?: string;
}

const CUSTOMER_STATUSES = ["ACTIVE", "INACTIVE", "SUSPENDED", "CLOSED"];

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

// Detail-page inline inputs deliberately use the darker --bg-deep
// background instead of --bg-elevated (which is the form-shell
// convention used by EntityFormPage). Reason: on a data-heavy read
// surface, the darker input slot gives a clearer "this is an edit
// affordance" signal. The Custom Fields section receives this same
// style via its `inputStyle` prop so it matches.
const inputStyle = {
  padding: "6px 10px",
  fontSize: "13px",
  background: "var(--bg-deep)",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius)",
  color: "var(--text-primary)",
  fontFamily: "inherit",
  outline: "none",
  width: "100%",
};

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
  const { toast } = useToast();
  const { canView, canEdit, canDelete } = usePermission("customers");
  const { canCreate: canCreateAccount } = usePermission("accounts");
  const [customer, setCustomer] = useState<Customer | null>(null);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState("overview");
  const [editing, setEditing] = useState(false);
  const [editForm, setEditForm] = useState<Record<string, string>>({});
  // Separate state bucket for the tenant-configurable custom fields
  // because their value types (string/number/date/boolean/enum) don't
  // fit the plain Record<string, string> shape the rest of editForm
  // uses. Seeded on handleEdit from customer.customFields.
  const [editCustomFields, setEditCustomFields] = useState<Record<string, unknown>>({});
  const [customFieldSchema, setCustomFieldSchema] = useState<FieldDefinition[]>([]);
  const [saving, setSaving] = useState(false);
  const [showDeactivateConfirm, setShowDeactivateConfirm] = useState(false);
  const [deactivating, setDeactivating] = useState(false);
  const [showAddAccount, setShowAddAccount] = useState(false);
  const [showUpload, setShowUpload] = useState(false);

  const loadCustomer = async () => {
    try {
      const data = await apiClient.get<Customer>(`/api/v1/customers/${id}`);
      setCustomer(data);
      return data;
    } catch (err) {
      console.error("Failed to load customer", err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadCustomer();
  }, [id]);

  // Load the tenant's custom-field schema once on mount. Separate
  // from loadCustomer because the schema is tenant-scoped config,
  // not per-customer, and we want it to survive customer reloads
  // without refetching.
  useEffect(() => {
    (async () => {
      try {
        const res = await apiClient.get<{ fields: FieldDefinition[] }>(
          "/api/v1/custom-fields/customer",
        );
        setCustomFieldSchema(res.fields ?? []);
      } catch (err) {
        console.error("[customers/detail] failed to load custom field schema", err);
        setCustomFieldSchema([]);
      }
    })();
  }, []);

  const handleEdit = () => {
    if (!customer) return;
    setEditForm({
      firstName: customer.firstName ?? "",
      lastName: customer.lastName ?? "",
      organizationName: customer.organizationName ?? "",
      email: customer.email ?? "",
      phone: customer.phone ?? "",
      altPhone: customer.altPhone ?? "",
      dateOfBirth: customer.dateOfBirth ? customer.dateOfBirth.slice(0, 10) : "",
      driversLicense: customer.driversLicense ?? "",
      taxId: customer.taxId ?? "",
      status: customer.status ?? "",
    });
    // Seed custom-field edit state from the currently stored values.
    // Shallow-clone so the input components can mutate freely without
    // affecting the view-mode display if the user cancels.
    setEditCustomFields({ ...(customer.customFields ?? {}) });
    setEditing(true);
  };

  const handleCancel = () => {
    setEditing(false);
    setEditForm({});
    setEditCustomFields({});
  };

  const handleDeactivate = async () => {
    if (!customer) return;
    setDeactivating(true);
    try {
      await apiClient.patch(`/api/v1/customers/${id}`, { status: "INACTIVE" });
      await loadCustomer();
      setShowDeactivateConfirm(false);
      toast("Customer deactivated successfully", "success");
    } catch (err: any) {
      toast(err.message || "Failed to deactivate customer", "error");
    } finally {
      setDeactivating(false);
    }
  };

  const handleSave = async () => {
    if (!customer) return;
    setSaving(true);
    try {
      const changes: Record<string, unknown> = {};
      if (customer.customerType === "INDIVIDUAL") {
        if (editForm.firstName !== (customer.firstName ?? "")) changes.firstName = editForm.firstName;
        if (editForm.lastName !== (customer.lastName ?? "")) changes.lastName = editForm.lastName;
        if (editForm.dateOfBirth !== (customer.dateOfBirth ? customer.dateOfBirth.slice(0, 10) : ""))
          changes.dateOfBirth = editForm.dateOfBirth || null;
        if (editForm.driversLicense !== (customer.driversLicense ?? "")) changes.driversLicense = editForm.driversLicense;
      }
      if (customer.customerType === "ORGANIZATION") {
        if (editForm.organizationName !== (customer.organizationName ?? "")) changes.organizationName = editForm.organizationName;
        if (editForm.taxId !== (customer.taxId ?? "")) changes.taxId = editForm.taxId;
      }
      if (editForm.email !== (customer.email ?? "")) changes.email = editForm.email;
      if (editForm.phone !== (customer.phone ?? "")) changes.phone = editForm.phone;
      if (editForm.altPhone !== (customer.altPhone ?? "")) changes.altPhone = editForm.altPhone;
      if (editForm.status !== (customer.status ?? "")) changes.status = editForm.status;

      // Custom fields: send the whole customFields bucket if any
      // value differs from the stored state. The backend's
      // validateCustomFields handles the merge with existing stored
      // values, so the patch only needs to include the keys that
      // changed — but sending the whole object is fine too and
      // simpler on the client. The deep-equality check keeps the
      // PATCH body tidy when nothing changed.
      const storedCustomJson = JSON.stringify(customer.customFields ?? {});
      const editedCustomJson = JSON.stringify(editCustomFields ?? {});
      if (storedCustomJson !== editedCustomJson) {
        changes.customFields = editCustomFields;
      }

      await apiClient.patch(`/api/v1/customers/${id}`, changes);
      await loadCustomer();
      setEditing(false);
      toast("Customer updated successfully", "success");
    } catch (err: any) {
      toast(err.message || "Failed to save customer", "error");
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return <div style={{ color: "var(--text-muted)", padding: "40px 0" }}>Loading...</div>;
  }
  if (!canView) return <AccessDenied />;
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
            <TypeBadge type={customer.customerType} variant="detail" />
            <StatusBadge status={customer.status} />
            {/* Muted secondary action — opens the visual relationship
                graph for this customer. Kept next to the badges (not
                a prominent CTA) because it's a navigation affordance,
                not an edit action. */}
            <Link
              href={`/customers/${customer.id}/graph`}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: "4px",
                padding: "3px 10px",
                borderRadius: "var(--radius)",
                background: "transparent",
                border: "1px solid var(--border)",
                color: "var(--text-secondary)",
                fontSize: "12px",
                fontWeight: 500,
                textDecoration: "none",
                whiteSpace: "nowrap",
              }}
            >
              View as graph &rarr;
            </Link>
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
          { key: "bills", label: "Bills" },
          { key: "attachments", label: "Attachments" },
        ]}
        activeTab={activeTab}
        onTabChange={(key) => {
          setActiveTab(key);
          if (key !== "accounts") setShowAddAccount(false);
          setShowUpload(false);
        }}
        action={
          activeTab === "accounts" && canCreateAccount ? (
            <button
              onClick={() => setShowAddAccount((v) => !v)}
              style={{
                padding: "6px 14px",
                fontSize: "12px",
                fontWeight: 500,
                background: showAddAccount ? "transparent" : "var(--accent-primary)",
                color: showAddAccount ? "var(--text-secondary)" : "#fff",
                border: showAddAccount ? "1px solid var(--border)" : "none",
                borderRadius: "var(--radius)",
                cursor: "pointer",
                fontFamily: "inherit",
              }}
            >
              {showAddAccount ? "Cancel" : "+ Add Account"}
            </button>
          ) : activeTab === "attachments" && !showUpload ? (
            <button
              onClick={() => setShowUpload(true)}
              style={{
                padding: "5px 12px",
                fontSize: "12px",
                fontWeight: 500,
                background: "var(--accent-primary)",
                color: "#fff",
                border: "none",
                borderRadius: "var(--radius, 10px)",
                cursor: "pointer",
                fontFamily: "inherit",
                marginBottom: "2px",
              }}
            >
              + Upload
            </button>
          ) : undefined
        }
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
            {/* Edit / Save / Cancel buttons */}
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "12px", gap: "8px" }}>
              <div>
                {canDelete && !editing && customer.status === "ACTIVE" && (
                  <button
                    onClick={() => setShowDeactivateConfirm(true)}
                    title="BR-CU-004: Customer can only be deactivated if all accounts are closed or inactive."
                    style={{ padding: "6px 14px", fontSize: "12px", background: "transparent", border: "1px solid var(--danger)", borderRadius: "var(--radius)", color: "var(--danger)", cursor: "pointer", fontFamily: "inherit" }}
                  >
                    Deactivate Customer
                  </button>
                )}
              </div>
              <div style={{ display: "flex", gap: "8px" }}>
                {editing ? (
                  <>
                    <button
                      onClick={handleCancel}
                      style={{ padding: "6px 14px", fontSize: "12px", background: "transparent", border: "1px solid var(--border)", borderRadius: "var(--radius)", color: "var(--text-secondary)", cursor: "pointer", fontFamily: "inherit" }}
                    >
                      Cancel
                    </button>
                    <button
                      onClick={handleSave}
                      disabled={saving}
                      style={{ padding: "6px 14px", fontSize: "12px", background: "var(--accent-primary)", color: "#fff", border: "none", borderRadius: "var(--radius)", cursor: saving ? "not-allowed" : "pointer", fontFamily: "inherit", opacity: saving ? 0.7 : 1 }}
                    >
                      {saving ? "Saving..." : "Save"}
                    </button>
                  </>
                ) : canEdit ? (
                  <button
                    onClick={handleEdit}
                    style={{ padding: "6px 14px", fontSize: "12px", background: "transparent", border: "1px solid var(--border)", borderRadius: "var(--radius)", color: "var(--text-secondary)", cursor: "pointer", fontFamily: "inherit" }}
                  >
                    Edit
                  </button>
                ) : null}
              </div>
            </div>

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
                  {editing ? (
                    <input
                      style={inputStyle}
                      value={editForm.firstName}
                      onChange={(e) => setEditForm((f) => ({ ...f, firstName: e.target.value }))}
                    />
                  ) : (
                    <span style={valueStyle}>{customer.firstName ?? "—"}</span>
                  )}
                </div>
                <div style={fieldStyle}>
                  <span style={labelStyle}>Last Name</span>
                  {editing ? (
                    <input
                      style={inputStyle}
                      value={editForm.lastName}
                      onChange={(e) => setEditForm((f) => ({ ...f, lastName: e.target.value }))}
                    />
                  ) : (
                    <span style={valueStyle}>{customer.lastName ?? "—"}</span>
                  )}
                </div>
                <div style={fieldStyle}>
                  <span style={labelStyle}>Date of Birth</span>
                  {editing ? (
                    <DatePicker
                      value={editForm.dateOfBirth}
                      onChange={(v) => setEditForm((f) => ({ ...f, dateOfBirth: v }))}
                    />
                  ) : (
                    <span style={valueStyle}>{customer.dateOfBirth ? customer.dateOfBirth.slice(0, 10) : "—"}</span>
                  )}
                </div>
                <div style={fieldStyle}>
                  <span style={labelStyle}>Driver&apos;s License</span>
                  {editing ? (
                    <input
                      style={{ ...inputStyle, fontFamily: "monospace" }}
                      value={editForm.driversLicense}
                      onChange={(e) => setEditForm((f) => ({ ...f, driversLicense: e.target.value }))}
                    />
                  ) : (
                    <span style={{ ...valueStyle, fontFamily: "monospace" }}>
                      {customer.driversLicense ?? "—"}
                    </span>
                  )}
                </div>
              </>
            )}

            {customer.customerType === "ORGANIZATION" && (
              <>
                <div style={fieldStyle}>
                  <span style={labelStyle}>Organization Name</span>
                  {editing ? (
                    <input
                      style={inputStyle}
                      value={editForm.organizationName}
                      onChange={(e) => setEditForm((f) => ({ ...f, organizationName: e.target.value }))}
                    />
                  ) : (
                    <span style={valueStyle}>{customer.organizationName ?? "—"}</span>
                  )}
                </div>
                <div style={fieldStyle}>
                  <span style={labelStyle}>Tax ID / EIN</span>
                  {editing ? (
                    <input
                      style={{ ...inputStyle, fontFamily: "monospace" }}
                      value={editForm.taxId}
                      onChange={(e) => setEditForm((f) => ({ ...f, taxId: e.target.value }))}
                    />
                  ) : (
                    <span style={{ ...valueStyle, fontFamily: "monospace" }}>{customer.taxId ?? "—"}</span>
                  )}
                </div>
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
              {editing ? (
                <input
                  style={inputStyle}
                  type="email"
                  value={editForm.email}
                  onChange={(e) => setEditForm((f) => ({ ...f, email: e.target.value }))}
                />
              ) : (
                <span style={valueStyle}>{customer.email ?? "—"}</span>
              )}
            </div>
            <div style={fieldStyle}>
              <span style={labelStyle}>Phone</span>
              {editing ? (
                <input
                  style={{ ...inputStyle, fontFamily: "monospace" }}
                  value={editForm.phone}
                  onChange={(e) => setEditForm((f) => ({ ...f, phone: e.target.value }))}
                />
              ) : (
                <span style={{ ...valueStyle, fontFamily: "monospace" }}>{customer.phone ?? "—"}</span>
              )}
            </div>
            <div style={fieldStyle}>
              <span style={labelStyle}>Alt Phone</span>
              {editing ? (
                <input
                  style={{ ...inputStyle, fontFamily: "monospace" }}
                  value={editForm.altPhone}
                  onChange={(e) => setEditForm((f) => ({ ...f, altPhone: e.target.value }))}
                />
              ) : (
                <span style={{ ...valueStyle, fontFamily: "monospace" }}>{customer.altPhone ?? "—"}</span>
              )}
            </div>

            {/*
             * Custom Fields section — tenant-configurable.
             *
             * View mode: render one line per active field using the
             * same fieldStyle/labelStyle/valueStyle grid as the built-
             * in fields, so the section looks like a native part of
             * the detail page. Deprecated fields still appear when
             * the customer has stored values for them (greyed out)
             * so legacy data remains visible.
             *
             * Edit mode: hand off to <CustomFieldsSection>, the same
             * form renderer the /customers/new page uses, bound to
             * editCustomFields. On save, handleSave diffs
             * editCustomFields against customer.customFields and
             * includes it in the PATCH body if anything changed.
             *
             * Renders nothing when the tenant has no schema
             * configured AND the customer has no stored values, so
             * untouched tenants see no change to the page.
             */}
            {(() => {
              const stored = customer.customFields ?? {};
              const hasSchema = customFieldSchema.length > 0;
              const hasStoredValues = Object.keys(stored).length > 0;
              if (!hasSchema && !hasStoredValues) return null;

              if (editing) {
                return (
                  <>
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
                      Custom Fields
                    </div>
                    <CustomFieldsSection
                      schema={customFieldSchema}
                      values={editCustomFields}
                      onChange={setEditCustomFields}
                      inputStyle={inputStyle}
                      fieldStyle={fieldStyle}
                      labelStyle={labelStyle}
                      hideHeader
                    />
                  </>
                );
              }

              // View mode: build display rows from the schema + stored
              // values, matching the built-in field layout.
              const activeFields = customFieldSchema.filter((f) => !f.deprecated);
              const deprecatedWithValue = customFieldSchema.filter(
                (f) => f.deprecated && stored[f.key] !== undefined && stored[f.key] !== null,
              );
              activeFields.sort((a, b) => a.order - b.order || a.key.localeCompare(b.key));
              deprecatedWithValue.sort((a, b) => a.order - b.order || a.key.localeCompare(b.key));

              const renderValue = (field: FieldDefinition) => {
                const v = stored[field.key];
                if (v === undefined || v === null || v === "") return "—";
                if (field.type === "boolean") return v ? "Yes" : "No";
                if (field.type === "enum") {
                  const match = field.enumOptions?.find((o) => o.value === v);
                  return match?.label ?? String(v);
                }
                return String(v);
              };

              return (
                <>
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
                    Custom Fields
                  </div>
                  {activeFields.map((field) => (
                    <div key={field.key} style={fieldStyle}>
                      <span style={labelStyle}>{field.label}</span>
                      <span style={valueStyle}>{renderValue(field)}</span>
                    </div>
                  ))}
                  {deprecatedWithValue.map((field) => (
                    <div key={field.key} style={{ ...fieldStyle, opacity: 0.6 }}>
                      <span style={labelStyle}>
                        {field.label}
                        <span
                          style={{
                            fontSize: 9,
                            color: "var(--danger)",
                            marginLeft: 6,
                            letterSpacing: "0.06em",
                            textTransform: "uppercase",
                          }}
                        >
                          deprecated
                        </span>
                      </span>
                      <span style={valueStyle}>{renderValue(field)}</span>
                    </div>
                  ))}
                  {activeFields.length === 0 && deprecatedWithValue.length === 0 && (
                    <div style={{ ...fieldStyle, color: "var(--text-muted)", fontStyle: "italic" }}>
                      <span style={labelStyle}>—</span>
                      <span style={valueStyle}>No custom fields configured</span>
                    </div>
                  )}
                </>
              );
            })()}

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
              {editing ? (
                <select
                  style={inputStyle}
                  value={editForm.status}
                  onChange={(e) => setEditForm((f) => ({ ...f, status: e.target.value }))}
                >
                  {CUSTOMER_STATUSES.map((s) => (
                    <option key={s} value={s}>{s}</option>
                  ))}
                </select>
              ) : (
                <StatusBadge status={customer.status} />
              )}
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

        {showDeactivateConfirm && (
          <ConfirmDialog
            title="Confirm Deactivation"
            message="Are you sure you want to deactivate this customer? This will set their status to INACTIVE."
            confirmLabel={deactivating ? "Processing..." : "Confirm"}
            confirmDisabled={deactivating}
            onConfirm={handleDeactivate}
            onCancel={() => setShowDeactivateConfirm(false)}
          />
        )}

        {/* Accounts tab */}
        {activeTab === "accounts" && (
          <AccountsTab
            customerId={customer.id}
            data={accounts}
            onAccountAdded={loadCustomer}
            showForm={showAddAccount}
            onShowFormChange={(v) => setShowAddAccount(v)}
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
              {canCreateAccount && (
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
              )}
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

        {activeTab === "bills" && (
          <CustomerBillsTab
            customerId={id}
            primaryPremiseLabel={
              ownedPremises[0]
                ? `${ownedPremises[0].addressLine1}, ${ownedPremises[0].city}`
                : "—"
            }
          />
        )}

        {activeTab === "attachments" && (
          <AttachmentsTab entityType="Customer" entityId={id} showForm={showUpload} onShowFormChange={setShowUpload} />
        )}
      </Tabs>
    </div>
  );
}
