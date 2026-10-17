import { Injectable } from '@nestjs/common';
import { Decimal } from '@ckh/shared';
import { z } from 'zod';
import type { TenantUser } from '../common/auth-context';
import { DomainError, forbidden } from '../common/errors';
import { decimalString, uuid } from '../common/validation';
import { DatabaseService, Tx } from '../db/database.service';
import { PricingService } from '../sales/pricing.service';
import { PosContextService } from './pos-context.service';
import { PosDevice, PosDevicesService } from './pos-devices.service';
import { canonical, CheckoutInput, clientKey, sha256 } from './pos-schemas';
import { PosSalesService } from './pos-sales.service';

const px = (v: string) => new Decimal(v).toFixed(4);

export const SyncInput = z.object({
  events: z
    .array(
      z.object({
        idempotencyKey: clientKey,
        type: z.literal('SALE'),
        /** Who sold it on the device (must be the person uploading). */
        userId: uuid,
        clientCreatedAt: z.string().datetime({ offset: true }),
        catalogSnapshotAt: z.string().datetime({ offset: true }).optional(),
        /** What the device charged, to compare with the server's arithmetic. */
        deviceTotal: decimalString,
        sale: CheckoutInput,
      }),
    )
    .min(1)
    .max(100),
});
export type SyncInput = z.infer<typeof SyncInput>;

type Status = 'ACCEPTED' | 'ACCEPTED_WITH_CHANGES' | 'REJECTED' | 'CONFLICT';

/**
 * Offline selling on the Windows POS: the catalogue snapshot it sells from,
 * and the replay of sales it recorded offline. Each sale is replayed through
 * the normal checkout in its own transaction, so stock, the drawer and the
 * ledger move exactly as for an online sale; anything the server would have
 * refused online (price, stock, discount, serial, shift) is recorded and
 * flagged for a supervisor's review rather than lost. Replays are
 * idempotent: the same event twice returns the first result.
 */
@Injectable()
export class PosSyncService {
  constructor(
    private readonly db: DatabaseService,
    private readonly ctx: PosContextService,
    private readonly devices: PosDevicesService,
    private readonly sales: PosSalesService,
    private readonly pricing: PricingService,
  ) {}

  /** What the device needs to sell offline: walk-in prices, tax, barcodes, offline payment methods and limits. */
  async bootstrap(tx: Tx, user: TenantUser, device: PosDevice) {
    const reg = await this.ctx.register(tx, user, device.register_id);
    const settings = await this.ctx.settings(tx);
    const pctx = await this.ctx.walkInPricing(tx);
    const today = tx.today();
    const products = await tx.query(
      `SELECT p.id, p.sku, p.barcode, p.name, p.name_local, p.category_id, p.serial_tracked, p.track_inventory,
              par.name AS parent_name, p.variant_attributes,
              COALESCE((SELECT json_agg(json_build_object('barcode', u.barcode, 'quantity', u.factor::text)) FROM product_uoms u
                         WHERE u.product_id = p.id AND u.barcode IS NOT NULL), '[]') AS packs
         FROM products p LEFT JOIN products par ON par.id = p.parent_product_id
        WHERE p.status = 'ACTIVE' AND p.is_sellable
          AND NOT EXISTS (SELECT 1 FROM products v WHERE v.parent_product_id = p.id AND v.status = 'ACTIVE')
        ORDER BY COALESCE(par.name, p.name), p.sku`,
    );
    for (const p of products) {
      const r = await this.pricing.resolve(tx, pctx, p.id, null, '1', today);
      Object.assign(p, { price: px(r.unitPrice), tax_rate_percent: r.taxRatePercent });
    }
    const categories = await tx.query('SELECT id, code, name FROM product_categories ORDER BY name');
    const methods = (await this.ctx.paymentMethods(tx)).filter((m) => m.allow_offline).map((m) => ({ id: m.id, code: m.code, name: m.name, kind: m.kind }));
    const shift = await this.ctx.openShift(tx, reg.id);
    await tx.query('UPDATE pos_devices SET last_seen_at = now() WHERE id = $1', [device.id]);
    return {
      snapshotAt: new Date().toISOString(),
      currency: pctx.currency,
      register: { id: reg.id, code: reg.code, name: reg.name, branch_name: reg.branch_name, hardware: reg.hardware },
      shift: shift ? { id: shift.id, number: shift.number, cashier_id: shift.cashier_id } : null,
      settings: { pricesIncludeTax: settings.pricesIncludeTax, cashierMaxDiscountPercent: settings.cashierMaxDiscountPercent, receipt: settings.receipt },
      company: await tx.one(
        `SELECT COALESCE(s.company_display_name, t.legal_name, t.name) AS display_name, t.vat_tin
           FROM tenants t LEFT JOIN tenant_theme_settings s ON s.tenant_id = t.id WHERE t.id = current_tenant_id()`,
      ),
      methods,
      categories,
      products,
    };
  }

  /** Replays a batch of offline sales, one transaction each. */
  async push(user: TenantUser, deviceHeader: string | undefined, input: SyncInput) {
    const device = await this.db.withTenant(user.tenantId, user.userId, (tx) => this.devices.authenticate(tx, deviceHeader));
    const results: { idempotencyKey: string; status: Status; saleId?: string; saleNumber?: string; reviewReasons?: unknown; error?: { code: string; message: string } }[] = [];
    for (const e of input.events) {
      results.push(await this.one(user, device, e));
    }
    await this.db.withTenant(user.tenantId, user.userId, (tx) => tx.query('UPDATE pos_devices SET last_sync_at = now(), last_seen_at = now() WHERE id = $1', [device.id]));
    return { deviceId: device.id, results };
  }

  private async one(user: TenantUser, device: PosDevice, e: SyncInput['events'][number]) {
    const hash = sha256(canonical(e));
    const prior = await this.db.withTenant(user.tenantId, user.userId, (tx) =>
      tx.maybeOne('SELECT payload_hash, status, result FROM pos_sync_events WHERE idempotency_key = $1', [e.idempotencyKey]),
    );
    if (prior) {
      if (prior.payload_hash === hash) return { idempotencyKey: e.idempotencyKey, ...prior.result, replayed: true };
      return { idempotencyKey: e.idempotencyKey, status: 'CONFLICT' as Status, error: { code: 'IDEMPOTENCY_CONFLICT', message: 'This event id was already used for a different sale' } };
    }
    try {
      return await this.db.withTenant(user.tenantId, user.userId, async (tx) => {
        this.check(user, device, e);
        const at = new Date(e.clientCreatedAt);
        const d = await tx.one<{ license_expires_at: string | null; created_at: string }>('SELECT license_expires_at, created_at FROM pos_devices WHERE id = $1', [device.id]);
        // A sale must fall inside the time the device was licensed to sell offline.
        if (!d.license_expires_at || at > new Date(d.license_expires_at) || at < new Date(d.created_at)) {
          throw new DomainError('OUTSIDE_OFFLINE_LICENSE', 'The sale was made when this device had no valid offline licence', 422);
        }
        const r = await this.sales.checkout(tx, user, e.sale, { deviceId: device.id, clientCreatedAt: at, deviceTotal: e.deviceTotal });
        const reasons = r.sale.review_reasons ?? [];
        const result = {
          status: (r.sale.review_status === 'NEEDS_REVIEW' ? 'ACCEPTED_WITH_CHANGES' : 'ACCEPTED') as Status,
          saleId: r.sale.id,
          saleNumber: r.sale.number,
          grandTotal: r.sale.grand_total,
          reviewReasons: reasons,
        };
        await this.record(tx, user, device, e, hash, result.status, result, r.sale.id);
        return { idempotencyKey: e.idempotencyKey, ...result };
      });
    } catch (err) {
      const de = err instanceof DomainError ? err : null;
      if (!de) throw err;
      const result = { status: 'REJECTED' as Status, error: { code: de.code, message: de.message } };
      await this.db.withTenant(user.tenantId, user.userId, (tx) => this.record(tx, user, device, e, hash, 'REJECTED', result, null));
      return { idempotencyKey: e.idempotencyKey, ...result };
    }
  }

  private check(user: TenantUser, device: PosDevice, e: SyncInput['events'][number]) {
    if (e.userId !== user.userId) throw forbidden('Offline sales are uploaded by the cashier who made them');
    if (e.sale.registerId !== device.register_id) throw new DomainError('REGISTER_MISMATCH', 'The sale is for another register than this device', 422);
    const at = new Date(e.clientCreatedAt).getTime();
    if (at > Date.now() + 5 * 60_000) throw new DomainError('CLOCK_AHEAD', 'The sale time is in the future; check the computer clock', 422);
  }

  private async record(tx: Tx, user: TenantUser, device: PosDevice, e: SyncInput['events'][number], hash: string, status: Status, result: unknown, saleId: string | null) {
    await tx.query(
      `INSERT INTO pos_sync_events (tenant_id, device_id, user_id, idempotency_key, event_type, payload, payload_hash, client_created_at,
          catalog_snapshot_at, status, result, resulting_sale_id)
       VALUES (current_tenant_id(), $1, $2, $3, 'SALE', $4, $5, $6, $7, $8, $9, $10)`,
      [device.id, user.userId, e.idempotencyKey, JSON.stringify(e), hash, e.clientCreatedAt, e.catalogSnapshotAt ?? null, status, JSON.stringify(result), saleId],
    );
  }

  async events(tx: Tx, q: { deviceId?: string; status?: string; limit: number }) {
    return tx.query(
      `SELECT e.id, e.idempotency_key, e.status, e.client_created_at, e.received_at, e.result, e.resulting_sale_id,
              s.number AS sale_number, d.name AS device_name, u.full_name AS cashier_name
         FROM pos_sync_events e JOIN pos_devices d ON d.id = e.device_id JOIN users u ON u.id = e.user_id
         LEFT JOIN pos_sales s ON s.id = e.resulting_sale_id
        WHERE ($1::uuid IS NULL OR e.device_id = $1) AND ($2::text IS NULL OR e.status = $2)
        ORDER BY e.received_at DESC LIMIT $3`,
      [q.deviceId ?? null, q.status ?? null, q.limit],
    );
  }
}
