"use client";

import { ImportWizard } from "@/components/imports/import-wizard";
import { usePermission } from "@/lib/use-permission";
import { AccessDenied } from "@/components/ui/access-denied";

export default function AccountImportPage() {
  const { canCreate } = usePermission("accounts");
  if (!canCreate) return <AccessDenied />;
  return <ImportWizard kind="account" />;
}
