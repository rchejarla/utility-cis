"use client";

import { ImportWizard } from "@/components/imports/import-wizard";
import { usePermission } from "@/lib/use-permission";
import { AccessDenied } from "@/components/ui/access-denied";

/**
 * Customer import page. Mounts the generic <ImportWizard> with
 * kind="customer". The wizard handles upload → mapping → preview →
 * commit; the customer kind handler in the API knows what to do
 * with each row.
 */
export default function CustomerImportPage() {
  const { canCreate } = usePermission("customers");
  if (!canCreate) return <AccessDenied />;
  return <ImportWizard kind="customer" />;
}
