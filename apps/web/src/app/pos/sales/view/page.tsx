'use client';
import { P } from '@ckh/shared';
import { PosShell, usePos } from '@/components/PosShell';
import { Card, ErrorBox, Loading, Page, Status } from '@/components/ui';
import { dateTime, human, money, num } from '@/lib/format';
import { useApi, useQueryParam } from '@/lib/hooks';

export default function SaleDetailsPage() {
  return (
    <PosShell needRegister={false}>
      <SaleDetails />
    </PosShell>
  );
}

function SaleDetails() {
  const id = useQueryParam('id');
  const { can } = usePos();
  const { data: s, error, loading } = useApi(id ? `/pos/sales/${id}` : null);
  if (error) return <ErrorBox error={error} />;
  if (loading || !s) return <Loading />;
  const cur = s.currency;
  const returnable = s.lines.some((l: any) => Number(l.quantity_returned) < Number(l.quantity));
  return (
    <Page
      title={`Sale ${s.number}`}
      subtitle={`${dateTime(s.sold_at)} · ${s.register_name} · ${s.cashier_name}`}
      actions={
        <>
          <a className="btn" href={`/pos/sales/view/receipt/?id=${s.id}`}>Receipt</a>
          {can(P.POS_REFUNDS_CREATE) && returnable && <a className="btn" href={`/pos/returns/new/?saleId=${s.id}`}>Return items</a>}
        </>
      }
    >
      <div className="row">
        <Status s={s.status} />
        <Status s={s.payment_status} />
        {s.is_offline && <span className="badge info">Recorded offline</span>}
        {s.review_status === 'NEEDS_REVIEW' && <span className="badge warn">Needs review</span>}
      </div>
      {s.review_reasons?.length > 0 && (
        <div className="notice warn small">{s.review_reasons.map((r: any) => r.message).join(' · ')}</div>
      )}
      <div className="grid-2">
        <Card title="Customer">
          <div>{s.customer_name ?? 'Walk-in customer'}</div>
          {s.customer_phone && <div className="small muted">{s.customer_phone}</div>}
          {s.customer_vat_tin && <div className="small muted">VAT TIN {s.customer_vat_tin}</div>}
        </Card>
        <Card title="Totals">
          <div className="kv">
            <span>Subtotal</span><span>{money(s.subtotal, cur)}</span>
            <span>Discounts</span><span>−{money(s.discount_total, cur)}</span>
            <span>Tax{s.prices_include_tax ? ' (included)' : ''}</span><span>{money(s.tax_total, cur)}</span>
            <b>Total</b><b>{money(s.grand_total, cur)}</b>
            <span>Tendered</span><span>{money(s.amount_tendered, cur)}</span>
            <span>Change</span><span>{money(s.change_due, cur)}</span>
            {Number(s.refunded_total) > 0 && <><span>Refunded</span><span>−{money(s.refunded_total, cur)}</span></>}
            {s.cost_total !== undefined && <><span className="muted">Cost of goods</span><span className="muted">{money(s.cost_total, cur)}</span></>}
          </div>
          {s.discount_approved_by_name && <div className="small muted" style={{ marginTop: 6 }}>Discount approved by {s.discount_approved_by_name}</div>}
          {s.journal_number && <div className="small muted">Journal {s.journal_number}</div>}
        </Card>
      </div>
      <div className="table-wrap">
        <table>
          <thead><tr><th>#</th><th>Item</th><th className="num">Qty</th><th className="num">Price</th><th className="num">Discount</th><th className="num">Tax</th><th className="num">Total</th><th className="num">Returned</th></tr></thead>
          <tbody>
            {s.lines.map((l: any) => (
              <tr key={l.id}>
                <td>{l.line_no}</td>
                <td>
                  {l.description}
                  <div className="small muted">{l.sku}{l.price_source === 'OVERRIDE' ? ' · price changed' : ''}{l.serial_numbers?.length ? ` · S/N ${l.serial_numbers.join(', ')}` : ''}</div>
                </td>
                <td className="num">{num(l.quantity, 4)}</td>
                <td className="num">{money(l.unit_price, cur)}</td>
                <td className="num">{money(l.discount_total, cur)}</td>
                <td className="num">{money(l.tax_amount, cur)}</td>
                <td className="num">{money(l.line_total, cur)}</td>
                <td className="num">{Number(l.quantity_returned) > 0 ? num(l.quantity_returned, 4) : ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Card title="Payments">
        <table>
          <tbody>
            {s.payments.map((p: any) => (
              <tr key={p.id}>
                <td>{p.method_name}{p.reference && <div className="small muted">Ref {p.reference}</div>}</td>
                <td className="num">{money(p.amount, cur)}{p.amount_tendered !== p.amount && <div className="small muted">tendered {money(p.amount_tendered, cur)}</div>}</td>
                <td><Status s={p.status} />{p.verified_by_name && <div className="small muted">by {p.verified_by_name} {dateTime(p.verified_at)}</div>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
      {s.returns.length > 0 && (
        <Card title="Returns">
          <ul className="list">
            {s.returns.map((r: any) => (
              <li key={r.id}>
                <a href={`/pos/returns/view/?id=${r.id}`}>{r.number}</a> · {money(r.refund_total, cur)} · {r.reason} <span className="small muted">({r.processed_by_name}, {dateTime(r.created_at)})</span>
              </li>
            ))}
          </ul>
        </Card>
      )}
      {s.receipts.length > 0 && (
        <Card title="Receipts printed">
          <ul className="list small">
            {s.receipts.map((r: any, i: number) => (
              <li key={i}>{human(r.kind)} #{r.copy_no} · {r.paper === 'A4' ? 'A4' : `${r.paper} mm`} · {r.language} · {r.printed_by_name} · {dateTime(r.printed_at)}</li>
            ))}
          </ul>
        </Card>
      )}
    </Page>
  );
}
