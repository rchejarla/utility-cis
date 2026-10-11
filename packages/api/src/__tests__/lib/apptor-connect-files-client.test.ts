import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  mintFileLink,
  putObject,
  getObject,
  ApptorConnectError,
} from "../../lib/apptor-connect/files-client.js";

/**
 * Contract test for apptor-connect's files plane.
 *
 * apptor-connect is faked in every other test rather than run — a JVM
 * service and a cloud bucket per test file would multiply an already
 * 20-minute integration suite for no coverage of our own logic. What a
 * fake cannot catch is their contract moving, so this file pins the
 * exact request fields POST /files/v1/links takes and the response
 * fields we read. When that contract changes, this is what fails.
 */

const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function linkResponse(url = "https://ac.test/files/v1/d?sig=abc", method = "PUT") {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      url,
      method,
      expiresAt: "2026-10-11T00:05:00Z",
      grantedTtlSeconds: 300,
      maxBytes: 1024,
      via: "service",
    }),
  };
}

describe("apptor-connect files client", () => {
  it("mints a link with exactly the documented request fields", async () => {
    fetchMock.mockResolvedValueOnce(linkResponse());

    await mintFileLink({
      integration: "cis-bills",
      connection: "primary",
      key: "bills/util-1/bill-1.pdf",
      op: "PUT",
      ttlSeconds: 300,
      maxBytes: 1024,
    });

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toMatch(/\/files\/v1\/links$/);
    expect(init.method).toBe("POST");
    expect(init.headers["Content-Type"]).toBe("application/json");
    expect(init.headers).toHaveProperty("X-Api-Key");
    expect(JSON.parse(init.body)).toEqual({
      i: "cis-bills",
      cn: "primary",
      key: "bills/util-1/bill-1.pdf",
      op: "PUT",
      ttlSeconds: 300,
      maxBytes: 1024,
    });
  });

  it("omits cn when there is no named connection", async () => {
    fetchMock.mockResolvedValueOnce(linkResponse());

    await mintFileLink({ integration: "cis-bills", key: "k", op: "GET", ttlSeconds: 60 });

    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      i: "cis-bills",
      key: "k",
      op: "GET",
      ttlSeconds: 60,
    });
  });

  it("reads the response fields we depend on", async () => {
    fetchMock.mockResolvedValueOnce(linkResponse("https://ac.test/files/v1/d?sig=xyz", "GET"));

    const link = await mintFileLink({
      integration: "cis-bills",
      key: "k",
      op: "GET",
      ttlSeconds: 60,
    });

    expect(link).toEqual({
      url: "https://ac.test/files/v1/d?sig=xyz",
      method: "GET",
      expiresAt: "2026-10-11T00:05:00Z",
      maxBytes: 1024,
    });
  });

  it("uploads to the minted url and returns nothing that holds it", async () => {
    fetchMock
      .mockResolvedValueOnce(linkResponse("https://ac.test/files/v1/d?sig=put"))
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({}) });

    const result = await putObject({
      integration: "cis-bills",
      key: "bills/util-1/bill-1.pdf",
      body: Buffer.from("%PDF-1.7"),
      maxBytes: 4096,
    });

    expect(result).toBeUndefined();
    const [putUrl, putInit] = fetchMock.mock.calls[1];
    expect(String(putUrl)).toBe("https://ac.test/files/v1/d?sig=put");
    expect(putInit.method).toBe("PUT");
  });

  it("downloads bytes through a GET link", async () => {
    fetchMock
      .mockResolvedValueOnce(linkResponse("https://ac.test/files/v1/d?sig=get", "GET"))
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        arrayBuffer: async () => new TextEncoder().encode("%PDF-1.7").buffer,
      });

    const bytes = await getObject({ integration: "cis-bills", key: "k" });

    expect(bytes.subarray(0, 5).toString()).toBe("%PDF-");
  });

  it("raises ApptorConnectError naming the integration when minting fails", async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 503, text: async () => "unavailable" });

    const err = await mintFileLink({
      integration: "cis-bills",
      key: "k",
      op: "PUT",
      ttlSeconds: 60,
      maxBytes: 1,
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ApptorConnectError);
    expect((err as ApptorConnectError).status).toBe(503);
    expect((err as ApptorConnectError).integration).toBe("cis-bills");
  });

  it("raises ApptorConnectError when the upload itself is rejected", async () => {
    fetchMock
      .mockResolvedValueOnce(linkResponse())
      .mockResolvedValueOnce({ ok: false, status: 413, text: async () => "too large" });

    const err = await putObject({
      integration: "cis-bills",
      key: "k",
      body: Buffer.from("x"),
      maxBytes: 1,
    }).catch((e: unknown) => e);

    expect((err as ApptorConnectError).status).toBe(413);
  });

  // A minted link is a bearer credential: anyone holding it can fetch
  // the file until it expires. It must never reach a log or a caller.
  it("never puts the minted url in an error message", async () => {
    fetchMock
      .mockResolvedValueOnce(linkResponse("https://ac.test/files/v1/d?sig=SECRET"))
      .mockResolvedValueOnce({ ok: false, status: 500, text: async () => "boom" });

    const err = await putObject({
      integration: "cis-bills",
      key: "k",
      body: Buffer.from("x"),
      maxBytes: 10,
    }).catch((e: unknown) => e);

    expect(String((err as Error).message)).not.toContain("SECRET");
    expect(String((err as Error).message)).not.toContain("sig=");
  });
});
