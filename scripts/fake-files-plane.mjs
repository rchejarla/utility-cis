#!/usr/bin/env node
/**
 * A dev-only stand-in for apptor-connect's files plane.
 *
 * It exists so bill PDFs can be produced and downloaded on a laptop with
 * no apptor-connect instance and no cloud account. It is NOT a storage
 * driver: no production code knows it exists. The seam it plugs into is
 * `APPTOR_CONNECT_URL`, which is already configuration — point that at
 * this process and the real client, the real service, the real
 * BillDocument row and the real audit trail all run unchanged.
 *
 * It is deliberately not a test dependency. The automated tests
 * substitute the files-client module, which is a stronger fake: it needs
 * no process, no port and no cleanup. This is for hands and eyes.
 *
 * What it does NOT do, because our fake cannot: notice apptor-connect's
 * real contract moving. It mirrors our reading of their API, so it
 * agrees with the contract test by construction. Only the real service
 * can settle that.
 *
 *   node scripts/fake-files-plane.mjs
 *   FAKE_FILES_PORT=8080 FAKE_FILES_ROOT=.dev-files node scripts/...
 *
 * Endpoints mirrored from the files plane we call:
 *   POST /files/v1/links  → mint a capability link
 *   PUT  /d/:token        → store bytes
 *   GET  /d/:token        → return them
 */
import { createServer } from "node:http";
import { mkdir, writeFile, readFile, stat } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";

const PORT = Number(process.env.FAKE_FILES_PORT ?? 8080);
const ROOT = resolve(process.env.FAKE_FILES_ROOT ?? ".dev-files");

const encode = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const decode = (t) => JSON.parse(Buffer.from(t, "base64url").toString("utf-8"));

/**
 * Where a stored object lands: <root>/<integration>/<key>.
 *
 * The containment check is the one piece of paranoia worth keeping. Our
 * keys are derived rather than supplied, so `../` cannot reach here from
 * the app — but this process will also be poked at by hand with curl,
 * and a dev tool that can be talked into writing outside its own
 * directory is a bad thing to leave lying around.
 */
function objectPath(integration, key) {
  const full = resolve(join(ROOT, integration, key));
  if (full !== ROOT && !full.startsWith(ROOT + sep)) {
    throw new Error(`key escapes the store root: ${key}`);
  }
  return full;
}

function send(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(payload);
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
}

async function mintLink(req, res) {
  const body = JSON.parse((await readBody(req)).toString("utf-8") || "{}");
  const { i: integration, cn: connection, key, op, ttlSeconds, maxBytes } = body;

  if (!integration || !key || !op) {
    return send(res, 400, { error: "i, key and op are required" });
  }
  if (op !== "GET" && op !== "PUT") {
    return send(res, 400, { error: `unsupported op ${op}` });
  }
  // Permissive on purpose — the key is empty by default in dev config —
  // but say so once, because a missing header in production is a 401
  // from the real service and this is where you would wonder why.
  if (!req.headers["x-api-key"]) {
    console.warn("  (no X-Api-Key header — the real files plane would reject this)");
  }

  const ttl = Number(ttlSeconds) || 300;
  const expiresAt = new Date(Date.now() + ttl * 1000).toISOString();
  const token = encode({
    integration,
    connection: connection ?? null,
    key,
    op,
    exp: Date.now() + ttl * 1000,
    maxBytes: maxBytes ?? null,
  });

  console.log(`mint ${op} ${integration}/${key} (ttl ${ttl}s)`);
  return send(res, 200, {
    url: `http://localhost:${PORT}/d/${token}`,
    method: op,
    expiresAt,
    grantedTtlSeconds: ttl,
    maxBytes: maxBytes ?? null,
    via: "dev-fake",
  });
}

async function useLink(req, res, token) {
  let claim;
  try {
    claim = decode(token);
  } catch {
    return send(res, 403, { error: "malformed link" });
  }

  // Both of these reproduce real failure modes rather than waving them
  // through, so the error paths can actually be exercised by hand.
  if (Date.now() > claim.exp) {
    return send(res, 403, { error: "link expired" });
  }
  if (req.method !== claim.op) {
    return send(res, 405, { error: `link is ${claim.op}, not ${req.method}` });
  }

  let target;
  try {
    target = objectPath(claim.integration, claim.key);
  } catch (err) {
    return send(res, 400, { error: String(err.message) });
  }

  if (req.method === "PUT") {
    const bytes = await readBody(req);
    if (claim.maxBytes !== null && bytes.length > claim.maxBytes) {
      console.log(`  413 ${bytes.length} > maxBytes ${claim.maxBytes}`);
      return send(res, 413, { error: "larger than the link allows" });
    }
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, bytes);
    console.log(`  stored ${bytes.length} bytes → ${target}`);
    return send(res, 200, { stored: bytes.length });
  }

  try {
    await stat(target);
  } catch {
    console.log(`  404 ${target}`);
    return send(res, 404, { error: "no such object" });
  }
  const bytes = await readFile(target);
  console.log(`  served ${bytes.length} bytes ← ${target}`);
  res.writeHead(200, {
    "Content-Type": "application/octet-stream",
    "Content-Length": String(bytes.length),
  });
  return res.end(bytes);
}

createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  const handle = async () => {
    if (req.method === "POST" && url.pathname === "/files/v1/links") {
      return mintLink(req, res);
    }
    if (url.pathname.startsWith("/d/")) {
      return useLink(req, res, url.pathname.slice(3));
    }
    if (url.pathname === "/health") return send(res, 200, { ok: true, root: ROOT });
    return send(res, 404, { error: `no route for ${req.method} ${url.pathname}` });
  };

  handle().catch((err) => {
    console.error("fake files plane error:", err);
    if (!res.headersSent) send(res, 500, { error: String(err.message) });
  });
}).listen(PORT, () => {
  console.log(`fake apptor-connect files plane on http://localhost:${PORT}`);
  console.log(`storing objects under ${ROOT}`);
  console.log("dev only — never point a deployed build at this.");
});
