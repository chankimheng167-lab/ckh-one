import Decimal from 'decimal.js';

/**
 * Order pricing arithmetic. The API runs this on the server with prices it
 * looked up itself; the client may run the same code for a live preview, but
 * the client's numbers are never trusted.
 *
 * Model: tax-exclusive line pricing (Cambodian VAT is normally quoted
 * exclusive). Each line is rounded half-up to the currency scale, then summed,
 * so the order total always equals the sum of printed line totals.
 */

Decimal.set({ precision: 40, rounding: Decimal.ROUND_HALF_UP });

export const CURRENCY_SCALE: Record<string, number> = { USD: 2, KHR: 0, THB: 2, VND: 0, EUR: 2 };

export function currencyScale(currency: string): number {
  return CURRENCY_SCALE[currency] ?? 2;
}

export interface PriceLineInput {
  quantity: string | number;
  unitPrice: string | number;
  discountPercent: string | number;
  taxRatePercent: string | number;
}

export interface PricedLine {
  quantity: string;
  unitPrice: string;
  discountPercent: string;
  grossAmount: string;
  discountAmount: string;
  netAmount: string;
  taxRatePercent: string;
  taxAmount: string;
  lineTotal: string;
}

export interface PricedOrder {
  lines: PricedLine[];
  subtotal: string;
  discountTotal: string;
  taxTotal: string;
  grandTotal: string;
  maxDiscountPercent: string;
}

export class PricingError extends Error {}

function d(v: string | number, field: string): Decimal {
  let x: Decimal;
  try {
    x = new Decimal(v);
  } catch {
    throw new PricingError(`${field} is not a number`);
  }
  if (!x.isFinite()) throw new PricingError(`${field} is not a finite number`);
  return x;
}

export function priceLine(input: PriceLineInput, currency: string): PricedLine {
  const scale = currencyScale(currency);
  const qty = d(input.quantity, 'quantity');
  const price = d(input.unitPrice, 'unitPrice');
  const disc = d(input.discountPercent, 'discountPercent');
  const tax = d(input.taxRatePercent, 'taxRatePercent');

  if (qty.lte(0)) throw new PricingError('quantity must be greater than zero');
  if (price.lt(0)) throw new PricingError('unitPrice cannot be negative');
  if (disc.lt(0) || disc.gt(100)) throw new PricingError('discountPercent must be between 0 and 100');
  if (tax.lt(0) || tax.gt(100)) throw new PricingError('taxRatePercent must be between 0 and 100');

  const gross = qty.mul(price).toDecimalPlaces(scale);
  const discountAmount = gross.mul(disc).div(100).toDecimalPlaces(scale);
  const net = gross.minus(discountAmount);
  const taxAmount = net.mul(tax).div(100).toDecimalPlaces(scale);
  const total = net.plus(taxAmount);

  return {
    quantity: qty.toString(),
    unitPrice: price.toString(),
    discountPercent: disc.toString(),
    grossAmount: gross.toFixed(scale),
    discountAmount: discountAmount.toFixed(scale),
    netAmount: net.toFixed(scale),
    taxRatePercent: tax.toString(),
    taxAmount: taxAmount.toFixed(scale),
    lineTotal: total.toFixed(scale),
  };
}

export function priceOrder(lines: PriceLineInput[], currency: string): PricedOrder {
  const scale = currencyScale(currency);
  const priced = lines.map((l) => priceLine(l, currency));
  const sum = (k: keyof PricedLine) => priced.reduce((acc, l) => acc.plus(l[k]), new Decimal(0));
  const maxDisc = priced.reduce((m, l) => Decimal.max(m, l.discountPercent), new Decimal(0));
  return {
    lines: priced,
    subtotal: sum('grossAmount').toFixed(scale),
    discountTotal: sum('discountAmount').toFixed(scale),
    taxTotal: sum('taxAmount').toFixed(scale),
    grandTotal: sum('lineTotal').toFixed(scale),
    maxDiscountPercent: maxDisc.toString(),
  };
}

export { Decimal };
