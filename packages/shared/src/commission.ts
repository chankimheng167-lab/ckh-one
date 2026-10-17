import Decimal from 'decimal.js';

/**
 * Commission plan rules (stored as sales_commission_plans.rules).
 *
 * The rate for a line is the most specific match:
 *   product → product category → customer → customer group → default.
 *
 * Plan basis (sales_commission_plans.basis) decides what the rate applies to:
 *   INVOICED_NET_SALES  invoice net amount (after discount, before VAT)
 *   COLLECTED_AMOUNT    verified collections, net of VAT
 *   GROSS_PROFIT        invoice net amount minus cost of goods
 *
 * Adjustments: credit notes reverse commission at the original rates;
 * invoices still unpaid `clawbackOverdueDays` after their due date are
 * clawed back, and reinstated when they are paid.
 */
export interface CommissionRules {
  defaultRatePercent: string;
  productRates?: Record<string, string>;
  categoryRates?: Record<string, string>;
  customerRates?: Record<string, string>;
  customerGroupRates?: Record<string, string>;
  /** Claw back commission on invoices this many days overdue (omit to disable). */
  clawbackOverdueDays?: number;
  /** Bonus multipliers by monthly NET_SALES target achievement, e.g. [{minAchievementPercent:'100', multiplier:'1.2'}]. */
  tiers?: { minAchievementPercent: string; multiplier: string }[];
}

export type CommissionBasis = 'INVOICED_NET_SALES' | 'COLLECTED_AMOUNT' | 'GROSS_PROFIT';

export interface CommissionLineContext {
  productId: string;
  categoryId?: string | null;
  customerId: string;
  customerGroupId?: string | null;
}

export function commissionRate(rules: CommissionRules, l: CommissionLineContext): string {
  const pick = (map: Record<string, string> | undefined, key: string | null | undefined) => (key && map ? map[key] : undefined);
  return (
    pick(rules.productRates, l.productId) ??
    pick(rules.categoryRates, l.categoryId) ??
    pick(rules.customerRates, l.customerId) ??
    pick(rules.customerGroupRates, l.customerGroupId) ??
    rules.defaultRatePercent
  );
}

/** Commission on a base amount, rounded to cents (half-up). */
export function commissionAmount(base: Decimal.Value, ratePercent: Decimal.Value, scale = 2): string {
  return new Decimal(base).mul(ratePercent).div(100).toDecimalPlaces(scale).toFixed(scale);
}

/** Highest tier multiplier whose threshold the achievement reaches (1 when none). */
export function tierMultiplier(rules: CommissionRules, achievementPercent: Decimal.Value): string {
  const a = new Decimal(achievementPercent);
  let best = new Decimal(1);
  let bestMin = new Decimal(-1);
  for (const t of rules.tiers ?? []) {
    if (a.gte(t.minAchievementPercent) && new Decimal(t.minAchievementPercent).gt(bestMin)) {
      best = new Decimal(t.multiplier);
      bestMin = new Decimal(t.minAchievementPercent);
    }
  }
  return best.toString();
}

export function validateCommissionRules(r: CommissionRules): string[] {
  const errors: string[] = [];
  const pct = (v: string, where: string) => {
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0 || n > 100) errors.push(`${where} must be a percentage between 0 and 100`);
  };
  pct(r.defaultRatePercent, 'defaultRatePercent');
  for (const k of ['productRates', 'categoryRates', 'customerRates', 'customerGroupRates'] as const) {
    for (const [id, v] of Object.entries(r[k] ?? {})) pct(v, `${k}.${id}`);
  }
  for (const t of r.tiers ?? []) {
    if (!(Number(t.multiplier) >= 0)) errors.push('tier multiplier must be ≥ 0');
  }
  if (r.clawbackOverdueDays !== undefined && !(r.clawbackOverdueDays >= 0)) errors.push('clawbackOverdueDays must be ≥ 0');
  return errors;
}

/** Calendar period for a target: month, quarter or year containing `start`. */
export function periodBounds(periodType: 'MONTH' | 'QUARTER' | 'YEAR', start: string): { start: string; end: string } {
  const [y, m] = start.split('-').map(Number);
  let sm = m;
  let months = 1;
  if (periodType === 'QUARTER') {
    sm = Math.floor((m - 1) / 3) * 3 + 1;
    months = 3;
  } else if (periodType === 'YEAR') {
    sm = 1;
    months = 12;
  }
  const s = new Date(Date.UTC(y, sm - 1, 1));
  const e = new Date(Date.UTC(y, sm - 1 + months, 0));
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  return { start: iso(s), end: iso(e) };
}
