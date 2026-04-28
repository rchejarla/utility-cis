"use client";

import { ImportWizard } from "@/components/imports/import-wizard";
import { usePermission } from "@/lib/use-permission";
import { AccessDenied } from "@/components/ui/access-denied";

/**
 * Meter-reads import page. Thin shell — every CSR-facing import entry
 * point in the system mounts the same `<ImportWizard>` parameterised
 * by entity kind. Cross-kind history lives at /imports.
 */
export default function MeterReadImportPage() {
  const { canCreate } = usePermission("meter_reads");
  if (!canCreate) return <AccessDenied />;
  return <ImportWizard kind="meter_read" />;
}
