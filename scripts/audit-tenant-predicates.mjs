/**
 * Audit the service layer for queries that are not scoped by tenant.
 *
 * The shape this looks for is the one recorded in architecture doc §7.1:
 * a function that receives a `utilityId` and spends it on some queries
 * while others read by primary key alone. `notification.service.ts` had
 * seven instances of it, reachable from two workers and three routes,
 * and they survived until someone looked on purpose.
 *
 *   node scripts/audit-tenant-predicates.mjs            # both passes
 *   node scripts/audit-tenant-predicates.mjs --by-id    # pass 1 only
 *   node scripts/audit-tenant-predicates.mjs --other    # pass 2 only
 *
 * **This narrows; it does not rule.** Every hit needs reading. A hit is
 * fine when the id was proved against `utility_id` earlier in the same
 * function — "entry-proved", the pattern `processBatch` and `lockAccount`
 * use — and a miss is only a miss if a request can choose the id.
 *
 * Two blind spots, both of which this script has had and one of which
 * hid 27 of 89 sites until 2026-10-18:
 *
 *   1. **Shorthand.** `where: { id }` names an id without a colon. The
 *      id pattern below matches `id:`, `id,` and `id }` for that reason.
 *      Check this first if you change it.
 *   2. **Spreads.** `where: { ...baseWhere, status }` carries the tenant
 *      predicate inside a variable, so pass 2 reports it as unscoped.
 *      `premise.service.ts`'s stats counts are the known instance.
 *
 * Neither pass sees raw SQL. `$queryRaw` tenancy is read by hand.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.argv.find((a) => !a.startsWith("--") && a.includes("packages")) ??
  "packages/api/src/services";
const MODE = process.argv.includes("--by-id")
  ? "by-id"
  : process.argv.includes("--other")
    ? "other"
    : "both";

const METHODS =
  "findUnique|findUniqueOrThrow|findFirst|findFirstOrThrow|findMany|update|updateMany|" +
  "delete|deleteMany|count|aggregate|upsert|groupBy";

/** `id:`, and the shorthand `{ id }` / `{ id, … }`. See blind spot 1. */
const NAMES_ID = /(^|[{,\s])id\s*[:,}]/;

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) {
      if (entry !== "__tests__" && entry !== "node_modules") out.push(...walk(p));
    } else if (entry.endsWith(".ts") && !entry.endsWith(".test.ts")) {
      out.push(p);
    }
  }
  return out;
}

function balanced(src, from, open, close) {
  let i = src.indexOf(open, from);
  if (i < 0) return "";
  let depth = 0;
  const start = i;
  for (; i < src.length; i++) {
    if (src[i] === open) depth++;
    else if (src[i] === close && --depth === 0) return src.slice(start, i + 1);
  }
  return src.slice(start);
}

function whereOf(call) {
  const m = /where\s*:\s*\{/.exec(call);
  return m ? balanced(call, m.index + m[0].length - 1, "{", "}") : null;
}

const byId = [];
const other = [];

for (const file of walk(ROOT)) {
  const src = readFileSync(file, "utf8");
  const re = new RegExp(`\\b(?:prisma|tx|client|db)\\.([a-zA-Z0-9_]+)\\.(${METHODS})\\b`, "g");
  let m;
  while ((m = re.exec(src))) {
    const where = whereOf(balanced(src, m.index + m[0].length, "(", ")"));
    if (!where || /utilityId/.test(where)) continue;
    const row = {
      at: `${file.replace(/\\/g, "/")}:${src.slice(0, m.index).split("\n").length}`,
      call: `${m[1]}.${m[2]}`,
      keys: [...where.matchAll(/([a-zA-Z0-9_]+)\s*:/g)].map((x) => x[1]).join(","),
    };
    (NAMES_ID.test(where) ? byId : other).push(row);
  }
}

function report(title, rows, note) {
  console.log(`\n=== ${title}: ${rows.length} ===`);
  console.log(note);
  for (const r of rows) console.log(`  ${r.at}  ${r.call}  where{${r.keys}}`);
}

if (MODE !== "other") {
  report(
    "by-id with no tenant predicate",
    byId,
    "Each is fine only if the id was proved against utility_id earlier in the\n" +
      "same function. Baseline 2026-10-18: 89, all entry-proved, no holes.",
  );
}
if (MODE !== "by-id") {
  report(
    "scoped by another column, no tenant predicate",
    other,
    "Mostly legitimate — global reference reads, lookups inside an already\n" +
      "proved transaction, and spreads that carry the predicate in a variable.\n" +
      "Baseline 2026-10-18: 19.",
  );
}
console.log("");
