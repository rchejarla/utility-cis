"use client";

import { EntityFormPage } from "@/components/ui/entity-form-page";

interface ContainerForm extends Record<string, unknown> {
  premiseId: string;
  serviceAgreementId: string;
  containerType: string;
  sizeGallons: string;
  quantity: string;
  serialNumber: string;
  rfidTag: string;
  deliveryDate: string;
  ramsContainerId: string;
  locationNotes: string;
}

const TYPES = [
  { value: "CART_GARBAGE", label: "Garbage cart" },
  { value: "CART_RECYCLING", label: "Recycling cart" },
  { value: "CART_ORGANICS", label: "Organics cart" },
  { value: "CART_YARD_WASTE", label: "Yard waste cart" },
  { value: "DUMPSTER", label: "Dumpster" },
  { value: "ROLL_OFF", label: "Roll-off" },
];

const SIZES = [
  { value: "32", label: "32 gal" },
  { value: "64", label: "64 gal" },
  { value: "96", label: "96 gal" },
  { value: "300", label: "300 gal (dumpster)" },
  { value: "1000", label: "1000 gal (dumpster)" },
  { value: "10000", label: "10 yd (roll-off)" },
];

export default function NewContainerPage() {
  return (
    <EntityFormPage<ContainerForm>
      title="Assign Container"
      subtitle="Deliver a container to a premise and optionally link to a service agreement"
      module="containers"
      endpoint="/api/v1/containers"
      returnTo="/containers"
      submitLabel="Assign Container"
      maxWidth="640px"
      initialValues={{
        premiseId: "",
        serviceAgreementId: "",
        containerType: "CART_GARBAGE",
        sizeGallons: "96",
        quantity: "1",
        serialNumber: "",
        rfidTag: "",
        deliveryDate: new Date().toISOString().slice(0, 10),
        ramsContainerId: "",
        locationNotes: "",
      }}
      fields={[
        {
          key: "premiseId",
          label: "Premise",
          type: "select",
          required: true,
          emptyOption: "Select premise...",
          options: {
            endpoint: "/api/v1/premises",
            params: { limit: "500" },
            mapOption: (p) => ({
              value: String(p.id),
              label: `${p.addressLine1}, ${p.city}`,
            }),
          },
        },
        {
          key: "serviceAgreementId",
          label: "Service Agreement (optional)",
          type: "select",
          emptyOption: "No agreement link",
          hint: "Containers can exist on a premise before an agreement is set up",
          options: {
            endpoint: "/api/v1/service-agreements",
            params: { limit: "500" },
            mapOption: (a) => ({
              value: String(a.id),
              label: String(a.agreementNumber),
            }),
          },
        },
        {
          row: [
            { key: "containerType", label: "Type", type: "select", required: true, options: TYPES },
            { key: "sizeGallons", label: "Size", type: "select", required: true, options: SIZES },
            { key: "quantity", label: "Qty", type: "number", min: "1", placeholder: "1" },
          ],
        },
        {
          row: [
            { key: "serialNumber", label: "Serial Number", type: "text", placeholder: "e.g. SN-123456" },
            { key: "rfidTag", label: "RFID Tag", type: "text", placeholder: "optional" },
          ],
        },
        {
          row: [
            { key: "deliveryDate", label: "Delivery Date", type: "date", required: true },
            { key: "ramsContainerId", label: "RAMS ID", type: "text", placeholder: "optional" },
          ],
        },
        {
          key: "locationNotes",
          label: "Pickup Location Notes",
          type: "text",
          placeholder: 'e.g. "alley behind garage"',
        },
      ]}
      toRequestBody={(form) => {
        const body: Record<string, unknown> = {
          premiseId: form.premiseId,
          containerType: form.containerType,
          sizeGallons: parseInt(form.sizeGallons, 10),
          quantity: parseInt(form.quantity, 10) || 1,
          deliveryDate: form.deliveryDate,
        };
        if (form.serviceAgreementId) body.serviceAgreementId = form.serviceAgreementId;
        if (form.serialNumber) body.serialNumber = form.serialNumber;
        if (form.rfidTag) body.rfidTag = form.rfidTag;
        if (form.ramsContainerId) body.ramsContainerId = form.ramsContainerId;
        if (form.locationNotes) body.locationNotes = form.locationNotes;
        return body;
      }}
    />
  );
}
