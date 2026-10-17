import { HttpStatus, Injectable } from '@nestjs/common';
import {
  Decimal,
  looksLikeCardNumber,
  P,
  PermissionCode,
  PosPricedCart,
  pricePosCart,
  settlePayments,
} from '@ckh/shared';
import { has, TenantUser } from '../common/auth-context';
import { AuditService } from '../common/audit.service';
import { businessDate } from '../common/business-time';
import { conflict, DomainError, forbidden, notFound } from '../common/errors';
import type { Tx } from '../db/database.service';
import { JournalLineInput, JournalService } from '../accounting/journal.service';
import { NumberingService } from '../core/numbering.service';
import { StockService } from '../inventory/stock.service';
import { CustomerPricingContext, PricingService } from '../sales/pricing.service';
import { PosCatalogService } from './pos-catalog.service';
import { PosContextService, PosPaymentMethod, PosRegister, PosSettings } from './pos-context.service';
import { canonical, CheckoutInput, PosCartInput, SalesQuery, sha256 } from './pos-schemas';

const D = (v: Decimal.Value) => new Decimal(v);

interface ResolvedLine {
  productId: string;
  sku: string;
  name: string;
  variantAttributes: unknown;
  trackInventory: boolean;
  serialTracked: boolean;
  quantity: string;
  unitPrice: string;
  listUnitPrice: string;
  priceSource: 'PRICE_LIST' | 'PROMOTION' | 'LIST_PRICE' | 'OVERRIDE' | 'OFFLINE';
  taxCodeId: string | null;
  taxRatePercent: string;
  serialNumbers: string[];
}

export interface PricedSale {
  register: PosRegister;
  settings: PosSettings;
  customerId: string | null;
  pricing: CustomerPricingContext;
  lines: ResolvedLine[];
  cart: PosPricedCart;
  needs: PermissionCode[];
  reviewReasons: { code: string; message: string }[];
}

/** Details of an offline sale replayed from a Windows POS (see PosSyncService). */
export interface OfflineContext {
  deviceId: string;
  clientCreatedAt: Date;
  /** Total the device charged; compared with the server's arithmetic. */
  deviceTotal?: string;
}

/**
 * POS checkout. One call = one database transaction: price on the server,
 * check discount and price authority, settle the tenders, lock and deduct
 * stock, record the cash drawer movement, post one balanced journal entry and
 * write the audit log. Nothing is half-done: any failure rolls back all of it.
 *
 * Idempotent on clientSaleId: a retry returns the stored sale; the same id
 * with a different payload is refused.
 */
@Injectable()
export class PosSalesService {
  constructor(
    private readonly ctx: PosContextService,
    private readonly catalog: PosCatalogService,
    private readonly pricing: PricingService,
    private readonly stock: StockService,
    private readonly journal: JournalService,
    private readonly numbering: NumberingService,
    private readonly audit: AuditService,
  ) {}

  /** Server-priced cart for the till (no writes). */
  async quote(tx: Tx, user: TenantUser, input: PosCartInput) {
    const priced = await this.price(tx, user, input);
    const stock = await this.availability(tx, priced);
    const missing = priced.needs.filter((p) => !has(user, p));
    return {
      currency: priced.cart.currency,
      pricesIncludeTax: priced.cart.pricesIncludeTax,
      customerId: priced.customerId,
      lines: priced.lines.map((l, i) => ({ ...l, ...priced.cart.lines[i], available: stock.get(l.productId)?.toString() ?? null })),
      totals: this.totals(priced.cart),
      approvalRequired: missing,
      stockShortfalls: this.shortfalls(priced, stock),
    };
  }

  /** Looks up every price itself and prices the cart with the shared POS arithmetic. */
  async price(tx: Tx, user: TenantUser, input: PosCartInput, offline?: OfflineContext): Promise<PricedSale> {
    const register = await this.ctx.register(tx, user, input.registerId);
    const settings = await this.ctx.settings(tx);
    const customerId = input.customerId ?? settings.walkInCustomerId ?? null;
    const pricing = await this.catalog.pricingContext(tx, customerId);
    const on = offline ? businessDate(tx.timezone, offline.clientCreatedAt) : tx.today();
    const needs = new Set<PermissionCode>();
    const reviewReasons: PricedSale['reviewReasons'] = [];

    const lines: ResolvedLine[] = [];
    for (const [i, l] of input.lines.entries()) {
      const p = await tx.maybeOne<{
        id: string; sku: string; name: string; variant_attributes: unknown; track_inventory: boolean; product_type: string;
        serial_tracked: boolean; has_variants: boolean;
      }>(
        `SELECT p.id, p.sku, p.name, p.variant_attributes, p.track_inventory, p.product_type, p.serial_tracked,
                EXISTS (SELECT 1 FROM products v WHERE v.parent_product_id = p.id AND v.status = 'ACTIVE') AS has_variants
           FROM products p WHERE p.id = $1`,
        [l.productId],
      );
      if (!p) throw new DomainError('PRODUCT_NOT_FOUND', `Line ${i + 1}: product not found`, 422);
      if (p.has_variants) throw new DomainError('VARIANT_REQUIRED', `Line ${i + 1}: choose a size/colour of ${p.name}`, 422, { productId: p.id });
      const resolved = await this.pricing.resolve(tx, pricing, l.productId, null, l.quantity, on);
      let unitPrice = resolved.unitPrice;
      let source: ResolvedLine['priceSource'] = resolved.priceSource;
      if (l.unitPrice !== undefined && !D(l.unitPrice).eq(resolved.unitPrice)) {
        if (D(l.unitPrice).lt(0)) throw new DomainError('PRICING_INVALID', `Line ${i + 1}: price cannot be negative`, 422);
        unitPrice = D(l.unitPrice).toString();
        if (offline) {
          source = 'OFFLINE';
          reviewReasons.push({ code: 'PRICE_VARIANCE', message: `${p.sku}: sold at ${unitPrice}, server price ${resolved.unitPrice}` });
        } else {
          source = 'OVERRIDE';
          needs.add(P.POS_PRICE_OVERRIDE);
        }
      }
      if (p.serial_tracked) {
        const q = D(l.quantity);
        if (!q.isInteger()) throw new DomainError('SERIALS_REQUIRED', `Line ${i + 1}: ${p.name} is sold in whole units`, 422);
        if (l.serialNumbers.length !== q.toNumber()) {
          throw new DomainError('SERIALS_REQUIRED', `Line ${i + 1}: enter ${q.toString()} serial number(s) for ${p.name}`, 422, { productId: p.id });
        }
      } else if (l.serialNumbers.length) {
        throw new DomainError('SERIALS_NOT_TRACKED', `Line ${i + 1}: ${p.name} does not use serial numbers`, 422);
      }
      lines.push({
        productId: p.id,
        sku: p.sku,
        name: resolved.productName,
        variantAttributes: p.variant_attributes,
        trackInventory: p.track_inventory && p.product_type === 'STOCK',
        serialTracked: p.serial_tracked,
        quantity: D(l.quantity).toString(),
        unitPrice,
        listUnitPrice: resolved.unitPrice,
        priceSource: source,
        taxCodeId: resolved.taxCodeId,
        taxRatePercent: resolved.taxRatePercent,
        serialNumbers: l.serialNumbers,
      });
    }
    const allSerials = lines.flatMap((l) => l.serialNumbers.map((s) => `${l.productId}:${s.toLowerCase()}`));
    if (new Set(allSerials).size !== allSerials.length) throw new DomainError('SERIAL_DUPLICATE', 'The same serial number is entered twice', 422);
    if (allSerials.length && !offline) {
      // Caught here so the till shows it while the cart is built; checkout re-checks under the unique index.
      const sold = await tx.maybeOne<{ serial_no: string; name: string }>(
        `SELECT s.serial_no, p.name FROM pos_sold_serials s JOIN products p ON p.id = s.product_id
          WHERE NOT s.returned AND (s.product_id::text || ':' || lower(s.serial_no)) = ANY($1::text[]) LIMIT 1`,
        [allSerials],
      );
      if (sold) throw conflict('SERIAL_ALREADY_SOLD', `Serial ${sold.serial_no} of ${sold.name} is already sold`);
    }

    const cart = pricePosCart({
      currency: pricing.currency,
      pricesIncludeTax: settings.pricesIncludeTax,
      orderDiscountPercent: input.orderDiscountPercent,
      orderDiscountAmount: input.orderDiscountAmount,
      lines: input.lines.map((l, i) => ({
        quantity: lines[i].quantity,
        unitPrice: lines[i].unitPrice,
        discountPercent: l.discountPercent,
        discountAmount: l.discountAmount,
        taxRatePercent: lines[i].taxRatePercent,
      })),
    });

    if (D(cart.discountTotal).gt(0)) needs.add(P.POS_DISCOUNT_APPLY);
    if (D(cart.maxDiscountPercent).gt(settings.cashierMaxDiscountPercent)) needs.add(P.POS_DISCOUNT_OVERRIDE);
    if (D(cart.maxDiscountPercent).gt(settings.overrideMaxDiscountPercent)) {
      if (!offline) {
        throw new DomainError('DISCOUNT_ABOVE_LIMIT', `Discounts above ${settings.overrideMaxDiscountPercent}% are not allowed`, 422, {
          maxDiscountPercent: cart.maxDiscountPercent,
        });
      }
      reviewReasons.push({ code: 'DISCOUNT_ABOVE_LIMIT', message: `Discount ${cart.maxDiscountPercent}% is above the ${settings.overrideMaxDiscountPercent}% limit` });
    }
    return { register, settings, customerId, pricing, lines, cart, needs: [...needs], reviewReasons };
  }

  async checkout(tx: Tx, user: TenantUser, input: CheckoutInput, offline?: OfflineContext) {
    // Serialise retries of the same checkout, then answer them from the stored sale.
    await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))', [`pos-sale:${tx.tenantId}:${input.clientSaleId}`]);
    const { approval: _approval, ...hashed } = input;
    const payloadHash = sha256(canonical(hashed));
    const existing = await tx.maybeOne<{ id: string; payload_hash: string }>('SELECT id, payload_hash FROM pos_sales WHERE client_sale_id = $1', [
      input.clientSaleId,
    ]);
    if (existing) {
      if (existing.payload_hash !== payloadHash) {
        throw conflict('IDEMPOTENCY_CONFLICT', 'This sale id was already used for a different sale');
      }
      return { sale: await this.details(tx, user, existing.id, { skipScope: true }), replayed: true, warnings: [] };
    }

    const priced = await this.price(tx, user, input, offline);
    const { register: reg, settings, cart } = priced;
    const reviewReasons = [...priced.reviewReasons];

    // Shift: the register's open shift, run by this cashier (or covered by a supervisor).
    const shift = await this.ctx.openShift(tx, reg.id, true);
    if (!shift && settings.requireOpenShift && !offline) {
      throw conflict('SHIFT_NOT_OPEN', `Open a shift on ${reg.name} before selling`);
    }
    if (shift && shift.cashier_id !== user.userId && !has(user, P.POS_SHIFT_APPROVE)) {
      if (!offline) throw forbidden('The open shift on this register belongs to another cashier');
      reviewReasons.push({ code: 'OTHER_CASHIER_SHIFT', message: 'Sold offline during another cashier’s shift' });
    }
    if (!shift && offline) reviewReasons.push({ code: 'NO_OPEN_SHIFT', message: 'The shift was closed before this offline sale arrived; its cash is not in the count' });

    // Discount / price authority.
    let approverId: string | null = null;
    if (offline) {
      const missing = priced.needs.filter((p) => !has(user, p));
      if (missing.length) reviewReasons.push({ code: 'UNAPPROVED_OFFLINE', message: `Needed approval not available offline: ${missing.join(', ')}` });
    } else {
      approverId = await this.ctx.authorise(tx, user, priced.needs, input.approval, reg.branch_id, 'this discount or price change');
    }

    if (input.expectedTotal !== undefined && !D(input.expectedTotal).eq(cart.grandTotal)) {
      throw conflict('TOTAL_CHANGED', `The total is now ${cart.grandTotal} ${cart.currency}; please review the sale`, { grandTotal: cart.grandTotal });
    }
    if (offline?.deviceTotal !== undefined && !D(offline.deviceTotal).eq(cart.grandTotal)) {
      reviewReasons.push({ code: 'TOTAL_VARIANCE', message: `Device charged ${offline.deviceTotal}, server total ${cart.grandTotal}` });
    }

    // Tenders.
    const methods = new Map((await this.ctx.paymentMethods(tx)).map((m) => [m.id, m]));
    const tenders = input.payments.map((p, i) => {
      const m = methods.get(p.methodId);
      if (!m) throw new DomainError('PAYMENT_METHOD_INVALID', `Payment ${i + 1}: payment method is not available`, 422);
      if (offline && !m.allow_offline) throw new DomainError('OFFLINE_PAYMENT_NOT_ALLOWED', `${m.name} cannot be taken offline`, 422);
      if (m.requires_reference && !p.reference) throw new DomainError('REFERENCE_REQUIRED', `${m.name}: enter the reference`, 422);
      if (p.reference && looksLikeCardNumber(p.reference)) {
        throw new DomainError('CARD_NUMBER_NOT_ALLOWED', 'Do not enter card numbers. Enter the terminal approval code instead.', 422);
      }
      return { input: p, method: m };
    });
    const settlement = settlePayments(cart.grandTotal, tenders.map((t) => ({ kind: t.method.kind, amount: t.input.amount })), cart.currency);

    // Stock: lock rows in product order, then check what is available.
    const available = await this.availability(tx, priced, true);
    const shortfalls = this.shortfalls(priced, available);
    if (shortfalls.length) {
      if (offline) reviewReasons.push({ code: 'STOCK_SHORTFALL', message: shortfalls.map((s) => `${s.sku}: sold ${s.quantity}, had ${s.available}`).join('; ') });
      else if (!settings.allowNegativeStock) {
        throw conflict('INSUFFICIENT_STOCK', `Not enough stock: ${shortfalls.map((s) => `${s.name} (${s.available} left)`).join(', ')}`, { shortfalls });
      }
    }

    const soldAt = offline?.clientCreatedAt ?? new Date();
    const day = offline ? businessDate(tx.timezone, offline.clientCreatedAt) : tx.today();
    const number = await this.numbering.next(tx, 'POS_SALE', soldAt);
    const pendingPayments = tenders.some((t) => t.method.requires_verification);
    const sale = await tx.one<{ id: string }>(
      `INSERT INTO pos_sales (tenant_id, number, client_sale_id, payload_hash, register_id, shift_id, branch_id, warehouse_id, cashier_id,
          customer_id, device_id, business_date, sold_at, payment_status, currency, prices_include_tax, subtotal, line_discount_total,
          order_discount_total, discount_total, net_total, tax_total, grand_total, amount_tendered, change_due, discount_approved_by,
          notes, is_offline, client_created_at, review_status, review_reasons)
       VALUES (current_tenant_id(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22,
               $23, $24, $25, $26, $27, $28, $29, $30)
       RETURNING id`,
      [
        number, input.clientSaleId, payloadHash, reg.id, shift?.id ?? null, reg.branch_id, reg.warehouse_id, user.userId,
        priced.customerId, offline?.deviceId ?? null, day, soldAt.toISOString(), pendingPayments ? 'PENDING_VERIFICATION' : 'PAID',
        cart.currency, cart.pricesIncludeTax, cart.subtotal, cart.lineDiscountTotal, cart.orderDiscountTotal, cart.discountTotal,
        cart.netTotal, cart.taxTotal, cart.grandTotal, settlement.totalTendered, settlement.changeDue, approverId, input.notes ?? null,
        !!offline, offline?.clientCreatedAt.toISOString() ?? null, reviewReasons.length ? 'NEEDS_REVIEW' : 'NONE',
        reviewReasons.length ? JSON.stringify(reviewReasons) : null,
      ],
    );

    // Lines, stock and serials.
    let costTotal = new Decimal(0);
    for (const [i, l] of priced.lines.entries()) {
      const c = cart.lines[i];
      let unitCost = new Decimal(0);
      if (l.trackInventory) {
        unitCost = await this.stock.issueDirect(tx, {
          warehouseId: reg.warehouse_id, productId: l.productId, qtyBase: D(l.quantity), referenceType: 'POS_SALE', referenceId: sale.id, userId: user.userId,
          notes: number,
        });
        costTotal = costTotal.plus(D(l.quantity).mul(unitCost).toDecimalPlaces(2));
      }
      const line = await tx.one<{ id: string }>(
        `INSERT INTO pos_sale_lines (tenant_id, sale_id, line_no, product_id, sku, description, variant_attributes, quantity, unit_price,
            list_unit_price, price_source, gross_amount, line_discount, order_discount_share, discount_total, gross_ex_tax, discount_ex_tax,
            net_amount, tax_code_id, tax_rate_percent, tax_amount, line_total, unit_cost, track_inventory, serial_numbers)
         VALUES (current_tenant_id(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24)
         RETURNING id`,
        [
          sale.id, i + 1, l.productId, l.sku, l.name, l.variantAttributes ? JSON.stringify(l.variantAttributes) : null, l.quantity, l.unitPrice,
          l.listUnitPrice, l.priceSource, c.gross, c.lineDiscount, c.orderDiscountShare, c.discountTotal, c.grossExTax, c.discountExTax, c.net,
          l.taxCodeId, l.taxRatePercent, c.tax, c.total, unitCost.toString(), l.trackInventory, l.serialNumbers,
        ],
      );
      for (const s of l.serialNumbers) {
        const ok = await tx.maybeOne(
          `INSERT INTO pos_sold_serials (tenant_id, product_id, serial_no, sale_line_id) VALUES (current_tenant_id(), $1, $2, $3)
           ON CONFLICT DO NOTHING RETURNING 1`,
          [l.productId, s, line.id],
        );
        if (!ok) {
          if (!offline) throw conflict('SERIAL_ALREADY_SOLD', `Serial ${s} of ${l.name} is already sold`);
          reviewReasons.push({ code: 'SERIAL_ALREADY_SOLD', message: `Serial ${s} of ${l.sku} was already sold` });
        }
      }
    }

    // Payments.
    const settings_ = settings;
    const accounts = await this.journal.accounts(tx);
    const payRows: { method: PosPaymentMethod; applied: string; pending: boolean; accountId: string }[] = [];
    for (const [i, t] of tenders.entries()) {
      const s = settlement.payments[i];
      const accountId = t.method.account_id ?? (t.method.kind === 'CASH' ? settings_.cashAccountId ?? accounts.cash : accounts.bank);
      const pending = t.method.requires_verification;
      await tx.query(
        `INSERT INTO pos_sale_payments (tenant_id, sale_id, method_id, kind, amount_tendered, amount, reference, provider_transaction_id, status, account_id, line_no)
         VALUES (current_tenant_id(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [sale.id, t.method.id, t.method.kind, s.tendered, s.applied, t.input.reference ?? null, t.input.providerTransactionId ?? null,
          pending ? 'PENDING_VERIFICATION' : 'CONFIRMED', accountId, i + 1],
      );
      payRows.push({ method: t.method, applied: s.applied, pending, accountId });
    }

    // Cash drawer.
    const cashIn = payRows.filter((p) => p.method.kind === 'CASH').reduce((a, p) => a.plus(p.applied), new Decimal(0));
    if (shift && cashIn.gt(0)) {
      await tx.query(
        `INSERT INTO pos_cash_movements (tenant_id, shift_id, movement_type, amount, reference_type, reference_id, created_by)
         VALUES (current_tenant_id(), $1, 'SALE', $2, 'POS_SALE', $3, $4)`,
        [shift.id, cashIn.toFixed(2), sale.id, user.userId],
      );
    }

    // Ledger: one balanced entry for payments, revenue, discounts, VAT and cost of goods.
    const sum = (k: 'grossExTax' | 'discountExTax' | 'tax') => cart.lines.reduce((a, l) => a.plus(l[k]), new Decimal(0));
    const jl: JournalLineInput[] = [];
    for (const p of payRows) {
      jl.push({
        accountId: p.pending ? (settings_.pendingPaymentAccountId as string) : p.accountId,
        debit: p.applied,
        customerId: null,
        description: `${p.method.name}${p.pending ? ' (pending verification)' : ''}`,
      });
    }
    jl.push({ accountId: accounts.salesDiscount, debit: sum('discountExTax'), description: 'Discounts' });
    jl.push({ accountId: accounts.revenue, credit: sum('grossExTax'), description: 'Sales revenue' });
    jl.push({ accountId: accounts.vatOutput, credit: sum('tax'), description: 'VAT output' });
    jl.push({ accountId: accounts.cogs, debit: costTotal, description: 'Cost of goods sold' });
    jl.push({ accountId: accounts.inventory, credit: costTotal, description: 'Inventory' });
    const journalId = await this.journal.post(tx, { date: day, description: `POS sale ${number}`, sourceType: 'POS_SALE', sourceId: sale.id, lines: jl });
    await tx.query(
      `UPDATE pos_sales SET journal_entry_id = $2, cost_total = $3, review_status = $4, review_reasons = $5 WHERE id = $1`,
      [sale.id, journalId, costTotal.toFixed(2), reviewReasons.length ? 'NEEDS_REVIEW' : 'NONE', reviewReasons.length ? JSON.stringify(reviewReasons) : null],
    );
    await tx.query('UPDATE pos_sale_payments SET journal_entry_id = $2 WHERE sale_id = $1', [sale.id, journalId]);

    await this.audit.record(tx, {
      action: offline ? 'POS_OFFLINE_SALE_RECORDED' : 'POS_SALE_COMPLETED',
      entityType: 'pos_sale',
      entityId: sale.id,
      after: {
        number, register: reg.code, shift: shift?.number ?? null, grandTotal: cart.grandTotal, discountTotal: cart.discountTotal,
        payments: payRows.map((p) => ({ method: p.method.code, amount: p.applied, pending: p.pending })), approvedBy: approverId,
        review: reviewReasons.length ? reviewReasons : undefined,
      },
    });

    const warnings = await this.lowStock(tx, reg.warehouse_id, priced.lines.filter((l) => l.trackInventory).map((l) => l.productId));
    return { sale: await this.details(tx, user, sale.id, { skipScope: true }), replayed: false, warnings };
  }

  /** On hand − reserved per stock-tracked product in the register's warehouse (rows locked when `lock`). */
  private async availability(tx: Tx, priced: PricedSale, lock = false): Promise<Map<string, Decimal>> {
    const ids = [...new Set(priced.lines.filter((l) => l.trackInventory).map((l) => l.productId))];
    if (!ids.length) return new Map();
    if (lock) {
      const m = await this.stock.lock(tx, priced.register.warehouse_id, ids);
      return new Map([...m].map(([k, v]) => [k, v.available]));
    }
    const rows = await tx.query<{ product_id: string; available: string }>(
      `SELECT product_id, GREATEST(qty_on_hand - qty_reserved, 0) AS available FROM stock_levels WHERE warehouse_id = $1 AND product_id = ANY($2::uuid[])`,
      [priced.register.warehouse_id, ids],
    );
    const out = new Map(ids.map((id) => [id, new Decimal(0)]));
    for (const r of rows) out.set(r.product_id, D(r.available));
    return out;
  }

  private shortfalls(priced: PricedSale, available: Map<string, Decimal>) {
    const need = new Map<string, Decimal>();
    for (const l of priced.lines) if (l.trackInventory) need.set(l.productId, (need.get(l.productId) ?? new Decimal(0)).plus(l.quantity));
    const out: { productId: string; sku: string; name: string; quantity: string; available: string }[] = [];
    for (const [pid, q] of need) {
      const a = available.get(pid) ?? new Decimal(0);
      if (a.lt(q)) {
        const l = priced.lines.find((x) => x.productId === pid)!;
        out.push({ productId: pid, sku: l.sku, name: l.name, quantity: q.toString(), available: a.toString() });
      }
    }
    return out;
  }

  private async lowStock(tx: Tx, warehouseId: string, productIds: string[]) {
    if (!productIds.length) return [];
    const rows = await tx.query<{ id: string; sku: string; name: string; qty_on_hand: string; reorder_point: string }>(
      `SELECT p.id, p.sku, p.name, s.qty_on_hand, p.reorder_point FROM products p JOIN stock_levels s ON s.product_id = p.id AND s.warehouse_id = $1
        WHERE p.id = ANY($2::uuid[]) AND p.reorder_point IS NOT NULL AND s.qty_on_hand <= p.reorder_point`,
      [warehouseId, productIds],
    );
    return rows.map((r) => ({ code: 'LOW_STOCK', productId: r.id, message: `${r.name} (${r.sku}) is low: ${D(r.qty_on_hand).toString()} left` }));
  }

  totals(cart: PosPricedCart) {
    const { lines: _l, ...t } = cart;
    return t;
  }

  /** SQL predicate limiting `s` (pos_sales) to what the user may see. */
  async scope(tx: Tx, user: TenantUser, startIndex: number): Promise<[string, unknown[]]> {
    const branches = await this.ctx.branchIds(tx, user);
    const parts: string[] = [];
    const params: unknown[] = [];
    if (!has(user, P.POS_SALES_VIEW_ALL)) {
      params.push(user.userId);
      parts.push(`s.cashier_id = $${startIndex + params.length - 1}`);
    }
    if (branches) {
      params.push(branches);
      parts.push(`s.branch_id = ANY($${startIndex + params.length - 1}::uuid[])`);
    }
    return [parts.length ? parts.join(' AND ') : 'TRUE', params];
  }

  async details(tx: Tx, user: TenantUser, id: string, opts: { skipScope?: boolean } = {}) {
    const [pred, params] = opts.skipScope ? ['TRUE', []] : await this.scope(tx, user, 2);
    const s = await tx.maybeOne(
      `SELECT s.*, r.code AS register_code, r.name AS register_name, b.name AS branch_name, b.address AS branch_address, b.phone AS branch_phone,
              u.full_name AS cashier_name, c.code AS customer_code, c.name AS customer_name, c.phone AS customer_phone, c.vat_tin AS customer_vat_tin,
              a.full_name AS discount_approved_by_name, sh.number AS shift_number, je.number AS journal_number
         FROM pos_sales s
         JOIN pos_registers r ON r.id = s.register_id
         JOIN branches b ON b.id = s.branch_id
         JOIN users u ON u.id = s.cashier_id
         LEFT JOIN customers c ON c.id = s.customer_id
         LEFT JOIN users a ON a.id = s.discount_approved_by
         LEFT JOIN pos_shifts sh ON sh.id = s.shift_id
         LEFT JOIN journal_entries je ON je.id = s.journal_entry_id
        WHERE s.id = $1 AND ${pred}`,
      [id, ...params],
    );
    if (!s) throw notFound('Sale');
    s.lines = await tx.query('SELECT * FROM pos_sale_lines WHERE sale_id = $1 ORDER BY line_no', [id]);
    s.payments = await tx.query(
      `SELECT p.id, p.method_id, m.code AS method_code, m.name AS method_name, p.kind, p.amount_tendered, p.amount, p.reference,
              p.provider_transaction_id, p.status, p.verified_at, v.full_name AS verified_by_name, p.verification_notes,
              p.is_settlement, p.received_by, rb.full_name AS received_by_name, p.created_at
         FROM pos_sale_payments p JOIN pos_payment_methods m ON m.id = p.method_id LEFT JOIN users v ON v.id = p.verified_by
         LEFT JOIN users rb ON rb.id = p.received_by
        WHERE p.sale_id = $1 ORDER BY p.line_no`,
      [id],
    );
    s.returns = await tx.query(
      `SELECT r.id, r.number, r.business_date, r.reason, r.refund_total, r.created_at, u.full_name AS processed_by_name
         FROM pos_returns r JOIN users u ON u.id = r.processed_by WHERE r.sale_id = $1 ORDER BY r.created_at`,
      [id],
    );
    s.receipts = await tx.query(
      `SELECT pr.kind, pr.copy_no, pr.paper, pr.language, pr.format, pr.printed_at, u.full_name AS printed_by_name
         FROM pos_receipts pr JOIN users u ON u.id = pr.printed_by WHERE pr.sale_id = $1 ORDER BY pr.printed_at`,
      [id],
    );
    if (!has(user, P.POS_REPORTS_VIEW)) {
      delete s.cost_total;
      for (const l of s.lines) delete l.unit_cost;
    }
    return s;
  }

  async list(tx: Tx, user: TenantUser, q: SalesQuery) {
    const [pred, params] = await this.scope(tx, user, 1);
    const where = [pred];
    const add = (sql: string, v: unknown) => {
      params.push(v);
      where.push(sql.replace('?', `$${params.length}`));
    };
    if (q.from) add('s.business_date >= ?', q.from);
    if (q.to) add('s.business_date <= ?', q.to);
    if (q.registerId) add('s.register_id = ?', q.registerId);
    if (q.branchId) add('s.branch_id = ?', q.branchId);
    if (q.cashierId) add('s.cashier_id = ?', q.cashierId);
    if (q.shiftId) add('s.shift_id = ?', q.shiftId);
    if (q.customerId) add('s.customer_id = ?', q.customerId);
    if (q.status) add('s.status = ?', q.status);
    if (q.paymentStatus) add('s.payment_status = ?', q.paymentStatus);
    if (q.reviewStatus) add('s.review_status = ?', q.reviewStatus);
    if (q.q) add(`(s.number ILIKE ? OR c.name ILIKE $${params.length + 1} OR c.phone ILIKE $${params.length + 1})`, `%${q.q}%`);
    params.push(q.limit, q.offset);
    return tx.query(
      `SELECT s.id, s.number, s.business_date, s.sold_at, s.status, s.payment_status, s.review_status, s.currency, s.grand_total,
              s.refunded_total, s.discount_total, s.is_offline, r.code AS register_code, u.full_name AS cashier_name, c.name AS customer_name,
              (SELECT count(*)::int FROM pos_sale_lines l WHERE l.sale_id = s.id) AS line_count,
              (SELECT string_agg(DISTINCT m.name, ', ') FROM pos_sale_payments p JOIN pos_payment_methods m ON m.id = p.method_id WHERE p.sale_id = s.id) AS payment_methods,
              count(*) OVER () AS total_count
         FROM pos_sales s
         JOIN pos_registers r ON r.id = s.register_id
         JOIN users u ON u.id = s.cashier_id
         LEFT JOIN customers c ON c.id = s.customer_id
        WHERE ${where.join(' AND ')}
        ORDER BY s.sold_at DESC, s.number DESC
        LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );
  }
}
