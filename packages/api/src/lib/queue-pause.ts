/**
 * Stopping a queue taking work, and saying who stopped it.
 *
 * **A pause needs no command path.** It is a key in Redis that every
 * worker on every node already checks before taking a job, not a message
 * to a process — the same fact spec 24 §D7 used to rule queue pause out
 * of *worker* control, read the other way round: it is buildable now,
 * and cluster-wide worker commands are not its prerequisite.
 *
 * What a pause does, exactly, because "pause" reads as "nothing will
 * happen" and that is not what happens: workers stop *taking* jobs,
 * jobs already running finish, and the crons keep firing — so the work
 * piles up as `waiting` and all of it runs when the queue resumes.
 *
 * The record beside the key exists because a queue found paused on a
 * Monday with no record of why is worse than one nobody could pause. It
 * is not an `audit_log` row: that table wants a `utility_id` and a uuid
 * `entity_id`, and a queue is neither. Spec 24 hit the same wall and
 * named the migration that would close both.
 */
import { getQueue, type QueueName } from "./queues.js";
import { queueRedisConnection } from "./queue-redis.js";
import { logger } from "./logger.js";

/** Where the pause records live, beside `platform:queue-concurrency`. */
export const PAUSE_RECORD_KEY = "platform:queue-pauses";

/** Long enough to say why, short enough to read in a table cell. */
const MAX_REASON = 200;

export interface PauseRecord {
  /** The operator's name, as the console will print it. */
  by: string;
  /** Their id, since two operators may share a name. */
  byId: string;
  /** ISO, when the pause was taken. */
  at: string;
  reason: string;
}

interface Actor {
  id: string;
  name: string;
}

/**
 * Stop this queue taking work.
 *
 * The reason is required, which is the whole value of the record — a
 * blank one leaves exactly the state it exists to prevent.
 *
 * Idempotent, and deliberately **does not overwrite an existing
 * record**: the operator who stopped it is the one worth naming, and a
 * second press would otherwise move the timestamp forward and lose why
 * it was stopped in the first place.
 */
export async function pauseQueue(
  name: QueueName,
  actor: Actor,
  reason: string,
): Promise<PauseRecord> {
  const trimmed = reason.trim().slice(0, MAX_REASON);
  if (trimmed === "") {
    throw Object.assign(
      new Error(
        "Say why this queue is being paused. A queue found paused with no reason costs the " +
          "next operator the whole investigation.",
      ),
      { statusCode: 400, code: "PAUSE_REASON_REQUIRED" },
    );
  }

  const existing = await readPauseRecord(name);
  const record: PauseRecord =
    existing ??
    { by: actor.name, byId: actor.id, at: new Date().toISOString(), reason: trimmed };

  await queueRedisConnection.hset(PAUSE_RECORD_KEY, name, JSON.stringify(record));
  await getQueue(name).pause();

  logger.warn(
    { component: "scheduler-control", queue: name, actor: actor.id, reason: record.reason },
    "Queue paused",
  );
  return record;
}

/**
 * Let it take work again.
 *
 * Never refuses for want of a record. A queue paused before the record
 * existed, or paused directly in Redis, is still a queue an operator
 * needs to restart — making the record a precondition would turn it into
 * a lock on the one action that matters during an incident.
 */
export async function resumeQueue(name: QueueName, actor: Actor): Promise<void> {
  await getQueue(name).resume();
  await queueRedisConnection.hdel(PAUSE_RECORD_KEY, name);

  logger.warn(
    { component: "scheduler-control", queue: name, actor: actor.id },
    "Queue resumed",
  );
}

/**
 * Who paused this queue and why, or null.
 *
 * Null rather than a throw on an unreadable value: whether the queue is
 * paused comes from Redis's own key, so a record that cannot be parsed
 * costs the detail and not the fact. The page still has to render.
 */
export async function readPauseRecord(name: QueueName): Promise<PauseRecord | null> {
  const raw = await queueRedisConnection.hget(PAUSE_RECORD_KEY, name);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<PauseRecord>;
    if (typeof parsed.reason !== "string" || typeof parsed.at !== "string") return null;
    return {
      by: typeof parsed.by === "string" ? parsed.by : "an operator",
      byId: typeof parsed.byId === "string" ? parsed.byId : "",
      at: parsed.at,
      reason: parsed.reason,
    };
  } catch {
    logger.warn({ component: "scheduler-control", queue: name }, "Unreadable pause record");
    return null;
  }
}
