import { queueRedisConnection } from "./queue-redis.js";
import { logger } from "./logger.js";

/**
 * Who is connected to Redis, read from Redis itself.
 *
 * Two questions, both of which must work from any node: which API nodes
 * are up, and which workers are alive. One `CLIENT LIST` answers both,
 * because every participant already holds a connection and **the TCP
 * connection is the liveness signal.**
 *
 * The alternative was a `platform:api-nodes` hash each node refreshes on
 * a timer. It is strictly worse: it needs a heartbeat interval and a
 * staleness threshold, and between the last refresh and the threshold it
 * reports a dead node as alive. A socket cannot lie about being open.
 *
 * Names come from two places. BullMQ names a worker's connection
 * `bull:<base64 of the queue>:w:<id>` when the `Worker` is given a
 * `name` — verified against a running worker, which appeared as
 * `bull:ZGVsaW5xdWVuY3ktdGVuYW50`. Ours are set at construction in
 * `queue-redis.ts`, which is what makes an API node discoverable at all:
 * an unnamed connection shows `name=` empty and is indistinguishable
 * from anyone else's.
 */

export interface ConnectedNode {
  host: string;
  /** How long its longest-held connection has been open. */
  ageSeconds: number;
}

/**
 * A worker's connection name ends with `:w:<id>`.
 *
 * Matched as a suffix rather than against the whole name on purpose: the
 * queue segment is base64, and nothing here should need to know that
 * encoding to recognise a worker. It also excludes the `:qe` suffix of a
 * QueueEvents connection — the DLQ monitor holds one of those per queue,
 * and counting them as workers would report attachment that does not
 * exist.
 */
const WORKER_NAME = /:w:([^:\s]+)$/;
const NODE_NAME = /^api:(.+)$/;

/** One parse of `CLIENT LIST` into the names and ages it reports. */
function parse(list: string): { name: string; age: number }[] {
  const clients: { name: string; age: number }[] = [];
  for (const line of list.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let name: string | undefined;
    let age = 0;
    for (const pair of line.split(" ")) {
      const at = pair.indexOf("=");
      if (at < 0) continue;
      const key = pair.slice(0, at);
      if (key === "name") name = pair.slice(at + 1);
      else if (key === "age") age = Number(pair.slice(at + 1)) || 0;
    }
    if (name !== undefined) clients.push({ name, age });
  }
  return clients;
}

/**
 * Null, never an empty list, when Redis will not say.
 *
 * A managed Redis (GCP Memorystore) refuses CLIENT LIST. "No nodes" is
 * never true of a deployment that is serving this page, so the caller has
 * to be able to tell "none" from "not known" — the same distinction the
 * per-queue worker count already makes.
 */
async function clients(): Promise<{ name: string; age: number }[] | null> {
  try {
    const list = (await queueRedisConnection.client("LIST")) as string;
    return parse(list);
  } catch (err) {
    logger.warn({ err, component: "connected-clients" }, "could not list Redis clients");
    return null;
  }
}

/** The API nodes currently connected, one row each. */
export async function connectedApiNodes(): Promise<ConnectedNode[] | null> {
  const list = await clients();
  if (list === null) return null;

  // A node holds several connections — the queue client, the cache
  // client — so the longest-held one is the node's age and the rest are
  // the same node again.
  const byHost = new Map<string, number>();
  for (const { name, age } of list) {
    const host = NODE_NAME.exec(name)?.[1];
    if (!host) continue;
    byHost.set(host, Math.max(byHost.get(host) ?? 0, age));
  }

  return [...byHost].map(([host, ageSeconds]) => ({ host, ageSeconds }));
}

/**
 * The ids of every worker currently attached, from any host.
 *
 * This is what makes a worker's liveness readable off its own host, where
 * `process.kill(pid, 0)` means nothing. One worker serves several queues
 * and so holds one named connection per queue; the id is counted once.
 */
export async function connectedWorkerIds(): Promise<Set<string> | null> {
  const list = await clients();
  if (list === null) return null;

  const ids = new Set<string>();
  for (const { name } of list) {
    const id = WORKER_NAME.exec(name)?.[1];
    if (id) ids.add(id);
  }
  return ids;
}
