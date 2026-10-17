'use client';
import { Authed } from '@/components/Authed';
import { Empty, ErrorBox, Loading, Page } from '@/components/ui';
import { api } from '@/lib/api';
import { date, human, money } from '@/lib/format';
import { useAction, useApi } from '@/lib/hooks';

function Approvals() {
  const { data, error, loading, reload } = useApi<any[]>('/sales/orders/pending-approvals');
  const act = useAction();
  async function decide(id: string, approve: boolean) {
    const comment = approve ? prompt('Comment (optional)') ?? undefined : prompt('Why are you rejecting this order?');
    if (!approve && !comment) return;
    await act.run(() => api.post(`/sales/orders/${id}/${approve ? 'approve' : 'reject'}`, { comment }));
    reload();
  }
  return (
    <Page title="Pending approvals" subtitle="Orders that exceed a discount, amount or credit limit you are authorised to approve">
      <ErrorBox error={error ?? act.error} />
      {loading && !data ? <Loading /> : (data ?? []).length === 0 ? <Empty>Nothing waiting for you.</Empty> : (
        <div className="stack">
          {data!.map((o) => (
            <div key={o.id} className="card">
              <div className="spread">
                <div>
                  <a href={`/orders/view/?id=${o.id}`}><b>{o.number}</b></a> · {o.customer_name} · {o.sales_rep_name}
                  <div className="muted small">{date(o.order_date)} · max discount {Number(o.max_discount_percent)}%</div>
                </div>
                <b>{money(o.grand_total, o.currency)}</b>
              </div>
              <ul className="small" style={{ margin: '8px 0' }}>
                {(o.approvals ?? o.approval_requirements ?? []).map((a: any, i: number) => <li key={i}><b>{human(a.reason)}</b>: {a.detail}</li>)}
              </ul>
              <div className="row">
                <button className="primary" disabled={act.busy} onClick={() => decide(o.id, true)}>Approve</button>
                <button className="danger" disabled={act.busy} onClick={() => decide(o.id, false)}>Reject</button>
              </div>
            </div>
          ))}
        </div>
      )}
    </Page>
  );
}
export default function P() {
  return <Authed><Approvals /></Authed>;
}
