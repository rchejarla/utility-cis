import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Who is connected to Redis, read from Redis itself.
 *
 * Two questions this answers, both of which have to work from any node:
 * which API nodes are up, and which workers are alive. Both come from one
 * `CLIENT LIST`, because every participant already holds a connection and
 * **the TCP connection is the liveness signal**. A `platform:api-nodes`
 * hash refreshed on a timer was the alternative, and it is strictly
 * worse: it needs a heartbeat interval and a staleness threshold, and it
 * reports a dead node as alive until the threshold passes. A socket
 * cannot.
 *
 * The names come from two places. BullMQ names a worker's connection
 * `bull:<base64 queue>:w:<id>` when the Worker is given a `name` —
 * verified against a running worker. Ours are named `api:<host>` and
 * `worker:<host>` at construction, which ioredis re-applies on every
 * reconnect.
 *
 * Matching on the `:w:<id>` suffix rather than the whole name is
 * deliberate: the queue part is base64, and nothing here should have to
 * know that encoding to recognise a worker.
 */

const clientList = vi.fn();

vi.mock("../../lib/queue-redis.js", () => ({
  queueRedisConnection: { client: clientList },
}));

vi.mock("../../lib/logger.js", () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

let lib: typeof import("../../lib/connected-clients.js");

/** A CLIENT LIST line, in Redis's real format. */
function line(name: string, over: Record<string, string> = {}): string {
  const fields = {
    id: "44",
    addr: "172.24.0.1:42484",
    laddr: "172.24.0.2:6379",
    fd: "15",
    name,
    age: "900",
    idle: "5",
    flags: "N",
    db: "0",
    ...over,
  };
  return Object.entries(fields)
    .map(([k, v]) => `${k}=${v}`)
    .join(" ");
}

beforeEach(async () => {
  vi.clearAllMocks();
  lib = await import("../../lib/connected-clients.js");
});

describe("connectedApiNodes", () => {
  it("lists each API node once, however many connections it holds", async () => {
    // A node holds more than one: the queue client, the cache client, and
    // whatever a request is doing. Three rows, one node.
    clientList.mockResolvedValue(
      [
        line("api:api-7f3c", { age: "3600" }),
        line("api:api-7f3c", { age: "3500" }),
        line("api:api-9b21", { age: "120" }),
        line(""),
      ].join("\n"),
    );

    const nodes = (await lib.connectedApiNodes())!;

    expect(nodes.map((n) => n.host)).toEqual(["api-7f3c", "api-9b21"]);
  });

  it("reports the longest-held connection's age for a node", async () => {
    // How long the node has been talking to Redis. The newest connection
    // is a request's, and says nothing about the node.
    clientList.mockResolvedValue(
      [line("api:api-7f3c", { age: "30" }), line("api:api-7f3c", { age: "86400" })].join("\n"),
    );

    const nodes = (await lib.connectedApiNodes())!;

    expect(nodes[0].ageSeconds).toBe(86400);
  });

  it("does not mistake a worker process for an API node", async () => {
    // Separate deployments in a cluster: a host that only runs workers is
    // not an API node, and listing it as one would invite a start command
    // that can never be served.
    clientList.mockResolvedValue(
      [
        line("api:api-7f3c"),
        line("worker:worker-1a"),
        line("bull:ZGVsaW5xdWVuY3ktdGVuYW50:w:4a1f"),
      ].join("\n"),
    );

    const nodes = (await lib.connectedApiNodes())!;

    expect(nodes.map((n) => n.host)).toEqual(["api-7f3c"]);
  });

  it("says nothing rather than guessing when Redis will not list clients", async () => {
    // Managed Redis refuses CLIENT LIST. An empty list would read as "no
    // nodes", which is never true of a deployment serving this page.
    clientList.mockRejectedValue(new Error("ERR unknown command 'client'"));

    expect(await lib.connectedApiNodes()).toBeNull();
  });
});

describe("connectedWorkerIds", () => {
  it("picks worker ids out of the names BullMQ gives its connections", async () => {
    clientList.mockResolvedValue(
      [
        line("bull:ZGVsaW5xdWVuY3ktdGVuYW50:w:4a1f0c3e"),
        line("bull:aW1wb3J0cw==:w:4a1f0c3e"),
        line("bull:aW1wb3J0cw==:w:9c02ab11"),
        line("api:api-7f3c"),
      ].join("\n"),
    );

    const ids = await lib.connectedWorkerIds();

    // One worker serves many queues, so its id appears once per queue and
    // is counted once.
    expect([...(ids ?? [])].sort()).toEqual(["4a1f0c3e", "9c02ab11"]);
  });

  it("ignores a queue-events connection, which is not a worker", async () => {
    // The DLQ monitor's subscription is named with a `:qe` suffix and
    // would otherwise look like an attached worker.
    clientList.mockResolvedValue(
      [
        line("bull:ZGVsaW5xdWVuY3ktdGVuYW50:qe"),
        line("bull:ZGVsaW5xdWVuY3ktdGVuYW50"),
      ].join("\n"),
    );

    expect([...(await lib.connectedWorkerIds())!]).toEqual([]);
  });

  it("says nothing rather than empty when the list cannot be read", async () => {
    clientList.mockRejectedValue(new Error("ERR unknown command 'client'"));

    expect(await lib.connectedWorkerIds()).toBeNull();
  });
});
