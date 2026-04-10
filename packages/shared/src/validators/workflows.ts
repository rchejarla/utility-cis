import { z } from "zod";

/**
 * Transfer of service: reassign an existing service agreement from one
 * account to another. The original agreement is closed (status=CLOSED,
 * end_date=transferDate) and a new agreement is created on the target
 * account with identical meter/premise/commodity but a fresh number and
 * start_date. The meter-read history stays attached to the closed
 * agreement, and the incoming account gets a fresh meter-read history
 * starting from the transfer date.
 */
export const transferServiceSchema = z.object({
  targetAccountId: z.string().uuid(),
  transferDate: z.string().date(),
  newAgreementNumber: z.string().min(1).max(50),
  finalMeterReading: z.number().nonnegative().optional(),
  initialMeterReading: z.number().nonnegative().optional(),
  reason: z.string().max(2000).optional(),
}).strict();

/**
 * Move-in: coordinated setup of a new customer + account + service
 * agreement(s) at a premise, all in a single transaction. The customer
 * may be an existing one (pass `existingCustomerId`) or created inline
 * (`newCustomer`). Exactly one of those must be present.
 */
const newCustomerPayload = z.object({
  customerType: z.enum(["INDIVIDUAL", "ORGANIZATION"]),
  firstName: z.string().max(100).optional(),
  lastName: z.string().max(100).optional(),
  organizationName: z.string().max(255).optional(),
  email: z.string().email().optional(),
  phone: z.string().max(20).optional(),
});

export const moveInSchema = z.object({
  premiseId: z.string().uuid(),
  moveInDate: z.string().date(),
  accountNumber: z.string().min(1).max(50),
  accountType: z.enum(["RESIDENTIAL", "COMMERCIAL", "INDUSTRIAL", "MUNICIPAL"]),
  existingCustomerId: z.string().uuid().optional(),
  newCustomer: newCustomerPayload.optional(),
  agreements: z.array(z.object({
    commodityId: z.string().uuid(),
    rateScheduleId: z.string().uuid(),
    billingCycleId: z.string().uuid(),
    agreementNumber: z.string().min(1).max(50),
    initialMeterReadings: z.array(z.object({
      meterId: z.string().uuid(),
      reading: z.number().nonnegative(),
    })).optional(),
  })).min(1),
  depositAmount: z.number().nonnegative().optional(),
})
  .strict()
  .refine(
    (v) => Boolean(v.existingCustomerId) !== Boolean(v.newCustomer),
    "Provide exactly one of existingCustomerId or newCustomer",
  );

/**
 * Move-out: coordinated teardown for when a customer vacates a premise.
 * All active service agreements on the account for this premise are
 * FINALed on the same date, final meter reads are recorded, and the
 * account can optionally be closed.
 */
export const moveOutSchema = z.object({
  accountId: z.string().uuid(),
  premiseId: z.string().uuid(),
  moveOutDate: z.string().date(),
  finalMeterReadings: z.array(z.object({
    meterId: z.string().uuid(),
    reading: z.number().nonnegative(),
  })),
  forwardingAddress: z.object({
    addressLine1: z.string().max(255),
    addressLine2: z.string().max(255).optional(),
    city: z.string().max(100),
    state: z.string().length(2),
    zip: z.string().max(10),
  }).optional(),
  closeAccount: z.boolean().default(false),
  refundDeposit: z.boolean().default(false),
  notes: z.string().max(2000).optional(),
}).strict();

/**
 * Global full-text search. The top-bar search queries customers,
 * premises, accounts, and meters concurrently. Results are merged
 * into a single ranked list.
 */
export const searchQuerySchema = z.object({
  q: z.string().min(1).max(200),
  limit: z.coerce.number().int().positive().max(50).default(20),
  kinds: z
    .string()
    .optional()
    .transform((v) =>
      v
        ? v.split(",").map((k) => k.trim()).filter(Boolean)
        : undefined,
    ),
}).strict();

export type TransferServiceInput = z.infer<typeof transferServiceSchema>;
export type MoveInInput = z.infer<typeof moveInSchema>;
export type MoveOutInput = z.infer<typeof moveOutSchema>;
export type SearchQuery = z.infer<typeof searchQuerySchema>;
