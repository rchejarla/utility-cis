"use client";

import { ServiceRequestList } from "@/components/service-requests/request-list";

export default function ServiceRequestsPage() {
  return <ServiceRequestList createHref="/service-requests/new" />;
}
