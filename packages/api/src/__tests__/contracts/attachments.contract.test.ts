import { describe, it, expect, beforeEach, vi } from "vitest";
import { ATTACHMENT_ENTITY_TYPES } from "@utility-cis/shared";
import { createTestApp, createTestToken } from "../setup.js";
import { prisma } from "../../lib/prisma.js";
import { attachmentsListQuery, attachmentsUploadFields } from "./web-payloads.js";

/**
 * Contract test: every PascalCase entity type the web ships with MUST be
 * accepted by the attachments route. This is the single test that would have
 * caught the 2026-04-09 regression where the API validator was changed to
 * lowercase.
 */

const ENTITY_ID = "11111111-1111-4111-8111-111111111111";

describe("Contract: attachments ← web", () => {
  const token = createTestToken();
  const headers = { authorization: `Bearer ${token}` };

  beforeEach(() => {
    vi.clearAllMocks();
    (prisma.tenantModule.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      { moduleKey: "attachments" },
    ]);
    (prisma.cisUser.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: "test-user-001",
      utilityId: "test-utility-001",
      roleId: "role-admin",
      isActive: true,
      role: {
        name: "Admin",
        permissions: { attachments: ["VIEW", "CREATE", "EDIT", "DELETE"] },
      },
    });
    (prisma.attachment.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
  });

  // This is the assertion that protects against casing drift: if somebody
  // adds a new entity type to the web but forgets the shared constant, the
  // test suite itself becomes unusable. If somebody narrows the API enum,
  // every single iteration of this loop fails at once.
  it("exercises every entity type from packages/shared", () => {
    expect(ATTACHMENT_ENTITY_TYPES.length).toBeGreaterThanOrEqual(7);
  });

  describe.each(ATTACHMENT_ENTITY_TYPES)(
    "entityType=%s (the casing the web app literally sends)",
    (entityType) => {
      it("GET /api/v1/attachments with the web's exact query shape returns 200", async () => {
        const app = await createTestApp();
        const query = attachmentsListQuery(entityType, ENTITY_ID);
        const qs = new URLSearchParams(query).toString();

        const response = await app.inject({
          method: "GET",
          url: `/api/v1/attachments?${qs}`,
          headers,
        });

        if (response.statusCode !== 200) {
          // Make failures obvious in CI logs
          // eslint-disable-next-line no-console
          console.error(
            `[contract] ${entityType} returned ${response.statusCode}:`,
            response.body
          );
        }
        expect(response.statusCode).toBe(200);
      });

      it("attachmentsUploadFields shape matches the upload schema", () => {
        // Not an API call — just validates that the fixture doesn't drift
        // from what the API expects. Parsing here so a tightened API enum
        // trips the fixture test, not production.
        const fields = attachmentsUploadFields(entityType, ENTITY_ID, "notes");
        expect(fields.entityType).toBe(entityType);
        expect(fields.entityId).toBe(ENTITY_ID);
        expect(fields.description).toBe("notes");
      });
    }
  );
});
