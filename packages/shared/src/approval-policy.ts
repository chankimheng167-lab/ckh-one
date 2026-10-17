import Decimal from 'decimal.js';

/**
 * Discount / amount / credit approval policy.
 *
 * Approval authority comes in levels. A role carries an approval level; a
 * user's level is the highest level among their roles.
 *   0 = none (sales representative)
 *   1 = supervisor
 *   2 = manager
 *   3 = director / tenant administrator
 */
export const APPROVAL_LEVEL = { NONE: 0, SUPERVISOR: 1, MANAGER: 2, DIRECTOR: 3 } as const;
export type ApprovalLevel = (typeof APPROVAL_LEVEL)[keyof typeof APPROVAL_LEVEL];

export interface ApprovalLimits {
  /** Highest line discount % a rep may give without approval. */
  repMaxDiscountPercent: string;
  /** Highest discount % a supervisor may approve. */
  supervisorMaxDiscountPercent: string;
  /** Highest discount % a manager may approve. Above this needs director. */
  managerMaxDiscountPercent: string;
  /** Orders with grand total above this need at least manager approval (null = no limit). */
  managerOrderAmountThreshold: string | null;
  /** Orders with grand total above this need director approval (null = no limit). */
  directorOrderAmountThreshold: string | null;
}

export const DEFAULT_APPROVAL_LIMITS: ApprovalLimits = {
  repMaxDiscountPercent: '5',
  supervisorMaxDiscountPercent: '10',
  managerMaxDiscountPercent: '20',
  managerOrderAmountThreshold: null,
  directorOrderAmountThreshold: null,
};

export type ApprovalReason = 'DISCOUNT' | 'ORDER_AMOUNT' | 'CREDIT_LIMIT' | 'OFFLINE_PRICE_CHANGE';

export interface ApprovalRequirement {
  reason: ApprovalReason;
  /** Minimum approval level, or 'CREDIT' for a credit controller (customers.credit.manage). */
  level: ApprovalLevel | 'CREDIT';
  detail: string;
}

export interface ApprovalCheckInput {
  maxDiscountPercent: string;
  /** Discount % pre-approved for this customer (special pricing). Acts like a raised rep limit. */
  customerDiscountAllowancePercent?: string | null;
  grandTotal: string;
  /** Customer credit limit; null = no limit configured. */
  creditLimit: string | null;
  /** Outstanding receivables + open (approved, not yet invoiced) orders, excluding this order. */
  creditExposure: string;
  creditHold?: boolean;
}

export function requiredApprovals(input: ApprovalCheckInput, limits: ApprovalLimits): ApprovalRequirement[] {
  const req: ApprovalRequirement[] = [];
  const disc = new Decimal(input.maxDiscountPercent);
  const repLimit = Decimal.max(
    new Decimal(limits.repMaxDiscountPercent),
    new Decimal(input.customerDiscountAllowancePercent ?? 0),
  );

  if (disc.gt(repLimit)) {
    let level: ApprovalLevel = APPROVAL_LEVEL.DIRECTOR;
    if (disc.lte(limits.supervisorMaxDiscountPercent)) level = APPROVAL_LEVEL.SUPERVISOR;
    else if (disc.lte(limits.managerMaxDiscountPercent)) level = APPROVAL_LEVEL.MANAGER;
    req.push({ reason: 'DISCOUNT', level, detail: `Discount ${disc}% exceeds rep limit ${repLimit}%` });
  }

  const total = new Decimal(input.grandTotal);
  if (limits.directorOrderAmountThreshold && total.gt(limits.directorOrderAmountThreshold)) {
    req.push({
      reason: 'ORDER_AMOUNT',
      level: APPROVAL_LEVEL.DIRECTOR,
      detail: `Order total ${total} exceeds ${limits.directorOrderAmountThreshold}`,
    });
  } else if (limits.managerOrderAmountThreshold && total.gt(limits.managerOrderAmountThreshold)) {
    req.push({
      reason: 'ORDER_AMOUNT',
      level: APPROVAL_LEVEL.MANAGER,
      detail: `Order total ${total} exceeds ${limits.managerOrderAmountThreshold}`,
    });
  }

  if (input.creditHold) {
    req.push({ reason: 'CREDIT_LIMIT', level: 'CREDIT', detail: 'Customer is on credit hold' });
  } else if (input.creditLimit !== null) {
    const exposure = new Decimal(input.creditExposure).plus(total);
    if (exposure.gt(input.creditLimit)) {
      req.push({
        reason: 'CREDIT_LIMIT',
        level: 'CREDIT',
        detail: `Credit exposure ${exposure} would exceed limit ${input.creditLimit}`,
      });
    }
  }
  return req;
}

/** Can a user with this level / credit authority satisfy the requirement? */
export function canSatisfy(
  requirement: ApprovalRequirement,
  approverLevel: number,
  approverHasCreditAuthority: boolean,
): boolean {
  if (requirement.level === 'CREDIT') return approverHasCreditAuthority;
  return approverLevel >= requirement.level;
}
