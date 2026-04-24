import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../lib/audit-wrap.js", () => ({
  auditCreate: vi.fn(async (_c, _e, fn) => fn()),
  auditUpdate: vi.fn(async (_c, _e, _b, fn) => fn()),
}));

const assertTypeMock = vi.fn();
vi.mock("../../services/service-request-type-def.service.js", () => ({
  assertServiceRequestTypeCode: (u: string, c: string) => assertTypeMock(u, c),
}));

const resolveSlaMock = vi.fn();
vi.mock("../../services/sla.service.js", () => ({
  resolveSlaForRequest: (u: string, t: string, p: string) => resolveSlaMock(u, t, p),
}));

const nextNumberMock = vi.fn();
vi.mock("../../services/service-request-counter.service.js", () => ({
  nextRequestNumber: (u: string, y: number) => nextNumberMock(u, y),
}));

import {
  createServiceRequest,
  transitionServiceRequest,
  completeServiceRequest,
  cancelServiceRequest,
  assignServiceRequest,
  updateServiceRequest,
  isValidTransition,
} from "../../services/service-request.service.js";
import { prisma } from "../../lib/prisma.js";

const UID = "00000000-0000-4000-8000-00000000000a";
const ACTOR = "00000000-0000-4000-8000-00000000000b";

function sr(partial: Partial<{ status: string; slaDueAt: Date | null; priority: string; requestType: string }> = {}) {
  return {
    id: "sr-1",
    utilityId: UID,
    requestNumber: "SR-2026-000001",
    accountId: null,
    premiseId: null,
    serviceAgreementId: null,
    requestType: partial.requestType ?? "LEAK_REPORT",
    requestSubtype: null,
    priority: partial.priority ?? "HIGH",
    status: partial.status ?? "NEW",
    source: "CSR",
    description: "desc",
    resolutionNotes: null,
    slaId: null,
    slaDueAt: partial.slaDueAt === undefined ? new Date("2026-04-23T20:00:00Z") : partial.slaDueAt,
    slaBreached: false,
    assignedTo: null,
    assignedTeam: null,
    externalSystem: null,
    externalRequestId: null,
    externalStatus: null,
    delinquencyActionId: null,
    billingAction: null,
    adhocChargeId: null,
    attachments: [],
    createdBy: ACTOR,
    createdAt: new Date("2026-04-23T10:00:00Z"),
    updatedAt: new Date(),
    completedAt: null,
    cancelledAt: null,
  };
}

describe("service-request state machine", () => {
  it.each([
    ["NEW", "ASSIGNED", true],
    ["NEW", "IN_PROGRESS", false],
    ["ASSIGNED", "IN_PROGRESS", true],
    ["IN_PROGRESS", "PENDING_FIELD", true],
    ["PENDING_FIELD", "IN_PROGRESS", true],
    ["COMPLETED", "IN_PROGRESS", false],
    ["CANCELLED", "NEW", false],
    ["FAILED", "IN_PROGRESS", false],
  ])("transition %s -> %s is %s", (from, to, ok) => {
    expect(isValidTransition(from as never, to as never)).toBe(ok);
  });
});

describe("createServiceRequest", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    assertTypeMock.mockResolvedValue(undefined);
    nextNumberMock.mockResolvedValue("SR-2026-000001");
  });

  it("resolves SLA and computes sla_due_at from resolutionHours", async () => {
    resolveSlaMock.mockResolvedValue({ id: "sla-1", resolutionHours: 6, responseHours: 0.5 });
    const created = sr({ status: "NEW" });
    (prisma.serviceRequest.create as ReturnType<typeof vi.fn>).mockResolvedValue(created);

    const result = await createServiceRequest(UID, ACTOR, "Jane", {
      requestType: "LEAK_REPORT",
      priority: "EMERGENCY",
      description: "leak",
    });

    const args = (prisma.serviceRequest.create as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(args.data.slaId).toBe("sla-1");
    expect(args.data.slaDueAt).toBeInstanceOf(Date);
    expect(result.requestNumber).toBe("SR-2026-000001");
  });

  it("leaves slaId and slaDueAt null when no SLA matches", async () => {
    resolveSlaMock.mockResolvedValue(null);
    (prisma.serviceRequest.create as ReturnType<typeof vi.fn>).mockResolvedValue(sr());
    await createServiceRequest(UID, ACTOR, "Jane", {
      requestType: "OTHER",
      priority: "LOW",
      description: "x",
    });
    const args = (prisma.serviceRequest.create as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(args.data.slaId).toBeNull();
    expect(args.data.slaDueAt).toBeNull();
  });
});

describe("completeServiceRequest", () => {
  beforeEach(() => vi.clearAllMocks());

  it("sets slaBreached=true when completed after slaDueAt", async () => {
    (prisma.serviceRequest.findFirstOrThrow as ReturnType<typeof vi.fn>).mockResolvedValue(
      sr({ status: "IN_PROGRESS", slaDueAt: new Date("2026-04-23T10:00:00Z") }),
    );
    (prisma.serviceRequest.update as ReturnType<typeof vi.fn>).mockImplementation(async ({ data }) => ({
      ...sr(), ...data, status: "COMPLETED",
    }));
    vi.useFakeTimers().setSystemTime(new Date("2026-04-23T13:00:00Z"));
    const result = await completeServiceRequest(UID, ACTOR, "Jane", "sr-1", { resolutionNotes: "fixed" });
    expect(result.slaBreached).toBe(true);
    vi.useRealTimers();
  });

  it("sets slaBreached=false when completed within SLA", async () => {
    (prisma.serviceRequest.findFirstOrThrow as ReturnType<typeof vi.fn>).mockResolvedValue(
      sr({ status: "IN_PROGRESS", slaDueAt: new Date("2026-04-23T20:00:00Z") }),
    );
    (prisma.serviceRequest.update as ReturnType<typeof vi.fn>).mockImplementation(async ({ data }) => ({
      ...sr(), ...data, status: "COMPLETED",
    }));
    vi.useFakeTimers().setSystemTime(new Date("2026-04-23T12:00:00Z"));
    const result = await completeServiceRequest(UID, ACTOR, "Jane", "sr-1", { resolutionNotes: "fixed" });
    expect(result.slaBreached).toBe(false);
    vi.useRealTimers();
  });

  it("rejects completion from a terminal state", async () => {
    (prisma.serviceRequest.findFirstOrThrow as ReturnType<typeof vi.fn>).mockResolvedValue(sr({ status: "CANCELLED" }));
    await expect(completeServiceRequest(UID, ACTOR, "Jane", "sr-1", { resolutionNotes: "x" }))
      .rejects.toMatchObject({ statusCode: 409 });
  });
});

describe("assignServiceRequest", () => {
  it("auto-transitions NEW -> ASSIGNED when assignedTo is set", async () => {
    vi.clearAllMocks();
    (prisma.serviceRequest.findFirstOrThrow as ReturnType<typeof vi.fn>).mockResolvedValue(sr({ status: "NEW" }));
    (prisma.serviceRequest.update as ReturnType<typeof vi.fn>).mockImplementation(async ({ data }) => ({
      ...sr(), ...data, status: "ASSIGNED",
    }));
    const result = await assignServiceRequest(UID, ACTOR, "Jane", "sr-1", {
      assignedTo: "00000000-0000-4000-8000-00000000000c",
    });
    expect(result.status).toBe("ASSIGNED");
  });
});

describe("updateServiceRequest", () => {
  it("recomputes slaDueAt when priority changes and a matching SLA exists", async () => {
    vi.clearAllMocks();
    (prisma.serviceRequest.findFirstOrThrow as ReturnType<typeof vi.fn>).mockResolvedValue(
      sr({ status: "IN_PROGRESS", priority: "NORMAL" }),
    );
    resolveSlaMock.mockResolvedValue({ id: "sla-2", resolutionHours: 3, responseHours: 1 });
    (prisma.serviceRequest.update as ReturnType<typeof vi.fn>).mockImplementation(async ({ data }) => ({
      ...sr(), ...data,
    }));
    const result = await updateServiceRequest(UID, ACTOR, "Jane", "sr-1", { priority: "EMERGENCY" });
    expect(result.slaId).toBe("sla-2");
    expect(result.slaDueAt).toBeInstanceOf(Date);
  });
});
