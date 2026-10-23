import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { sendMail } from "../../lib/apptor-connect/mail-client.js";
import { ApptorConnectError } from "../../lib/apptor-connect/files-client.js";

/**
 * Contract test for apptor-connect's mail plane.
 *
 * apptor-connect is faked everywhere else rather than run; what a fake
 * cannot catch is their contract moving, so this pins the exact fields
 * `POST /proxy/v1/{integration}` takes for a `SendMailRequest` and what
 * we read back. When that contract changes, this is what fails.
 *
 * The shapes below were read from
 * `apptor-connect-core/.../proxy/mail/SendMailRequest.java` and
 * `MailAttachment.java` on 2026-10-23, and checked against the running
 * service: `mail@tenant:acme` answers 400 "at least one 'to' recipient
 * is required" to a payload without recipients, which is how the
 * integration was identified in the first place.
 */

const fetchMock = vi.fn();

function ok(bodyText = '{"messageId":"sg-1"}') {
  return { ok: true, status: 202, text: async () => bodyText };
}

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset().mockResolvedValue(ok());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** The JSON body of the single call made. */
function sentBody(): Record<string, unknown> {
  return JSON.parse(fetchMock.mock.calls[0]![1].body as string);
}

describe("sendMail", () => {
  it("posts to the named integration with the key, and nothing else", async () => {
    await sendMail("mail", { to: ["jane@example.com"], body: "Your bill is ready." });

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toMatch(/\/proxy\/v1\/mail$/);
    expect(init.method).toBe("POST");
    // The integration name selects the transport and the credential on
    // their side. Nothing here carries a key, a host or a sender domain.
    expect(init.headers["X-Api-Key"]).toBeDefined();
    expect(JSON.stringify(sentBody())).not.toMatch(/apiKey|password|sendgrid\.com/i);
  });

  it("sends the fields SendMailRequest declares, and omits the ones it has not got", async () => {
    await sendMail("mail", { to: ["a@example.com", "b@example.com"], body: "Hello" });

    const body = sentBody();
    expect(body.to).toEqual(["a@example.com", "b@example.com"]);
    expect(body.body).toBe("Hello");
    // An absent subject is absent, not an empty string: their record
    // treats blank and missing differently for `from`, and there is no
    // reason to make them guess here either.
    expect(body).not.toHaveProperty("subject");
    expect(body).not.toHaveProperty("html");
    // An empty attachment list is omitted rather than sent as [].
    expect(body).not.toHaveProperty("attachments");
  });

  /*
   * The point of the whole design: a bill's PDF already lives in a
   * connection apptor-connect owns, so it travels as a pointer. Sending
   * bytes would mean streaming the file out to us and posting it back
   * base64-encoded — for a 12,000-account run, 24,000 transfers of
   * bytes that never needed to move.
   */
  it("names an attachment by where it lives rather than sending its bytes", async () => {
    await sendMail("mail", {
      to: ["jane@example.com"],
      subject: "Your bill",
      body: "Attached.",
      attachments: [
        {
          integration: "dev-files",
          connection: null,
          path: "inbound/bills/2026-10/BILL-202610-1.pdf",
          filename: "Bill-BILL-202610-1.pdf",
          contentType: "application/pdf",
        },
      ],
    });

    const [att] = sentBody().attachments as Array<Record<string, unknown>>;
    expect(att!.integration).toBe("dev-files");
    expect(att!.path).toBe("inbound/bills/2026-10/BILL-202610-1.pdf");
    expect(att!.filename).toBe("Bill-BILL-202610-1.pdf");
    // Mutually exclusive with `path` in their record — sending both is a 400.
    expect(att).not.toHaveProperty("contentBase64");
    // A null connection is omitted, not sent as null: the field narrows
    // among an integration's connections and "none given" is its default.
    expect(att).not.toHaveProperty("connection");
  });

  /*
   * Measured against the running service on 2026-10-23: without a
   * sender, `mail@tenant:acme` answers 500 CONFIG_INVALID — "no sender:
   * the request has no 'from' and the connection has no 'from'
   * property". The tenant's `notifications.senderEmail` is what fills
   * it, and a blank one is omitted rather than sent, because blank and
   * missing both fall back to the connection on their side.
   */
  it("sends the tenant's sender, and omits it rather than sending blank", async () => {
    await sendMail("mail", {
      from: "billing@utility.example",
      to: ["a@example.com"],
      body: "x",
    });
    expect(sentBody().from).toBe("billing@utility.example");

    fetchMock.mockClear();
    await sendMail("mail", { from: null, to: ["a@example.com"], body: "x" });
    expect(sentBody()).not.toHaveProperty("from");
  });

  it("passes a connection when one narrows the choice", async () => {
    await sendMail(
      "mail",
      { to: ["jane@example.com"], body: "Hello" },
      { connection: "primary" },
    );
    expect(sentBody().cn).toBe("primary");
  });

  it("reads the transport's message id when it returns one", async () => {
    expect(await sendMail("mail", { to: ["a@example.com"], body: "x" })).toEqual({
      messageId: "sg-1",
    });
  });

  it("accepts a transport that returns no id, because SMTP often has none", async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 202, text: async () => "" });
    expect(await sendMail("mail", { to: ["a@example.com"], body: "x" })).toEqual({
      messageId: null,
    });
  });

  it("names the integration when the send is refused", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 404,
      text: async () => '{"error":"NO_MATCH","message":"No integration \'post\'"}',
    });

    // A 404 means the tenant's configured name does not resolve, which
    // is an operator fixing Settings rather than a bug — so the name
    // they typed has to be in the message.
    await expect(
      sendMail("post", { to: ["a@example.com"], body: "x" }),
    ).rejects.toMatchObject({ integration: "post", status: 404 });
  });

  it("distinguishes an unreachable service from a refusal", async () => {
    fetchMock.mockRejectedValue(new Error("ECONNREFUSED"));

    const err = await sendMail("mail", { to: ["a@example.com"], body: "x" }).catch(
      (e) => e,
    );
    expect(err).toBeInstanceOf(ApptorConnectError);
    // Null status, and the cause carried: ECONNREFUSED, a DNS failure
    // and a TLS error all read the same without it.
    expect(err.status).toBeNull();
    expect(err.cause).toBeInstanceOf(Error);
  });
});
