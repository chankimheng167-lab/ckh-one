import { priceLine, priceOrder, PricingError } from './pricing';
import { requiredApprovals, DEFAULT_APPROVAL_LIMITS, canSatisfy } from './approval-policy';
import { nextStatus, allowedActions, InvalidTransitionError } from './order-workflow';

describe('pricing', () => {
  it('prices a line with discount and 10% VAT', () => {
    const l = priceLine({ quantity: 3, unitPrice: '12.50', discountPercent: 10, taxRatePercent: 10 }, 'USD');
    expect(l.grossAmount).toBe('37.50');
    expect(l.discountAmount).toBe('3.75');
    expect(l.netAmount).toBe('33.75');
    expect(l.taxAmount).toBe('3.38');
    expect(l.lineTotal).toBe('37.13');
  });

  it('rounds KHR to whole riel', () => {
    const l = priceLine({ quantity: 1, unitPrice: '4105', discountPercent: 3, taxRatePercent: 10 }, 'KHR');
    expect(l.discountAmount).toBe('123');
    expect(l.netAmount).toBe('3982');
    expect(l.taxAmount).toBe('398');
    expect(l.lineTotal).toBe('4380');
  });

  it('order total equals the sum of rounded line totals', () => {
    const o = priceOrder(
      [
        { quantity: 1, unitPrice: '0.333', discountPercent: 0, taxRatePercent: 10 },
        { quantity: 1, unitPrice: '0.333', discountPercent: 0, taxRatePercent: 10 },
        { quantity: 1, unitPrice: '0.333', discountPercent: 0, taxRatePercent: 10 },
      ],
      'USD',
    );
    expect(o.grandTotal).toBe('1.11');
  });

  it('rejects bad input', () => {
    expect(() => priceLine({ quantity: 0, unitPrice: 1, discountPercent: 0, taxRatePercent: 0 }, 'USD')).toThrow(PricingError);
    expect(() => priceLine({ quantity: 1, unitPrice: 1, discountPercent: 101, taxRatePercent: 0 }, 'USD')).toThrow(PricingError);
    expect(() => priceLine({ quantity: 'abc', unitPrice: 1, discountPercent: 0, taxRatePercent: 0 }, 'USD')).toThrow(PricingError);
  });
});

describe('approval policy', () => {
  const base = { grandTotal: '100', creditLimit: null, creditExposure: '0' };
  it('needs nothing within rep limit', () => {
    expect(requiredApprovals({ ...base, maxDiscountPercent: '5' }, DEFAULT_APPROVAL_LIMITS)).toEqual([]);
  });
  it('routes discounts to the right level', () => {
    expect(requiredApprovals({ ...base, maxDiscountPercent: '8' }, DEFAULT_APPROVAL_LIMITS)[0].level).toBe(1);
    expect(requiredApprovals({ ...base, maxDiscountPercent: '15' }, DEFAULT_APPROVAL_LIMITS)[0].level).toBe(2);
    expect(requiredApprovals({ ...base, maxDiscountPercent: '30' }, DEFAULT_APPROVAL_LIMITS)[0].level).toBe(3);
  });
  it('honours customer special discount allowance', () => {
    expect(
      requiredApprovals({ ...base, maxDiscountPercent: '8', customerDiscountAllowancePercent: '10' }, DEFAULT_APPROVAL_LIMITS),
    ).toEqual([]);
  });
  it('flags credit limit breaches for a credit controller', () => {
    const r = requiredApprovals({ ...base, maxDiscountPercent: '0', creditLimit: '500', creditExposure: '450' }, DEFAULT_APPROVAL_LIMITS);
    expect(r).toHaveLength(1);
    expect(r[0].reason).toBe('CREDIT_LIMIT');
    expect(canSatisfy(r[0], 3, false)).toBe(false);
    expect(canSatisfy(r[0], 0, true)).toBe(true);
  });
});

describe('order workflow', () => {
  it('walks the happy path', () => {
    let s = nextStatus('DRAFT', 'SUBMIT');
    s = nextStatus(s, 'REQUIRE_APPROVAL');
    s = nextStatus(s, 'APPROVE');
    s = nextStatus(s, 'RESERVE');
    s = nextStatus(s, 'START_PICKING');
    s = nextStatus(s, 'PACK');
    s = nextStatus(s, 'DISPATCH');
    s = nextStatus(s, 'DELIVER');
    s = nextStatus(s, 'INVOICE');
    expect(nextStatus(s, 'CLOSE')).toBe('CLOSED');
  });
  it('lets tenants skip pick/pack', () => {
    const cfg = { pickPackEnabled: false, invoiceOnDispatch: false };
    expect(nextStatus('STOCK_RESERVED', 'DISPATCH', cfg)).toBe('DISPATCHED');
    expect(() => nextStatus('STOCK_RESERVED', 'START_PICKING', cfg)).toThrow(InvalidTransitionError);
  });
  it('blocks invalid moves', () => {
    expect(() => nextStatus('DELIVERED', 'CANCEL')).toThrow(InvalidTransitionError);
    expect(allowedActions('PENDING_APPROVAL')).toEqual(expect.arrayContaining(['APPROVE', 'REJECT', 'CANCEL']));
  });
});
