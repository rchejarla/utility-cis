/**
 * Does the scheduler config actually work against a real database?
 *
 * Written because the unit suites mock Prisma end to end, so they passed
 * for three commits while the dev database was missing columns the code
 * referenced. A mock cannot tell you that a query compiles against the
 * schema you have.
 */
import { runAsTenant, runAsPlatform } from "../src/lib/tenant-context.js";
import {
  getAutomationConfig,
  patchAutomationConfig,
  tenantsForScheduler,
} from "../src/services/automation-config.service.js";

const UID = "00000000-0000-4000-8000-000000000001";

async function main() {
  const before = await runAsTenant(UID, async () => getAutomationConfig(UID));
  console.log("read:", before.schedulers.map((s) => `${s.key}=${s.enabled}/${s.runHourLocal}`).join(" "));

  const after = await runAsTenant(UID, async () =>
    patchAutomationConfig(UID, { schedulers: [{ key: "billing", enabled: true, runHourLocal: 5 }] }),
  );
  const billing = after.schedulers.find((s) => s.key === "billing");
  console.log("after patch: billing enabled =", billing?.enabled, "hour =", billing?.runHourLocal);

  const tenants = await runAsPlatform(async () => tenantsForScheduler("billing"));
  console.log("dispatcher sees", tenants.length, "tenant(s):", JSON.stringify(tenants));

  const delinq = await runAsPlatform(async () => tenantsForScheduler("delinquency"));
  console.log("delinquency sees", delinq.length, "tenant(s)");

  // Put it back, so the dev tenant is left as the seed made it.
  await runAsTenant(UID, async () =>
    patchAutomationConfig(UID, { schedulers: [{ key: "billing", enabled: false, runHourLocal: 3 }] }),
  );
  console.log("restored");
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error("FAILED:", err);
    process.exit(1);
  },
);
