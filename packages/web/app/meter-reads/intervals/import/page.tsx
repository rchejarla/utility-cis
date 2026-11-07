"use client";

import { ImportWizard } from "@/components/imports/import-wizard";
import { usePermission } from "@/lib/use-permission";
import { AccessDenied } from "@/components/ui/access-denied";

/**
 * Interval-data import. Thin shell, like every other import entry
 * point: the handler declares this path, so a kind cannot register
 * without a page to reach it by.
 *
 * Separate from the meter-read import beside it because the two read
 * different files. A read is a dial and a date; an interval is a
 * quantity, a start instant and a length, and a meter's day is 96 rows
 * rather than one.
 */
export default function IntervalImportPage() {
  const { canCreate } = usePermission("meter_reads");
  if (!canCreate) return <AccessDenied />;
  return <ImportWizard kind="meter_read_interval" />;
}
