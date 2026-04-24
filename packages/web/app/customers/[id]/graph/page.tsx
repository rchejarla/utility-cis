"use client";

import { use } from "react";
import { CustomerGraphView } from "@/components/customer-graph/customer-graph-view";

/**
 * Customer graph surface — visual overview of the customer's related
 * accounts, premises, agreements, meters, and service requests.
 *
 * Spec: docs/superpowers/specs/2026-04-24-customer-graph-view.md
 */
export default function CustomerGraphPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  return <CustomerGraphView customerId={id} />;
}
