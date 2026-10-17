import { createHash } from 'crypto';
import { z } from 'zod';
import { decimalString, isoDate, positiveDecimal, uuid } from '../common/validation';

/** Client-generated idempotency key: one per checkout attempt, reused on retry. */
export const clientKey = z.string().min(8).max(100).regex(/^[A-Za-z0-9._:-]+$/, 'letters, digits and . _ : - only');

export const PosLineInput = z.object({
  productId: uuid,
  quantity: positiveDecimal,
  discountPercent: decimalString.optional(),
  discountAmount: decimalString.optional(),
  /** Only to override the price (needs pos.price.override); otherwise the server price is used. */
  unitPrice: decimalString.optional(),
  serialNumbers: z.array(z.string().trim().min(1).max(100)).max(1000).default([]),
});
export type PosLineInput = z.infer<typeof PosLineInput>;

export const PosCartInput = z.object({
  registerId: uuid,
  customerId: uuid.nullable().optional(),
  lines: z.array(PosLineInput).min(1).max(500),
  orderDiscountPercent: decimalString.optional(),
  orderDiscountAmount: decimalString.optional(),
});
export type PosCartInput = z.infer<typeof PosCartInput>;

/** A supervisor approving on the till with their POS PIN. */
export const PosApproval = z.object({ userId: uuid, pin: z.string().regex(/^\d{4,8}$/, 'PIN is 4–8 digits') });
export type PosApproval = z.infer<typeof PosApproval>;

export const PosPaymentInput = z.object({
  methodId: uuid,
  /** Cash: money handed over (change is worked out). Others: amount charged. */
  amount: positiveDecimal,
  /** Transfer id, QR transaction id or card approval code. Never a card number. */
  reference: z.string().trim().min(1).max(120).optional(),
  providerTransactionId: z.string().trim().min(1).max(120).optional(),
});

export const CheckoutInput = PosCartInput.extend({
  clientSaleId: clientKey,
  payments: z.array(PosPaymentInput).max(10).default([]),
  /** The total the till showed; a different server total is refused (TOTAL_CHANGED). */
  expectedTotal: decimalString.optional(),
  approval: PosApproval.optional(),
  notes: z.string().max(500).optional(),
});
export type CheckoutInput = z.infer<typeof CheckoutInput>;

export const SalesQuery = z.object({
  from: isoDate.optional(),
  to: isoDate.optional(),
  registerId: uuid.optional(),
  branchId: uuid.optional(),
  cashierId: uuid.optional(),
  shiftId: uuid.optional(),
  customerId: uuid.optional(),
  status: z.enum(['COMPLETED', 'PARTIALLY_REFUNDED', 'REFUNDED']).optional(),
  paymentStatus: z.enum(['PAID', 'PENDING_VERIFICATION', 'BALANCE_DUE']).optional(),
  reviewStatus: z.enum(['NONE', 'NEEDS_REVIEW', 'REVIEWED']).optional(),
  q: z.string().max(100).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
export type SalesQuery = z.infer<typeof SalesQuery>;

/** Stable JSON so the same payload always hashes the same, whatever the key order. */
export function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v as object)
      .sort()
      .filter((k) => (v as Record<string, unknown>)[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(v ?? null);
}

export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
