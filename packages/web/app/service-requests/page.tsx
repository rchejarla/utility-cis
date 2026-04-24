"use client";

import { PageDescription } from "@/components/ui/page-description";
import { ServiceRequestList } from "@/components/service-requests/request-list";

export default function ServiceRequestsPage() {
  return (
    <ServiceRequestList
      createHref="/service-requests/new"
      emptyState={{
        headline: "No service requests yet",
        description:
          "Log a leak report, disconnect, billing dispute, or any other customer-reported work item — each one starts an SLA timer when it's opened.",
      }}
      headerSlot={
        <PageDescription storageKey="service-requests">
          A <b>service request</b> is a work item filed by a customer or an
          internal user — leak report, disconnect, billing dispute, meter
          re-read. Each request has a status lifecycle and an <b>SLA timer</b>
          that starts when it's opened; breach is computed at completion by
          comparing total elapsed time against the SLA window, not continuously
          in the background.
        </PageDescription>
      }
    />
  );
}
