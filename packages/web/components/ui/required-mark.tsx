/**
 * The red asterisk, plus the word a screen reader reads instead of it.
 *
 * Extracted from `FormField`, which has always rendered exactly this
 * and was the only thing that did — so a form built from raw labels
 * (the rate component editor's modal, and the builders inside it) had
 * no way to mark a required field without copying the markup. It was
 * copied four times before this existed.
 */
export function RequiredMark() {
  return (
    <>
      <span
        aria-hidden="true"
        style={{ color: "var(--danger)", fontSize: "14px", lineHeight: 1, marginLeft: 3 }}
      >
        *
      </span>
      <span className="sr-only">(required)</span>
    </>
  );
}
