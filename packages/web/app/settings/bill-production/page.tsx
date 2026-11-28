"use client";

import { useMemo } from "react";
import {
  REQUIRED_ISSUER_FIELDS,
  type IssuerSettings,
  type BillDocumentSettings,
} from "@utility-cis/shared";
import {
  SettingsSection,
  SettingsCard,
  SettingRow,
  SettingsSaveBar,
  SettingPlaceholder,
  settingInputStyle,
} from "@/components/settings/settings-shell";
import { useTenantSettingsNamespace } from "@/lib/use-tenant-settings-namespace";
import { usePermission } from "@/lib/use-permission";
import { AccessDenied } from "@/components/ui/access-denied";

/**
 * What it takes to produce a bill: who the bill says it is from, where
 * payment is sent, and where the PDF is stored.
 *
 * One page rather than two sections on other tabs, because these fields
 * answer a single question — why a bill will not produce — and the API's
 * own 422 sends the operator to "Settings" to answer it. Splitting the
 * five mandatory issuer fields from the storage field would mean two
 * places to visit for one failure.
 *
 * Bill storage deliberately does not sit beside the SaaSLogic endpoint.
 * SaaSLogic is a payment rail; the bill store is reached through
 * apptor-connect. They are both "an integration" and nothing else, and
 * grouping by that word would file them together while they do unrelated
 * jobs.
 */

type IssuerShape = Required<IssuerSettings>;
type StorageShape = Required<BillDocumentSettings>;

const ISSUER_DEFAULTS: IssuerShape = {
  utilityName: "",
  utilityLegalName: "",
  remittanceAddressLine1: "",
  remittanceAddressLine2: "",
  remittanceCity: "",
  remittanceState: "",
  remittancePostalCode: "",
  billingPhone: "",
  billingEmail: "",
  websiteUrl: "",
};

const STORAGE_DEFAULTS: StorageShape = {
  storageIntegration: "",
  storageConnection: "",
};

/** Imported rather than retyped, so the page and the API's 422 agree. */
const REQUIRED = new Set<string>(REQUIRED_ISSUER_FIELDS);

function isRequired(field: keyof IssuerShape): boolean {
  return REQUIRED.has(field);
}

export default function BillProductionSettingsPage() {
  const { canView, canEdit } = usePermission("settings");

  const issuerDefaults = useMemo(() => ({ ...ISSUER_DEFAULTS }), []);
  const storageDefaults = useMemo(() => ({ ...STORAGE_DEFAULTS }), []);

  const issuer = useTenantSettingsNamespace<"issuer", IssuerShape>("issuer", issuerDefaults);
  const storage = useTenantSettingsNamespace<"billDocuments", StorageShape>(
    "billDocuments",
    storageDefaults,
  );

  if (!canView) return <AccessDenied />;

  const loading = issuer.loading || storage.loading;
  const missing = REQUIRED_ISSUER_FIELDS.filter(
    (f) => (issuer.draft[f] ?? "").trim() === "",
  );

  // Two namespaces, one save. Only the dirty one is sent, so an operator
  // who edited the issuer does not also get a "saved" for storage.
  async function saveBoth() {
    if (issuer.isDirty) await issuer.save();
    if (storage.isDirty) await storage.save();
  }

  function resetBoth() {
    issuer.reset();
    storage.reset();
  }

  if (loading) {
    return (
      <SettingsSection title="Bill Production" description={DESCRIPTION}>
        <p style={{ color: "var(--text-muted)", padding: "24px 0" }}>Loading…</p>
      </SettingsSection>
    );
  }

  return (
    <SettingsSection title="Bill Production" description={DESCRIPTION}>
      {/*
        Stated before the fields, not after a failed render. An operator
        who has not filled these in has no other way to find out, since
        the bill simply refuses with a 422 naming them.
      */}
      {missing.length > 0 && (
        <div style={WARNING}>
          <b>Bills cannot be produced yet.</b> A bill must say who issued it and where to
          send payment. Still needed: {missing.map(labelFor).join(", ")}.
        </div>
      )}

      <SettingsCard>
        <IssuerField
          field="utilityName"
          description="The name printed at the top of the bill, as customers know it."
          state={issuer}
          canEdit={canEdit}
        />
        <IssuerField
          field="utilityLegalName"
          description="The legal entity a cheque is made out to, when it differs from the name above. The remittance stub uses this when set."
          state={issuer}
          canEdit={canEdit}
        />
        <IssuerField
          field="remittanceAddressLine1"
          description="Where payment is sent — usually a PO box, not the office address."
          state={issuer}
          canEdit={canEdit}
        />
        <IssuerField field="remittanceAddressLine2" state={issuer} canEdit={canEdit} />
        <IssuerField field="remittanceCity" state={issuer} canEdit={canEdit} />
        <IssuerField field="remittanceState" state={issuer} canEdit={canEdit} />
        <IssuerField field="remittancePostalCode" state={issuer} canEdit={canEdit} />
        <IssuerField
          field="billingPhone"
          description="Printed on the bill so a customer with a question can call."
          state={issuer}
          canEdit={canEdit}
        />
        <IssuerField field="billingEmail" type="email" state={issuer} canEdit={canEdit} />
        <IssuerField field="websiteUrl" type="url" state={issuer} canEdit={canEdit} />
      </SettingsCard>

      <div style={{ marginTop: 24 }}>
        <SettingsCard>
          <SettingRow
            label="Bill storage integration"
            description="The apptor-connect integration holding this tenant's bill PDFs. The integration name selects the backend — S3, Azure Blob or GCS — on their side; no bucket name, region or credential belongs here."
            control={
              <input
                type="text"
                style={{ ...settingInputStyle, width: "260px" }}
                value={storage.draft.storageIntegration}
                disabled={!canEdit}
                placeholder="cis-bills"
                onChange={(e) =>
                  storage.setDraft({ ...storage.draft, storageIntegration: e.target.value })
                }
              />
            }
          />
          <SettingRow
            label="Named connection"
            description="Only when the integration defines more than one connection. Leave empty otherwise."
            control={
              <input
                type="text"
                style={{ ...settingInputStyle, width: "260px" }}
                value={storage.draft.storageConnection}
                disabled={!canEdit}
                onChange={(e) =>
                  storage.setDraft({ ...storage.draft, storageConnection: e.target.value })
                }
              />
            }
          />
        </SettingsCard>
      </div>

      <SettingsSaveBar
        saving={issuer.saving || storage.saving}
        isDirty={issuer.isDirty || storage.isDirty}
        canEdit={canEdit}
        onSave={saveBoth}
        onReset={resetBoth}
      />

      <div style={{ marginTop: 20 }}>
        <SettingPlaceholder>
          Bill delivery — email to paperless customers, and a print-vendor export for the
          rest — is not built. These settings govern producing and storing the PDF, which
          staff and customers download through the CIS.
        </SettingPlaceholder>
      </div>
    </SettingsSection>
  );
}

const DESCRIPTION =
  "Who the bill says it is from, where payment is sent, and where the stored PDF lives. A bill cannot be produced until the required fields are filled in.";

/** Field labels, so a warning names fields the way the form does. */
const LABELS: Record<keyof IssuerShape, string> = {
  utilityName: "Utility name",
  utilityLegalName: "Legal name",
  remittanceAddressLine1: "Remittance address",
  remittanceAddressLine2: "Remittance address line 2",
  remittanceCity: "City",
  remittanceState: "State",
  remittancePostalCode: "Postal code",
  billingPhone: "Billing phone",
  billingEmail: "Billing email",
  websiteUrl: "Website",
};

function labelFor(field: keyof IssuerShape): string {
  return LABELS[field];
}

function IssuerField({
  field,
  description,
  type = "text",
  state,
  canEdit,
}: {
  field: keyof IssuerShape;
  description?: string;
  type?: "text" | "email" | "url";
  state: ReturnType<typeof useTenantSettingsNamespace<"issuer", IssuerShape>>;
  canEdit: boolean;
}) {
  const required = isRequired(field);
  const empty = (state.draft[field] ?? "").trim() === "";
  return (
    <SettingRow
      label={required ? `${LABELS[field]} *` : LABELS[field]}
      description={description}
      control={
        <input
          type={type}
          aria-label={LABELS[field]}
          aria-required={required}
          style={{
            ...settingInputStyle,
            width: "340px",
            // Only on a required field left blank: an optional empty
            // field is not a problem and must not look like one.
            borderColor: required && empty ? "var(--warning)" : undefined,
          }}
          value={state.draft[field]}
          disabled={!canEdit}
          onChange={(e) => state.setDraft({ ...state.draft, [field]: e.target.value })}
        />
      }
    />
  );
}

const WARNING: React.CSSProperties = {
  padding: "12px 16px",
  marginBottom: 20,
  fontSize: 13,
  lineHeight: 1.6,
  color: "var(--text-primary)",
  background: "color-mix(in srgb, var(--warning) 12%, transparent)",
  border: "1px solid var(--warning)",
  borderRadius: "var(--radius)",
};
