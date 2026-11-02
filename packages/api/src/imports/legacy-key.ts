import type { CanonicalFieldDef } from "@utility-cis/shared";

/**
 * Matching a mirrored row to the legacy row it came from (spec 28,
 * OVL-IN-5).
 *
 * The overlay runs a utility's existing CIS alongside this one and
 * re-imports its export every cycle. Create-only handlers made that
 * impossible: the second cycle's file reported DUPLICATE_ACCOUNT,
 * DUPLICATE_METER and DUPLICATE_AGREEMENT on effectively every row, so
 * the mirror never advanced past its first load.
 *
 * A row that carries a `legacyKey` is matched on `(utility_id,
 * legacy_key)` and **updated in place**; one that does not is created,
 * exactly as before. So a one-shot migration behaves as it always did
 * and only an overlay import opts into the second shape.
 */

/** The canonical field every mirrored kind offers for the legacy id. */
export const LEGACY_KEY_FIELD = "legacyKey";

/**
 * The row's key, or undefined when it has none.
 *
 * **A blank cell is absence, not a key.** A CSV carries a cell for
 * every column it declares, so a file with the column present but empty
 * on some rows must create those rows rather than match them all
 * against each other — and the partial unique index covers only rows
 * that have a key, so a blank one is not unique anyway.
 */
export function legacyKeyOf(row: { legacyKey?: string }): string | undefined {
  const trimmed = (row.legacyKey ?? "").trim();
  return trimmed || undefined;
}

/**
 * Whether the incoming row still describes the same thing as the one
 * already mirrored under this key — and if not, which fields moved.
 *
 * **A key whose identity-bearing fields have changed is a row error,
 * not an update.** If a legacy agreement's account or commodity now
 * differs from the stored row's, the key is pointing at something else:
 * either the legacy system re-used an id, or the connector pack maps it
 * wrongly. Applying it would silently move an agreement between
 * accounts, which is a billing change nobody asked for and which no
 * later cycle would reveal. Spec 05 already calls `agreementNumber`
 * structurally immutable; this is the same reasoning applied to the
 * columns that decide what a row *is*.
 *
 * A field the incoming row does not carry is not compared: a file that
 * omits a column is not asserting the column is empty.
 */
export function identityConflict(
  stored: Record<string, unknown>,
  incoming: Record<string, unknown>,
): string | undefined {
  const moved: string[] = [];
  for (const [field, value] of Object.entries(incoming)) {
    if (value === undefined) continue;
    if (stored[field] !== value) moved.push(field);
  }
  if (moved.length === 0) return undefined;
  return moved
    .map((f) => `${f} (was ${JSON.stringify(stored[f])}, file says ${JSON.stringify(incoming[f])})`)
    .join("; ");
}

/** The canonical-field definition each mirrored kind appends. */
export const legacyKeyField: CanonicalFieldDef = {
  name: LEGACY_KEY_FIELD,
  label: "Legacy id",
  required: false,
  description:
    "The row's id in the system this was exported from. Supply it and a re-sent file updates the row in place instead of reporting a duplicate; leave it blank and the row is created as usual.",
  example: "LEG-100045",
  aliases: ["^legacykey$", "^legacyid$", "^sourceid$", "^externalid$", "^legacy(system)?(ref|reference)$"],
};
