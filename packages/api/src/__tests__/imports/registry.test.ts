import { describe, it, expect, beforeAll } from "vitest";

/**
 * Every registered import kind has to be reachable from the UI.
 *
 * The framework made adding a kind cheap — one handler file and one line
 * in `handlers/index.ts` — and that is exactly how a kind ends up with
 * no way in. The wizard route is a page under `/<entity>/import`, and
 * nothing connected the two: a handler could register, serve
 * `GET /imports/kinds`, generate a template, accept a POST, and still be
 * a URL you had to know by heart.
 *
 * So the route is declared *by the handler*, which puts it in the one
 * place that cannot be forgotten without a type error, and
 * `/imports` builds its menu from the list. A seventh kind appears there
 * on registration, with no page to edit.
 *
 * It is a web route named in an API module, which is worth defending
 * rather than assuming. The simpler alternative is a map in the web app
 * keyed by kind — and that is what the premise kind effectively had: a
 * page at `/premises/import` that existed for months. The handler
 * already declares `module` and `permission`, both of which exist to
 * drive the client, so one more client-facing fact is not a new kind of
 * knowledge for it.
 */

let listKinds: typeof import("../../imports/registry.js")["listKinds"];

beforeAll(async () => {
  // Importing the index is the registration side effect.
  await import("../../imports/handlers/index.js");
  ({ listKinds } = await import("../../imports/registry.js"));
});

describe("the import kind registry", () => {
  it("registers the six kinds the specs name", () => {
    expect(listKinds().map((k) => k.kind).sort()).toEqual([
      "account",
      "customer",
      "meter",
      "meter_read",
      "premise",
      "service_agreement",
    ]);
  });

  it("gives every kind a wizard route", () => {
    for (const kind of listKinds()) {
      expect(kind.wizardPath, `${kind.kind} has no wizardPath`).toBeTruthy();
      // An absolute path under the web app, ending at the wizard —
      // relative or hand-mangled values would 404 from the menu.
      expect(kind.wizardPath).toMatch(/^\/[a-z-]+(\/[a-z-]+)*\/import$/);
    }
  });

  it("gives no two kinds the same wizard route", () => {
    const paths = listKinds().map((k) => k.wizardPath);
    expect(new Set(paths).size).toBe(paths.length);
  });

  it("declares custom fields for every kind whose entity can carry them", () => {
    /*
     * `CUSTOM_FIELD_ENTITY_TYPES` is the set of entities with a
     * `custom_fields` column. A handler for one of them that forgets
     * `customFieldEntity` silently drops the tenant's own facts — which
     * is exactly what happened for months: premise was wired only when
     * stormwater forced it, because stormwater is priced from
     * `premise:attr:eru_count`, and the other four stayed blind for a
     * day after that. Nothing would have failed.
     *
     * `meter_read` is deliberately absent: a reading has no custom
     * fields, and the entity type list is where that is decided.
     */
    const CARRIES_CUSTOM_FIELDS: Record<string, string> = {
      customer: "customer",
      premise: "premise",
      meter: "meter",
      account: "account",
      service_agreement: "service_agreement",
    };
    for (const kind of listKinds()) {
      const expected = CARRIES_CUSTOM_FIELDS[kind.kind];
      if (expected) {
        expect(kind.customFieldEntity, `${kind.kind} must declare it`).toBe(expected);
      } else {
        expect(kind.customFieldEntity, `${kind.kind} must not`).toBeUndefined();
      }
    }
  });

  it("names a label and a permission for each, which the menu gates on", () => {
    for (const kind of listKinds()) {
      expect(kind.label).toBeTruthy();
      expect(kind.module).toBeTruthy();
      expect(["CREATE", "EDIT"]).toContain(kind.permission);
    }
  });
});
