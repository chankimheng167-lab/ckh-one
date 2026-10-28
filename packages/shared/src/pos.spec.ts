import { allocate, looksLikeCardNumber, pricePosCart, refundForLine, settlePayments } from './pos';
import { Decimal } from './pricing';

describe('POS cart pricing', () => {
  it('prices tax-exclusive lines: $100 net + 10% VAT = $110', () => {
    const c = pricePosCart({ currency: 'USD', pricesIncludeTax: false, lines: [{ quantity: 4, unitPrice: '25', taxRatePercent: 10 }] });
    expect(c.subtotal).toBe('100.00');
    expect(c.netTotal).toBe('100.00');
    expect(c.taxTotal).toBe('10.00');
    expect(c.grandTotal).toBe('110.00');
  });

  it('applies line discounts (percent and amount) before tax', () => {
    const c = pricePosCart({
      currency: 'USD',
      pricesIncludeTax: false,
      lines: [
        { quantity: 2, unitPrice: '10', discountPercent: '10', taxRatePercent: 10 },
        { quantity: 1, unitPrice: '5', discountAmount: '0.50', taxRatePercent: 0 },
      ],
    });
    expect(c.lines[0].lineDiscount).toBe('2.00');
    expect(c.lines[0].net).toBe('18.00');
    expect(c.lines[0].tax).toBe('1.80');
    expect(c.lines[1].net).toBe('4.50');
    expect(c.grandTotal).toBe('24.30');
    expect(c.maxDiscountPercent).toBe('10');
  });

  it('spreads an order discount across lines so the parts add up exactly', () => {
    const c = pricePosCart({
      currency: 'USD',
      pricesIncludeTax: false,
      orderDiscountAmount: '1.00',
      lines: [
        { quantity: 1, unitPrice: '1', taxRatePercent: 0 },
        { quantity: 1, unitPrice: '1', taxRatePercent: 0 },
        { quantity: 1, unitPrice: '1', taxRatePercent: 0 },
      ],
    });
    const shares = c.lines.map((l) => l.orderDiscountShare);
    expect(shares.reduce((a, s) => a.plus(s), new Decimal(0)).toFixed(2)).toBe('1.00');
    expect(shares).toEqual(['0.34', '0.33', '0.33']);
    expect(c.grandTotal).toBe('2.00');
    expect(c.orderDiscountTotal).toBe('1.00');
  });

  it('handles tax-inclusive shelf prices', () => {
    const c = pricePosCart({ currency: 'USD', pricesIncludeTax: true, lines: [{ quantity: 1, unitPrice: '11.00', taxRatePercent: 10 }] });
    expect(c.grandTotal).toBe('11.00');
    expect(c.netTotal).toBe('10.00');
    expect(c.taxTotal).toBe('1.00');
    // Revenue − discount + tax = what the customer paid.
    const l = c.lines[0];
    expect(new Decimal(l.grossExTax).minus(l.discountExTax).plus(l.tax).toFixed(2)).toBe(l.total);
  });

  it('keeps the ledger identity on awkward inclusive prices with discounts', () => {
    const c = pricePosCart({
      currency: 'USD',
      pricesIncludeTax: true,
      orderDiscountPercent: '7',
      lines: [
        { quantity: 3, unitPrice: '3.33', discountPercent: '5', taxRatePercent: 10 },
        { quantity: 7, unitPrice: '0.99', taxRatePercent: 10 },
      ],
    });
    const lhs = c.lines.reduce((a, l) => a.plus(l.grossExTax).minus(l.discountExTax).plus(l.tax), new Decimal(0));
    expect(lhs.toFixed(2)).toBe(c.grandTotal);
  });

  it('uses whole riel for KHR', () => {
    const c = pricePosCart({ currency: 'KHR', pricesIncludeTax: false, lines: [{ quantity: 3, unitPrice: '1333', taxRatePercent: 10 }] });
    expect(c.grandTotal).toBe('4399');
  });

  it('rejects discounts larger than the line or sale, and empty carts', () => {
    expect(() => pricePosCart({ currency: 'USD', pricesIncludeTax: false, lines: [{ quantity: 1, unitPrice: 1, discountAmount: 2, taxRatePercent: 0 }] })).toThrow(/larger/);
    expect(() =>
      pricePosCart({ currency: 'USD', pricesIncludeTax: false, orderDiscountAmount: 5, lines: [{ quantity: 1, unitPrice: 1, taxRatePercent: 0 }] }),
    ).toThrow(/larger/);
    expect(() => pricePosCart({ currency: 'USD', pricesIncludeTax: false, lines: [] })).toThrow(/no items/);
  });

  it('allocates zero-weight carts without losing money', () => {
    expect(allocate('0.05', [0, 0], 2).map(String)).toEqual(['0.05', '0']);
  });
});

describe('POS split tender', () => {
  it('gives change from cash only', () => {
    const s = settlePayments('110.00', [{ kind: 'CARD', amount: '60' }, { kind: 'CASH', amount: '100' }], 'USD');
    expect(s.changeDue).toBe('50.00');
    expect(s.payments[0].applied).toBe('60.00');
    expect(s.payments[1].applied).toBe('50.00');
  });

  it('rejects overpaying by card or transfer', () => {
    expect(() => settlePayments('10.00', [{ kind: 'CARD', amount: '11' }], 'USD')).toThrow(/cannot be more/);
    expect(() => settlePayments('10.00', [{ kind: 'QR', amount: '6' }, { kind: 'BANK_TRANSFER', amount: '6' }], 'USD')).toThrow(/cannot be more/);
  });

  it('rejects underpayment, zero amounts and sub-cent amounts', () => {
    expect(() => settlePayments('10.00', [{ kind: 'CASH', amount: '9.99' }], 'USD')).toThrow(/do not cover/);
    expect(() => settlePayments('10.00', [{ kind: 'CASH', amount: '0' }], 'USD')).toThrow(/greater than zero/);
    expect(() => settlePayments('10.00', [{ kind: 'CASH', amount: '10.001' }], 'USD')).toThrow(/decimals/);
  });
});

describe('POS refunds', () => {
  const line = { quantity: '3', grossExTax: '10.00', discountExTax: '1.00', net: '9.00', tax: '0.90', total: '9.90' };

  it('refunds exactly what was paid when returned in several steps', () => {
    const a = refundForLine(line, 0, 1, 'USD');
    const b = refundForLine(line, 1, 1, 'USD');
    const c = refundForLine(line, 2, 1, 'USD');
    const total = [a, b, c].reduce((s, r) => s.plus(r.total), new Decimal(0));
    expect(total.toFixed(2)).toBe('9.90');
    const tax = [a, b, c].reduce((s, r) => s.plus(r.tax), new Decimal(0));
    expect(tax.toFixed(2)).toBe('0.90');
  });

  it('refuses to return more than was sold', () => {
    expect(() => refundForLine(line, 2, 2, 'USD')).toThrow(/Only 1/);
  });
});

describe('card number guard', () => {
  it('spots card numbers but not approval codes', () => {
    expect(looksLikeCardNumber('4111 1111 1111 1111')).toBe(true);
    expect(looksLikeCardNumber('APPR-123456')).toBe(false);
    expect(looksLikeCardNumber('123456')).toBe(false);
  });
});
