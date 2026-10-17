import { HttpStatus, Injectable } from '@nestjs/common';
import { P, PermissionCode, PosPaymentKind } from '@ckh/shared';
import * as bcrypt from 'bcryptjs';
import { has, TenantUser } from '../common/auth-context';
import { DomainError, forbidden, notFound } from '../common/errors';
import type { Tx } from '../db/database.service';
import type { CustomerPricingContext } from '../sales/pricing.service';

export interface PosSettings {
  pricesIncludeTax: boolean;
  cashierMaxDiscountPercent: string;
  overrideMaxDiscountPercent: string;
  allowNegativeStock: boolean;
  requireOpenShift: boolean;
  cashDifferenceTolerance: string;
  walkInCustomerId: string | null;
  receipt: ReceiptSettings;
  cashAccountId: string | null;
  pendingPaymentAccountId: string | null;
  cashOverShortAccountId: string | null;
  inventoryAdjustmentAccountId: string | null;
}

export interface ReceiptSettings {
  paper?: '58' | '80' | 'A4';
  languages?: ('en' | 'km' | 'zh')[];
  showLogo?: boolean;
  showTaxId?: boolean;
  header?: Partial<Record<'en' | 'km' | 'zh', string>>;
  footer?: Partial<Record<'en' | 'km' | 'zh', string>>;
}

export interface PosRegister {
  id: string;
  code: string;
  name: string;
  branch_id: string;
  branch_name: string;
  warehouse_id: string;
  warehouse_name: string;
  status: string;
  hardware: Record<string, unknown>;
}

export interface PosPaymentMethod {
  id: string;
  code: string;
  name: string;
  kind: PosPaymentKind;
  requires_reference: boolean;
  requires_verification: boolean;
  provider: string | null;
  account_id: string | null;
  allow_offline: boolean;
  is_active: boolean;
}

export interface PosLicense {
  maxBranches: number | null;
  maxRegisters: number | null;
  maxDevices: number | null;
  offlineValidityHours: number;
}

const PIN_MAX_FAILURES = 5;
const PIN_LOCK_MINUTES = 15;
// Same work for unknown approvers as for wrong PINs.
const DUMMY_HASH = bcrypt.hashSync('not-a-real-pin', 10);

/**
 * Shared POS rules: settings, which registers a user may work at, licence
 * limits, payment methods, and supervisor approval by PIN on the till.
 */
@Injectable()
export class PosContextService {
  async settings(tx: Tx): Promise<PosSettings> {
    const r = await tx.maybeOne(`SELECT * FROM pos_settings WHERE tenant_id = current_tenant_id()`);
    if (!r) throw new DomainError('POS_NOT_CONFIGURED', 'POS settings are missing for this company', 422);
    return {
      pricesIncludeTax: r.prices_include_tax,
      cashierMaxDiscountPercent: r.cashier_max_discount_percent,
      overrideMaxDiscountPercent: r.override_max_discount_percent,
      allowNegativeStock: r.allow_negative_stock,
      requireOpenShift: r.require_open_shift,
      cashDifferenceTolerance: r.cash_difference_tolerance,
      walkInCustomerId: r.walk_in_customer_id,
      receipt: r.receipt ?? {},
      cashAccountId: r.cash_account_id,
      pendingPaymentAccountId: r.pending_payment_account_id,
      cashOverShortAccountId: r.cash_over_short_account_id,
      inventoryAdjustmentAccountId: r.inventory_adjustment_account_id,
    };
  }

  async license(tx: Tx): Promise<PosLicense> {
    const r = await tx.maybeOne(`SELECT * FROM pos_licenses WHERE tenant_id = current_tenant_id()`);
    return {
      maxBranches: r?.max_branches ?? null,
      maxRegisters: r?.max_registers ?? null,
      maxDevices: r?.max_devices ?? null,
      offlineValidityHours: r?.offline_validity_hours ?? 72,
    };
  }

  /** Branch ids the user may work in; null means every branch. */
  async branchIds(tx: Tx, user: TenantUser): Promise<string[] | null> {
    if (has(user, P.POS_ALL_BRANCHES)) return null;
    const rows = await tx.query<{ branch_id: string }>('SELECT branch_id FROM pos_staff_branches WHERE user_id = $1', [user.userId]);
    return rows.map((r) => r.branch_id);
  }

  async assertBranch(tx: Tx, user: TenantUser, branchId: string): Promise<void> {
    const ids = await this.branchIds(tx, user);
    if (ids && !ids.includes(branchId)) throw forbidden('You are not assigned to this branch');
  }

  /** A register the user may work at (active, in one of their branches). */
  async register(tx: Tx, user: TenantUser, registerId: string, opts: { allowInactive?: boolean } = {}): Promise<PosRegister> {
    const r = await tx.maybeOne<PosRegister>(
      `SELECT r.id, r.code, r.name, r.branch_id, b.name AS branch_name, r.warehouse_id, w.name AS warehouse_name, r.status, r.hardware
         FROM pos_registers r JOIN branches b ON b.id = r.branch_id JOIN warehouses w ON w.id = r.warehouse_id
        WHERE r.id = $1`,
      [registerId],
    );
    if (!r) throw notFound('Register');
    await this.assertBranch(tx, user, r.branch_id);
    if (r.status !== 'ACTIVE' && !opts.allowInactive) throw new DomainError('REGISTER_INACTIVE', `Register ${r.code} is not active`, 422);
    return r;
  }

  async paymentMethods(tx: Tx, onlyActive = true): Promise<PosPaymentMethod[]> {
    return tx.query<PosPaymentMethod>(
      `SELECT id, code, name, kind, requires_reference, requires_verification, provider, account_id, allow_offline, is_active
         FROM pos_payment_methods ${onlyActive ? 'WHERE is_active' : ''} ORDER BY sort_order, name`,
    );
  }

  /** Price context for a sale: the customer's own, or the company default list for walk-in customers. */
  async walkInPricing(tx: Tx): Promise<CustomerPricingContext> {
    const r = await tx.one<{ list_id: string | null; list_currency: string | null; base_currency: string }>(
      `SELECT pl.id AS list_id, pl.currency AS list_currency, t.base_currency
         FROM tenants t LEFT JOIN price_lists pl ON pl.is_default AND pl.is_active AND pl.tenant_id = t.id
        WHERE t.id = current_tenant_id() LIMIT 1`,
    );
    return { customerId: '', priceListId: r.list_id, customerGroupId: null, currency: r.list_currency ?? r.base_currency };
  }

  async openShift(tx: Tx, registerId: string, lock = false) {
    return tx.maybeOne<{ id: string; number: string; cashier_id: string; status: string; currency: string; business_date: string }>(
      `SELECT id, number, cashier_id, status, currency, business_date FROM pos_shifts
        WHERE register_id = $1 AND status = 'OPEN' ${lock ? 'FOR UPDATE' : ''}`,
      [registerId],
    );
  }

  /**
   * Supervisor approval on the till. The approver picks their name and enters
   * their POS PIN; they must be active, work in the branch, and hold every
   * permission the action needs. Wrong PINs count towards a lockout.
   * Returns the approver's user id.
   */
  async verifyApprover(
    tx: Tx,
    cashier: TenantUser,
    approval: { userId: string; pin: string },
    needs: PermissionCode[],
    branchId: string,
  ): Promise<string> {
    const u = await tx.maybeOne<{ id: string; status: string; pos_pin_hash: string | null; locked: boolean; full_name: string }>(
      `SELECT id, status, pos_pin_hash, COALESCE(pos_pin_locked_until > now(), false) AS locked, full_name FROM users WHERE id = $1 FOR UPDATE`,
      [approval.userId],
    );
    const refuse = (msg: string) => new DomainError('APPROVAL_INVALID', msg, HttpStatus.FORBIDDEN);
    if (!u || u.status !== 'ACTIVE' || !u.pos_pin_hash) {
      await bcrypt.compare(approval.pin, DUMMY_HASH);
      throw refuse('The approver or PIN is not valid');
    }
    if (u.locked) throw new DomainError('APPROVAL_LOCKED', 'Too many wrong PINs. Try again later.', HttpStatus.TOO_MANY_REQUESTS);
    const ok = await bcrypt.compare(approval.pin, u.pos_pin_hash);
    if (!ok) {
      await tx.query(
        `UPDATE users SET pos_pin_failed_count = CASE WHEN pos_pin_failed_count + 1 >= $2 THEN 0 ELSE pos_pin_failed_count + 1 END,
                          pos_pin_locked_until = CASE WHEN pos_pin_failed_count + 1 >= $2 THEN now() + make_interval(mins => $3) ELSE pos_pin_locked_until END
          WHERE id = $1`,
        [u.id, PIN_MAX_FAILURES, PIN_LOCK_MINUTES],
      );
      throw refuse('The approver or PIN is not valid');
    }
    await tx.query('UPDATE users SET pos_pin_failed_count = 0, pos_pin_locked_until = NULL WHERE id = $1 AND pos_pin_failed_count > 0', [u.id]);
    const perms = new Set(
      (
        await tx.query<{ permission_code: string }>(
          `SELECT rp.permission_code FROM user_roles ur JOIN role_permissions rp ON rp.role_id = ur.role_id WHERE ur.user_id = $1`,
          [u.id],
        )
      ).map((r) => r.permission_code),
    );
    const missing = needs.filter((p) => !perms.has(p));
    if (missing.length) throw new DomainError('APPROVAL_INVALID', `${u.full_name} cannot approve this`, HttpStatus.FORBIDDEN, { missingPermissions: missing });
    if (!perms.has(P.POS_ALL_BRANCHES)) {
      const inBranch = await tx.maybeOne('SELECT 1 FROM pos_staff_branches WHERE user_id = $1 AND branch_id = $2', [u.id, branchId]);
      if (!inBranch) throw new DomainError('APPROVAL_INVALID', `${u.full_name} does not work in this branch`, HttpStatus.FORBIDDEN);
    }
    if (u.id === cashier.userId) throw new DomainError('APPROVAL_INVALID', 'Approval must come from another person', HttpStatus.FORBIDDEN);
    return u.id;
  }

  /**
   * Resolves who authorises a set of permissions for an action: the cashier
   * when they hold them all, otherwise a supervisor's PIN approval. Throws
   * APPROVAL_REQUIRED (with the missing permissions) so the till can ask.
   */
  async authorise(
    tx: Tx,
    user: TenantUser,
    needs: PermissionCode[],
    approval: { userId: string; pin: string } | undefined,
    branchId: string,
    what: string,
  ): Promise<string | null> {
    const missing = [...new Set(needs)].filter((p) => !has(user, p));
    if (missing.length === 0) return null;
    if (!approval) {
      throw new DomainError('APPROVAL_REQUIRED', `A supervisor must approve ${what}`, HttpStatus.FORBIDDEN, { missingPermissions: missing });
    }
    return this.verifyApprover(tx, user, approval, missing, branchId);
  }
}
