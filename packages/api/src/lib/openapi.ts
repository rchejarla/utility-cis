import { zodToJsonSchema } from "zod-to-json-schema";
import type { ZodTypeAny } from "zod";
import {
  createAccountSchema,
  updateAccountSchema,
  accountQuerySchema,
  createBillingCycleSchema,
  updateBillingCycleSchema,
  createCommoditySchema,
  updateCommoditySchema,
  createContactSchema,
  updateContactSchema,
  createCustomerSchema,
  updateCustomerSchema,
  customerQuerySchema,
  createMeterSchema,
  updateMeterSchema,
  meterQuerySchema,
  createPremiseSchema,
  updatePremiseSchema,
  premiseQuerySchema,
  createRateScheduleSchema,
  rateScheduleQuerySchema,
  createServiceAgreementSchema,
  updateServiceAgreementSchema,
  serviceAgreementQuerySchema,
  createUserSchema,
  updateUserSchema,
  userQuerySchema,
  createRoleSchema,
  updateRoleSchema,
  createUomSchema,
  updateUomSchema,
  createBillingAddressSchema,
  updateBillingAddressSchema,
} from "@utility-cis/shared";

/**
 * OpenAPI document generator. Every API contract lives in `@utility-cis/shared`
 * as a Zod schema, and this module converts the subset used by the HTTP layer
 * into a machine-verifiable OpenAPI 3.1 document. Consumers can pull the spec
 * from `GET /api/v1/openapi.json` to generate clients, drive contract tests,
 * or feed an API console.
 *
 * Design notes:
 *   - We keep the route table in one place so that the single source of
 *     truth for every endpoint's request/response shape is Zod-first.
 *   - We rely on `zod-to-json-schema` rather than a type provider so the
 *     existing `registerCrudRoutes` factory keeps working unchanged.
 *   - The document is rebuilt on each call (it's tiny and fast); if profiling
 *     ever shows it in a hot path, wrap with `memoize`.
 */

type SchemaName = string;

const COMPONENT_SCHEMAS: Record<SchemaName, ZodTypeAny> = {
  CreateAccount: createAccountSchema,
  UpdateAccount: updateAccountSchema,
  AccountQuery: accountQuerySchema,
  CreateBillingAddress: createBillingAddressSchema,
  UpdateBillingAddress: updateBillingAddressSchema,
  CreateBillingCycle: createBillingCycleSchema,
  UpdateBillingCycle: updateBillingCycleSchema,
  CreateCommodity: createCommoditySchema,
  UpdateCommodity: updateCommoditySchema,
  CreateContact: createContactSchema,
  UpdateContact: updateContactSchema,
  CreateCustomer: createCustomerSchema,
  UpdateCustomer: updateCustomerSchema,
  CustomerQuery: customerQuerySchema,
  CreateMeter: createMeterSchema,
  UpdateMeter: updateMeterSchema,
  MeterQuery: meterQuerySchema,
  CreatePremise: createPremiseSchema,
  UpdatePremise: updatePremiseSchema,
  PremiseQuery: premiseQuerySchema,
  CreateRateSchedule: createRateScheduleSchema,
  RateScheduleQuery: rateScheduleQuerySchema,
  CreateServiceAgreement: createServiceAgreementSchema,
  UpdateServiceAgreement: updateServiceAgreementSchema,
  ServiceAgreementQuery: serviceAgreementQuerySchema,
  CreateUser: createUserSchema,
  UpdateUser: updateUserSchema,
  UserQuery: userQuerySchema,
  CreateRole: createRoleSchema,
  UpdateRole: updateRoleSchema,
  CreateUom: createUomSchema,
  UpdateUom: updateUomSchema,
};

interface RouteSpec {
  method: "get" | "post" | "patch" | "delete";
  path: string;
  tag: string;
  summary: string;
  /** Body schema name in `COMPONENT_SCHEMAS`. */
  body?: SchemaName;
  /** Query schema name in `COMPONENT_SCHEMAS`. */
  query?: SchemaName;
  /** Response schema name in `COMPONENT_SCHEMAS` (for the non-envelope shape). */
  response?: SchemaName;
  /** True for routes that take `/:id`. */
  idParam?: boolean;
  /** List endpoints return `{data: [...], meta: {...}}` — set this to true. */
  paginatedResponse?: boolean;
  /** 201 Created instead of 200. */
  createdStatus?: boolean;
}

const ROUTES: RouteSpec[] = [
  // Accounts
  { method: "get", path: "/api/v1/accounts", tag: "Accounts", summary: "List accounts", query: "AccountQuery", paginatedResponse: true },
  { method: "get", path: "/api/v1/accounts/{id}", tag: "Accounts", summary: "Get account by id", idParam: true },
  { method: "post", path: "/api/v1/accounts", tag: "Accounts", summary: "Create account", body: "CreateAccount", createdStatus: true },
  { method: "patch", path: "/api/v1/accounts/{id}", tag: "Accounts", summary: "Update account", body: "UpdateAccount", idParam: true },

  // Billing addresses
  { method: "get", path: "/api/v1/billing-addresses", tag: "Billing", summary: "List billing addresses" },
  { method: "post", path: "/api/v1/billing-addresses", tag: "Billing", summary: "Create billing address", body: "CreateBillingAddress", createdStatus: true },
  { method: "patch", path: "/api/v1/billing-addresses/{id}", tag: "Billing", summary: "Update billing address", body: "UpdateBillingAddress", idParam: true },

  // Billing cycles
  { method: "get", path: "/api/v1/billing-cycles", tag: "Billing", summary: "List billing cycles" },
  { method: "get", path: "/api/v1/billing-cycles/{id}", tag: "Billing", summary: "Get billing cycle", idParam: true },
  { method: "post", path: "/api/v1/billing-cycles", tag: "Billing", summary: "Create billing cycle", body: "CreateBillingCycle", createdStatus: true },
  { method: "patch", path: "/api/v1/billing-cycles/{id}", tag: "Billing", summary: "Update billing cycle", body: "UpdateBillingCycle", idParam: true },

  // Commodities
  { method: "get", path: "/api/v1/commodities", tag: "Commodities", summary: "List commodities" },
  { method: "post", path: "/api/v1/commodities", tag: "Commodities", summary: "Create commodity", body: "CreateCommodity", createdStatus: true },
  { method: "patch", path: "/api/v1/commodities/{id}", tag: "Commodities", summary: "Update commodity", body: "UpdateCommodity", idParam: true },

  // Contacts
  { method: "get", path: "/api/v1/contacts", tag: "Contacts", summary: "List contacts for an account" },
  { method: "post", path: "/api/v1/contacts", tag: "Contacts", summary: "Create contact", body: "CreateContact", createdStatus: true },
  { method: "patch", path: "/api/v1/contacts/{id}", tag: "Contacts", summary: "Update contact", body: "UpdateContact", idParam: true },
  { method: "delete", path: "/api/v1/contacts/{id}", tag: "Contacts", summary: "Delete contact", idParam: true },

  // Customers
  { method: "get", path: "/api/v1/customers", tag: "Customers", summary: "List customers", query: "CustomerQuery", paginatedResponse: true },
  { method: "get", path: "/api/v1/customers/{id}", tag: "Customers", summary: "Get customer", idParam: true },
  { method: "post", path: "/api/v1/customers", tag: "Customers", summary: "Create customer", body: "CreateCustomer", createdStatus: true },
  { method: "patch", path: "/api/v1/customers/{id}", tag: "Customers", summary: "Update customer", body: "UpdateCustomer", idParam: true },

  // Meters
  { method: "get", path: "/api/v1/meters", tag: "Meters", summary: "List meters", query: "MeterQuery", paginatedResponse: true },
  { method: "get", path: "/api/v1/meters/{id}", tag: "Meters", summary: "Get meter", idParam: true },
  { method: "post", path: "/api/v1/meters", tag: "Meters", summary: "Create meter", body: "CreateMeter", createdStatus: true },
  { method: "patch", path: "/api/v1/meters/{id}", tag: "Meters", summary: "Update meter", body: "UpdateMeter", idParam: true },

  // Premises
  { method: "get", path: "/api/v1/premises", tag: "Premises", summary: "List premises", query: "PremiseQuery", paginatedResponse: true },
  { method: "get", path: "/api/v1/premises/geo", tag: "Premises", summary: "Premises as GeoJSON feature collection" },
  { method: "get", path: "/api/v1/premises/{id}", tag: "Premises", summary: "Get premise", idParam: true },
  { method: "post", path: "/api/v1/premises", tag: "Premises", summary: "Create premise", body: "CreatePremise", createdStatus: true },
  { method: "patch", path: "/api/v1/premises/{id}", tag: "Premises", summary: "Update premise", body: "UpdatePremise", idParam: true },

  // Rate schedules
  { method: "get", path: "/api/v1/rate-schedules", tag: "Rate Schedules", summary: "List rate schedules", query: "RateScheduleQuery", paginatedResponse: true },
  { method: "get", path: "/api/v1/rate-schedules/{id}", tag: "Rate Schedules", summary: "Get rate schedule", idParam: true },
  { method: "post", path: "/api/v1/rate-schedules", tag: "Rate Schedules", summary: "Create rate schedule", body: "CreateRateSchedule", createdStatus: true },
  { method: "post", path: "/api/v1/rate-schedules/{id}/revise", tag: "Rate Schedules", summary: "Revise (supersede) a rate schedule", body: "CreateRateSchedule", idParam: true, createdStatus: true },

  // Roles
  { method: "get", path: "/api/v1/roles", tag: "Settings", summary: "List roles" },
  { method: "get", path: "/api/v1/roles/{id}", tag: "Settings", summary: "Get role", idParam: true },
  { method: "post", path: "/api/v1/roles", tag: "Settings", summary: "Create role", body: "CreateRole", createdStatus: true },
  { method: "patch", path: "/api/v1/roles/{id}", tag: "Settings", summary: "Update role", body: "UpdateRole", idParam: true },
  { method: "delete", path: "/api/v1/roles/{id}", tag: "Settings", summary: "Delete role", idParam: true },

  // Service agreements
  { method: "get", path: "/api/v1/service-agreements", tag: "Service Agreements", summary: "List service agreements", query: "ServiceAgreementQuery", paginatedResponse: true },
  { method: "get", path: "/api/v1/service-agreements/{id}", tag: "Service Agreements", summary: "Get service agreement", idParam: true },
  { method: "post", path: "/api/v1/service-agreements", tag: "Service Agreements", summary: "Create service agreement", body: "CreateServiceAgreement", createdStatus: true },
  { method: "patch", path: "/api/v1/service-agreements/{id}", tag: "Service Agreements", summary: "Update service agreement", body: "UpdateServiceAgreement", idParam: true },

  // UOM
  { method: "get", path: "/api/v1/uom", tag: "Units", summary: "List units of measure" },
  { method: "post", path: "/api/v1/uom", tag: "Units", summary: "Create unit of measure", body: "CreateUom", createdStatus: true },
  { method: "patch", path: "/api/v1/uom/{id}", tag: "Units", summary: "Update unit of measure", body: "UpdateUom", idParam: true },
  { method: "delete", path: "/api/v1/uom/{id}", tag: "Units", summary: "Delete unit of measure", idParam: true },

  // Users
  { method: "get", path: "/api/v1/users", tag: "Settings", summary: "List users", query: "UserQuery", paginatedResponse: true },
  { method: "get", path: "/api/v1/users/{id}", tag: "Settings", summary: "Get user", idParam: true },
  { method: "post", path: "/api/v1/users", tag: "Settings", summary: "Create user", body: "CreateUser", createdStatus: true },
  { method: "patch", path: "/api/v1/users/{id}", tag: "Settings", summary: "Update user", body: "UpdateUser", idParam: true },
];

const ERROR_RESPONSE = {
  type: "object",
  required: ["error", "message"],
  properties: {
    error: { type: "string" },
    message: { type: "string" },
    details: { type: "object", additionalProperties: true },
  },
} as const;

const PAGINATED_ENVELOPE_META = {
  type: "object",
  required: ["total", "page", "limit", "pages"],
  properties: {
    total: { type: "integer", minimum: 0 },
    page: { type: "integer", minimum: 1 },
    limit: { type: "integer", minimum: 1 },
    pages: { type: "integer", minimum: 0 },
  },
} as const;

function componentRef(name: SchemaName) {
  return { $ref: `#/components/schemas/${name}` };
}

function paginatedEnvelope() {
  return {
    type: "object",
    required: ["data", "meta"],
    properties: {
      data: { type: "array", items: { type: "object", additionalProperties: true } },
      meta: PAGINATED_ENVELOPE_META,
    },
  };
}

function buildOperation(route: RouteSpec) {
  const operation: Record<string, unknown> = {
    tags: [route.tag],
    summary: route.summary,
    security: [{ bearerAuth: [] }],
    responses: {
      [route.createdStatus ? "201" : "200"]: {
        description: "Success",
        content: {
          "application/json": {
            schema: route.paginatedResponse
              ? paginatedEnvelope()
              : route.response
              ? componentRef(route.response)
              : { type: "object", additionalProperties: true },
          },
        },
      },
      "400": { description: "Validation error", content: { "application/json": { schema: ERROR_RESPONSE } } },
      "401": { description: "Unauthorized", content: { "application/json": { schema: ERROR_RESPONSE } } },
      "403": { description: "Forbidden", content: { "application/json": { schema: ERROR_RESPONSE } } },
      "404": { description: "Not found", content: { "application/json": { schema: ERROR_RESPONSE } } },
    },
  };

  const parameters: unknown[] = [];
  if (route.idParam) {
    parameters.push({
      name: "id",
      in: "path",
      required: true,
      schema: { type: "string", format: "uuid" },
    });
  }
  if (route.query) {
    parameters.push({
      name: "query",
      in: "query",
      required: false,
      schema: componentRef(route.query),
      description: "See referenced schema for the full set of query parameters.",
    });
  }
  if (parameters.length > 0) operation.parameters = parameters;

  if (route.body) {
    operation.requestBody = {
      required: true,
      content: {
        "application/json": {
          schema: componentRef(route.body),
        },
      },
    };
  }

  // 204 for DELETE instead of 200
  if (route.method === "delete") {
    operation.responses = {
      "204": { description: "Deleted" },
      "401": { description: "Unauthorized", content: { "application/json": { schema: ERROR_RESPONSE } } },
      "403": { description: "Forbidden", content: { "application/json": { schema: ERROR_RESPONSE } } },
      "404": { description: "Not found", content: { "application/json": { schema: ERROR_RESPONSE } } },
    };
  }

  return operation;
}

export function buildOpenApiDocument(): Record<string, unknown> {
  const paths: Record<string, Record<string, unknown>> = {};

  for (const route of ROUTES) {
    if (!paths[route.path]) paths[route.path] = {};
    paths[route.path][route.method] = buildOperation(route);
  }

  const schemas: Record<string, unknown> = {};
  for (const [name, zod] of Object.entries(COMPONENT_SCHEMAS)) {
    // zod-to-json-schema returns a JSON Schema document; we strip the
    // outer `$schema` header so it's embeddable in an OpenAPI doc.
    const json = zodToJsonSchema(zod, { name, target: "openApi3" }) as Record<string, unknown>;
    // When `name` is provided the shape is { $ref, definitions: { [name]: ... } }
    const definitions = json.definitions as Record<string, unknown> | undefined;
    if (definitions && definitions[name]) {
      schemas[name] = definitions[name];
    } else {
      // Fallback for schemas that didn't land under `definitions`
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { $schema, ...rest } = json;
      schemas[name] = rest;
    }
  }

  return {
    openapi: "3.1.0",
    info: {
      title: "Utility CIS API",
      version: "1.0.0",
      description:
        "Customer Information System for utilities. Every request/response shape is derived from Zod validators in `@utility-cis/shared`; this document is the machine-verifiable contract.",
    },
    servers: [{ url: "http://localhost:3001", description: "Local development" }],
    tags: [
      { name: "Accounts" },
      { name: "Billing" },
      { name: "Commodities" },
      { name: "Contacts" },
      { name: "Customers" },
      { name: "Meters" },
      { name: "Premises" },
      { name: "Rate Schedules" },
      { name: "Service Agreements" },
      { name: "Settings" },
      { name: "Units" },
    ],
    components: {
      securitySchemes: {
        bearerAuth: {
          type: "http",
          scheme: "bearer",
          bearerFormat: "JWT",
        },
      },
      schemas,
    },
    paths,
  };
}
