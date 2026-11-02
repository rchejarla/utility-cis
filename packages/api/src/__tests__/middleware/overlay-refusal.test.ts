import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * An overlay tenant is refused the capabilities its legacy CIS owns
 * (spec 28, OVL-T-2).
 *
 * The overlay offer mirrors a utility's existing CIS while **it** keeps
 * billing the customers. Nothing structural stopped us billing them
 * too: an overlay tenant with a cycle configured is an ordinary tenant
 * to every route, so a CSR pressing Run, or a dispatcher reaching a
 * bill day, would produce a second bill for the same period — the one
 * with our name on it.
 *
 * The refusal lives in the authorization pass, beside suspension and
 * the module check, because that is the one place every authenticated
 * request already goes. It reads the mode from the same cached row as
 * the status, so the pass costs no extra round trip — which matters,
 * since this pass once added a flat two seconds to every request by
 * fetching in sequence.
 *
 * **409, not 403.** The caller is permitted; the tenant is in a state
 * where the operation is meaningless. A 403 would send an operator to
 * check their role, which is the wrong screen, and the message names
 * the mode so the next question is the right one.
 */

const { getUtilityGuards, getTenantModules, getUserRole } = vi.hoisted(() => ({
  getUtilityGuards: vi.fn(),
  getTenantModules: vi.fn(),
  getUserRole: vi.fn(),
}));

vi.mock("../../services/rbac.service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../services/rbac.service.js")>()),
  getUtilityGuards,
  getTenantModules,
  getUserRole,
}));

type Sent = { status: number; body: unknown };

function fakeReply() {
  const sent: Sent[] = [];
  const reply = {
    sent,
    status(code: number) {
      sent.push({ status: code, body: undefined });
      return reply;
    },
    send(body: unknown) {
      if (sent.length > 0) sent[sent.length - 1].body = body;
      else sent.push({ status: 200, body });
      return reply;
    },
  };
  return reply;
}

function request(routeConfig: Record<string, unknown>) {
  return {
    user: { id: "user-1", utilityId: "tenant-1" },
    url: "/api/v1/billing-runs",
    log: { warn: () => {} },
    routeOptions: { config: routeConfig },
  };
}

async function run(routeConfig: Record<string, unknown>) {
  const { authorizationMiddleware } = await import(
    "../../middleware/authorization.js"
  );
  const reply = fakeReply();
  await authorizationMiddleware(request(routeConfig) as never, reply as never);
  return reply.sent[0];
}

beforeEach(() => {
  vi.clearAllMocks();
  getTenantModules.mockResolvedValue(["billing_runs", "customers"]);
  getUserRole.mockResolvedValue({
    isActive: true,
    permissions: { billing_runs: ["VIEW", "CREATE"], customers: ["VIEW", "CREATE", "EDIT"] },
  });
});

describe("overlay mode refusals", () => {
  it("refuses a route the legacy CIS owns, naming the mode", async () => {
    getUtilityGuards.mockResolvedValue({ status: "ACTIVE", operatingMode: "OVERLAY" });

    const sent = await run({
      module: "billing_runs",
      permission: "CREATE",
      refusedInOverlay: true,
    });

    expect(sent.status).toBe(409);
    expect(sent.body).toMatchObject({
      error: { code: "UTILITY_IN_OVERLAY_MODE" },
    });
    expect(JSON.stringify(sent.body)).toMatch(/overlay/i);
  });

  it("allows the same route for a full tenant", async () => {
    getUtilityGuards.mockResolvedValue({ status: "ACTIVE", operatingMode: "FULL" });

    const sent = await run({
      module: "billing_runs",
      permission: "CREATE",
      refusedInOverlay: true,
    });

    expect(sent).toBeUndefined();
  });

  it("leaves routes that are not refused alone in overlay mode", async () => {
    // Reading is the whole point of an overlay tenant — staff look at
    // the mirrored data and at the variance report.
    getUtilityGuards.mockResolvedValue({ status: "ACTIVE", operatingMode: "OVERLAY" });

    const sent = await run({ module: "customers", permission: "VIEW" });

    expect(sent).toBeUndefined();
  });

  it("reports suspension first, because it is the more fundamental state", async () => {
    // A suspended overlay tenant sent to "this is in overlay mode"
    // would have an operator chasing the wrong thing entirely.
    getUtilityGuards.mockResolvedValue({ status: "SUSPENDED", operatingMode: "OVERLAY" });

    const sent = await run({
      module: "billing_runs",
      permission: "CREATE",
      refusedInOverlay: true,
    });

    expect(sent.status).toBe(403);
    expect(sent.body).toMatchObject({ error: { code: "UTILITY_SUSPENDED" } });
  });

  it("reports a disabled module before the mode", async () => {
    // "Not enabled" is about what the tenant bought; the mode is about
    // what it is doing with what it bought. The first is the earlier
    // question.
    getUtilityGuards.mockResolvedValue({ status: "ACTIVE", operatingMode: "OVERLAY" });
    getTenantModules.mockResolvedValue(["customers"]);

    const sent = await run({
      module: "billing_runs",
      permission: "CREATE",
      refusedInOverlay: true,
    });

    expect(sent.status).toBe(403);
    expect(sent.body).toMatchObject({ error: { code: "MODULE_DISABLED" } });
  });

  it("refuses before the permission check, so the message is about the tenant", async () => {
    // A CSR who does hold the permission must still be told the mode,
    // not handed a 403 that makes them doubt their role.
    getUtilityGuards.mockResolvedValue({ status: "ACTIVE", operatingMode: "OVERLAY" });
    getUserRole.mockResolvedValue({ isActive: true, permissions: {} });

    const sent = await run({
      module: "billing_runs",
      permission: "CREATE",
      refusedInOverlay: true,
    });

    expect(sent.status).toBe(409);
    expect(sent.body).toMatchObject({ error: { code: "UTILITY_IN_OVERLAY_MODE" } });
  });

  it("treats an unreadable mode as not overlay, as it does an unreadable status", async () => {
    // getUtilityGuards returns null when the row could not be read.
    // Refusing on that would take a whole tenant offline over a blip.
    getUtilityGuards.mockResolvedValue(null);

    const sent = await run({
      module: "billing_runs",
      permission: "CREATE",
      refusedInOverlay: true,
    });

    expect(sent).toBeUndefined();
  });
});

describe("mirrored-record refusals (OVL-T-3)", () => {
  it("refuses a staff write to a mirrored record, pointing at notes", async () => {
    /*
     * Since the import began matching on a legacy key and updating in
     * place, an edit here does not merely diverge — the next cycle
     * overwrites it silently, leaving an audit row for a change nobody
     * asked for. Before the upsert the edit at least survived.
     */
    getUtilityGuards.mockResolvedValue({ status: "ACTIVE", operatingMode: "OVERLAY" });

    const sent = await run({
      module: "customers",
      permission: "EDIT",
      refusedWhenMirrored: true,
    });

    expect(sent.status).toBe(409);
    expect(sent.body).toMatchObject({
      error: { code: "RECORD_MIRRORED_FROM_LEGACY" },
    });
    expect(JSON.stringify(sent.body)).toMatch(/add a note/i);
  });

  it("leaves the read alone — viewing the mirror is the product", async () => {
    getUtilityGuards.mockResolvedValue({ status: "ACTIVE", operatingMode: "OVERLAY" });
    const sent = await run({ module: "customers", permission: "VIEW" });
    expect(sent).toBeUndefined();
  });

  it("allows the write for a full tenant", async () => {
    getUtilityGuards.mockResolvedValue({ status: "ACTIVE", operatingMode: "FULL" });
    const sent = await run({
      module: "customers",
      permission: "EDIT",
      refusedWhenMirrored: true,
    });
    expect(sent).toBeUndefined();
  });

  it("tells a portal customer something a customer can act on", async () => {
    /*
     * A portal token carries a customerId and belongs to a member of
     * the public, who has no idea what a legacy CIS is and cannot add
     * a note — telling them to would be worse than telling them
     * nothing.
     */
    getUtilityGuards.mockResolvedValue({ status: "ACTIVE", operatingMode: "OVERLAY" });

    const reply = fakeReply();
    const { authorizationMiddleware } = await import(
      "../../middleware/authorization.js"
    );
    await authorizationMiddleware(
      {
        user: { id: "user-1", utilityId: "tenant-1", customerId: "cust-1" },
        url: "/portal/api/profile",
        log: { warn: () => {} },
        routeOptions: {
          config: { module: "customers", permission: "EDIT", refusedWhenMirrored: true },
        },
      } as never,
      reply as never,
    );

    expect(reply.sent[0].status).toBe(409);
    // The *message* is what a customer reads; the code is for programs
    // and is the same either way, so it is excluded from this.
    const message = (reply.sent[0].body as { error: { message: string } }).error.message;
    expect(message).toMatch(/contact the utility/i);
    expect(message).not.toMatch(/legacy|overlay|note/i);
  });
});
