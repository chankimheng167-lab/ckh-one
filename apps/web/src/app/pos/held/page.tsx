'use client';
import { useState } from 'react';
import { P } from '@ckh/shared';
import { PosShell, Sheet, usePos } from '@/components/PosShell';
import { Empty, ErrorBox, Field, Loading, Page } from '@/components/ui';
import { api, qs } from '@/lib/api';
import { dateTime, money } from '@/lib/format';
import { useAction, useApi } from '@/lib/hooks';
import { type Cart, newKey, stashResume } from '@/lib/pos';

export default function HeldSalesPage() {
  return (
    <PosShell>
      <Held />
    </PosShell>
  );
}

function Held() {
  const { ctx, can } = usePos();
  const [status, setStatus] = useState<'HELD' | 'RESUMED' | 'CANCELLED'>('HELD');
  const { data, error, loading, reload } = useApi<any[]>(`/pos/held-sales${qs({ registerId: ctx.register!.id, status })}`);
  const [cancel, setCancel] = useState<any>(null);
  const act = useAction();

  async function resume(h: any) {
    const r = await act.run(() => api.post(`/pos/held-sales/${h.id}/resume`));
    if (!r) return;
    const cart: Cart = {
      customer: r.cart.customerId ? { id: r.cart.customerId, name: h.customer_name ?? 'Customer' } : null,
      orderDiscountPercent: r.cart.orderDiscountPercent,
      orderDiscountAmount: r.cart.orderDiscountAmount,
      lines: r.cart.lines.map((l: any) => ({ ...l, key: newKey(), sku: '', name: '', serialNumbers: l.serialNumbers ?? [] })),
    };
    stashResume(cart);
    location.href = '/pos/sell/';
  }

  return (
    <Page title="Held sales" subtitle={`${ctx.register!.name}. Carts parked on this register; prices are checked again on resume.`}>
      <div className="tabs">
        {(['HELD', 'RESUMED', 'CANCELLED'] as const).map((s) => (
          <button key={s} className={status === s ? 'on' : ''} onClick={() => setStatus(s)}>{s === 'HELD' ? 'Waiting' : s === 'RESUMED' ? 'Resumed' : 'Cancelled'}</button>
        ))}
      </div>
      <ErrorBox error={error ?? act.error} />
      {loading && !data && <Loading />}
      {data?.length === 0 && <Empty>Nothing here.</Empty>}
      <div className="pos-tiles">
        {(data ?? []).map((h) => (
          <div key={h.id} className="card stack">
            <div className="spread"><b>{h.label}</b><span className="muted small">{dateTime(h.created_at)}</span></div>
            <div className="small">{h.item_count} item(s) · about {h.estimated_total ? money(h.estimated_total, ctx.currency) : '–'}</div>
            <div className="small muted">Held by {h.held_by_name}{h.customer_name ? ` · ${h.customer_name}` : ''}</div>
            {h.cancel_reason && <div className="small muted">Reason: {h.cancel_reason}</div>}
            {status === 'HELD' && (
              <div className="row">
                {can(P.POS_SALES_CREATE) && <button className="primary" disabled={act.busy} onClick={() => resume(h)}>Resume</button>}
                <button className="danger" onClick={() => setCancel(h)}>Cancel</button>
              </div>
            )}
          </div>
        ))}
      </div>
      {cancel && <CancelSheet held={cancel} onClose={() => setCancel(null)} onDone={() => { setCancel(null); reload(); }} />}
    </Page>
  );
}

function CancelSheet({ held, onClose, onDone }: { held: any; onClose: () => void; onDone: () => void }) {
  const [reason, setReason] = useState('');
  const act = useAction();
  return (
    <Sheet title={`Cancel “${held.label}”`} onClose={onClose}>
      <Field label="Reason"><input autoFocus value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Customer left" /></Field>
      <ErrorBox error={act.error} />
      <button className="danger" disabled={!reason.trim() || act.busy} onClick={async () => (await act.run(() => api.post(`/pos/held-sales/${held.id}/cancel`, { reason }))) && onDone()}>
        Cancel held sale
      </button>
    </Sheet>
  );
}
