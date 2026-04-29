"use client";

import { ImportWizard } from "@/components/imports/import-wizard";
import { usePermission } from "@/lib/use-permission";
import { AccessDenied } from "@/components/ui/access-denied";

export default function PremiseImportPage() {
  const { canCreate } = usePermission("premises");
  if (!canCreate) return <AccessDenied />;
  return <ImportWizard kind="premise" />;
}
