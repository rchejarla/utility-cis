"use client";

import { DatePicker } from "@/components/ui/date-picker";
import { EntityFormPage } from "@/components/ui/entity-form-page";

interface CustomerForm extends Record<string, unknown> {
  customerType: "INDIVIDUAL" | "ORGANIZATION";
  firstName: string;
  lastName: string;
  dateOfBirth: string;
  driversLicense: string;
  organizationName: string;
  taxId: string;
  email: string;
  phone: string;
  altPhone: string;
}

const toggleStyle = (active: boolean) => ({
  flex: 1,
  padding: "9px 0",
  borderRadius: "calc(var(--radius) - 2px)",
  border: "none",
  background: active ? "var(--accent-primary)" : "transparent",
  color: active ? "#fff" : "var(--text-secondary)",
  fontSize: "13px",
  fontWeight: active ? 600 : 400,
  cursor: "pointer",
  fontFamily: "inherit" as const,
  transition: "all 0.15s ease",
});

const isIndividual = (v: CustomerForm) => v.customerType === "INDIVIDUAL";
const isOrganization = (v: CustomerForm) => v.customerType === "ORGANIZATION";

export default function NewCustomerPage() {
  return (
    <EntityFormPage<CustomerForm>
      title="Add Customer"
      subtitle="Create a new customer record"
      module="customers"
      endpoint="/api/v1/customers"
      returnTo="/customers"
      submitLabel="Create Customer"
      initialValues={{
        customerType: "INDIVIDUAL",
        firstName: "",
        lastName: "",
        dateOfBirth: "",
        driversLicense: "",
        organizationName: "",
        taxId: "",
        email: "",
        phone: "",
        altPhone: "",
      }}
      fields={[
        {
          key: "customerType",
          label: "Customer Type",
          type: "custom",
          hint: "BR-CU-003: Customer type cannot be changed after creation",
          render: ({ value, setValue }) => (
            <div
              style={{
                display: "flex",
                gap: "4px",
                padding: "4px",
                background: "var(--bg-elevated)",
                borderRadius: "var(--radius)",
                border: "1px solid var(--border)",
              }}
            >
              <button
                type="button"
                onClick={() => setValue("INDIVIDUAL" as never)}
                style={toggleStyle(value === "INDIVIDUAL")}
              >
                Individual
              </button>
              <button
                type="button"
                onClick={() => setValue("ORGANIZATION" as never)}
                style={toggleStyle(value === "ORGANIZATION")}
              >
                Organization
              </button>
            </div>
          ),
        },
        {
          row: [
            {
              key: "firstName",
              label: "First Name",
              type: "text",
              required: true,
              placeholder: "Jane",
              visibleWhen: isIndividual,
            },
            {
              key: "lastName",
              label: "Last Name",
              type: "text",
              required: true,
              placeholder: "Smith",
              visibleWhen: isIndividual,
            },
          ],
        },
        {
          row: [
            {
              key: "dateOfBirth",
              label: "Date of Birth",
              type: "custom",
              visibleWhen: isIndividual,
              render: ({ value, setValue }) => (
                <DatePicker
                  value={String(value ?? "")}
                  onChange={(v) => setValue(v as never)}
                  placeholder="Select date..."
                />
              ),
            },
            {
              key: "driversLicense",
              label: "Driver's License",
              type: "text",
              placeholder: "DL-12345678",
              visibleWhen: isIndividual,
            },
          ],
        },
        {
          key: "organizationName",
          label: "Organization Name",
          type: "text",
          required: true,
          placeholder: "Acme Corporation",
          visibleWhen: isOrganization,
        },
        {
          key: "taxId",
          label: "Tax ID / EIN",
          type: "text",
          placeholder: "12-3456789",
          hint: "e.g. 12-3456789",
          visibleWhen: isOrganization,
        },
        {
          key: "email",
          label: "Email",
          type: "text",
          placeholder: "customer@example.com",
          hint: "Used for notifications and portal access",
        },
        {
          row: [
            {
              key: "phone",
              label: "Phone",
              type: "text",
              placeholder: "(555) 000-0000",
            },
            {
              key: "altPhone",
              label: "Alternate Phone",
              type: "text",
              placeholder: "(555) 000-0000",
            },
          ],
        },
      ]}
      toRequestBody={(form) => {
        const body: Record<string, unknown> = {
          customerType: form.customerType,
        };
        if (form.email) body.email = form.email;
        if (form.phone) body.phone = form.phone;
        if (form.altPhone) body.altPhone = form.altPhone;

        if (form.customerType === "INDIVIDUAL") {
          body.firstName = form.firstName;
          body.lastName = form.lastName;
          if (form.dateOfBirth) body.dateOfBirth = form.dateOfBirth;
          if (form.driversLicense) body.driversLicense = form.driversLicense;
        } else {
          body.organizationName = form.organizationName;
          if (form.taxId) body.taxId = form.taxId;
        }
        return body;
      }}
      onSuccess={(response) => {
        const id = (response as { id?: string })?.id;
        return id ? `/customers/${id}` : undefined;
      }}
    />
  );
}
