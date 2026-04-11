import { parseTemplate, format, buildMatchPattern, nextSeq } from "@utility-cis/shared";
import type { NumberFormatConfig } from "@utility-cis/shared";
import { getTenantConfig } from "../services/tenant-config.service.js";

/**
 * Shared generator for tenant-configurable identifier numbers
 * (agreement numbers, account numbers, and any future entity that
 * follows the same numberFormats pattern).
 *
 * Algorithm:
 *   1. Read the tenant's template from tenant_config.settings.numberFormats[entity]
 *      (fall back to the caller-supplied default if not configured).
 *   2. Substitute today's year/month into the template to get the
 *      expected prefix/suffix. Build a POSIX regex from the literal
 *      parts with \d+ in place of the seq token.
 *   3. Query the highest existing identifier matching that regex for
 *      this tenant using a raw SQL query so Postgres's regex operator
 *      can leverage any trigram or btree index on the column.
 *   4. Parse the numeric tail of the matched identifier, take
 *      max(startAt, parsed+1), format back into the template.
 *   5. Return the candidate number. Caller is responsible for the
 *      retry loop — if the candidate collides with another concurrent
 *      insert, caller re-invokes the generator and retries the create.
 *
 * Date-token reset behaviour: because step 2 substitutes the current
 * date, including {YYYY} in the template naturally resets the
 * sequence on January 1 (new year prefix → no matching rows → start
 * fresh from startAt). No separate reset policy needed.
 */

export interface NumberGeneratorOptions {
  utilityId: string;
  /** Entity key, e.g. "agreement" or "account". Used to look up tenant template. */
  entity: "agreement" | "account";
  /** Fallback template if the tenant hasn't configured one. */
  defaultTemplate: string;
  /** Fallback startAt. */
  defaultStartAt?: number;
  /** Prisma table name for the raw query, e.g. "service_agreement". */
  tableName: string;
  /** Column storing the identifier, e.g. "agreement_number". */
  columnName: string;
  /**
   * Prisma client or transaction. Must expose $queryRawUnsafe.
   * Accepting a tx lets the caller run the generator inside the same
   * transaction that does the create, so the max query sees any rows
   * the current tx has already inserted.
   */
  db: { $queryRawUnsafe: (sql: string, ...params: unknown[]) => Promise<unknown> };
  /** Reference date for token substitution. Defaults to now. */
  now?: Date;
}

export async function generateNumber(opts: NumberGeneratorOptions): Promise<string> {
  const now = opts.now ?? new Date();

  // 1. Load tenant format config with fallback.
  const tenantConfig = await getTenantConfig(opts.utilityId);
  const formats =
    (tenantConfig.settings.numberFormats as Record<string, NumberFormatConfig> | undefined) ?? {};
  const entityFormat: NumberFormatConfig = formats[opts.entity] ?? {
    template: opts.defaultTemplate,
    startAt: opts.defaultStartAt ?? 1,
  };

  // 2. Parse + build regex.
  const parsed = parseTemplate(entityFormat.template);
  const { match, seqExtract } = buildMatchPattern(parsed, now);

  // 3. Raw query — uses the `~` regex operator. Parameters are bound
  //    positionally; we never interpolate untrusted values into the
  //    SQL string. Table + column names come from the caller, which
  //    is always our own code, so those are safe to interpolate.
  const sql =
    `SELECT ${opts.columnName} AS identifier ` +
    `FROM ${opts.tableName} ` +
    `WHERE utility_id = $1::uuid AND ${opts.columnName} ~ $2 ` +
    `ORDER BY ${opts.columnName} DESC LIMIT 50`;

  const rows = (await opts.db.$queryRawUnsafe(sql, opts.utilityId, match)) as Array<{
    identifier: string;
  }>;

  // 4. Parse the numeric tail of each matched row and take the max.
  //    We order by column DESC and take 50 rather than MAX() because
  //    string-ordering doesn't sort numerically (e.g. "9" > "10"), so
  //    we need to parse a batch and find the real max.
  let existingMax: number | null = null;
  for (const row of rows) {
    const m = seqExtract.exec(row.identifier);
    if (!m) continue;
    const n = Number(m[1]);
    if (Number.isFinite(n) && (existingMax === null || n > existingMax)) {
      existingMax = n;
    }
  }

  const seq = nextSeq(existingMax, entityFormat.startAt ?? 1);

  // 5. Format back into the template.
  return format(parsed, seq, now);
}

/**
 * Run an insert with automatic retry when the generator's candidate
 * number collides with a concurrent insert from another request.
 * `createFn` is invoked with the generated number; if it throws a
 * Prisma P2002 unique-constraint error, we regenerate and retry.
 */
export async function generateAndInsertWithRetry<T>(
  opts: NumberGeneratorOptions & {
    createFn: (generatedNumber: string) => Promise<T>;
    maxAttempts?: number;
  },
): Promise<T> {
  const maxAttempts = opts.maxAttempts ?? 3;
  let lastError: unknown;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const candidate = await generateNumber(opts);
    try {
      return await opts.createFn(candidate);
    } catch (err) {
      // Prisma wraps unique-constraint violations as P2002.
      if (
        err &&
        typeof err === "object" &&
        "code" in err &&
        (err as { code?: string }).code === "P2002"
      ) {
        lastError = err;
        continue;
      }
      throw err;
    }
  }
  throw Object.assign(
    new Error(
      `Failed to generate a unique number for ${opts.entity} after ${maxAttempts} attempts`,
    ),
    { cause: lastError, statusCode: 500, code: "NUMBER_GENERATION_FAILED" },
  );
}
