import { describe, it, expect, vi, beforeEach } from "vitest";
import { nextRequestNumber } from "../../services/service-request-counter.service.js";
import { prisma } from "../../lib/prisma.js";

const UID = "00000000-0000-4000-8000-00000000000a";

describe("service-request-counter", () => {
  beforeEach(() => vi.clearAllMocks());

  it("formats as SR-YYYY-NNNNNN with zero-padded counter", async () => {
    const fakeTx = {
      $queryRaw: vi.fn().mockResolvedValue([{ next_value: 42n }]),
      serviceRequestCounter: {
        upsert: vi.fn().mockResolvedValue({ nextValue: 43n }),
      },
    };
    // The implementation is expected to run inside an interactive
    // transaction via prisma.$transaction — we stub that here.
    (prisma.$transaction as ReturnType<typeof vi.fn>).mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => fn(fakeTx));

    const result = await nextRequestNumber(UID, 2026);
    expect(result).toBe("SR-2026-000042");
  });

  it("pads multi-digit years independently from the counter", async () => {
    const fakeTx = {
      $queryRaw: vi.fn().mockResolvedValue([{ next_value: 1n }]),
      serviceRequestCounter: { upsert: vi.fn().mockResolvedValue({ nextValue: 2n }) },
    };
    (prisma.$transaction as ReturnType<typeof vi.fn>).mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => fn(fakeTx));

    const result = await nextRequestNumber(UID, 2027);
    expect(result).toBe("SR-2027-000001");
  });
});
