import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { resolveLogoDataUri } from "../../bill-generation/generate-bill-pdf.js";

/**
 * Where the bill renderer is allowed to send a request.
 *
 * `utilityTheme.logoUrl` is written by a tenant under `theme:EDIT` and
 * validated only as a URL, and the renderer fetches it from inside the
 * API. That makes it a request this service performs on the writer's
 * behalf, from the API's own network position — and the bytes come back
 * base64-embedded in a PDF they can then download, so it reads rather
 * than merely probes. An adversarial review proved the first version
 * accepted `169.254.169.254`, `127.0.0.1`, `metadata.google.internal`
 * and `[::1]`, followed a redirect from a public host to an internal
 * one, and buffered a hostile 64 MiB body before its 2 MiB cap could
 * reject it.
 *
 * These assert on whether the request was made at all, because the
 * refusal has to happen before it.
 */

/**
 * DNS is mocked so these tests assert the policy, not the internet: an
 * IP literal resolves to itself (as Node's own lookup does), and the one
 * hostname used here resolves to a public address. Without this, the
 * public-host cases would fail wherever DNS is unavailable and the
 * refusals would pass for the wrong reason.
 */
vi.mock("node:dns/promises", () => ({
  lookup: async (hostname: string) => {
    if (/^\d+\.\d+\.\d+\.\d+$/.test(hostname) || hostname.includes(":")) {
      return [{ address: hostname, family: hostname.includes(":") ? 6 : 4 }];
    }
    if (hostname === "example.com") return [{ address: "93.184.216.34", family: 4 }];
    throw Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" });
  },
}));

const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const REFUSED: [string, string][] = [
  ["cloud metadata", "https://169.254.169.254/latest/meta-data/"],
  ["loopback", "https://127.0.0.1/logo.png"],
  ["0.0.0.0", "https://0.0.0.0/logo.png"],
  ["private 10/8", "https://10.0.0.5/logo.png"],
  ["private 192.168/16", "https://192.168.1.10/logo.png"],
  ["private 172.16/12", "https://172.20.0.3/logo.png"],
  ["carrier-grade NAT", "https://100.80.0.1/logo.png"],
  ["IPv6 loopback", "https://[::1]/logo.png"],
  ["IPv6 unique-local", "https://[fd00::1]/logo.png"],
  // Normalised by URL to the hex form ::ffff:7f00:1, which is how this
  // slipped past a dotted-form-only check.
  ["IPv4-mapped loopback", "https://[::ffff:127.0.0.1]/logo.png"],
  ["IPv4-mapped metadata", "https://[::ffff:169.254.169.254]/logo.png"],
  ["IPv4-mapped private", "https://[::ffff:10.0.0.5]/logo.png"],
  ["plaintext http", "http://example.com/logo.png"],
  ["a non-web scheme", "file:///etc/passwd"],
  ["nonsense", "not a url at all"],
];

describe("bill logo fetching", () => {
  it.each(REFUSED)("never requests %s", async (_label, url) => {
    expect(await resolveLogoDataUri(url)).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("asks for nothing when no logo is configured", async () => {
    expect(await resolveLogoDataUri(null)).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("inlines a public PNG as a data uri", async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
    fetchMock.mockResolvedValueOnce(okImage("image/png", [png]));

    const uri = await resolveLogoDataUri("https://example.com/logo.png");

    expect(uri).toBe(`data:image/png;base64,${Buffer.from(png).toString("base64")}`);
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ redirect: "manual" });
  });

  it("refuses a format react-pdf cannot draw", async () => {
    fetchMock.mockResolvedValueOnce(okImage("image/svg+xml", [new Uint8Array([1])]));

    expect(await resolveLogoDataUri("https://example.com/logo.svg")).toBeNull();
  });

  it("refuses a redirect from a public host to an internal address", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 302,
      headers: new Headers({ location: "https://169.254.169.254/latest/meta-data/" }),
      body: null,
    });

    expect(await resolveLogoDataUri("https://example.com/logo.png")).toBeNull();
    // The first hop happened; the second was refused before any request.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toBe("https://example.com/logo.png");
  });

  it("refuses a body that declares itself over the cap, without reading it", async () => {
    let read = false;
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      headers: new Headers({
        "content-type": "image/png",
        "content-length": String(64 * 1024 * 1024),
      }),
      body: {
        cancel: async () => {},
        getReader: () => {
          read = true;
          throw new Error("must not read a body already known to be too large");
        },
      },
    });

    expect(await resolveLogoDataUri("https://example.com/huge.png")).toBeNull();
    expect(read).toBe(false);
  });

  it("stops reading a body that goes over the cap mid-stream", async () => {
    const chunk = new Uint8Array(512 * 1024);
    let reads = 0;
    let cancelled = false;
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      // No content-length, so only the streaming cap can stop this.
      headers: new Headers({ "content-type": "image/png" }),
      body: {
        cancel: async () => {},
        getReader: () => ({
          read: async () => {
            reads += 1;
            return { done: false, value: chunk };
          },
          cancel: async () => {
            cancelled = true;
          },
          releaseLock: () => {},
        }),
      },
    });

    expect(await resolveLogoDataUri("https://example.com/endless.png")).toBeNull();
    expect(cancelled).toBe(true);
    // 2 MiB cap, 512 KiB chunks: it gives up as soon as it is over rather
    // than reading an unbounded body.
    expect(reads).toBeLessThanOrEqual(5);
  });

  it("is a bill without a logo when the fetch throws", async () => {
    fetchMock.mockRejectedValueOnce(new Error("timed out"));

    expect(await resolveLogoDataUri("https://example.com/logo.png")).toBeNull();
  });

  it("refuses a public hostname that does not resolve", async () => {
    expect(await resolveLogoDataUri("https://nowhere.invalid/logo.png")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

function okImage(contentType: string, chunks: Uint8Array[]) {
  let i = 0;
  return {
    ok: true,
    status: 200,
    headers: new Headers({ "content-type": contentType }),
    body: {
      cancel: async () => {},
      getReader: () => ({
        read: async () =>
          i < chunks.length ? { done: false, value: chunks[i++] } : { done: true, value: undefined },
        cancel: async () => {},
        releaseLock: () => {},
      }),
    },
  };
}
