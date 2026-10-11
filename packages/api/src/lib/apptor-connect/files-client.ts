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
  ) {
    super(message);
    this.name = "ApptorConnectError";
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
    );
  }

  if (!res.ok) {
    throw new ApptorConnectError(
      `Minting a ${args.op} link failed with ${res.status}`,
      res.status,
      args.integration,
    );
  }

  const json = (await res.json()) as FileLink;
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
    );
  }

  if (!res.ok) {
    throw new ApptorConnectError(
      `Upload of ${args.key} rejected with ${res.status}`,
      res.status,
      args.integration,
    );
  }
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
    );
  }

  if (!res.ok) {
    throw new ApptorConnectError(
      `Download of ${args.key} failed with ${res.status}`,
      res.status,
      args.integration,
    );
  }

  return Buffer.from(await res.arrayBuffer());
}
