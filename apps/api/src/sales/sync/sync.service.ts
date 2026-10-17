import { Injectable, Logger } from '@nestjs/common';
import { createHash } from 'crypto';
import { Decimal, MODULES, P, PermissionCode } from '@ckh/shared';
import { z } from 'zod';
import { has, TenantUser } from '../../common/auth-context';
import { AuditService } from '../../common/audit.service';
import { DomainError } from '../../common/errors';
import { isoDate, parse, uuid } from '../../common/validation';
import { DatabaseService, Tx } from '../../db/database.service';
import { SubscriptionService } from '../../core/subscriptions/subscription.service';
import { CatalogService } from '../catalog/catalog.service';
import { CollectionsService } from '../collections/collections.service';
import { CollectionInput } from '../fulfilment.controllers';
import { CreateOrderInput } from '../orders/order.schemas';
import { OrdersService } from '../orders/orders.service';
import { SalesContextService } from '../sales-context.service';
import { CheckInInput, CheckOutInput, VisitInput, VisitNoteInput } from '../field.controllers';
import { VisitsService } from '../visits/visits.service';

export const SyncEvent = z.object({
  /** Generated on the device when the action was taken; a retry reuses it. */
  idempotencyKey: z.string().min(8).max(100),
  entityType: z.enum(['SALES_ORDER', 'COLLECTION', 'VISIT', 'VISIT_NOTE']),
  clientCreatedAt: z.string().datetime({ offset: true }).optional(),
  payload: z.record(z.unknown()),
});
export const SyncBatch = z.object({
  deviceId: z.string().min(1).max(200),
  /** When the device last downloaded the catalogue (prices and stock). */
  catalogSnapshotAt: z.string().datetime({ offset: true }).optional(),
  events: z.array(SyncEvent).min(1).max(100),
});
export type SyncBatch = z.infer<typeof SyncBatch>;
type SyncEvent = z.infer<typeof SyncEvent>;

const OfflineOrder = CreateOrderInput.omit({ source: true }).extend({
  /** The total the device showed the customer; compared with the server total. */
  deviceGrandTotal: z.string().optional(),
  /** False keeps the order as a draft on the server instead of submitting it. */
  submit: z.boolean().default(true),
  /** Idempotency key of a VISIT event in the same or an earlier batch. */
  visitKey: z.string().optional(),
});
/** A whole visit captured offline: schedule, and optionally check-in and check-out. */
const OfflineVisit = VisitInput.extend({
  visitId: uuid.optional(),
  checkIn: CheckInInput.optional(),
  checkOut: CheckOutInput.optional(),
}).partial({ customerId: true, scheduledStart: true });
const OfflineVisitNote = VisitNoteInput.extend({ visitId: uuid.optional(), visitKey: z.string().optional() });

export type SyncStatus = 'ACCEPTED' | 'ACCEPTED_WITH_CHANGES' | 'REJECTED' | 'CONFLICT' | 'RETRY';
export interface SyncResult {
  idempotencyKey: string;
  entityType: SyncEvent['entityType'];
  status: SyncStatus;
  replayed: boolean;
  entityId?: string;
  number?: string;
  changes?: { code: string; message: string }[];
  error?: { code: string; message: string; details?: unknown };
  result?: Record<string, unknown>;
}

const MODULE_FOR: Record<SyncEvent['entityType'], string[]> = {
  SALES_ORDER: [MODULES.SALES_ORDER_MANAGEMENT],
  COLLECTION: [MODULES.SALES_TEAM_BASIC, MODULES.ACCOUNTING],
  VISIT: [MODULES.SALES_TEAM_BASIC],
  VISIT_NOTE: [MODULES.SALES_TEAM_BASIC],
};
const PERMISSION_FOR: Record<SyncEvent['entityType'], PermissionCode> = {
  SALES_ORDER: P.SALES_ORDERS_CREATE,
  COLLECTION: P.SALES_COLLECTIONS_SUBMIT,
  VISIT: P.SALES_VISITS_MANAGE,
  VISIT_NOTE: P.SALES_VISITS_MANAGE,
};

/** Stable JSON so the same payload always hashes the same, whatever the key order. */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v as object).sort().map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(',')}}`;
  }
  return JSON.stringify(v ?? null);
}
const hash = (e: SyncEvent) => createHash('sha256').update(canonical({ t: e.entityType, p: e.payload })).digest('hex');

/**
 * Replays actions a rep took while offline. Nothing from the device is
 * trusted: every event runs through the same services as an online request
 * (permissions, customer access, prices, stock, credit and approval rules),
 * and the subscription and modules are re-checked for each event.
 *
 * Each event is its own transaction, so one bad event never blocks the rest
 * of the outbox. Events are idempotent by key: a retry returns the stored
 * result, and the same key with a different payload is a CONFLICT.
 */
@Injectable()
export class SyncService {
  private readonly log = new Logger(SyncService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly subscriptions: SubscriptionService,
    private readonly ctx: SalesContextService,
    private readonly orders: OrdersService,
    private readonly collections: CollectionsService,
    private readonly visits: VisitsService,
    private readonly catalog: CatalogService,
    private readonly audit: AuditService,
  ) {}

  async push(user: TenantUser, batch: SyncBatch) {
    const results: SyncResult[] = [];
    for (const e of batch.events) {
      try {
        results.push(await this.db.withTenant(user.tenantId, user.userId, (tx) => this.one(tx, user, batch, e)));
      } catch (err) {
        // Unexpected failure: nothing was stored, so the device keeps the event and retries later.
        this.log.error(`sync event ${e.idempotencyKey} failed: ${(err as Error).message}`, (err as Error).stack);
        results.push({ idempotencyKey: e.idempotencyKey, entityType: e.entityType, status: 'RETRY', replayed: false, error: { code: 'TEMPORARY_FAILURE', message: 'Could not process this item now; it will be retried' } });
      }
    }
    const summary = results.reduce<Record<string, number>>((s, r) => ({ ...s, [r.status]: (s[r.status] ?? 0) + 1 }), {});
    return { serverTime: new Date().toISOString(), summary, results };
  }

  private async one(tx: Tx, user: TenantUser, batch: SyncBatch, e: SyncEvent): Promise<SyncResult> {
    const h = hash(e);
    const prior = await tx.maybeOne<{ user_id: string; payload_hash: string; status: SyncStatus; result: SyncResult | null; entity_type: string }>(
      'SELECT user_id, payload_hash, status, result, entity_type FROM sales_offline_sync_events WHERE idempotency_key = $1',
      [e.idempotencyKey],
    );
    if (prior) {
      if (prior.user_id === user.userId && prior.payload_hash === h && prior.result) return { ...prior.result, replayed: true };
      return {
        idempotencyKey: e.idempotencyKey, entityType: e.entityType, status: 'CONFLICT', replayed: false,
        error: { code: 'IDEMPOTENCY_KEY_REUSED', message: 'This key was already used for a different item. Generate a new key on the device.' },
      };
    }

    const ev = await tx.one<{ id: string }>(
      `INSERT INTO sales_offline_sync_events (tenant_id, user_id, device_id, idempotency_key, entity_type, payload, payload_hash, client_created_at, catalog_snapshot_at)
       VALUES (current_tenant_id(), $1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
      [user.userId, batch.deviceId, e.idempotencyKey, e.entityType, JSON.stringify(e.payload), h, e.clientCreatedAt ?? null, batch.catalogSnapshotAt ?? null],
    );

    let res: SyncResult;
    await tx.query('SAVEPOINT sync_event');
    try {
      await this.assertAllowed(tx, user, e);
      res = await this.apply(tx, user, batch, e);
    } catch (err) {
      if (!(err instanceof DomainError)) throw err;
      await tx.query('ROLLBACK TO SAVEPOINT sync_event');
      res = {
        idempotencyKey: e.idempotencyKey, entityType: e.entityType, status: 'REJECTED', replayed: false,
        error: { code: err.code, message: err.message, ...(err.details !== undefined ? { details: err.details } : {}) },
      };
    }
    await tx.query(
      `UPDATE sales_offline_sync_events SET status = $2, result = $3, resulting_entity_id = $4, processed_at = now() WHERE id = $1`,
      [ev.id, res.status, JSON.stringify(res), res.entityId ?? null],
    );
    await this.audit.record(tx, { action: 'OFFLINE_SYNC_EVENT', entityType: 'sales_offline_sync_event', entityId: ev.id, after: { key: e.idempotencyKey, type: e.entityType, status: res.status } });
    return res;
  }

  /** Entitlements and permissions as they are now, not when the device went offline. */
  private async assertAllowed(tx: Tx, user: TenantUser, e: SyncEvent) {
    const ent = await this.subscriptions.entitlementsTx(tx);
    if (!ent.active) throw new DomainError(ent.reason ?? 'SUBSCRIPTION_INACTIVE', 'The company subscription is not active', 402);
    const missing = [MODULES.SALES_OFFLINE_ORDERING, ...MODULE_FOR[e.entityType]].filter((m) => !ent.modules.has(m));
    if (missing.length) throw new DomainError('MODULE_NOT_SUBSCRIBED', `Not included in the subscription: ${missing.join(', ')}`, 402, { modules: missing });
    if (!has(user, PERMISSION_FOR[e.entityType])) throw new DomainError('FORBIDDEN', 'You are not allowed to do this', 403);
  }

  private async apply(tx: Tx, user: TenantUser, batch: SyncBatch, e: SyncEvent): Promise<SyncResult> {
    const base = { idempotencyKey: e.idempotencyKey, entityType: e.entityType, replayed: false };
    switch (e.entityType) {
      case 'SALES_ORDER': {
        const p = parse(OfflineOrder, e.payload);
        const { deviceGrandTotal, submit, visitKey, ...input } = p;
        const visitId = input.visitId ?? (visitKey ? await this.resolveKey(tx, user, visitKey, 'VISIT') : undefined);
        const changes: { code: string; message: string }[] = [];
        if (await this.catalogIsStale(tx, batch.catalogSnapshotAt)) {
          changes.push({ code: 'STALE_CATALOG', message: 'Prices and stock on the device were out of date; the server re-checked them' });
        }
        const { order } = await this.orders.create(
          tx, user,
          { ...input, visitId, source: 'MOBILE', clientReference: input.clientReference ?? `sync:${e.idempotencyKey}` },
          { provisional: true, source: 'OFFLINE_SYNC' },
        );
        if (!submit) return { ...base, status: changes.length ? 'ACCEPTED_WITH_CHANGES' : 'ACCEPTED', entityId: order.id, number: order.number, changes, result: { orderStatus: order.status, grandTotal: order.grand_total } };

        const s = await this.orders.submit(tx, user, order.id, { deviceGrandTotal });
        if (deviceGrandTotal !== undefined && !new Decimal(deviceGrandTotal).eq(s.order.grand_total)) {
          changes.push({ code: 'PRICE_CHANGED', message: `Total changed from ${deviceGrandTotal} on the device to ${s.order.grand_total}` });
        }
        if (s.shortages.length) changes.push({ code: 'BACKORDER', message: 'Some items are short in stock and will be backordered' });
        if (s.requirements.length) changes.push({ code: 'NEEDS_APPROVAL', message: s.requirements.map((r) => r.detail).join('; ') });
        return {
          ...base, status: changes.length ? 'ACCEPTED_WITH_CHANGES' : 'ACCEPTED', entityId: s.order.id, number: s.order.number, changes,
          result: { orderStatus: s.order.status, grandTotal: s.order.grand_total, deviceGrandTotal: deviceGrandTotal ?? null, shortages: s.shortages },
        };
      }
      case 'COLLECTION': {
        const input = parse(CollectionInput, e.payload);
        const { collection } = await this.collections.submit(tx, user, { ...input, clientReference: input.clientReference ?? `sync:${e.idempotencyKey}` }, { viaSync: true });
        return { ...base, status: 'ACCEPTED', entityId: collection.id, number: collection.number, result: { collectionStatus: collection.status, amount: collection.amount } };
      }
      case 'VISIT': {
        const p = parse(OfflineVisit, e.payload);
        let visitId = p.visitId;
        if (!visitId) {
          if (!p.customerId || !p.scheduledStart) throw new DomainError('VALIDATION_FAILED', 'customerId and scheduledStart are required for a new visit', 400);
          visitId = (await this.visits.schedule(tx, user, { customerId: p.customerId, salesRepId: p.salesRepId, scheduledStart: p.scheduledStart, scheduledEnd: p.scheduledEnd, purpose: p.purpose })).id as string;
        }
        if (p.checkIn) await this.visits.checkIn(tx, user, visitId, p.checkIn);
        if (p.checkOut) await this.visits.checkOut(tx, user, visitId, p.checkOut);
        const v = await this.visits.get(tx, user, visitId);
        return { ...base, status: 'ACCEPTED', entityId: visitId, result: { visitStatus: v.status } };
      }
      case 'VISIT_NOTE': {
        const p = parse(OfflineVisitNote, e.payload);
        const visitId = p.visitId ?? (p.visitKey ? await this.resolveKey(tx, user, p.visitKey, 'VISIT') : undefined);
        if (!visitId) throw new DomainError('VALIDATION_FAILED', 'visitId or visitKey is required', 400);
        const { visitId: _v, visitKey: _k, ...note } = p;
        const n = await this.visits.addNote(tx, user, visitId, note);
        return { ...base, status: 'ACCEPTED', entityId: (n as { id: string }).id, result: { visitId } };
      }
    }
  }

  /** Lets a later event refer to an entity an earlier offline event created. */
  private async resolveKey(tx: Tx, user: TenantUser, key: string, type: string): Promise<string> {
    const r = await tx.maybeOne<{ resulting_entity_id: string | null; status: string }>(
      'SELECT resulting_entity_id, status FROM sales_offline_sync_events WHERE idempotency_key = $1 AND user_id = $2 AND entity_type = $3',
      [key, user.userId, type],
    );
    if (!r) throw new DomainError('DEPENDENCY_NOT_SYNCED', `The ${type.toLowerCase()} this item belongs to has not been synced yet`, 409);
    if (!r.resulting_entity_id) throw new DomainError('DEPENDENCY_REJECTED', `The ${type.toLowerCase()} this item belongs to was rejected`, 422);
    return r.resulting_entity_id;
  }

  private async catalogIsStale(tx: Tx, snapshotAt?: string) {
    if (!snapshotAt) return true;
    const { offlineCatalogMaxAgeHours } = await this.ctx.settings(tx);
    return Date.now() - new Date(snapshotAt).getTime() > offlineCatalogMaxAgeHours * 3600_000;
  }

  // ---------------------------------------------------------------------------
  // Download side
  // ---------------------------------------------------------------------------

  /**
   * Everything a rep needs to work offline: their customers (with addresses,
   * price list and, where allowed, balances), the sellable catalogue with
   * available stock per authorised warehouse, active price-list items and
   * tax rates. Prices here are indicative; the server re-prices on sync.
   */
  async bootstrap(tx: Tx, user: TenantUser, q: { since?: string }) {
    const settings = await this.ctx.settings(tx);
    const rep = await this.ctx.repForUser(tx, user.userId);
    const [scope, params] = await this.ctx.customerScope(tx, user, 'c', 1);
    const showBalances = has(user, P.SALES_CUSTOMERS_VIEW_BALANCE) || settings.showBalancesToReps;
    const customers = await tx.query(
      `SELECT c.id, c.code, c.name, c.name_local, c.phone, c.price_list_id, c.customer_group_id, c.payment_terms_days, c.credit_limit,
              c.credit_hold, c.updated_at,
              ${showBalances ? 'b.outstanding, b.overdue' : 'NULL::numeric AS outstanding, NULL::numeric AS overdue'},
              COALESCE((SELECT json_agg(json_build_object('id', a.id, 'type', a.address_type, 'line1', a.line1, 'line2', a.line2,
                         'isDefault', a.is_default, 'latitude', a.latitude, 'longitude', a.longitude) ORDER BY a.is_default DESC)
                  FROM customer_addresses a WHERE a.customer_id = c.id), '[]') AS addresses
         FROM customers c LEFT JOIN customer_balances b ON b.customer_id = c.id
        WHERE c.status = 'ACTIVE' AND ${scope}
        ORDER BY c.name`,
      params,
    );
    const products = await this.catalog.search(tx, user, { limit: 5000, offset: 0 });
    const priceListIds = [...new Set(customers.map((c) => c.price_list_id).filter(Boolean))];
    const def = await tx.maybeOne<{ id: string }>('SELECT id FROM price_lists WHERE is_default AND is_active LIMIT 1');
    if (def) priceListIds.push(def.id);
    const priceItems = await tx.query(
      `SELECT price_list_id, product_id, unit_id, min_quantity, unit_price, valid_from, valid_to FROM price_list_items
        WHERE price_list_id = ANY($1::uuid[]) AND (valid_to IS NULL OR valid_to >= CURRENT_DATE)`,
      [priceListIds],
    );
    const taxCodes = await tx.query('SELECT id, code, name, rate_percent, is_default FROM tax_codes WHERE is_active ORDER BY code');
    const visits = rep
      ? await tx.query(
          `SELECT v.id, v.customer_id, v.scheduled_start, v.scheduled_end, v.purpose, v.status FROM sales_visits v
            WHERE v.sales_rep_id = $1 AND v.status IN ('PLANNED', 'IN_PROGRESS') AND v.scheduled_start < now() + interval '14 days'
            ORDER BY v.scheduled_start`,
          [rep.id],
        )
      : [];
    const snapshotAt = new Date().toISOString();
    return {
      snapshotAt,
      maxAgeHours: settings.offlineCatalogMaxAgeHours,
      staleAfter: new Date(Date.now() + settings.offlineCatalogMaxAgeHours * 3600_000).toISOString(),
      settings: {
        visitLocationCapture: settings.visitLocationCapture,
        allowPriceOverride: settings.allowPriceOverride,
        allowBackorders: settings.allowBackorders,
        showBalancesToReps: settings.showBalancesToReps,
      },
      rep: rep ? { id: rep.id, teamId: rep.team_id, defaultWarehouseId: rep.default_warehouse_id, defaultBranchId: rep.default_branch_id, maxDiscountPercent: rep.max_discount_percent } : null,
      customers,
      products: products.map(({ total_count: _t, ...p }) => p),
      priceLists: priceListIds.map((id) => ({ id, items: priceItems.filter((i) => i.price_list_id === id) })),
      taxCodes,
      visits,
    };
  }

  /** The device's recent sync history, so a rep can see what happened to each queued item. */
  history(tx: Tx, user: TenantUser, q: { deviceId?: string; limit: number }) {
    return tx.query(
      `SELECT idempotency_key, entity_type, status, result, resulting_entity_id, client_created_at, received_at, processed_at, device_id
         FROM sales_offline_sync_events WHERE user_id = $1 AND ($2::text IS NULL OR device_id = $2)
        ORDER BY received_at DESC LIMIT $3`,
      [user.userId, q.deviceId ?? null, q.limit],
    );
  }
}

export const SyncHistoryQuery = z.object({ deviceId: z.string().max(200).optional(), limit: z.coerce.number().int().min(1).max(500).default(100) });
export const BootstrapQuery = z.object({ since: isoDate.optional() });
