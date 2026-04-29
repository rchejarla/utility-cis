/** Friendly label for the ImportBatchSource enum. Mirrors the wizard
 * dropdown wording so the list/detail pages don't surface raw enum
 * tokens like MANUAL_UPLOAD to operators. */
const LABELS: Record<string, string> = {
  MANUAL_UPLOAD: "Manual upload",
  AMR: "AMR drive-by",
  AMI: "AMI interval",
  API: "API",
};

export function sourceLabel(source: string): string {
  return LABELS[source] ?? source;
}
