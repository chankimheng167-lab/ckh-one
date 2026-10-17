'use client';
import { PosShell } from '@/components/PosShell';
import { Card, ErrorBox, Loading, Page } from '@/components/ui';
import { dateTime, money, num } from '@/lib/format';
import { useApi, useQueryParam } from '@/lib/hooks';

export default function ReturnDetailsPage() {
  return (
    <PosShell needRegister={false}>
      <ReturnDetails />
    </PosShell>
  );
}

function ReturnDetails() {
  const id = useQueryParam('id');
  const { data: r, error, loading } = useApi(id ? `/pos/returns/${id}` : null);
  if (error) return <ErrorBox error={error} />;
  if (loading || !r) return <Loading />;
  const cur = r.currency;
  return (
    <Page
      title={`Return ${r.number}`}
      subtitle={`${dateTime(r.created_at)} · ${r.register_name} · ${r.processed_by_name}${r.approved_by_name ? `, approved by ${r.approved_by_name}` : ''}`}
      actions={<><a className="btn" href={`/pos/sales/view/?id=${r.sale_id}`}>Sale {r.sale_number}</a><a className="btn" href={`/pos/sales/view/receipt/?returnId=${r.id}`}>Refund slip</a></>}
    >
      <div className="notice small">Reason: {r.reason}</div>
      <div className="table-wrap">
        <table>
          <thead><tr><th>Item</th><th className="num">Qty</th><th>Back to shelf</th><th className="num">Net</th><th className="num">Tax</th><th className="num">Refund</th></tr></thead>
          <tbody>
            {r.lines.map((l: any) => (
              <tr key={l.id}>
                <td>{l.description}<div className="small muted">{l.sku}{l.serial_numbers?.length ? ` · S/N ${l.serial_numbers.join(', ')}` : ''}</div></td>
                <td className="num">{num(l.quantity, 4)}</td>
                <td>{l.restock ? 'Yes' : 'No (damaged)'}</td>
                <td className="num">{money(l.net_amount, cur)}</td>
                <td className="num">{money(l.tax_amount, cur)}</td>
                <td className="num">{money(l.refund_amount, cur)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="grid-2">
        <Card title="Refunded to">
          <div className="kv">{r.refunds.map((x: any) => [<span key={`${x.id}l`}>{x.method_name}{x.reference ? ` · ${x.reference}` : ''}</span>, <span key={`${x.id}v`}>{money(x.amount, cur)}</span>])}</div>
        </Card>
        <Card title="Totals">
          <div className="kv">
            <span>Revenue reversed</span><span>{money(r.gross_ex_tax, cur)}</span>
            <span>Discount reversed</span><span>{money(r.discount_ex_tax, cur)}</span>
            <span>VAT reversed</span><span>{money(r.tax_total, cur)}</span>
            <b>Refund</b><b>{money(r.refund_total, cur)}</b>
            {r.cost_total !== undefined && <><span className="muted">Cost back in stock</span><span className="muted">{money(r.cost_total, cur)}</span></>}
          </div>
          {r.journal_number && <div className="small muted">Journal {r.journal_number}</div>}
        </Card>
      </div>
    </Page>
  );
}
