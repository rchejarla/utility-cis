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

  it("uploads the bytes to the minted url", async () => {
    fetchMock
      .mockResolvedValueOnce(linkResponse("https://ac.test/files/v1/d?sig=put"))
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({}) });

    // This used to also assert the resolved value was undefined, which a
    // Promise<void> cannot fail; that the url does not escape is the
    // business of the error-message test below and of the return type.
    await putObject({
      integration: "cis-bills",
      key: "bills/util-1/bill-1.pdf",
      body: Buffer.from("%PDF-1.7"),
      maxBytes: 4096,
    });

    const [putUrl, putInit] = fetchMock.mock.calls[1];
    expect(String(putUrl)).toBe("https://ac.test/files/v1/d?sig=put");
    expect(putInit.method).toBe("PUT");
    expect(Buffer.from(putInit.body).toString()).toBe("%PDF-1.7");
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

  /**
   * The transport-failure branch: `status` is null because there was no
   * response, and the underlying error is carried so ECONNREFUSED can be
   * told apart from a DNS or TLS failure. Nothing exercised this before,
   * so the 502 mapping it feeds was untested.
   */
  it("raises ApptorConnectError with a null status when apptor-connect cannot be reached", async () => {
    const cause = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:8080"), {
      code: "ECONNREFUSED",
    });
    fetchMock.mockRejectedValueOnce(cause);

    const err = await mintFileLink({
      integration: "cis-bills",
      key: "k",
      op: "GET",
      ttlSeconds: 60,
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ApptorConnectError);
    expect((err as ApptorConnectError).status).toBeNull();
    expect((err as ApptorConnectError).integration).toBe("cis-bills");
    expect((err as ApptorConnectError).cause).toBe(cause);
  });

  it("carries the cause when a download's transport fails", async () => {
    const cause = new Error("socket hang up");
    fetchMock.mockResolvedValueOnce(linkResponse("https://ac.test/files/v1/d", "GET"));
    fetchMock.mockRejectedValueOnce(cause);

    const err = await getObject({ integration: "cis-bills", key: "k" }).catch(
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(ApptorConnectError);
    expect((err as ApptorConnectError).cause).toBe(cause);
  });

  /**
   * A 200 whose body is not the documented shape used to be asserted
   * through with a cast, so a missing `url` became a TypeError from
   * somewhere downstream and reached the caller as a 500 — bypassing the
   * 502 mapping that every other storage failure goes through.
   */
  it("refuses a mint response that is missing a field it depends on", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ method: "GET", expiresAt: "2026-10-11T00:05:00Z", maxBytes: null }),
    });

    const err = await mintFileLink({
      integration: "cis-bills",
      key: "k",
      op: "GET",
      ttlSeconds: 60,
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ApptorConnectError);
    expect((err as Error).message).toContain("url");
  });

  /**
   * A GET link's response has no `maxBytes` key at all. Their OpenAPI
   * spec lists it as required and describes it as "null for a
   * download", but the service omits the field, so a schema that
   * required it turned every download into a 502. Found by pointing
   * this client at a real apptor-connect; the fake could not have shown
   * it, because the fake answers whatever we taught it to.
   */
  it("accepts a GET link that omits maxBytes entirely", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        url: "https://ac.test/files/v1/d?sig=get",
        method: "GET",
        expiresAt: "2026-10-14T11:26:07.764850900Z",
        grantedTtlSeconds: 300,
        via: "service",
      }),
    });

    const link = await mintFileLink({
      integration: "dev-files",
      key: "k",
      op: "GET",
      ttlSeconds: 300,
    });

    expect(link.maxBytes).toBeNull();
    expect(link.url).toBe("https://ac.test/files/v1/d?sig=get");
  });

  it("refuses a mint response that is not JSON at all", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => {
        throw new SyntaxError("Unexpected token < in JSON at position 0");
      },
    });

    const err = await mintFileLink({
      integration: "cis-bills",
      key: "k",
      op: "GET",
      ttlSeconds: 60,
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ApptorConnectError);
    expect((err as Error).message).toMatch(/not JSON/);
  });

  /**
   * undici keeps the socket out of its pool until an unread body is
   * consumed or garbage-collected, so every path that does not read one
   * leaked a connection per call. Nothing exercised that.
   */
  it("releases bodies it does not read, on success and on failure", async () => {
    const cancels: string[] = [];
    const body = (label: string) => ({
      cancel: async () => {
        cancels.push(label);
      },
    });

    // Mint ok, PUT ok: the PUT's body is of no interest but still exists.
    fetchMock
      .mockResolvedValueOnce({ ...linkResponse("https://ac.test/d?sig=a"), body: body("mint-ok") })
      .mockResolvedValueOnce({ ok: true, status: 200, body: body("put-ok") });
    await putObject({
      integration: "cis-bills",
      key: "k",
      body: Buffer.from("x"),
      maxBytes: 10,
    });
    expect(cancels).toContain("put-ok");

    // A rejected upload: its error body is not read either.
    cancels.length = 0;
    fetchMock
      .mockResolvedValueOnce({ ...linkResponse("https://ac.test/d?sig=b"), body: body("mint-ok-2") })
      .mockResolvedValueOnce({ ok: false, status: 413, body: body("put-rejected") });
    await putObject({
      integration: "cis-bills",
      key: "k",
      body: Buffer.from("x"),
      maxBytes: 10,
    }).catch(() => undefined);
    expect(cancels).toContain("put-rejected");

    // A failed mint: same.
    cancels.length = 0;
    fetchMock.mockResolvedValueOnce({ ok: false, status: 503, body: body("mint-failed") });
    await mintFileLink({ integration: "cis-bills", key: "k", op: "GET", ttlSeconds: 60 }).catch(
      () => undefined,
    );
    expect(cancels).toContain("mint-failed");
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
