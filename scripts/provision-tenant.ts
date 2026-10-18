/**
 * Bring a tenant into existence, or list the ones that exist.
 *
 * This is the whole operator interface at build-order step 3: D1 says
 * "callable from a script, no UI", and the build order puts a console at
 * step 6 "only if operating the above through scripts proves genuinely
 * insufficient". `--dry-run` and `--list` are what make that claim
 * testable rather than merely asserted — seeing what exists, and seeing
 * what a run would change before it changes it, are the two things an
 * operator would otherwise open a console for.
 *
 *   npx tsx scripts/provision-tenant.ts --name "City of Example"
 *   npx tsx scripts/provision-tenant.ts --name "City of Example" --dry-run
 *   npx tsx scripts/provision-tenant.ts --utility-id <uuid> --name "X" \
 *                                       --admin-email a@b.gov --admin-name "Pat"
 *   npx tsx scripts/provision-tenant.ts --list
 *
 * Run from the repo root. Reads DATABASE_URL the way every other Prisma
 * caller here does; see CLAUDE.md on a stray DATABASE_URL in the shell.
 */
import { parseArgs } from "node:util";
import { randomUUID } from "node:crypto";
import { provisionTenant, listUtilities } from "../packages/api/src/services/provisioning.service.js";

const USAGE = `
provision-tenant — create a tenant, or list tenants

  --list                   list every utility with its module, role and user counts
  --name <name>            display name (required unless --list)
  --utility-id <uuid>      defaults to a fresh uuid
  --admin-email <email>    create a first admin holding System Admin
  --admin-name <name>      required with --admin-email
  --dry-run                do everything, report it, write nothing
`.trim();

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      list: { type: "boolean", default: false },
      name: { type: "string" },
      "utility-id": { type: "string" },
      "admin-email": { type: "string" },
      "admin-name": { type: "string" },
      "dry-run": { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
  });

  if (values.help) {
    console.log(USAGE);
    return 0;
  }

  if (values.list) {
    const utilities = await listUtilities();
    if (utilities.length === 0) {
      console.log("No utilities. This database has no tenants at all.");
      return 0;
    }
    for (const u of utilities) {
      console.log(
        `${u.name}\n  id       ${u.id}\n  status   ${u.status}\n` +
          `  created  ${u.createdAt.toISOString().slice(0, 10)}\n` +
          `  holds    ${u.moduleCount} modules, ${u.roleCount} roles, ${u.userCount} users`,
      );
    }
    return 0;
  }

  if (!values.name?.trim()) {
    console.error("--name is required.\n\n" + USAGE);
    return 1;
  }
  if (Boolean(values["admin-email"]) !== Boolean(values["admin-name"])) {
    console.error("--admin-email and --admin-name go together.\n\n" + USAGE);
    return 1;
  }

  const utilityId = values["utility-id"] ?? randomUUID();
  const result = await provisionTenant({
    utilityId,
    name: values.name.trim(),
    firstAdmin: values["admin-email"]
      ? { email: values["admin-email"], name: values["admin-name"] as string }
      : undefined,
    dryRun: values["dry-run"],
  });

  // Report what this call actually did, so a re-run reads as the no-op it
  // was rather than looking identical to the first run.
  console.log(values["dry-run"] ? "DRY RUN — nothing was written." : "Provisioned.");
  console.log(`  utility          ${result.utilityId}`);
  console.log(`  utility created  ${result.created}`);
  console.log(`  modules enabled  ${result.modulesEnabled}`);
  console.log(`  roles created    ${result.rolesCreated}`);
  console.log(`  admin created    ${result.adminCreated}`);
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    const e = err as { code?: string; message?: string };
    console.error(e.code ? `${e.code}: ${e.message}` : String(err));
    process.exit(1);
  });
