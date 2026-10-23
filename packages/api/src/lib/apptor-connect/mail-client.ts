import { config } from "../../config.js";
import { ApptorConnectError } from "./files-client.js";

/**
 * The only place in this codebase that sends mail.
 *
 * `POST /proxy/v1/{integration}` with apptor-connect's own
 * `SendMailRequest`. One payload serves every mail transport they
 * support — SMTP and SendGrid's HTTP API — so a tenant moving between
 * them changes a row on their side and nothing here. That is the whole
 * reason to go through the mail plane rather than through the `REST`
 * integration that wraps SendGrid's API directly: the latter would mean
 * building SendGrid's JSON by hand and learning their contract, which
 * is the coupling the proxy exists to remove.
 *
 * Nothing here knows an API key, a sender domain or a host. The
 * integration name comes from the tenant's settings and selects all of
 * that on their side.
 *
 * Attachments are sent as **pointers**, not bytes. A bill's PDF already
 * lives in a connection apptor-connect owns, so naming
 * `{integration, connection, path}` lets the bytes go from their store
 * to their mail transport without a round trip out to us and back
 * base64-encoded — which for a twelve-thousand-account run would be
 * twenty-four thousand transfers of bytes that never needed to move,
 * and would put customer bill content back through this process for no
 * reason.
 */

/** A file to send, named by where it already lives. */
export interface MailAttachmentRef {
  /** The integration holding it — the resolution key, as everywhere. */
  integration: string;
  /** Narrows among that integration's connections, when there are several. */
  connection?: string | null;
  /** Path within that connection's root. */
  path: string;
  /** What the recipient sees. Defaults on their side to the last path segment. */
  filename: string;
  contentType?: string;
}

export interface MailMessage {
  to: string[];
  subject?: string | null;
  body: string;
  html?: boolean;
  /** Omitted entirely when empty, rather than sent as `[]`. */
  attachments?: MailAttachmentRef[];
}

export interface SentMail {
  /** The transport's own id for the message, where it returns one. */
  messageId: string | null;
}

/**
 * Send one message through a tenant's mail integration.
 *
 * Throws `ApptorConnectError` for anything that is not a 2xx, carrying
 * the integration name — a 404 means the tenant's configured name does
 * not resolve, which is an operator's problem to fix in Settings rather
 * than a bug.
 */
export async function sendMail(
  integration: string,
  message: MailMessage,
  opts: { connection?: string | null } = {},
): Promise<SentMail> {
  const body: Record<string, unknown> = {
    to: message.to,
    body: message.body,
  };
  if (message.subject) body.subject = message.subject;
  if (message.html) body.html = true;
  if (opts.connection) body.cn = opts.connection;
  if (message.attachments && message.attachments.length > 0) {
    body.attachments = message.attachments.map((a) => ({
      integration: a.integration,
      ...(a.connection ? { connection: a.connection } : {}),
      path: a.path,
      filename: a.filename,
      ...(a.contentType ? { contentType: a.contentType } : {}),
    }));
  }

  let res: Response;
  try {
    res = await fetch(
      `${config.APPTOR_CONNECT_URL}/proxy/v1/${encodeURIComponent(integration)}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Api-Key": config.APPTOR_CONNECT_API_KEY,
        },
        body: JSON.stringify(body),
      },
    );
  } catch (cause) {
    // The cause is carried rather than dropped: ECONNREFUSED, a DNS
    // failure and a TLS error all read as "unreachable" without it.
    throw new ApptorConnectError(
      `apptor-connect unreachable while sending mail through ${integration}`,
      null,
      integration,
      { cause },
    );
  }

  const text = await res.text().catch(() => "");
  if (!res.ok) {
    throw new ApptorConnectError(
      `apptor-connect refused the send through ${integration} (${res.status})` +
        (text ? `: ${text.slice(0, 300)}` : ""),
      res.status,
      integration,
    );
  }

  // A transport that returns no id is not an error: SMTP often has
  // none, and the outbox row is our record of the attempt either way.
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    const id = parsed.messageId ?? parsed.id;
    return { messageId: typeof id === "string" ? id : null };
  } catch {
    return { messageId: null };
  }
}
