import { Injectable } from '@nestjs/common';
import { currencyScale, Decimal, P } from '@ckh/shared';
import { existsSync } from 'fs';
import PDFDocument from 'pdfkit';
import { z } from 'zod';
import { has, TenantUser } from '../common/auth-context';
import { AuditService } from '../common/audit.service';
import { DomainError, notFound } from '../common/errors';
import type { Tx } from '../db/database.service';
import { PosContextService } from './pos-context.service';
import { PosApproval } from './pos-schemas';
import { PosReturnsService } from './pos-returns.service';
import { PosSalesService } from './pos-sales.service';

export const ReceiptLang = z.enum(['en', 'km', 'zh']);
export type ReceiptLang = z.infer<typeof ReceiptLang>;
export const ReceiptPaper = z.enum(['58', '80', 'A4']);
export const ReceiptFormat = z.enum(['json', 'html', 'text', 'pdf']);
export const ReceiptQuery = z.object({
  language: ReceiptLang.optional(),
  paper: ReceiptPaper.optional(),
  format: ReceiptFormat.default('html'),
});
export const PrintInput = ReceiptQuery.extend({ approval: PosApproval.optional() });

/**
 * Receipt wording. Khmer and Chinese labels are a starting point: have a
 * native speaker check them (and any tax-invoice wording the GDT requires)
 * before printing customer receipts.
 */
const LABELS: Record<string, Record<ReceiptLang, string>> = {
  receipt: { en: 'Receipt', km: 'បង្កាន់ដៃ', zh: '收据' },
  refund: { en: 'Refund', km: 'ការសងប្រាក់វិញ', zh: '退款单' },
  reprint: { en: 'REPRINT', km: 'ច្បាប់ចម្លង', zh: '补打' },
  number: { en: 'No.', km: 'លេខ', zh: '单号' },
  sale: { en: 'Original sale', km: 'ការលក់ដើម', zh: '原销售单' },
  date: { en: 'Date', km: 'កាលបរិច្ឆេទ', zh: '日期' },
  cashier: { en: 'Cashier', km: 'អ្នកគិតលុយ', zh: '收银员' },
  register: { en: 'Register', km: 'បញ្ជរ', zh: '收银台' },
  customer: { en: 'Customer', km: 'អតិថិជន', zh: '顾客' },
  walkIn: { en: 'Walk-in customer', km: 'អតិថិជនទូទៅ', zh: '散客' },
  vatTin: { en: 'VAT TIN', km: 'លេខ VATTIN', zh: '增值税号' },
  item: { en: 'Item', km: 'មុខទំនិញ', zh: '商品' },
  qty: { en: 'Qty', km: 'ចំនួន', zh: '数量' },
  price: { en: 'Price', km: 'តម្លៃ', zh: '单价' },
  amount: { en: 'Amount', km: 'ទឹកប្រាក់', zh: '金额' },
  discount: { en: 'Discount', km: 'បញ្ចុះតម្លៃ', zh: '折扣' },
  subtotal: { en: 'Subtotal', km: 'សរុបរង', zh: '小计' },
  vat: { en: 'VAT', km: 'អាករលើតម្លៃបន្ថែម', zh: '增值税' },
  inclVat: { en: 'Prices include VAT', km: 'តម្លៃរួមបញ្ចូលអាករ', zh: '价格含增值税' },
  total: { en: 'Total', km: 'សរុប', zh: '合计' },
  paid: { en: 'Paid', km: 'បានបង់', zh: '已付' },
  tendered: { en: 'Received', km: 'ប្រាក់ទទួល', zh: '实收' },
  change: { en: 'Change', km: 'ប្រាក់អាប់', zh: '找零' },
  refunded: { en: 'Refunded', km: 'បានសងវិញ', zh: '已退款' },
  pending: { en: 'awaiting verification', km: 'កំពុងរង់ចាំការផ្ទៀងផ្ទាត់', zh: '待核实' },
  reason: { en: 'Reason', km: 'មូលហេតុ', zh: '原因' },
  serial: { en: 'S/N', km: 'លេខស៊េរី', zh: '序列号' },
  thanks: { en: 'Thank you!', km: 'សូមអរគុណ!', zh: '谢谢惠顾！' },
};

export interface ReceiptModel {
  kind: 'SALE' | 'REFUND';
  reprint: boolean;
  paper: '58' | '80' | 'A4';
  languages: ReceiptLang[];
  currency: string;
  company: { name: string; logoUrl: string | null; vatTin: string | null; branch: string; address: string | null; phone: string | null };
  header: string | null;
  footer: string | null;
  number: string;
  saleNumber: string | null;
  date: string;
  cashier: string;
  register: string;
  customer: { name: string; vatTin: string | null } | null;
  reason: string | null;
  lines: { description: string; sku: string; quantity: string; unitPrice: string; discount: string; total: string; serials: string[] }[];
  totals: { subtotal: string; discount: string; taxes: { rate: string; amount: string }[]; tax: string; total: string; pricesIncludeTax: boolean };
  payments: { method: string; amount: string; reference: string | null; pending: boolean }[];
  tendered: string | null;
  change: string | null;
  labels: Record<keyof typeof LABELS, string>;
}

const esc = (s: unknown) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/**
 * Receipts for POS sales and refunds in 58 mm, 80 mm and A4, in English,
 * Khmer and Chinese (one or two languages per receipt), as structured data,
 * HTML (browser and Windows printing), plain text (ESC/POS printers, Latin
 * script only) and PDF. Every print is logged; a second print of the same
 * receipt is a reprint and needs reprint permission or a supervisor PIN.
 */
@Injectable()
export class PosReceiptsService {
  constructor(
    private readonly ctx: PosContextService,
    private readonly sales: PosSalesService,
    private readonly returns: PosReturnsService,
    private readonly audit: AuditService,
  ) {}

  private async company(tx: Tx) {
    return tx.one(
      `SELECT t.name, t.legal_name, t.vat_tin, s.logo_url, COALESCE(s.company_display_name, t.legal_name, t.name) AS display_name
         FROM tenants t LEFT JOIN tenant_theme_settings s ON s.tenant_id = t.id WHERE t.id = current_tenant_id()`,
    );
  }

  private languages(settings: any, requested?: ReceiptLang): ReceiptLang[] {
    const configured = ((settings.receipt?.languages as ReceiptLang[]) ?? ['en']).filter((l) => ['en', 'km', 'zh'].includes(l));
    if (!requested) return configured.length ? configured.slice(0, 2) : ['en'];
    return [requested, ...configured.filter((l) => l !== requested)].slice(0, 2);
  }

  private labels(langs: ReceiptLang[]) {
    return Object.fromEntries(Object.entries(LABELS).map(([k, v]) => [k, [...new Set(langs.map((l) => v[l]))].join(' / ')])) as ReceiptModel['labels'];
  }

  private when(tx: Tx, at: Date | string) {
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: tx.timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
    }).format(new Date(at));
  }

  async saleModel(tx: Tx, user: TenantUser, saleId: string, q: { language?: ReceiptLang; paper?: '58' | '80' | 'A4' }, reprint: boolean): Promise<ReceiptModel> {
    const s = await this.receiptSale(tx, user, saleId);
    const settings = await this.ctx.settings(tx);
    const reg = await tx.one('SELECT hardware FROM pos_registers WHERE id = $1', [s.register_id]);
    const langs = this.languages(settings, q.language);
    const c = await this.company(tx);
    const r = settings.receipt ?? {};
    const taxes = new Map<string, Decimal>();
    for (const l of s.lines) taxes.set(l.tax_rate_percent, (taxes.get(l.tax_rate_percent) ?? new Decimal(0)).plus(l.tax_amount));
    return {
      kind: 'SALE',
      reprint,
      paper: q.paper ?? reg.hardware?.receiptPaper ?? r.paper ?? '80',
      languages: langs,
      currency: s.currency,
      company: {
        name: c.display_name, logoUrl: r.showLogo === false ? null : c.logo_url, vatTin: r.showTaxId === false ? null : c.vat_tin,
        branch: s.branch_name, address: s.branch_address, phone: s.branch_phone,
      },
      header: langs.map((l) => r.header?.[l]).filter(Boolean).join('\n') || null,
      footer: langs.map((l) => r.footer?.[l]).filter(Boolean).join('\n') || this.labels(langs).thanks,
      number: s.number,
      saleNumber: null,
      date: this.when(tx, s.sold_at),
      cashier: s.cashier_name,
      register: s.register_code,
      customer: s.customer_id && s.customer_id !== settings.walkInCustomerId ? { name: s.customer_name, vatTin: s.customer_vat_tin } : null,
      reason: null,
      lines: s.lines.map((l: any) => ({
        description: l.description, sku: l.sku, quantity: new Decimal(l.quantity).toString(), unitPrice: l.unit_price, discount: l.discount_total,
        total: l.line_total, serials: l.serial_numbers ?? [],
      })),
      totals: {
        subtotal: s.subtotal, discount: s.discount_total, tax: s.tax_total, total: s.grand_total, pricesIncludeTax: s.prices_include_tax,
        taxes: [...taxes].filter(([, v]) => !v.isZero()).map(([rate, amount]) => ({ rate: new Decimal(rate).toString(), amount: amount.toFixed(2) })),
      },
      payments: s.payments.filter((p: any) => p.status !== 'REJECTED').map((p: any) => ({
        method: p.method_name, amount: p.amount, reference: p.reference, pending: p.status === 'PENDING_VERIFICATION',
      })),
      tendered: s.amount_tendered,
      change: s.change_due,
      labels: this.labels(langs),
    };
  }

  async returnModel(tx: Tx, user: TenantUser, returnId: string, q: { language?: ReceiptLang; paper?: '58' | '80' | 'A4' }, reprint: boolean): Promise<ReceiptModel> {
    const r = await this.returns.details(tx, user, returnId);
    const settings = await this.ctx.settings(tx);
    const reg = await tx.one('SELECT hardware FROM pos_registers WHERE id = $1', [r.register_id]);
    const langs = this.languages(settings, q.language);
    const c = await this.company(tx);
    const rs = settings.receipt ?? {};
    return {
      kind: 'REFUND',
      reprint,
      paper: q.paper ?? reg.hardware?.receiptPaper ?? rs.paper ?? '80',
      languages: langs,
      currency: r.currency,
      company: {
        name: c.display_name, logoUrl: rs.showLogo === false ? null : c.logo_url, vatTin: rs.showTaxId === false ? null : c.vat_tin,
        branch: r.branch_name, address: r.branch_address, phone: r.branch_phone,
      },
      header: langs.map((l) => rs.header?.[l]).filter(Boolean).join('\n') || null,
      footer: langs.map((l) => rs.footer?.[l]).filter(Boolean).join('\n') || null,
      number: r.number,
      saleNumber: r.sale_number,
      date: this.when(tx, r.created_at),
      cashier: r.processed_by_name,
      register: r.register_code,
      customer: r.customer_id && r.customer_id !== settings.walkInCustomerId ? { name: r.customer_name, vatTin: null } : null,
      reason: r.reason,
      lines: r.lines.map((l: any) => ({
        description: l.description, sku: l.sku, quantity: new Decimal(l.quantity).toString(), unitPrice: l.unit_price,
        discount: l.discount_ex_tax, total: l.refund_amount, serials: l.serial_numbers ?? [],
      })),
      totals: {
        subtotal: r.gross_ex_tax, discount: r.discount_ex_tax, tax: r.tax_total, total: r.refund_total, pricesIncludeTax: false, taxes: [],
      },
      payments: r.refunds.map((p: any) => ({ method: p.method_name, amount: p.amount, reference: p.reference, pending: false })),
      tendered: null,
      change: null,
      labels: this.labels(langs),
    };
  }

  /** A sale for its receipt: the cashier's own, or any in the branch for staff who may reprint or refund. */
  private async receiptSale(tx: Tx, user: TenantUser, saleId: string) {
    const s = await tx.maybeOne<{ branch_id: string; cashier_id: string }>('SELECT branch_id, cashier_id FROM pos_sales WHERE id = $1', [saleId]);
    if (!s) throw notFound('Sale');
    await this.ctx.assertBranch(tx, user, s.branch_id);
    const wide = has(user, P.POS_SALES_VIEW_ALL) || has(user, P.POS_RECEIPT_REPRINT) || has(user, P.POS_REFUNDS_CREATE);
    if (!wide && s.cashier_id !== user.userId) throw notFound('Sale');
    return this.sales.details(tx, user, saleId, { skipScope: true });
  }

  /**
   * Records a print and returns the rendered receipt. The first print of a
   * sale is the original; later ones are reprints (marked on the slip).
   */
  async print(
    tx: Tx,
    user: TenantUser,
    target: { saleId?: string; returnId?: string },
    i: z.infer<typeof PrintInput>,
  ): Promise<{ model: ReceiptModel; body: string | Buffer; contentType: string; copyNo: number }> {
    const branch = target.saleId
      ? await tx.maybeOne<{ branch_id: string }>('SELECT branch_id FROM pos_sales WHERE id = $1', [target.saleId])
      : await tx.maybeOne<{ branch_id: string }>('SELECT branch_id FROM pos_returns WHERE id = $1', [target.returnId]);
    if (!branch) throw notFound(target.saleId ? 'Sale' : 'Return');
    // One print at a time per document, so two terminals cannot both print the "original".
    await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))', [`pos-receipt:${target.saleId ?? target.returnId}`]);
    const prior = await tx.one<{ n: number }>(
      `SELECT count(*)::int AS n FROM pos_receipts WHERE ${target.saleId ? 'sale_id' : 'return_id'} = $1`,
      [target.saleId ?? target.returnId],
    );
    const reprint = prior.n > 0;
    let approverId: string | null = null;
    if (reprint) approverId = await this.ctx.authorise(tx, user, [P.POS_RECEIPT_REPRINT], i.approval, branch.branch_id, 'a receipt reprint');
    const model = target.saleId ? await this.saleModel(tx, user, target.saleId, i, reprint) : await this.returnModel(tx, user, target.returnId!, i, reprint);
    const rendered = await this.render(model, i.format);
    await tx.query(
      `INSERT INTO pos_receipts (tenant_id, sale_id, return_id, kind, copy_no, paper, language, format, printed_by)
       VALUES (current_tenant_id(), $1, $2, $3, $4, $5, $6, $7, $8)`,
      [target.saleId ?? null, target.returnId ?? null, model.kind === 'REFUND' ? 'REFUND' : reprint ? 'REPRINT' : 'ORIGINAL', prior.n + 1, model.paper,
        model.languages[0], i.format, user.userId],
    );
    if (reprint) {
      await this.audit.record(tx, {
        action: 'POS_RECEIPT_REPRINTED',
        entityType: target.saleId ? 'pos_sale' : 'pos_return',
        entityId: target.saleId ?? target.returnId!,
        after: { copyNo: prior.n + 1, approvedBy: approverId },
      });
    }
    return { model, ...rendered, copyNo: prior.n + 1 };
  }

  async render(m: ReceiptModel, format: z.infer<typeof ReceiptFormat>): Promise<{ body: string | Buffer; contentType: string }> {
    if (format === 'json') return { body: JSON.stringify(m), contentType: 'application/json; charset=utf-8' };
    if (format === 'text') return { body: this.text(m), contentType: 'text/plain; charset=utf-8' };
    if (format === 'pdf') return { body: await this.pdf(m), contentType: 'application/pdf' };
    return { body: this.html(m), contentType: 'text/html; charset=utf-8' };
  }

  private money(m: ReceiptModel, v: string | null) {
    if (v === null) return '';
    return new Decimal(v).toFixed(currencyScale(m.currency));
  }

  /** Fixed-width text for ESC/POS printers: 32 columns on 58 mm, 48 on 80 mm. Latin script only (thermal fonts have no Khmer/Chinese). */
  text(m: ReceiptModel): string {
    if (m.languages.some((l) => l !== 'en')) {
      throw new DomainError('TEXT_RECEIPT_LATIN_ONLY', 'Plain-text receipts are English only; print Khmer or Chinese receipts as HTML or PDF', 422);
    }
    const w = m.paper === '58' ? 32 : 48;
    const L = m.labels;
    const out: string[] = [];
    const center = (s: string) => (s.length >= w ? s.slice(0, w) : ' '.repeat(Math.floor((w - s.length) / 2)) + s);
    const pair = (a: string, b: string) => {
      const room = w - b.length - 1;
      return a.length > room ? `${a.slice(0, w)}\n${' '.repeat(Math.max(0, w - b.length))}${b}` : a + ' '.repeat(w - a.length - b.length) + b;
    };
    const rule = '-'.repeat(w);
    out.push(center(m.company.name));
    if (m.company.branch) out.push(center(m.company.branch));
    for (const x of [m.company.address, m.company.phone]) if (x) out.push(center(x));
    if (m.company.vatTin) out.push(center(`${L.vatTin}: ${m.company.vatTin}`));
    if (m.header) out.push(...m.header.split('\n').map(center));
    out.push(rule, center(m.kind === 'REFUND' ? L.refund.toUpperCase() : L.receipt.toUpperCase()));
    if (m.reprint) out.push(center(`*** ${L.reprint} ***`));
    out.push(pair(L.number, m.number));
    if (m.saleNumber) out.push(pair(L.sale, m.saleNumber));
    out.push(pair(L.date, m.date), pair(L.cashier, m.cashier), pair(L.register, m.register));
    if (m.customer) {
      out.push(pair(L.customer, m.customer.name));
      if (m.customer.vatTin) out.push(pair(L.vatTin, m.customer.vatTin));
    }
    out.push(rule);
    for (const l of m.lines) {
      out.push(l.description.slice(0, w));
      out.push(pair(`  ${l.quantity} x ${this.money(m, l.unitPrice)}`, this.money(m, l.total)));
      if (Number(l.discount) > 0) out.push(pair(`  ${L.discount}`, `-${this.money(m, l.discount)}`));
      if (l.serials.length) out.push(`  ${L.serial} ${l.serials.join(', ')}`.slice(0, w));
    }
    out.push(rule);
    out.push(pair(L.subtotal, this.money(m, m.totals.subtotal)));
    if (Number(m.totals.discount) > 0) out.push(pair(L.discount, `-${this.money(m, m.totals.discount)}`));
    if (m.totals.taxes.length > 1) for (const t of m.totals.taxes) out.push(pair(`${L.vat} ${t.rate}%`, this.money(m, t.amount)));
    else out.push(pair(m.totals.taxes[0] ? `${L.vat} ${m.totals.taxes[0].rate}%` : L.vat, this.money(m, m.totals.tax)));
    out.push(pair(`${m.kind === 'REFUND' ? L.refunded : L.total} ${m.currency}`, this.money(m, m.totals.total)));
    if (m.totals.pricesIncludeTax) out.push(L.inclVat);
    out.push(rule);
    for (const p of m.payments) {
      out.push(pair(p.method + (p.pending ? ` (${L.pending})` : ''), this.money(m, p.amount)));
      if (p.reference) out.push(`  ${p.reference}`.slice(0, w));
    }
    if (m.tendered !== null && Number(m.change) > 0) out.push(pair(L.tendered, this.money(m, m.tendered)), pair(L.change, this.money(m, m.change)));
    if (m.reason) out.push(`${L.reason}: ${m.reason}`.slice(0, w * 2));
    if (m.footer) out.push('', ...m.footer.split('\n').map(center));
    return `${out.join('\n')}\n`;
  }

  html(m: ReceiptModel): string {
    const L = m.labels;
    const roll = m.paper !== 'A4';
    const width = m.paper === '58' ? '48mm' : m.paper === '80' ? '72mm' : '180mm';
    const row = (a: string, b: string, cls = '') => `<tr class="${cls}"><td>${a}</td><td class="r">${b}</td></tr>`;
    const lines = m.lines
      .map(
        (l) =>
          `<tr><td colspan="2">${esc(l.description)}${l.serials.length ? `<div class="s">${esc(L.serial)} ${esc(l.serials.join(', '))}</div>` : ''}</td></tr>` +
          row(`<span class="s">${esc(l.quantity)} × ${esc(this.money(m, l.unitPrice))}${Number(l.discount) > 0 ? ` (−${esc(this.money(m, l.discount))})` : ''}</span>`, esc(this.money(m, l.total))),
      )
      .join('');
    const a4Lines = m.lines
      .map(
        (l, i) =>
          `<tr><td>${i + 1}</td><td>${esc(l.description)}<div class="s">${esc(l.sku)}${l.serials.length ? ` · ${esc(L.serial)} ${esc(l.serials.join(', '))}` : ''}</div></td>
           <td class="r">${esc(l.quantity)}</td><td class="r">${esc(this.money(m, l.unitPrice))}</td><td class="r">${Number(l.discount) > 0 ? esc(this.money(m, l.discount)) : ''}</td><td class="r">${esc(this.money(m, l.total))}</td></tr>`,
      )
      .join('');
    const taxes = m.totals.taxes.length
      ? m.totals.taxes.map((t) => row(`${esc(L.vat)} ${esc(t.rate)}%`, esc(this.money(m, t.amount)))).join('')
      : row(esc(L.vat), esc(this.money(m, m.totals.tax)));
    return `<!doctype html>
<html lang="${m.languages[0]}"><head><meta charset="utf-8"><title>${esc(m.number)}</title>
<style>
@page { size: ${roll ? `${m.paper}mm auto` : 'A4'}; margin: ${roll ? '2mm' : '15mm'}; }
* { box-sizing: border-box; }
body { margin: 0; font-family: 'Noto Sans Khmer', 'Khmer OS', 'Noto Sans SC', 'Microsoft YaHei', 'Segoe UI', Arial, sans-serif; color: #000; font-size: ${m.paper === '58' ? '11px' : '12px'}; }
.rc { width: ${width}; margin: 0 auto; }
.c { text-align: center; } .r { text-align: right; white-space: nowrap; } .s { font-size: .85em; color: #333; }
h1 { font-size: 1.25em; margin: 2px 0; } h2 { font-size: 1.1em; margin: 6px 0 2px; letter-spacing: .05em; }
table { width: 100%; border-collapse: collapse; } td, th { padding: 1px 0; vertical-align: top; }
.rule { border-top: 1px dashed #000; margin: 4px 0; }
.big td { font-size: 1.3em; font-weight: 700; padding-top: 3px; }
.reprint { border: 1px solid #000; padding: 2px; margin: 4px 0; font-weight: 700; }
img.logo { max-width: 60%; max-height: 60px; }
${roll ? '' : 'th { text-align: left; border-bottom: 1px solid #000; } .a4 td { border-bottom: 1px solid #ddd; padding: 4px 2px; }'}
</style></head><body><div class="rc">
<div class="c">
${m.company.logoUrl ? `<img class="logo" src="${esc(m.company.logoUrl)}" alt="">` : ''}
<h1>${esc(m.company.name)}</h1>
<div>${esc(m.company.branch)}</div>
${m.company.address ? `<div class="s">${esc(m.company.address)}</div>` : ''}
${m.company.phone ? `<div class="s">${esc(m.company.phone)}</div>` : ''}
${m.company.vatTin ? `<div class="s">${esc(L.vatTin)}: ${esc(m.company.vatTin)}</div>` : ''}
${m.header ? `<div class="s">${esc(m.header).replace(/\n/g, '<br>')}</div>` : ''}
<h2>${esc(m.kind === 'REFUND' ? L.refund : L.receipt)}</h2>
${m.reprint ? `<div class="reprint">${esc(L.reprint)}</div>` : ''}
</div>
<table>
${row(esc(L.number), esc(m.number))}
${m.saleNumber ? row(esc(L.sale), esc(m.saleNumber)) : ''}
${row(esc(L.date), esc(m.date))}
${row(esc(L.cashier), esc(m.cashier))}
${row(esc(L.register), esc(m.register))}
${row(esc(L.customer), esc(m.customer?.name ?? L.walkIn))}
${m.customer?.vatTin ? row(esc(L.vatTin), esc(m.customer.vatTin)) : ''}
</table>
<div class="rule"></div>
${roll ? `<table>${lines}</table>` : `<table class="a4"><thead><tr><th>#</th><th>${esc(L.item)}</th><th class="r">${esc(L.qty)}</th><th class="r">${esc(L.price)}</th><th class="r">${esc(L.discount)}</th><th class="r">${esc(L.amount)}</th></tr></thead><tbody>${a4Lines}</tbody></table>`}
<div class="rule"></div>
<table>
${row(esc(L.subtotal), esc(this.money(m, m.totals.subtotal)))}
${Number(m.totals.discount) > 0 ? row(esc(L.discount), `−${esc(this.money(m, m.totals.discount))}`) : ''}
${taxes}
${row(`${esc(m.kind === 'REFUND' ? L.refunded : L.total)} ${esc(m.currency)}`, esc(this.money(m, m.totals.total)), 'big')}
</table>
${m.totals.pricesIncludeTax ? `<div class="s">${esc(L.inclVat)}</div>` : ''}
<div class="rule"></div>
<table>
${m.payments.map((p) => row(`${esc(p.method)}${p.pending ? ` <span class="s">(${esc(L.pending)})</span>` : ''}${p.reference ? `<div class="s">${esc(p.reference)}</div>` : ''}`, esc(this.money(m, p.amount)))).join('')}
${m.tendered !== null && Number(m.change) > 0 ? row(esc(L.tendered), esc(this.money(m, m.tendered))) + row(esc(L.change), esc(this.money(m, m.change))) : ''}
</table>
${m.reason ? `<div class="s">${esc(L.reason)}: ${esc(m.reason)}</div>` : ''}
${m.footer ? `<div class="rule"></div><div class="c">${esc(m.footer).replace(/\n/g, '<br>')}</div>` : ''}
</div></body></html>`;
  }

  /**
   * PDF receipt. English uses the built-in Helvetica. Khmer and Chinese need a
   * font that covers them: set RECEIPT_FONT_KM / RECEIPT_FONT_ZH to a .ttf/.otf
   * file on the server (e.g. Noto Sans Khmer, Noto Sans SC); without it the
   * PDF is refused rather than printed with missing characters.
   */
  async pdf(m: ReceiptModel): Promise<Buffer> {
    const fonts: Record<string, string | undefined> = { km: process.env.RECEIPT_FONT_KM, zh: process.env.RECEIPT_FONT_ZH };
    const needed = m.languages.filter((l) => l !== 'en');
    for (const l of needed) {
      if (!fonts[l] || !existsSync(fonts[l]!)) {
        throw new DomainError('PDF_FONT_MISSING', `No ${l === 'km' ? 'Khmer' : 'Chinese'} font is installed for PDF receipts; print as HTML or set RECEIPT_FONT_${l.toUpperCase()}`, 422);
      }
    }
    const roll = m.paper !== 'A4';
    const mm = 72 / 25.4;
    const width = m.paper === '58' ? 58 * mm : m.paper === '80' ? 80 * mm : 595.28;
    const margin = roll ? 3 * mm : 42;
    const lineCount = 20 + m.lines.length * 3 + m.payments.length * 2 + (m.header?.split('\n').length ?? 0) + (m.footer?.split('\n').length ?? 0);
    const size: [number, number] = roll ? [width, Math.max(200, lineCount * 13 + 40)] : [595.28, 841.89];
    const doc = new PDFDocument({ size, margin, info: { Title: m.number } });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    const done = new Promise<Buffer>((res) => doc.on('end', () => res(Buffer.concat(chunks))));
    const font = needed[0] ? fonts[needed[0]]! : 'Helvetica';
    doc.font(font);
    const fs = m.paper === '58' ? 7 : roll ? 8 : 10;
    const inner = width - margin * 2;
    const L = m.labels;
    const center = (t: string, s = fs) => doc.fontSize(s).text(t, { width: inner, align: 'center' });
    const pair = (a: string, b: string, s = fs) => {
      const y = doc.y;
      doc.fontSize(s).text(a, margin, y, { width: inner * 0.62 });
      const y2 = doc.y;
      doc.text(b, margin, y, { width: inner, align: 'right' });
      doc.y = Math.max(y2, doc.y);
    };
    const rule = () => {
      doc.moveDown(0.2);
      doc.moveTo(margin, doc.y).lineTo(width - margin, doc.y).dash(2, { space: 2 }).stroke().undash();
      doc.moveDown(0.3);
    };
    center(m.company.name, fs + 3);
    center(m.company.branch);
    for (const x of [m.company.address, m.company.phone]) if (x) center(x);
    if (m.company.vatTin) center(`${L.vatTin}: ${m.company.vatTin}`);
    if (m.header) center(m.header);
    doc.moveDown(0.3);
    center(m.kind === 'REFUND' ? L.refund : L.receipt, fs + 2);
    if (m.reprint) center(`*** ${L.reprint} ***`);
    pair(L.number, m.number);
    if (m.saleNumber) pair(L.sale, m.saleNumber);
    pair(L.date, m.date);
    pair(L.cashier, m.cashier);
    pair(L.register, m.register);
    pair(L.customer, m.customer?.name ?? L.walkIn);
    if (m.customer?.vatTin) pair(L.vatTin, m.customer.vatTin);
    rule();
    for (const l of m.lines) {
      doc.fontSize(fs).text(l.description, margin, doc.y, { width: inner });
      pair(`  ${l.quantity} x ${this.money(m, l.unitPrice)}${Number(l.discount) > 0 ? ` (-${this.money(m, l.discount)})` : ''}`, this.money(m, l.total));
      if (l.serials.length) doc.fontSize(fs - 1).text(`  ${L.serial} ${l.serials.join(', ')}`, margin, doc.y, { width: inner });
    }
    rule();
    pair(L.subtotal, this.money(m, m.totals.subtotal));
    if (Number(m.totals.discount) > 0) pair(L.discount, `-${this.money(m, m.totals.discount)}`);
    if (m.totals.taxes.length) for (const t of m.totals.taxes) pair(`${L.vat} ${t.rate}%`, this.money(m, t.amount));
    else pair(L.vat, this.money(m, m.totals.tax));
    pair(`${m.kind === 'REFUND' ? L.refunded : L.total} ${m.currency}`, this.money(m, m.totals.total), fs + 3);
    if (m.totals.pricesIncludeTax) doc.fontSize(fs - 1).text(L.inclVat, margin, doc.y, { width: inner });
    rule();
    for (const p of m.payments) pair(`${p.method}${p.pending ? ` (${L.pending})` : ''}${p.reference ? ` ${p.reference}` : ''}`, this.money(m, p.amount));
    if (m.tendered !== null && Number(m.change) > 0) {
      pair(L.tendered, this.money(m, m.tendered));
      pair(L.change, this.money(m, m.change));
    }
    if (m.reason) doc.fontSize(fs).text(`${L.reason}: ${m.reason}`, margin, doc.y, { width: inner });
    if (m.footer) {
      rule();
      center(m.footer);
    }
    doc.end();
    return done;
  }
}
