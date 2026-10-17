import Decimal from 'decimal.js';
import { currencyScale, PricingError } from './pricing';

/**
 * POS cart arithmetic: line discounts, an order discount spread across lines,
 * tax-exclusive or tax-inclusive prices, split tender and refunds.
 *
 * The API runs this with prices it resolved itself; the cashier screen and the
 * Windows POS run the same code for an instant preview (and for offline cash
 * sales), but the server's result is the one that is recorded.
 *
 * All money is decimal: every amount is rounded half-up to the currency scale
 * per line, and totals are sums of the rounded line amounts, so a receipt
 * always adds up.
 */

Decimal.set({ precision: 40, rounding: Decimal.ROUND_HALF_UP });

export type Money = string;

export interface PosLineInput {
  quantity: string | number;
  unitPrice: string | number;
  /** Percentage discount on this line (0–100). Ignored when discountAmount is given. */
  discountPercent?: string | number | null;
  /** Fixed discount on this line, in money. */
  discountAmount?: string | number | null;
  taxRatePercent: string | number;
}

export interface PosCartInput {
  lines: PosLineInput[];
  /** Discount on the whole sale, as a percentage of the total after line discounts. */
  orderDiscountPercent?: string | number | null;
  /** Discount on the whole sale, as money (wins over the percentage). */
  orderDiscountAmount?: string | number | null;
  /** True when shelf prices already include VAT (common in retail). */
  pricesIncludeTax: boolean;
  currency: string;
}

export interface PosPricedLine {
  quantity: string;
  unitPrice: string;
  taxRatePercent: string;
  /** quantity × unit price, as shown on the shelf (tax-inclusive when prices include tax). */
  gross: Money;
  lineDiscount: Money;
  orderDiscountShare: Money;
  discountTotal: Money;
  /** Discount as a share of gross, in percent (for permission limits). */
  effectiveDiscountPercent: string;
  /** Revenue before discounts and tax (what is credited to sales revenue). */
  grossExTax: Money;
  /** Discount excluding tax (what is debited to sales discounts). */
  discountExTax: Money;
  /** Taxable amount after all discounts. */
  net: Money;
  tax: Money;
  /** What the customer pays for this line. */
  total: Money;
}

export interface PosPricedCart {
  currency: string;
  pricesIncludeTax: boolean;
  lines: PosPricedLine[];
  subtotal: Money;
  lineDiscountTotal: Money;
  orderDiscountTotal: Money;
  discountTotal: Money;
  netTotal: Money;
  taxTotal: Money;
  grandTotal: Money;
  /** Highest effective discount % on any line, order discount included. */
  maxDiscountPercent: string;
  /** Order discount as a percent of the total after line discounts. */
  orderDiscountPercent: string;
}

function num(v: string | number | null | undefined, field: string): Decimal {
  let x: Decimal;
  try {
    x = new Decimal(v ?? 0);
  } catch {
    throw new PricingError(`${field} is not a number`);
  }
  if (!x.isFinite()) throw new PricingError(`${field} is not a finite number`);
  return x;
}

/**
 * Splits `amount` across `weights` in proportion, in whole currency units,
 * so the parts always add up to the amount exactly (largest remainder).
 */
export function allocate(amount: Decimal.Value, weights: Decimal.Value[], scale: number): Decimal[] {
  const total = weights.reduce<Decimal>((a, w) => a.plus(w), new Decimal(0));
  const unit = new Decimal(10).pow(-scale);
  const amt = new Decimal(amount);
  if (weights.length === 0) return [];
  if (total.isZero()) return weights.map((_, i) => (i === 0 ? amt : new Decimal(0)));
  const raw = weights.map((w) => amt.mul(w).div(total));
  const floors = raw.map((r) => r.toDecimalPlaces(scale, Decimal.ROUND_DOWN));
  let left = amt.minus(floors.reduce((a, f) => a.plus(f), new Decimal(0)));
  const order = raw.map((r, i) => ({ i, rem: r.minus(floors[i]) })).sort((a, b) => b.rem.comparedTo(a.rem) || a.i - b.i);
  for (const { i } of order) {
    if (left.lt(unit)) break;
    floors[i] = floors[i].plus(unit);
    left = left.minus(unit);
  }
  return floors;
}

export function pricePosCart(input: PosCartInput): PosPricedCart {
  const scale = currencyScale(input.currency);
  if (input.lines.length === 0) throw new PricingError('The sale has no items');
  const base = input.lines.map((l, i) => {
    const qty = num(l.quantity, `line ${i + 1} quantity`);
    const price = num(l.unitPrice, `line ${i + 1} unitPrice`);
    const rate = num(l.taxRatePercent, `line ${i + 1} taxRatePercent`);
    if (qty.lte(0)) throw new PricingError(`Line ${i + 1}: quantity must be greater than zero`);
    if (price.lt(0)) throw new PricingError(`Line ${i + 1}: price cannot be negative`);
    if (rate.lt(0) || rate.gt(100)) throw new PricingError(`Line ${i + 1}: tax rate must be between 0 and 100`);
    const gross = qty.mul(price).toDecimalPlaces(scale);
    let lineDiscount: Decimal;
    if (l.discountAmount !== undefined && l.discountAmount !== null && l.discountAmount !== '') {
      lineDiscount = num(l.discountAmount, `line ${i + 1} discountAmount`).toDecimalPlaces(scale);
    } else {
      const pct = num(l.discountPercent, `line ${i + 1} discountPercent`);
      if (pct.lt(0) || pct.gt(100)) throw new PricingError(`Line ${i + 1}: discount must be between 0 and 100%`);
      lineDiscount = gross.mul(pct).div(100).toDecimalPlaces(scale);
    }
    if (lineDiscount.lt(0)) throw new PricingError(`Line ${i + 1}: discount cannot be negative`);
    if (lineDiscount.gt(gross)) throw new PricingError(`Line ${i + 1}: discount is larger than the line amount`);
    return { qty, price, rate, gross, lineDiscount, afterLine: gross.minus(lineDiscount) };
  });

  const afterLines = base.reduce((a, b) => a.plus(b.afterLine), new Decimal(0));
  let orderDiscount: Decimal;
  if (input.orderDiscountAmount !== undefined && input.orderDiscountAmount !== null && input.orderDiscountAmount !== '') {
    orderDiscount = num(input.orderDiscountAmount, 'orderDiscountAmount').toDecimalPlaces(scale);
  } else {
    const pct = num(input.orderDiscountPercent, 'orderDiscountPercent');
    if (pct.lt(0) || pct.gt(100)) throw new PricingError('Order discount must be between 0 and 100%');
    orderDiscount = afterLines.mul(pct).div(100).toDecimalPlaces(scale);
  }
  if (orderDiscount.lt(0)) throw new PricingError('Order discount cannot be negative');
  if (orderDiscount.gt(afterLines)) throw new PricingError('Order discount is larger than the sale');
  const shares = allocate(orderDiscount, base.map((b) => b.afterLine), scale);

  const lines: PosPricedLine[] = base.map((b, i) => {
    const discountTotal = b.lineDiscount.plus(shares[i]);
    const payable = b.gross.minus(discountTotal);
    let net: Decimal;
    let tax: Decimal;
    let total: Decimal;
    let grossExTax: Decimal;
    if (input.pricesIncludeTax) {
      const divisor = new Decimal(1).plus(b.rate.div(100));
      total = payable;
      net = payable.div(divisor).toDecimalPlaces(scale);
      tax = total.minus(net);
      grossExTax = b.gross.div(divisor).toDecimalPlaces(scale);
      if (grossExTax.lt(net)) grossExTax = net;
    } else {
      net = payable;
      tax = net.mul(b.rate).div(100).toDecimalPlaces(scale);
      total = net.plus(tax);
      grossExTax = b.gross;
    }
    const discountExTax = grossExTax.minus(net);
    return {
      quantity: b.qty.toString(),
      unitPrice: b.price.toString(),
      taxRatePercent: b.rate.toString(),
      gross: b.gross.toFixed(scale),
      lineDiscount: b.lineDiscount.toFixed(scale),
      orderDiscountShare: shares[i].toFixed(scale),
      discountTotal: discountTotal.toFixed(scale),
      effectiveDiscountPercent: b.gross.isZero() ? '0' : discountTotal.mul(100).div(b.gross).toDecimalPlaces(4).toString(),
      grossExTax: grossExTax.toFixed(scale),
      discountExTax: discountExTax.toFixed(scale),
      net: net.toFixed(scale),
      tax: tax.toFixed(scale),
      total: total.toFixed(scale),
    };
  });

  const sum = (k: keyof PosPricedLine) => lines.reduce((a, l) => a.plus(l[k] as string), new Decimal(0)).toFixed(scale);
  const maxDisc = lines.reduce((m, l) => Decimal.max(m, l.effectiveDiscountPercent), new Decimal(0));
  return {
    currency: input.currency,
    pricesIncludeTax: input.pricesIncludeTax,
    lines,
    subtotal: sum('gross'),
    lineDiscountTotal: sum('lineDiscount'),
    orderDiscountTotal: orderDiscount.toFixed(scale),
    discountTotal: sum('discountTotal'),
    netTotal: sum('net'),
    taxTotal: sum('tax'),
    grandTotal: sum('total'),
    maxDiscountPercent: maxDisc.toString(),
    orderDiscountPercent: afterLines.isZero() ? '0' : orderDiscount.mul(100).div(afterLines).toDecimalPlaces(4).toString(),
  };
}

// ---------------------------------------------------------------------------
// Tender
// ---------------------------------------------------------------------------

export type PosPaymentKind = 'CASH' | 'BANK_TRANSFER' | 'QR' | 'CARD' | 'OTHER';

export interface TenderInput {
  kind: PosPaymentKind;
  /** For cash: the money handed over. For everything else: the amount charged. */
  amount: string | number;
}

export interface SettledTender {
  kind: PosPaymentKind;
  tendered: Money;
  /** Part of the sale this payment settles (cash tendered minus change). */
  applied: Money;
}

export interface Settlement {
  payments: SettledTender[];
  totalTendered: Money;
  changeDue: Money;
}

/**
 * Checks that a set of payments settles a sale exactly once:
 *  - every amount is positive;
 *  - non-cash payments can never exceed what is owed (no change is given on a
 *    card or a transfer, and an overcharge would be a duplicate payment);
 *  - the total must cover the sale; any excess is change, and must come out
 *    of the cash handed over.
 */
export function settlePayments(grandTotal: string, payments: TenderInput[], currency: string): Settlement {
  const scale = currencyScale(currency);
  const due = new Decimal(grandTotal);
  if (payments.length === 0) {
    if (due.isZero()) return { payments: [], totalTendered: due.toFixed(scale), changeDue: new Decimal(0).toFixed(scale) };
    throw new PricingError('Add a payment to complete the sale');
  }
  const amounts = payments.map((p, i) => {
    const a = num(p.amount, `payment ${i + 1} amount`);
    if (a.lte(0)) throw new PricingError(`Payment ${i + 1} must be greater than zero`);
    if (a.decimalPlaces() > scale) throw new PricingError(`Payment ${i + 1} has more decimals than ${currency} allows`);
    return a;
  });
  const nonCash = payments.reduce((acc, p, i) => (p.kind === 'CASH' ? acc : acc.plus(amounts[i])), new Decimal(0));
  const cash = payments.reduce((acc, p, i) => (p.kind === 'CASH' ? acc.plus(amounts[i]) : acc), new Decimal(0));
  if (nonCash.gt(due)) throw new PricingError('Card, transfer and QR payments cannot be more than the amount due');
  const total = nonCash.plus(cash);
  if (total.lt(due)) throw new PricingError(`Payments (${total.toFixed(scale)}) do not cover the total (${due.toFixed(scale)})`);
  const change = total.minus(due);
  if (change.gt(cash)) throw new PricingError('Change can only be given from cash');
  // Change comes out of the cash payments, last first.
  let changeLeft = change;
  const applied = [...amounts];
  for (let i = payments.length - 1; i >= 0 && changeLeft.gt(0); i--) {
    if (payments[i].kind !== 'CASH') continue;
    const take = Decimal.min(changeLeft, applied[i]);
    applied[i] = applied[i].minus(take);
    changeLeft = changeLeft.minus(take);
  }
  return {
    payments: payments.map((p, i) => ({ kind: p.kind, tendered: amounts[i].toFixed(scale), applied: applied[i].toFixed(scale) })),
    totalTendered: total.toFixed(scale),
    changeDue: change.toFixed(scale),
  };
}

// ---------------------------------------------------------------------------
// Refunds
// ---------------------------------------------------------------------------

export interface SoldLineAmounts {
  quantity: string;
  grossExTax: string;
  discountExTax: string;
  net: string;
  tax: string;
  total: string;
}

export interface RefundAmounts {
  grossExTax: Money;
  discountExTax: Money;
  net: Money;
  tax: Money;
  total: Money;
}

/**
 * The refund for returning `qty` more units of a sold line when
 * `alreadyReturned` units were refunded before. Computed as the difference of
 * cumulative proportional shares, so returning every unit, in any number of
 * steps, refunds exactly what was paid: never a cent more.
 */
export function refundForLine(line: SoldLineAmounts, alreadyReturned: string | number, qty: string | number, currency: string): RefundAmounts {
  const scale = currencyScale(currency);
  const sold = new Decimal(line.quantity);
  const before = new Decimal(alreadyReturned);
  const k = num(qty, 'return quantity');
  if (k.lte(0)) throw new PricingError('Return quantity must be greater than zero');
  if (before.plus(k).gt(sold)) throw new PricingError(`Only ${sold.minus(before).toString()} can still be returned`);
  const cum = (x: string, q: Decimal) => new Decimal(x).mul(q).div(sold).toDecimalPlaces(scale);
  const part = (x: string) => cum(x, before.plus(k)).minus(cum(x, before));
  const grossExTax = part(line.grossExTax);
  const net = part(line.net);
  const tax = part(line.tax);
  return {
    grossExTax: grossExTax.toFixed(scale),
    discountExTax: grossExTax.minus(net).toFixed(scale),
    net: net.toFixed(scale),
    tax: tax.toFixed(scale),
    total: net.plus(tax).toFixed(scale),
  };
}

/** Card numbers must never be stored. True when a reference looks like a payment card number (13–19 digits passing Luhn). */
export function looksLikeCardNumber(ref: string): boolean {
  const digits = ref.replace(/[\s-]/g, '');
  if (!/^\d{13,19}$/.test(digits)) return false;
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return sum % 10 === 0;
}
