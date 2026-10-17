import { commissionAmount, commissionRate, periodBounds, tierMultiplier, validateCommissionRules } from './commission';

describe('commission rules', () => {
  const rules = {
    defaultRatePercent: '2',
    productRates: { p1: '5' },
    categoryRates: { cat: '3' },
    customerRates: { c9: '1' },
    tiers: [{ minAchievementPercent: '100', multiplier: '1.2' }, { minAchievementPercent: '120', multiplier: '1.5' }],
  };

  it('uses the most specific rate', () => {
    expect(commissionRate(rules, { productId: 'p1', categoryId: 'cat', customerId: 'c9' })).toBe('5');
    expect(commissionRate(rules, { productId: 'p2', categoryId: 'cat', customerId: 'c9' })).toBe('3');
    expect(commissionRate(rules, { productId: 'p2', customerId: 'c9' })).toBe('1');
    expect(commissionRate(rules, { productId: 'p2', customerId: 'c1' })).toBe('2');
  });

  it('rounds half-up to cents', () => {
    expect(commissionAmount('33.75', '2')).toBe('0.68');
    expect(commissionAmount('-33.75', '2')).toBe('-0.68');
  });

  it('picks the highest tier reached', () => {
    expect(tierMultiplier(rules, '99')).toBe('1');
    expect(tierMultiplier(rules, '110')).toBe('1.2');
    expect(tierMultiplier(rules, '130')).toBe('1.5');
  });

  it('validates percentages', () => {
    expect(validateCommissionRules(rules)).toEqual([]);
    expect(validateCommissionRules({ defaultRatePercent: '150' })).toHaveLength(1);
  });

  it('computes calendar periods', () => {
    expect(periodBounds('MONTH', '2026-02-10')).toEqual({ start: '2026-02-01', end: '2026-02-28' });
    expect(periodBounds('QUARTER', '2026-05-03')).toEqual({ start: '2026-04-01', end: '2026-06-30' });
    expect(periodBounds('YEAR', '2026-05-03')).toEqual({ start: '2026-01-01', end: '2026-12-31' });
  });
});
