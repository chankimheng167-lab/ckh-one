import { z, ZodTypeAny } from 'zod';

/** Parse and validate a request body/query; throws ZodError → HTTP 400. */
export function parse<S extends ZodTypeAny>(schema: S, input: unknown): z.infer<S> {
  return schema.parse(input);
}

export const uuid = z.string().uuid();
/** Decimal number sent as string or number; normalised to string. */
export const decimalString = z
  .union([z.string(), z.number()])
  .transform((v) => String(v).trim())
  .refine((v) => /^-?\d+(\.\d+)?$/.test(v), 'must be a decimal number');
export const positiveDecimal = decimalString.refine((v) => Number(v) > 0, 'must be greater than zero');
export const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must be YYYY-MM-DD');
export const paging = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
