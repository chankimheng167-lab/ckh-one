import { z } from 'zod';
import { decimalString, isoDate, positiveDecimal, uuid } from '../../common/validation';

export const OrderLineInput = z.object({
  productId: uuid,
  unitId: uuid.optional(),
  quantity: positiveDecimal,
  discountPercent: decimalString.refine((v) => Number(v) >= 0 && Number(v) <= 100, 'must be 0–100').default('0'),
  /**
   * Only honoured when the tenant allows price overrides; otherwise sending a
   * price that differs from the server price is rejected. Never trusted for
   * totals — the server recomputes everything.
   */
  unitPrice: decimalString.optional(),
  notes: z.string().max(500).optional(),
});

export const CreateOrderInput = z.object({
  clientReference: z.string().min(8).max(100).optional(),
  customerId: uuid,
  salesRepId: uuid.optional(),
  branchId: uuid.optional(),
  warehouseId: uuid.optional(),
  orderDate: isoDate.optional(),
  requestedDeliveryDate: isoDate.optional(),
  deliveryAddressId: uuid.optional(),
  paymentTermsDays: z.number().int().min(0).max(365).optional(),
  notes: z.string().max(2000).optional(),
  source: z.enum(['WEB', 'MOBILE', 'VISIT']).default('WEB'),
  visitId: uuid.optional(),
  lines: z.array(OrderLineInput).min(1).max(500),
});
export type CreateOrderInput = z.infer<typeof CreateOrderInput>;

export const UpdateOrderInput = CreateOrderInput.omit({ clientReference: true, source: true, customerId: true, salesRepId: true }).extend({
  version: z.number().int().positive(),
});
export type UpdateOrderInput = z.infer<typeof UpdateOrderInput>;

export const DecisionInput = z.object({ comment: z.string().max(1000).optional() });
export const RejectInput = z.object({ comment: z.string().min(3).max(1000) });
export const CancelInput = z.object({ reason: z.string().min(3).max(1000) });

export const ListOrdersQuery = z.object({
  status: z.string().optional(),
  customerId: uuid.optional(),
  salesRepId: uuid.optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
  mine: z.coerce.boolean().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
