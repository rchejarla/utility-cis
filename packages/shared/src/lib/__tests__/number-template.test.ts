import { describe, it, expect } from "vitest";
import {
  parseTemplate,
  format,
  previewTemplate,
  buildMatchPattern,
  nextSeq,
} from "../number-template";

describe("number-template engine", () => {
  describe("parseTemplate", () => {
    it("parses a plain prefix + seq template", () => {
      const parsed = parseTemplate("SA-{seq:4}");
      expect(parsed.parts).toEqual([
        { kind: "literal", text: "SA-" },
        { kind: "seq", width: 4 },
      ]);
      expect(parsed.seqWidth).toBe(4);
    });

    it("parses a template with year and month tokens", () => {
      const parsed = parseTemplate("{YYYY}{MM}-{seq:5}");
      expect(parsed.parts).toEqual([
        { kind: "year4" },
        { kind: "month2" },
        { kind: "literal", text: "-" },
        { kind: "seq", width: 5 },
      ]);
    });

    it("parses {seq} (no width) as zero-width padding", () => {
      const parsed = parseTemplate("X-{seq}");
      expect(parsed.parts).toEqual([
        { kind: "literal", text: "X-" },
        { kind: "seq", width: 0 },
      ]);
    });

    it("parses {YY} as 2-digit year", () => {
      const parsed = parseTemplate("SA-{YY}-{seq:3}");
      expect(parsed.parts.some((p) => p.kind === "year2")).toBe(true);
    });

    it("rejects templates with no seq token", () => {
      expect(() => parseTemplate("SA-{YYYY}")).toThrow(/seq/);
    });

    it("rejects templates with multiple seq tokens", () => {
      expect(() => parseTemplate("{seq:3}-{seq:4}")).toThrow(/at most one/);
    });

    it("rejects unknown tokens", () => {
      expect(() => parseTemplate("SA-{BOGUS}-{seq:4}")).toThrow(/Unknown token/);
    });

    it("rejects invalid seq widths", () => {
      expect(() => parseTemplate("SA-{seq:0}")).toThrow(/seq width/);
      expect(() => parseTemplate("SA-{seq:foo}")).toThrow(/seq width/);
      expect(() => parseTemplate("SA-{seq:999}")).toThrow(/seq width/);
    });

    it("rejects unclosed tokens", () => {
      expect(() => parseTemplate("SA-{seq:4")).toThrow(/Unclosed/);
    });

    it("rejects empty templates", () => {
      expect(() => parseTemplate("")).toThrow();
    });
  });

  describe("format", () => {
    const APRIL_2026 = new Date("2026-04-10T12:00:00Z");

    it("formats a simple prefix template", () => {
      const parsed = parseTemplate("SA-{seq:4}");
      expect(format(parsed, 42, APRIL_2026)).toBe("SA-0042");
    });

    it("formats with {YYYY}", () => {
      const parsed = parseTemplate("SA-{YYYY}-{seq:4}");
      expect(format(parsed, 42, APRIL_2026)).toBe("SA-2026-0042");
    });

    it("formats with {YY}", () => {
      const parsed = parseTemplate("{YY}-{seq:3}");
      expect(format(parsed, 7, APRIL_2026)).toBe("26-007");
    });

    it("formats with {MM}", () => {
      const parsed = parseTemplate("{YYYY}{MM}-{seq:5}");
      expect(format(parsed, 1, APRIL_2026)).toBe("202604-00001");
    });

    it("zero-pads correctly for small numbers", () => {
      const parsed = parseTemplate("SA-{seq:6}");
      expect(format(parsed, 1, APRIL_2026)).toBe("SA-000001");
    });

    it("does not truncate numbers larger than the padding width", () => {
      const parsed = parseTemplate("SA-{seq:3}");
      expect(format(parsed, 12345, APRIL_2026)).toBe("SA-12345");
    });

    it("unpadded seq emits the raw number", () => {
      const parsed = parseTemplate("X-{seq}");
      expect(format(parsed, 42, APRIL_2026)).toBe("X-42");
    });

    it("uses the current date when not overridden", () => {
      const parsed = parseTemplate("{YYYY}-{seq:2}");
      const result = format(parsed, 1);
      expect(result).toMatch(/^\d{4}-01$/);
    });
  });

  describe("previewTemplate", () => {
    it("returns ok for a valid template", () => {
      const result = previewTemplate("SA-{seq:4}", 42, new Date("2026-04-10"));
      expect(result).toEqual({ ok: true, value: "SA-0042" });
    });

    it("returns an error for an invalid template", () => {
      const result = previewTemplate("no-seq-here", 1);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toMatch(/seq/);
      }
    });
  });

  describe("buildMatchPattern", () => {
    const APRIL_2026 = new Date("2026-04-10T12:00:00Z");

    it("substitutes year and month literals into the regex", () => {
      const parsed = parseTemplate("SA-{YYYY}-{seq:4}");
      const { match } = buildMatchPattern(parsed, APRIL_2026);
      expect(match).toBe("^SA-2026-\\d+$");
    });

    it("relaxes seq width so legacy rows with different padding still match", () => {
      // Admin has changed from {seq:4} to {seq:5} mid-year. The regex
      // must still find existing SA-2026-0042 rows despite the new
      // width expectation.
      const parsed = parseTemplate("SA-{YYYY}-{seq:5}");
      const { match } = buildMatchPattern(parsed, APRIL_2026);
      expect(match).toBe("^SA-2026-\\d+$");
    });

    it("extracts the sequence number from a matched identifier", () => {
      const parsed = parseTemplate("SA-{YYYY}-{seq:4}");
      const { seqExtract } = buildMatchPattern(parsed, APRIL_2026);
      const m = seqExtract.exec("SA-2026-0042");
      expect(m?.[1]).toBe("0042");
    });

    it("escapes regex metacharacters in literal parts", () => {
      const parsed = parseTemplate("SA.{seq:3}");
      const { match } = buildMatchPattern(parsed, APRIL_2026);
      // The literal dot must be escaped so it doesn't match "SAx0001".
      expect(match).toBe("^SA\\.\\d+$");
    });
  });

  describe("nextSeq", () => {
    it("returns startAt when there is no existing max", () => {
      expect(nextSeq(null, 1)).toBe(1);
      expect(nextSeq(null, 1000)).toBe(1000);
    });

    it("returns max+1 when existing max is above startAt", () => {
      expect(nextSeq(42, 1)).toBe(43);
    });

    it("returns startAt when existing max is below startAt", () => {
      // Tenant migrated from legacy system and bumped startAt to 50000.
      // Existing rows from legacy import are sub-50000 and shouldn't
      // pull the counter backward.
      expect(nextSeq(42, 50000)).toBe(50000);
    });

    it("defaults startAt to 1", () => {
      expect(nextSeq(null)).toBe(1);
      expect(nextSeq(5)).toBe(6);
    });
  });
});
