import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * What an API error says to the person who caused it.
 *
 * `error-handler.ts` has always answered a failed Zod parse with
 * `details: [{ field, message }]`, and this client read only
 * `error.message` — so **every** validation failure in the product
 * surfaced as the bare "Validation failed". Saving a TOU day type with
 * an empty code said exactly that: true, and no use at all. It named
 * neither the field nor which row of the list it was in.
 *
 * The global setup mocks this module for component tests, so it is
 * unmocked here to exercise the real `handleResponse`.
 */
vi.unmock("@/lib/api-client");

const realFetch = global.fetch;

function respondWith(status: number, body: unknown) {
  global.fetch = vi.fn().mockResolvedValue({
    ok: false,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  vi.resetModules();
  localStorage.clear();
});

afterEach(() => {
  global.fetch = realFetch;
});

async function getAndCatch(): Promise<string> {
  const { apiClient } = await vi.importActual<typeof import("../api-client")>("../api-client");
  try {
    await apiClient.get("/api/v1/anything");
    return "no error thrown";
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

describe("a validation failure", () => {
  it("names the field and the reason, not just 'Validation failed'", async () => {
    respondWith(400, {
      error: {
        code: "VALIDATION_ERROR",
        message: "Validation failed",
        details: [
          {
            field: "dayTypes.0.dayTypeCode",
            message: "String must contain at least 1 character(s)",
          },
        ],
      },
    });

    const message = await getAndCatch();
    expect(message).toContain("dayTypes.0.dayTypeCode");
    expect(message).toContain("at least 1 character");
  });

  it("keeps the row index, which is how you find the row", async () => {
    // `dayTypes.2.label` is the third row. Dropping the index would
    // leave somebody checking every row of a long list.
    respondWith(400, {
      error: {
        message: "Validation failed",
        details: [{ field: "dayTypes.2.label", message: "Required" }],
      },
    });

    expect(await getAndCatch()).toContain("dayTypes.2.label");
  });

  it("lists every field at fault, not only the first", async () => {
    respondWith(400, {
      error: {
        message: "Validation failed",
        details: [
          { field: "periods.0.peakCode", message: "Required" },
          { field: "periods.0.label", message: "Required" },
        ],
      },
    });

    const message = await getAndCatch();
    expect(message).toContain("periods.0.peakCode");
    expect(message).toContain("periods.0.label");
  });

  it("still reads an error that carries no details", async () => {
    respondWith(409, { error: { code: "ALREADY_PUBLISHED", message: "Already published." } });
    const message = await getAndCatch();
    expect(message).toContain("Already published.");
    expect(message).not.toContain("undefined");
  });

  it("leaves the 422 `missing` list working", async () => {
    // The same idea, fixed earlier for one status only. Both now.
    respondWith(422, {
      error: { message: "Cannot deliver", missing: ["billing address", "recipient name"] },
    });
    const message = await getAndCatch();
    expect(message).toContain("billing address");
    expect(message).toContain("recipient name");
  });
});
