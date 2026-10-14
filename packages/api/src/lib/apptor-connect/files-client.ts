import { z } from "zod";
import { config } from "../../config.js";

/**
 * The only place in this codebase that talks to apptor-connect's files
 * plane (`POST /files/v1/links`, then the minted link).
 *
 * apptor-connect holds the vendor credential and never hands it out, so
 * nothing here knows a bucket name, a region or a key — one integration
 * name selects S3, Azure Blob or GCS on their side.
 *
 * Bytes transit their service (`via: "service"`, not a vendor presign),
 * so their upload limit and timeouts apply. `maxBytes` is always set
 * explicitly so an unbounded render cannot stream indefinitely.
 */

export interface FileLink {
  url: string;
  method: "GET" | "PUT";
  expiresAt: string;
  maxBytes: number | null;
}

export class ApptorConnectError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly integration: string,
    options?: { cause?: unknown },
  ) {
    // The underlying error is carried rather than dropped: ECONNREFUSED,
    // a DNS failure and a TLS handshake error all produce the same
    // "unreachable" message, and without a cause the operator has
    // nothing to tell them apart.
    super(message, options);
    this.name = "ApptorConnectError";
  }
}

/**
 * The fields of apptor-connect's mint response this client relies on,
 * checked rather than asserted. A 200 whose body is not what we expect
 * would otherwise surface as a TypeError from somewhere downstream and
 * reach the caller as a 500, bypassing the error mapping that exists to
 * turn every storage failure into a 502 naming the integration.
 *
 * Their response carries `grantedTtlSeconds` and `via` as well; this
 * client does not use them, so they are not required here.
 */
const mintResponseSchema = z.object({
  url: z.string().min(1),
  method: z.enum(["GET", "PUT"]),
  expiresAt: z.string().min(1),
  /**
   * Absent on a GET link, and the spec is wrong about this: it lists
   * `maxBytes` as required and documents it as "null for a download",
   * while the service omits the field altogether. Requiring it here
   * rejected every download with a 502 — caught within a minute of
   * pointing this client at a real apptor-connect, and invisible to the
   * local fake, which answers whatever we taught it to.
   *
   * Normalised to null so `FileLink.maxBytes` keeps meaning "no limit
   * applies", whichever way their serialiser expresses it.
   */
  maxBytes: z
    .number()
    .nullish()
    .transform((v) => v ?? null),
});

/**
 * Release a response whose body we are not going to read.
 *
 * undici holds the socket out of the keep-alive pool until an unread
 * body is consumed or garbage collected, so every error path and the
 * bodyless PUT success would otherwise leak a connection per call.
 */
async function discardBody(res: Response): Promise<void> {
  try {
    await res.body?.cancel();
  } catch {
    // A body that cannot be cancelled is already finished with.
  }
}

interface MintArgs {
  integration: string;
  connection?: string | null;
  key: string;
  op: "GET" | "PUT";
  ttlSeconds: number;
  maxBytes?: number;
}

/**
 * Mint a capability link.
 *
 * The returned url needs no login: "anyone holding it can use it until
 * it expires". Treat it as a bearer credential — it must not be logged,
 * returned to a client, or put in a page or an email. Callers use
 * putObject/getObject below, which consume the link and discard it;
 * this is exported only because those two need it.
 */
export async function mintFileLink(args: MintArgs): Promise<FileLink> {
  const body: Record<string, unknown> = {
    i: args.integration,
    key: args.key,
    op: args.op,
    ttlSeconds: args.ttlSeconds,
  };
  if (args.connection) body.cn = args.connection;
  if (args.maxBytes !== undefined) body.maxBytes = args.maxBytes;

  let res: Response;
  try {
    res = await fetch(`${config.APPTOR_CONNECT_URL}/files/v1/links`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Api-Key": config.APPTOR_CONNECT_API_KEY,
      },
      body: JSON.stringify(body),
    });
  } catch (cause) {
    throw new ApptorConnectError(
      `apptor-connect unreachable while minting a ${args.op} link`,
      null,
      args.integration,
      { cause },
    );
  }

  if (!res.ok) {
    await discardBody(res);
    throw new ApptorConnectError(
      `Minting a ${args.op} link failed with ${res.status}`,
      res.status,
      args.integration,
    );
  }

  let minted: unknown;
  try {
    minted = await res.json();
  } catch (cause) {
    throw new ApptorConnectError(
      `Minting a ${args.op} link returned a body that is not JSON`,
      res.status,
      args.integration,
      { cause },
    );
  }

  const parsed = mintResponseSchema.safeParse(minted);
  if (!parsed.success) {
    // Deliberately does not quote the body: a well-formed-enough
    // response holds a live capability link, and this message is bound
    // for a log.
    throw new ApptorConnectError(
      `Minting a ${args.op} link returned an unexpected shape: ${parsed.error.issues
        .map((i) => i.path.join("."))
        .join(", ")}`,
      res.status,
      args.integration,
    );
  }

  const json = parsed.data;
  return {
    url: json.url,
    method: json.method,
    expiresAt: json.expiresAt,
    maxBytes: json.maxBytes,
  };
}

/**
 * Write bytes to `key`. Errors never carry the minted url: a failed
 * upload gets logged, and a log line holding a live capability link is
 * a credential in a log file.
 */
export async function putObject(args: {
  integration: string;
  connection?: string | null;
  key: string;
  body: Buffer;
  maxBytes: number;
  ttlSeconds?: number;
}): Promise<void> {
  const link = await mintFileLink({
    integration: args.integration,
    connection: args.connection,
    key: args.key,
    op: "PUT",
    ttlSeconds: args.ttlSeconds ?? config.BILL_DOCUMENT_LINK_TTL_SECONDS,
    maxBytes: args.maxBytes,
  });

  let res: Response;
  try {
    res = await fetch(link.url, {
      method: "PUT",
      headers: { "Content-Type": "application/octet-stream" },
      body: new Uint8Array(args.body),
    });
  } catch (cause) {
    throw new ApptorConnectError(
      `Upload of ${args.key} failed: apptor-connect unreachable`,
      null,
      args.integration,
      { cause },
    );
  }

  if (!res.ok) {
    await discardBody(res);
    throw new ApptorConnectError(
      `Upload of ${args.key} rejected with ${res.status}`,
      res.status,
      args.integration,
    );
  }

  // A PUT's response body is of no interest, which is not the same as it
  // not existing.
  await discardBody(res);
}

/** Read the bytes at `key`. */
export async function getObject(args: {
  integration: string;
  connection?: string | null;
  key: string;
  ttlSeconds?: number;
}): Promise<Buffer> {
  const link = await mintFileLink({
    integration: args.integration,
    connection: args.connection,
    key: args.key,
    op: "GET",
    ttlSeconds: args.ttlSeconds ?? config.BILL_DOCUMENT_LINK_TTL_SECONDS,
  });

  let res: Response;
  try {
    res = await fetch(link.url, { method: "GET" });
  } catch (cause) {
    throw new ApptorConnectError(
      `Download of ${args.key} failed: apptor-connect unreachable`,
      null,
      args.integration,
      { cause },
    );
  }

  if (!res.ok) {
    await discardBody(res);
    throw new ApptorConnectError(
      `Download of ${args.key} failed with ${res.status}`,
      res.status,
      args.integration,
    );
  }

  return Buffer.from(await res.arrayBuffer());
}
