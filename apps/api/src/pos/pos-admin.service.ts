import { HttpStatus, Injectable } from '@nestjs/common';
import { P } from '@ckh/shared';
import * as bcrypt from 'bcryptjs';
import { z } from 'zod';
import { has, TenantUser } from '../common/auth-context';
import { AuditService } from '../common/audit.service';
import { conflict, DomainError, notFound } from '../common/errors';
import { decimalString, uuid } from '../common/validation';
import type { Tx } from '../db/database.service';
import { PosContextService } from './pos-context.service';

export const Hardware = z
  .object({
    receiptPaper: z.enum(['58', '80', 'A4']).default('80'),
    autoPrint: z.boolean().default(true),
    copies: z.number().int().min(1).max(3).default(1),
    printerName: z.string().max(200).nullable().optional(),
    /** How the Windows POS reaches the printer: the OS print queue, or raw ESC/POS over TCP/serial. */
    printerConnection: z.enum(['SYSTEM', 'NETWORK', 'SERIAL']).default('SYSTEM'),
    printerAddress: z.string().max(200).nullable().optional(),
    openDrawerOnCash: z.boolean().default(true),
    /** Drawer wired to the receipt printer's kick port (ESC p). */
    drawerPin: z.union([z.literal(0), z.literal(1)]).default(0),
    customerDisplay: z.boolean().default(false),
    scannerSuffix: z.enum(['ENTER', 'TAB', 'NONE']).default('ENTER'),
  })
  .strict();

export const RegisterInput = z.object({
  code: z.string().regex(/^[A-Za-z0-9_-]{1,30}$/),
  name: z.string().min(1).max(100),
  branchId: uuid,
  warehouseId: uuid,
  hardware: Hardware.optional(),
});
export const RegisterUpdate = RegisterInput.partial().extend({ status: z.enum(['ACTIVE', 'INACTIVE']).optional() });

const lang = z.enum(['en', 'km', 'zh']);
export const SettingsInput = z
  .object({
    pricesIncludeTax: z.boolean(),
    cashierMaxDiscountPercent: decimalString,
    overrideMaxDiscountPercent: decimalString,
    allowNegativeStock: z.boolean(),
    requireOpenShift: z.boolean(),
    cashDifferenceTolerance: decimalString,
    walkInCustomerId: uuid.nullable(),
    receipt: z
      .object({
        paper: z.enum(['58', '80', 'A4']),
        languages: z.array(lang).min(1).max(3),
        showLogo: z.boolean(),
        showTaxId: z.boolean(),
        header: z.record(lang, z.string().max(500)).default({}),
        footer: z.record(lang, z.string().max(500)).default({}),
      })
      .partial(),
    cashAccountId: uuid.nullable(),
    pendingPaymentAccountId: uuid,
    cashOverShortAccountId: uuid,
    inventoryAdjustmentAccountId: uuid,
  })
  .partial();

export const PaymentMethodInput = z.object({
  code: z.string().regex(/^[A-Z0-9_]{2,30}$/),
  name: z.string().min(1).max(60),
  kind: z.enum(['CASH', 'BANK_TRANSFER', 'QR', 'CARD', 'OTHER']),
  requiresReference: z.boolean().default(false),
  requiresVerification: z.boolean().default(false),
  provider: z.string().max(60).nullable().optional(),
  accountId: uuid.nullable().optional(),
  allowOffline: z.boolean().default(false),
  sortOrder: z.number().int().min(0).max(1000).default(10),
  isActive: z.boolean().default(true),
});

/** POS administration: registers (within the licence), settings, payment methods, staff branches, PINs. */
@Injectable()
export class PosAdminService {
  constructor(private readonly ctx: PosContextService, private readonly audit: AuditService) {}

  async registers(tx: Tx, user: TenantUser) {
    const branches = await this.ctx.branchIds(tx, user);
    return tx.query(
      `SELECT r.*, b.name AS branch_name, w.name AS warehouse_name,
              (SELECT s.number FROM pos_shifts s WHERE s.register_id = r.id AND s.status = 'OPEN') AS open_shift_number,
              (SELECT u.full_name FROM pos_shifts s JOIN users u ON u.id = s.cashier_id WHERE s.register_id = r.id AND s.status = 'OPEN') AS open_shift_cashier,
              (SELECT count(*)::int FROM pos_devices d WHERE d.register_id = r.id AND d.status = 'ACTIVE') AS device_count
         FROM pos_registers r JOIN branches b ON b.id = r.branch_id JOIN warehouses w ON w.id = r.warehouse_id
        WHERE ($1::uuid[] IS NULL OR r.branch_id = ANY($1::uuid[]))
        ORDER BY b.name, r.code`,
      [branches],
    );
  }

  /** Enforces the Super Admin's register and branch limits for active registers. */
  private async checkRegisterLimits(tx: Tx, branchId: string, excludeId: string | null) {
    const lic = await this.ctx.license(tx);
    const r = await tx.one<{ registers: number; branches: number; in_branch: boolean }>(
      `SELECT count(*)::int AS registers, count(DISTINCT branch_id)::int AS branches, bool_or(branch_id = $1) AS in_branch
         FROM pos_registers WHERE status = 'ACTIVE' AND ($2::uuid IS NULL OR id <> $2)`,
      [branchId, excludeId],
    );
    if (lic.maxRegisters !== null && r.registers + 1 > lic.maxRegisters) {
      throw new DomainError('LICENSE_LIMIT', `Your POS licence allows ${lic.maxRegisters} active register(s)`, HttpStatus.PAYMENT_REQUIRED, { limit: 'registers' });
    }
    if (lic.maxBranches !== null && !r.in_branch && r.branches + 1 > lic.maxBranches) {
      throw new DomainError('LICENSE_LIMIT', `Your POS licence allows POS in ${lic.maxBranches} branch(es)`, HttpStatus.PAYMENT_REQUIRED, { limit: 'branches' });
    }
  }

  async createRegister(tx: Tx, user: TenantUser, i: z.infer<typeof RegisterInput>) {
    await this.ctx.assertBranch(tx, user, i.branchId);
    const wh = await tx.maybeOne<{ branch_id: string }>('SELECT branch_id FROM warehouses WHERE id = $1 AND is_active', [i.warehouseId]);
    if (!wh) throw notFound('Warehouse');
    if (wh.branch_id !== i.branchId) throw new DomainError('WAREHOUSE_BRANCH_MISMATCH', 'The warehouse belongs to another branch', 422);
    await this.checkRegisterLimits(tx, i.branchId, null);
    const r = await tx.one(
      `INSERT INTO pos_registers (tenant_id, code, name, branch_id, warehouse_id, hardware)
       VALUES (current_tenant_id(), $1, $2, $3, $4, $5) RETURNING *`,
      [i.code, i.name, i.branchId, i.warehouseId, JSON.stringify(Hardware.parse(i.hardware ?? {}))],
    );
    await this.audit.record(tx, { action: 'POS_REGISTER_CREATED', entityType: 'pos_register', entityId: r.id, after: r });
    return r;
  }

  async updateRegister(tx: Tx, user: TenantUser, id: string, i: z.infer<typeof RegisterUpdate>) {
    const before = await tx.maybeOne('SELECT * FROM pos_registers WHERE id = $1 FOR UPDATE', [id]);
    if (!before) throw notFound('Register');
    await this.ctx.assertBranch(tx, user, before.branch_id);
    const branchId = i.branchId ?? before.branch_id;
    if (i.branchId) await this.ctx.assertBranch(tx, user, i.branchId);
    const warehouseId = i.warehouseId ?? before.warehouse_id;
    const wh = await tx.maybeOne<{ branch_id: string }>('SELECT branch_id FROM warehouses WHERE id = $1', [warehouseId]);
    if (!wh || wh.branch_id !== branchId) throw new DomainError('WAREHOUSE_BRANCH_MISMATCH', 'The warehouse belongs to another branch', 422);
    const status = i.status ?? before.status;
    if (status === 'ACTIVE') await this.checkRegisterLimits(tx, branchId, id);
    if (status === 'INACTIVE' && (await this.ctx.openShift(tx, id))) throw conflict('SHIFT_OPEN', 'Close the open shift before deactivating the register');
    const after = await tx.one(
      `UPDATE pos_registers SET code = $2, name = $3, branch_id = $4, warehouse_id = $5, hardware = $6, status = $7 WHERE id = $1 RETURNING *`,
      [id, i.code ?? before.code, i.name ?? before.name, branchId, warehouseId,
        JSON.stringify(i.hardware ? Hardware.parse(i.hardware) : before.hardware), status],
    );
    await this.audit.record(tx, { action: 'POS_REGISTER_UPDATED', entityType: 'pos_register', entityId: id, before, after });
    return after;
  }

  async getSettings(tx: Tx) {
    const s = await tx.one(`SELECT * FROM pos_settings WHERE tenant_id = current_tenant_id()`);
    const accounts = await tx.query(`SELECT id, code, name, account_type FROM chart_of_accounts WHERE is_active AND is_postable ORDER BY code`);
    return { ...s, accounts };
  }

  async putSettings(tx: Tx, i: z.infer<typeof SettingsInput>) {
    const before = await tx.one(`SELECT * FROM pos_settings WHERE tenant_id = current_tenant_id() FOR UPDATE`);
    if (i.walkInCustomerId) {
      const c = await tx.maybeOne(`SELECT 1 FROM customers WHERE id = $1 AND status = 'ACTIVE'`, [i.walkInCustomerId]);
      if (!c) throw notFound('Walk-in customer');
    }
    const receipt = i.receipt ? { ...before.receipt, ...i.receipt } : before.receipt;
    const after = await tx.one(
      `UPDATE pos_settings SET
         prices_include_tax = COALESCE($1, prices_include_tax),
         cashier_max_discount_percent = COALESCE($2::numeric, cashier_max_discount_percent),
         override_max_discount_percent = COALESCE($3::numeric, override_max_discount_percent),
         allow_negative_stock = COALESCE($4, allow_negative_stock),
         require_open_shift = COALESCE($5, require_open_shift),
         cash_difference_tolerance = COALESCE($6::numeric, cash_difference_tolerance),
         walk_in_customer_id = CASE WHEN $7 THEN $8::uuid ELSE walk_in_customer_id END,
         receipt = $9::jsonb,
         cash_account_id = CASE WHEN $10 THEN $11::uuid ELSE cash_account_id END,
         pending_payment_account_id = COALESCE($12::uuid, pending_payment_account_id),
         cash_over_short_account_id = COALESCE($13::uuid, cash_over_short_account_id),
         inventory_adjustment_account_id = COALESCE($14::uuid, inventory_adjustment_account_id),
         updated_at = now()
       WHERE tenant_id = current_tenant_id() RETURNING *`,
      [
        i.pricesIncludeTax ?? null, i.cashierMaxDiscountPercent ?? null, i.overrideMaxDiscountPercent ?? null, i.allowNegativeStock ?? null,
        i.requireOpenShift ?? null, i.cashDifferenceTolerance ?? null, i.walkInCustomerId !== undefined, i.walkInCustomerId ?? null,
        JSON.stringify(receipt), i.cashAccountId !== undefined, i.cashAccountId ?? null, i.pendingPaymentAccountId ?? null,
        i.cashOverShortAccountId ?? null, i.inventoryAdjustmentAccountId ?? null,
      ],
    );
    await this.audit.record(tx, { action: 'POS_SETTINGS_UPDATED', entityType: 'pos_settings', before, after });
    return after;
  }

  async createPaymentMethod(tx: Tx, i: z.infer<typeof PaymentMethodInput>) {
    if (i.allowOffline && i.kind !== 'CASH') throw new DomainError('OFFLINE_CASH_ONLY', 'Only cash can be accepted offline', 422);
    const m = await tx.one(
      `INSERT INTO pos_payment_methods (tenant_id, code, name, kind, requires_reference, requires_verification, provider, account_id, allow_offline, sort_order, is_active)
       VALUES (current_tenant_id(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
      [i.code, i.name, i.kind, i.requiresReference, i.requiresVerification, i.provider ?? null, i.accountId ?? null, i.allowOffline, i.sortOrder, i.isActive],
    );
    await this.audit.record(tx, { action: 'POS_PAYMENT_METHOD_CREATED', entityType: 'pos_payment_method', entityId: m.id, after: m });
    return m;
  }

  async updatePaymentMethod(tx: Tx, id: string, i: Partial<z.infer<typeof PaymentMethodInput>>) {
    const b = await tx.maybeOne('SELECT * FROM pos_payment_methods WHERE id = $1 FOR UPDATE', [id]);
    if (!b) throw notFound('Payment method');
    const kind = i.kind ?? b.kind;
    const allowOffline = i.allowOffline ?? b.allow_offline;
    if (allowOffline && kind !== 'CASH') throw new DomainError('OFFLINE_CASH_ONLY', 'Only cash can be accepted offline', 422);
    const a = await tx.one(
      `UPDATE pos_payment_methods SET code = $2, name = $3, kind = $4, requires_reference = $5, requires_verification = $6, provider = $7,
              account_id = $8, allow_offline = $9, sort_order = $10, is_active = $11 WHERE id = $1 RETURNING *`,
      [id, i.code ?? b.code, i.name ?? b.name, kind, i.requiresReference ?? b.requires_reference, i.requiresVerification ?? b.requires_verification,
        i.provider !== undefined ? i.provider : b.provider, i.accountId !== undefined ? i.accountId : b.account_id, allowOffline,
        i.sortOrder ?? b.sort_order, i.isActive ?? b.is_active],
    );
    await this.audit.record(tx, { action: 'POS_PAYMENT_METHOD_UPDATED', entityType: 'pos_payment_method', entityId: id, before: b, after: a });
    return a;
  }

  /** POS staff and the branches they work in. */
  async staff(tx: Tx) {
    return tx.query(
      `SELECT u.id, u.full_name, u.email, u.status, (u.pos_pin_hash IS NOT NULL) AS has_pin,
              COALESCE((SELECT array_agg(r.code ORDER BY r.code) FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = u.id), '{}') AS roles,
              COALESCE((SELECT array_agg(sb.branch_id) FROM pos_staff_branches sb WHERE sb.user_id = u.id), '{}') AS branch_ids
         FROM users u
        WHERE EXISTS (SELECT 1 FROM user_roles ur JOIN role_permissions rp ON rp.role_id = ur.role_id WHERE ur.user_id = u.id AND rp.permission_code = 'pos.access')
        ORDER BY u.full_name`,
    );
  }

  async setStaffBranches(tx: Tx, user: TenantUser, userId: string, branchIds: string[]) {
    if (!(await tx.maybeOne('SELECT 1 FROM users WHERE id = $1', [userId]))) throw notFound('User');
    if (!has(user, P.POS_ALL_BRANCHES)) {
      // A branch administrator can only assign people to their own branches.
      const mine = (await this.ctx.branchIds(tx, user)) ?? [];
      const current = (await tx.query<{ branch_id: string }>('SELECT branch_id FROM pos_staff_branches WHERE user_id = $1', [userId])).map((r) => r.branch_id);
      const touched = [...new Set([...branchIds.filter((b) => !current.includes(b)), ...current.filter((b) => !branchIds.includes(b))])];
      if (touched.some((b) => !mine.includes(b))) throw new DomainError('FORBIDDEN', 'You can only change access to your own branches', 403);
    }
    await tx.query('DELETE FROM pos_staff_branches WHERE user_id = $1', [userId]);
    await tx.query('INSERT INTO pos_staff_branches (tenant_id, user_id, branch_id) SELECT current_tenant_id(), $1, unnest($2::uuid[])', [userId, branchIds]);
    await this.audit.record(tx, { action: 'POS_STAFF_BRANCHES_SET', entityType: 'user', entityId: userId, after: { branchIds } });
    return { userId, branchIds };
  }

  /** Sets the caller's own approval PIN after re-checking their password. */
  async setOwnPin(tx: Tx, user: TenantUser, i: { currentPassword: string; pin: string }) {
    const u = await tx.one<{ password_hash: string }>('SELECT password_hash FROM users WHERE id = $1', [user.userId]);
    if (!(await bcrypt.compare(i.currentPassword, u.password_hash))) {
      throw new DomainError('INVALID_CREDENTIALS', 'Current password is incorrect', 422);
    }
    if (/^(\d)\1+$/.test(i.pin) || '0123456789'.includes(i.pin) || '9876543210'.includes(i.pin)) {
      throw new DomainError('PIN_TOO_SIMPLE', 'Choose a PIN that is not a sequence or a repeated digit', 422);
    }
    await tx.query('UPDATE users SET pos_pin_hash = $2, pos_pin_failed_count = 0, pos_pin_locked_until = NULL WHERE id = $1', [
      user.userId, await bcrypt.hash(i.pin, 10),
    ]);
    await this.audit.record(tx, { action: 'POS_PIN_SET', entityType: 'user', entityId: user.userId });
    return { pinSet: true };
  }

  /** People who can approve discounts, price changes or refunds at this register (have a PIN, work in the branch). */
  async approvers(tx: Tx, user: TenantUser, registerId: string) {
    const reg = await this.ctx.register(tx, user, registerId, { allowInactive: true });
    return tx.query(
      `SELECT u.id, u.full_name,
              array_agg(DISTINCT rp.permission_code ORDER BY rp.permission_code) FILTER (WHERE rp.permission_code IN
                ('pos.discount.override', 'pos.price.override', 'pos.refunds.create', 'pos.receipts.reprint', 'pos.discount.apply')) AS can
         FROM users u JOIN user_roles ur ON ur.user_id = u.id JOIN role_permissions rp ON rp.role_id = ur.role_id
        WHERE u.status = 'ACTIVE' AND u.pos_pin_hash IS NOT NULL AND u.id <> $2
          AND (EXISTS (SELECT 1 FROM user_roles ur2 JOIN role_permissions rp2 ON rp2.role_id = ur2.role_id
                        WHERE ur2.user_id = u.id AND rp2.permission_code = 'pos.branches.all')
               OR EXISTS (SELECT 1 FROM pos_staff_branches sb WHERE sb.user_id = u.id AND sb.branch_id = $1))
        GROUP BY u.id, u.full_name
       HAVING bool_or(rp.permission_code IN ('pos.discount.override', 'pos.price.override', 'pos.refunds.create', 'pos.receipts.reprint'))
        ORDER BY u.full_name`,
      [reg.branch_id, user.userId],
    );
  }
}
