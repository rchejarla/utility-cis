import { describe, it, expect } from "vitest";
import { legacyKeyOf, identityConflict } from "../../imports/legacy-key.js";

/**
 * Matching a mirrored row to the legacy row it came from (spec 28,
 * OVL-IN-5).
 *
 * The overlay re-imports a utility's export every cycle. Create-only
 * handlers made that impossible — the second cycle reported
 * DUPLICATE_ACCOUNT, DUPLICATE_METER and DUPLICATE_AGREEMENT on
 * effectively every row, and the mirror never advanced past its first
 * load.
 *
 * Two decisions are pinned here, because both are judgement rather than
 * mechanism.
 *
 * **A blank legacy key is absence, not a key.** A CSV carries a cell
 * for every column, so a file that declares the column but leaves it
 * empty on some rows must create those rows rather than match them all
 * against one another — and the partial unique index only covers rows
 * that have a key, so a blank one is not even unique.
 *
 * **A key whose identity-bearing fields have changed is a row error,
 * not an update.** If a legacy agreement's account or commodity now
 * differs from the mirrored row's, the key is pointing at a different
 * thing: either the legacy system re-used an id or the connector pack
 * maps it wrongly. Applying it would silently move an agreement between
 * accounts, which is a billing change nobody asked for. Spec 05 already
 * calls `agreementNumber` structurally immutable; this extends the same
 * reasoning to the columns that decide what a row *is*.
 */

describe("legacyKeyOf", () => {
  it("reads the key off a row", () => {
    expect(legacyKeyOf({ legacyKey: "SA-0001" })).toBe("SA-0001");
  });

  it("trims, because an exported cell carries whatever the file had", () => {
    expect(legacyKeyOf({ legacyKey: "  SA-0001  " })).toBe("SA-0001");
  });

  it("treats a blank cell as no key at all", () => {
    expect(legacyKeyOf({ legacyKey: "" })).toBeUndefined();
    expect(legacyKeyOf({ legacyKey: "   " })).toBeUndefined();
    expect(legacyKeyOf({})).toBeUndefined();
    expect(legacyKeyOf({ legacyKey: undefined })).toBeUndefined();
  });
});

describe("identityConflict", () => {
  it("is silent when the identity-bearing fields still agree", () => {
    expect(
      identityConflict({ accountId: "a-1", commodityId: "c-1" }, { accountId: "a-1", commodityId: "c-1" }),
    ).toBeUndefined();
  });

  it("names the field that moved", () => {
    const conflict = identityConflict(
      { accountId: "a-1", commodityId: "c-1" },
      { accountId: "a-2", commodityId: "c-1" },
    );
    expect(conflict).toContain("accountId");
  });

  it("names every field that moved, not just the first", () => {
    const conflict = identityConflict(
      { accountId: "a-1", commodityId: "c-1" },
      { accountId: "a-2", commodityId: "c-2" },
    );
    expect(conflict).toContain("accountId");
    expect(conflict).toContain("commodityId");
  });

  it("ignores a field the incoming row does not carry", () => {
    // A file that omits a column is not asserting the column is empty,
    // so an absent value cannot be a conflict.
    expect(
      identityConflict({ accountId: "a-1", commodityId: "c-1" }, { accountId: "a-1" }),
    ).toBeUndefined();
  });

  it("compares as values, so a stored null and an absent incoming agree", () => {
    expect(identityConflict({ rateServiceClassId: null }, {})).toBeUndefined();
  });
});
