import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/**
 * Teardown that the API cannot do, for specs that write rows nothing can
 * delete.
 *
 * ## Why this exists
 *
 * Some journeys are irreversible by design. A transfer of service closes
 * one agreement and opens another; a move-out finalizes agreements and
 * detaches meters. There is **no `DELETE /api/v1/service-agreements/:id`**
 * — closing is the lifecycle, deleting is not an operation — and none for
 * premises or meters either. So a browser spec that drives those journeys
 * against the shared dev database leaves rows behind on every run, and
 * `read-route-walk.spec.ts`'s approach (empty the walk through the API)
 * has no equivalent.
 *
 * Without this, the transfer spec left one FINAL agreement per run.
 * Twenty runs is twenty dead agreements on the Service Agreements list
 * and in every operator's filters.
 *
 * ## Why `prisma db execute` and not a database client
 *
 * The repo root has no `pg` and no `dotenv`, so a spec cannot open a
 * connection or read `DATABASE_URL` without new dependencies and a
 * hand-rolled credential path. `packages/shared/prisma.config.ts` already
 * owns both: it loads that package's `.env`, where `DATABASE_URL` names
 * the **owner** role, which is the role fixture work gets here — the same
 * decision `_effective-dating-fixtures.ts` made for `resetDb`, and the
 * same mechanism (`execSync` + `--stdin`).
 *
 * It costs a process per call, which is why it belongs in `afterAll` and
 * not in a loop.
 *
 * ## What it is not for
 *
 * **Setup belongs in the API.** A spec that seeds rows with SQL is
 * testing a database it arranged by hand rather than a product that can
 * reach that state — and it would not notice the day the API stops being
 * able to produce it. Everything these specs assert about is created
 * through endpoints; this is only for taking rows away afterwards.
 *
 * It is also not a verification tool. A teardown checked with the same
 * connection that performed it shares its failure modes, so callers
 * confirm the rows are gone **through the API** instead.
 */

/**
 * `packages/shared`, found by walking up from the working directory.
 *
 * Not `import.meta.url`: Playwright transpiles these specs to CommonJS —
 * the repo root has no `"type": "module"` — so `import.meta` is a syntax
 * error at load and takes the whole spec file with it, reported as "No
 * tests found". Not `__dirname` either, which would work today and stop
 * working the day the repo becomes ESM.
 *
 * The landmark is the Prisma config rather than the directory name,
 * because that config is the thing being relied on: it supplies the
 * schema path and the owner `DATABASE_URL`.
 */
function sharedDir(): string {
  let dir = process.cwd();
  for (let up = 0; up < 6; up++) {
    const candidate = path.join(dir, "packages", "shared");
    if (fs.existsSync(path.join(candidate, "prisma.config.ts"))) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(
    `Could not find packages/shared/prisma.config.ts above ${process.cwd()}. ` +
      "Run Playwright from inside the repo.",
  );
}

/**
 * Run statements against the dev database as the schema owner.
 *
 * Throws with the command's own stderr attached: a teardown that fails
 * silently is worse than one that fails, because the next run inherits
 * whatever it did not remove and the failure appears somewhere else.
 */
export function executeSql(sql: string): void {
  try {
    execSync("pnpm prisma db execute --stdin", {
      cwd: sharedDir(),
      input: sql,
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (err) {
    const detail =
      err && typeof err === "object" && "stderr" in err
        ? String((err as { stderr: Buffer | string }).stderr)
        : String(err);
    throw new Error(`dev-db teardown failed.\n--- sql ---\n${sql}\n--- stderr ---\n${detail}`);
  }
}

/**
 * Remove every agreement whose number starts with `prefix`, for one
 * tenant, together with the rows that hang off them.
 *
 * Cascades do most of it: `service_point` and `sa_rate_schedule_assignment`
 * both declare `onDelete: Cascade` from `service_agreement`, and
 * `service_point_meter` from `service_point`.
 *
 * Two things do not cascade, and both bit on the first run.
 *
 * **Meter reads are RESTRICT.** `meter_read.service_agreement_id` refuses
 * to let the agreement go while a read points at it, which is the
 * constraint working — a reading is a measurement someone took, not a
 * detail of the agreement that happened to own the meter. A move-out
 * writes a FINAL read, so the reads are cleared first, by agreement
 * rather than by meter: that is the FK actually in the way, and clearing
 * by meter (as `deleteMeterAndPremise` does) happens later and would not
 * have helped.
 *
 * **Audit rows have no foreign key at all** — `audit_log.entity_id` is a
 * bare uuid, by design, so the log outlives what it describes. A test's
 * audit rows are noise in a real operator's history, so they go too,
 * which means collecting the child ids *before* the cascade removes them.
 *
 * `utilityId` is required rather than inferred: this is a `DELETE` with a
 * `LIKE`, and the one thing worth being certain of is whose rows it is
 * allowed to touch.
 */
export function deleteAgreementsByPrefix(utilityId: string, prefix: string): void {
  const doomed = `
    SELECT id FROM service_agreement
    WHERE utility_id = '${utilityId}'::uuid AND agreement_number LIKE '${prefix}%'
  `;
  executeSql(`
    DELETE FROM audit_log
    WHERE utility_id = '${utilityId}'::uuid
      AND entity_id IN (
        ${doomed}
        UNION ALL
        SELECT sp.id FROM service_point sp WHERE sp.service_agreement_id IN (${doomed})
        UNION ALL
        SELECT spm.id FROM service_point_meter spm
        WHERE spm.service_point_id IN (
          SELECT sp.id FROM service_point sp WHERE sp.service_agreement_id IN (${doomed})
        )
      );
    DELETE FROM meter_read
    WHERE utility_id = '${utilityId}'::uuid AND service_agreement_id IN (${doomed});
    DELETE FROM service_agreement WHERE id IN (${doomed});
  `);
}

/**
 * Remove a meter and a premise this spec created, by their own markers.
 *
 * After the agreements are gone, so no service point still references
 * the meter — `meter` is `onDelete: Restrict` from `service_point_meter`,
 * which is the constraint doing its job rather than something to work
 * around. Reads are deleted first for the same reason: `meter_read`
 * points at the meter, and these specs capture final reads.
 */
export function deleteMeterAndPremise(
  utilityId: string,
  meterNumber: string,
  premiseAddress: string,
): void {
  executeSql(`
    DELETE FROM meter_read
    WHERE utility_id = '${utilityId}'::uuid
      AND meter_id IN (
        SELECT id FROM meter
        WHERE utility_id = '${utilityId}'::uuid AND meter_number = '${meterNumber}'
      );
    DELETE FROM meter
    WHERE utility_id = '${utilityId}'::uuid AND meter_number = '${meterNumber}';
    DELETE FROM premise
    WHERE utility_id = '${utilityId}'::uuid AND address_line1 = '${premiseAddress}';
  `);
}
