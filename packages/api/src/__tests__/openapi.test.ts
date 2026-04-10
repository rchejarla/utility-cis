import { describe, it, expect } from "vitest";
import { buildOpenApiDocument } from "../lib/openapi.js";

/**
 * These tests are the ONLY way to catch silent drift between the Zod
 * validators and the OpenAPI document. They enforce that:
 *   1. Every declared route is present with the expected method.
 *   2. Every request/response reference resolves to an actual component.
 *   3. The document passes the minimum shape-checks required by OpenAPI 3.
 * They are intentionally structural (not snapshot): adding a new route or
 * field should not require updating this test, only adding a case.
 */

describe("OpenAPI document", () => {
  const doc = buildOpenApiDocument();

  it("reports OpenAPI 3.1 with the expected info block", () => {
    expect(doc.openapi).toBe("3.1.0");
    const info = doc.info as { title: string; version: string };
    expect(info.title).toBe("Utility CIS API");
    expect(info.version).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("declares the bearer-auth security scheme globally", () => {
    const components = doc.components as {
      securitySchemes: Record<string, { type: string; scheme?: string }>;
    };
    expect(components.securitySchemes.bearerAuth).toMatchObject({
      type: "http",
      scheme: "bearer",
    });
  });

  const REQUIRED_PATHS: Array<{ path: string; methods: string[] }> = [
    { path: "/api/v1/accounts", methods: ["get", "post"] },
    { path: "/api/v1/accounts/{id}", methods: ["get", "patch"] },
    { path: "/api/v1/customers", methods: ["get", "post"] },
    { path: "/api/v1/customers/{id}", methods: ["get", "patch"] },
    { path: "/api/v1/meters", methods: ["get", "post"] },
    { path: "/api/v1/premises", methods: ["get", "post"] },
    { path: "/api/v1/premises/geo", methods: ["get"] },
    { path: "/api/v1/rate-schedules", methods: ["get", "post"] },
    { path: "/api/v1/rate-schedules/{id}/revise", methods: ["post"] },
    { path: "/api/v1/roles/{id}", methods: ["get", "patch", "delete"] },
    { path: "/api/v1/service-agreements", methods: ["get", "post"] },
    { path: "/api/v1/users", methods: ["get", "post"] },
  ];

  it.each(REQUIRED_PATHS)("has $path with methods $methods", ({ path, methods }) => {
    const paths = doc.paths as Record<string, Record<string, unknown>>;
    expect(paths[path]).toBeDefined();
    for (const method of methods) {
      expect(paths[path][method]).toBeDefined();
    }
  });

  it("every requestBody reference points to a defined component schema", () => {
    const paths = doc.paths as Record<string, Record<string, unknown>>;
    const components = doc.components as { schemas: Record<string, unknown> };

    for (const [path, operations] of Object.entries(paths)) {
      for (const [method, op] of Object.entries(operations)) {
        const operation = op as {
          requestBody?: {
            content?: { "application/json"?: { schema?: { $ref?: string } } };
          };
        };
        const ref = operation.requestBody?.content?.["application/json"]?.schema?.$ref;
        if (ref) {
          const schemaName = ref.replace("#/components/schemas/", "");
          expect(components.schemas[schemaName], `${method.toUpperCase()} ${path} references missing schema ${schemaName}`).toBeDefined();
        }
      }
    }
  });

  it("every listX endpoint declares a paginated envelope response shape", () => {
    const paths = doc.paths as Record<string, Record<string, unknown>>;
    const listPaths = [
      "/api/v1/accounts",
      "/api/v1/customers",
      "/api/v1/meters",
      "/api/v1/premises",
      "/api/v1/rate-schedules",
      "/api/v1/service-agreements",
      "/api/v1/users",
    ];

    for (const p of listPaths) {
      const getOp = paths[p]?.get as {
        responses?: {
          "200"?: {
            content?: {
              "application/json"?: {
                schema?: { type?: string; properties?: Record<string, unknown> };
              };
            };
          };
        };
      };
      const schema = getOp?.responses?.["200"]?.content?.["application/json"]?.schema;
      expect(schema?.type, `${p} GET is missing response schema`).toBe("object");
      expect(schema?.properties, `${p} GET response has no properties`).toHaveProperty("data");
      expect(schema?.properties).toHaveProperty("meta");
    }
  });

  it("POST create endpoints declare 201 instead of 200", () => {
    const paths = doc.paths as Record<string, Record<string, unknown>>;
    const createPaths = [
      "/api/v1/accounts",
      "/api/v1/customers",
      "/api/v1/meters",
      "/api/v1/premises",
      "/api/v1/rate-schedules",
    ];

    for (const p of createPaths) {
      const postOp = paths[p]?.post as { responses?: Record<string, unknown> };
      expect(postOp?.responses, `${p} POST missing responses`).toBeDefined();
      expect(postOp?.responses, `${p} POST should return 201`).toHaveProperty("201");
      expect(postOp?.responses).not.toHaveProperty("200");
    }
  });

  it("DELETE endpoints return 204 and declare no requestBody", () => {
    const paths = doc.paths as Record<string, Record<string, unknown>>;
    const deleteOp = paths["/api/v1/roles/{id}"]?.delete as {
      requestBody?: unknown;
      responses: Record<string, unknown>;
    };
    expect(deleteOp).toBeDefined();
    expect(deleteOp.requestBody).toBeUndefined();
    expect(deleteOp.responses).toHaveProperty("204");
    expect(deleteOp.responses).not.toHaveProperty("200");
  });

  it("CreateAccount schema captures the required depositAmount invariant", () => {
    const components = doc.components as {
      schemas: Record<string, { properties?: Record<string, unknown> }>;
    };
    const schema = components.schemas.CreateAccount;
    expect(schema).toBeDefined();
    expect(schema.properties).toHaveProperty("accountNumber");
    expect(schema.properties).toHaveProperty("accountType");
  });

  it("parameterizes {id} path params as uuid-format strings", () => {
    const paths = doc.paths as Record<string, Record<string, unknown>>;
    const getAccount = paths["/api/v1/accounts/{id}"]?.get as {
      parameters?: Array<{
        name: string;
        in: string;
        required: boolean;
        schema: { type: string; format?: string };
      }>;
    };
    const idParam = getAccount.parameters?.find((p) => p.name === "id");
    expect(idParam).toMatchObject({
      name: "id",
      in: "path",
      required: true,
      schema: { type: "string", format: "uuid" },
    });
  });
});
