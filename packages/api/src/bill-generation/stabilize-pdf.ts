/**
 * Pins the non-deterministic bytes a PDF carries, so the same
 * `BillPresentation` always generates the same bytes.
 *
 * Spec §4.5 writes each bill to a deterministic object key and treats
 * `sha256` as the answer to "has this document changed?". A wall-clock
 * timestamp in the file breaks that silently: every generation differs
 * while looking identical, so a stored hash stops meaning anything and
 * an overwrite can no longer be assumed safe.
 *
 * Two forms have to be caught. react-pdf emits the creation date as a
 * **standalone indirect object** — `15 0 obj\n(D:20261011082303Z)\nendobj`
 * — and not only as a `/CreationDate (...)` dictionary entry. An earlier
 * version of this file matched the dictionary form alone and left a
 * single varying byte (the seconds digit), which passed in isolation and
 * failed under a loaded test suite: two generations a second apart differed.
 *
 * Every replacement preserves length. A PDF's cross-reference table
 * holds byte offsets into the file, so changing the size of anything
 * ahead of them corrupts the document. Replacing digits in place keeps
 * every offset valid without having to rebuild the xref.
 */

/** The 14 digits of a PDF date (D:YYYYMMDDHHMMSS), fixed. */
const FIXED_DIGITS = "20000101000000";

export function stabilizePdf(pdf: Buffer): Buffer {
  const pinned = pdf
    .toString("latin1")
    // Any PDF date, in a dictionary or as its own object. Only the
    // digits are rewritten, so a trailing Z or a +HH'MM' offset — and
    // the byte length — survive untouched.
    .replace(/\(D:\d{14}/g, `(D:${FIXED_DIGITS}`)
    // The document id pair, zeroed digit for digit so the length of
    // each hex string is preserved whatever react-pdf chose.
    .replace(/\/ID\s*\[\s*<([0-9a-fA-F]*)>\s*<([0-9a-fA-F]*)>\s*\]/g, (_match, a: string, b: string) =>
      `/ID [<${"0".repeat(a.length)}> <${"0".repeat(b.length)}>]`,
    );

  return Buffer.from(pinned, "latin1");
}
