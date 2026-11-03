import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { MODULES, MODULE_META } from "@utility-cis/shared";

/**
 * Every module key has to be enforced by the server.
 *
 * A key is a promise that something is gated. Until 2026-11-03
 * `tenant_users` was in `MODULES`, named by the Users & Roles screen and
 * the mobile menu, and **enforced by no route whatsoever** — the users
 * and roles APIs gated on `settings`, which Utility Admin holds
 * VIEW-only. So the role whose description is "full access except system
 * settings" could not create a staff user, and nothing anywhere said so.
 * The same shape had the custom-fields page gating `tenant_profile` while
 * its API demanded `settings`, which 403'd on save.
 *
 * None of that is visible by reading one file, which is why it survived.
 * This test reads the whole server for every key and fails when one is
 * decorative — so the next key added for a screen cannot ship without
 * the server agreeing.
 *
 * It is a source scan rather than a route-table walk on purpose: it
 * catches a key named in a service or a middleware as readily as one in
 * a route's `config`, including the indirect kind
 * (`UNFILTERED_READ_MODULE = "settings"` in `routes/audit-log.ts`), which
 * a registered-route walk would miss.
 */

const SRC = join(import.meta.dirname ?? __dirname, "..");

/** Every .ts under src, minus the tests and the declarations. */
function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "__tests__" || entry.name === "node_modules") continue;
      sourceFiles(path, out);
    } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) {
      out.push(path);
    }
  }
  return out;
}

const serverSource = sourceFiles(SRC)
  .map((f) => readFileSync(f, "utf8"))
  .join("\n");

/**
 * Keys the server legitimately never names.
 *
 * Each is here with the reason it is not a defect. Anything else that
 * appears in `MODULES` without server code behind it is one.
 */
const CLIENT_SIDE_ONLY: Record<string, string> = {
  /*
   * The theme editor reads and writes `/api/v1/theme`, which is gated on
   * the tenant's own profile authority; `theme` exists so a tenant can
   * grant the editor without granting the rest of the profile, and that
   * distinction is made in the menu. Listed rather than silently
   * tolerated: if the theme routes ever enforce it, delete this line.
   */
  theme: "Gates the theme editor's menu entry; the route behind it answers to tenant_profile.",
  /*
   * Search has no route of its own — the global search box calls each
   * entity's own list endpoint, so each result is already gated by the
   * key for that entity. The key gates whether the box appears.
   */
  search: "Gates the search box; results come from each entity's own gated endpoint.",
};

describe("module keys", () => {
  it("gives every key a sentence saying what it covers", () => {
    for (const key of MODULES) {
      const covers = MODULE_META[key]?.covers;
      expect(covers, `${key} has no \`covers\``).toBeTruthy();
      // A sentence, not a restatement of the key.
      expect(covers.length, `${key}'s \`covers\` is too short to say anything`).toBeGreaterThan(20);
    }
  });

  it("enforces every key somewhere on the server", () => {
    const unenforced = MODULES.filter(
      (key) => !CLIENT_SIDE_ONLY[key] && !serverSource.includes(`"${key}"`),
    );
    expect(
      unenforced,
      `These keys are named by the client and enforced by nothing: ${unenforced.join(", ")}. ` +
        "A key no route checks is a gate that is not there — add the gate, or list it in " +
        "CLIENT_SIDE_ONLY with the reason.",
    ).toEqual([]);
  });

  it("explains each key it excuses, rather than listing it bare", () => {
    for (const [key, reason] of Object.entries(CLIENT_SIDE_ONLY)) {
      expect(MODULES, `${key} is excused but is not a module`).toContain(key);
      expect(reason.length, `${key}'s excuse says nothing`).toBeGreaterThan(30);
    }
  });

  it("keeps user and role administration off the system-settings key", () => {
    /*
     * The specific regression, pinned by name. `settings` is what
     * separates Utility Admin from System Admin, so anything a Utility
     * Admin should be able to do must not answer to it — and
     * administering staff is the main thing that role is for.
     */
    const users = readFileSync(join(SRC, "routes", "users.ts"), "utf8");
    const roles = readFileSync(join(SRC, "routes", "roles.ts"), "utf8");
    for (const [name, source] of [
      ["users", users],
      ["roles", roles],
    ] as const) {
      expect(source, `${name} routes must gate on tenant_users`).toContain('module: "tenant_users"');
      expect(source, `${name} routes must not gate on settings`).not.toContain('module: "settings"');
    }
  });

  it("keeps billing work off the account record's key", () => {
    // `POST /billing-runs`, `/:id/post` and `/:id/send` required
    // `accounts:EDIT` until 2026-11-03 — the verb that edits an address.
    const runs = readFileSync(join(SRC, "routes", "billing-runs.ts"), "utf8");
    expect(runs).toContain('module: "billing"');
    expect(runs).not.toContain('module: "accounts"');
  });

  it("keeps the type-definition lists off the operational keys", () => {
    /*
     * A Field Technician holds `premises:EDIT` for field work, which is
     * not a reason to let them rewrite the premise type list. Reads stay
     * ungated, because every form that offers those types needs them.
     */
    for (const [file, operational] of [
      ["premise-type-defs.ts", "premises"],
      ["account-type-defs.ts", "accounts"],
      ["measure-type-defs.ts", "commodities"],
    ] as const) {
      const source = readFileSync(join(SRC, "routes", file), "utf8");
      expect(source, `${file} writes must answer to tenant_profile`).toContain(
        'module: "tenant_profile"',
      );
      expect(source, `${file} must not gate writes on ${operational}`).not.toContain(
        `module: "${operational}"`,
      );
    }
  });
});
