'use client';
import { useState } from 'react';
import { P } from '@ckh/shared';
import { SettleSheet, VerifyPaymentSheet } from '@/components/PosPayments';
import { PosShell, Sheet, usePos } from '@/components/PosShell';
import { Card, ErrorBox, Field, Loading, Page, Status } from '@/components/ui';
import { api } from '@/lib/api';
import { dateTime, human, money, num } from '@/lib/format';
import { useAction, useApi, useQueryParam } from '@/lib/hooks';

export default function SaleDetailsPage() {
  return (
    <PosShell needRegister={false}>
      <SaleDetails />
    </PosShell>
  );
}

function SaleDetails() {
  const id = useQueryParam('id');
  const { ctx, can } = usePos();
  const { data: s, error, loading, reload } = useApi(id ? `/pos/sales/${id}` : null);
  const [verify, setVerify] = useState<any>(null);
  const [settle, setSettle] = useState(false);
  const [review, setReview] = useState(false);
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
        <div className="notice warn small">
          {s.review_reasons.map((r: any) => r.message ?? human(r.code)).join(' · ')}
          {s.review_status === 'NEEDS_REVIEW' && can(P.POS_SHIFT_APPROVE) && ctx.user.id !== s.cashier_id && (
            <button className="small" style={{ marginLeft: 8 }} onClick={() => setReview(true)}>Mark reviewed</button>
          )}
          {s.review_notes && <div>Reviewed: {s.review_notes}</div>}
        </div>
      )}
      {Number(s.amount_unpaid) > 0 && (
        <div className="notice bad row">
          <span>The customer still owes <b>{money(s.amount_unpaid, cur)}</b>: a payment was rejected.</span>
          {can(P.POS_SALES_CREATE) && <button className="primary" onClick={() => setSettle(true)}>Take payment</button>}
        </div>
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
                <td>
                  <Status s={p.status} />
                  {p.is_settlement && <span className="small muted"> balance payment</span>}
                  {p.verified_by_name && <div className="small muted">by {p.verified_by_name} {dateTime(p.verified_at)}{p.verification_notes ? ` · ${p.verification_notes}` : ''}</div>}
                  {p.provider_transaction_id && <div className="small muted">Txn {p.provider_transaction_id}</div>}
                </td>
                <td>
                  {p.status === 'PENDING_VERIFICATION' && can(P.POS_PAYMENTS_VERIFY) && ctx.user.id !== (p.is_settlement ? p.received_by : s.cashier_id) && (
                    <button onClick={() => setVerify(p)}>Verify</button>
                  )}
                </td>
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
      {verify && <VerifyPaymentSheet payment={{ ...verify, sale_number: s.number }} currency={cur} onClose={() => setVerify(null)} onDone={() => { setVerify(null); reload(); }} />}
      {settle && <SettleSheet sale={s} onClose={() => setSettle(false)} onDone={() => { setSettle(false); reload(); }} />}
      {review && <ReviewSheet saleId={s.id} onClose={() => setReview(false)} onDone={() => { setReview(false); reload(); }} />}
    </Page>
  );
}

function ReviewSheet({ saleId, onDone, onClose }: { saleId: string; onDone: () => void; onClose: () => void }) {
  const [notes, setNotes] = useState('');
  const act = useAction();
  return (
    <Sheet title="Mark sale reviewed" onClose={onClose}>
      <Field label="What you checked"><input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="e.g. Price list changed while offline; accepted" /></Field>
      <ErrorBox error={act.error} />
      <button className="primary" style={{ marginTop: 8 }} disabled={act.busy || !notes.trim()} onClick={async () => { if (await act.run(() => api.post(`/pos/sales/${saleId}/review`, { notes }))) onDone(); }}>Mark reviewed</button>
    </Sheet>
  );
}
