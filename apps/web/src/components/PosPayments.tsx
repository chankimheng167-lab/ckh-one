'use client';
import { useRef, useState } from 'react';
import { Keypad, Sheet, usePos } from '@/components/PosShell';
import { ErrorBox, Field } from '@/components/ui';
import { api } from '@/lib/api';
import { money } from '@/lib/format';
import { useAction } from '@/lib/hooks';
import { newKey } from '@/lib/pos';

/** Confirm or reject a transfer/QR payment after checking the bank statement or provider. */
export function VerifyPaymentSheet({ payment, currency, onDone, onClose }: {
  payment: { id: string; method_name: string; amount: string; reference: string | null; sale_number?: string };
  currency: string;
  onDone: () => void;
  onClose: () => void;
}) {
  const [txn, setTxn] = useState('');
  const [notes, setNotes] = useState('');
  const act = useAction();
  async function decide(decision: 'CONFIRM' | 'REJECT') {
    const r = await act.run(() =>
      api.post(`/pos/payments/${payment.id}/verify`, { decision, providerTransactionId: txn.trim() || undefined, notes: notes.trim() || undefined }),
    );
    if (r) onDone();
  }
  return (
    <Sheet title={`Verify ${payment.method_name} ${money(payment.amount, currency)}`} onClose={onClose}>
      <div className="stack">
        <div className="small">
          {payment.sale_number && <>Sale {payment.sale_number} · </>}Reference <b>{payment.reference ?? '—'}</b>
        </div>
        <div className="notice small">Check the bank statement or the QR provider’s app. Confirm only when the money has arrived.</div>
        <Field label="Bank or provider transaction id (optional)"><input value={txn} onChange={(e) => setTxn(e.target.value)} /></Field>
        <Field label="Notes (required to reject)"><input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="e.g. Not on the statement for 17 Oct" /></Field>
        <ErrorBox error={act.error} />
        <div className="row">
          <button className="primary" disabled={act.busy} onClick={() => decide('CONFIRM')}>Money received: confirm</button>
          <button className="danger" disabled={act.busy || !notes.trim()} onClick={() => decide('REJECT')}>Not received: reject</button>
        </div>
        <div className="small muted">Rejecting leaves the amount owing on the sale; the customer can pay it later from the sale’s page.</div>
      </div>
    </Sheet>
  );
}

/** Take payment of a balance a rejected transfer/QR left on a sale. */
export function SettleSheet({ sale, onDone, onClose }: { sale: { id: string; number: string; amount_unpaid: string; currency: string }; onDone: () => void; onClose: () => void }) {
  const { ctx } = usePos();
  const methods = ctx.paymentMethods;
  const [methodId, setMethodId] = useState(methods.find((m) => m.kind === 'CASH')?.id ?? methods[0]?.id);
  const [amount, setAmount] = useState(sale.amount_unpaid);
  const [reference, setReference] = useState('');
  const [change, setChange] = useState<string | null>(null);
  const key = useRef(newKey());
  const act = useAction();
  const m = methods.find((x) => x.id === methodId);
  async function pay() {
    const r = await act.run(() =>
      api.post<any>(`/pos/sales/${sale.id}/settle`, { clientPaymentId: key.current, registerId: ctx.register!.id, methodId, amount: Number(amount).toFixed(2), reference: reference.trim() || undefined }),
    );
    if (r) {
      if (Number(r.change) > 0) setChange(r.change);
      else onDone();
    }
  }
  if (change) {
    return (
      <Sheet title="Balance paid" onClose={onDone}>
        <div className="kv"><b>Change</b><b className="big-total">{money(change, sale.currency)}</b></div>
        <button className="primary" style={{ marginTop: 10 }} onClick={onDone}>Done</button>
      </Sheet>
    );
  }
  if (!ctx.register) return <Sheet title="Take payment" onClose={onClose}><div className="notice">Choose a register first: the payment goes into its drawer.</div></Sheet>;
  return (
    <Sheet title={`Balance due on ${sale.number}: ${money(sale.amount_unpaid, sale.currency)}`} onClose={onClose}>
      <div className="stack">
        <div className="methods row">
          {methods.map((x) => (
            <button key={x.id} className={x.id === methodId ? 'primary' : ''} onClick={() => setMethodId(x.id)}>{x.name}</button>
          ))}
        </div>
        <div className="small muted">Amount received</div>
        <Keypad value={amount} onChange={setAmount} />
        {m?.requires_reference && <Field label={m.kind === 'CARD' ? 'Approval code' : 'Reference'}><input value={reference} onChange={(e) => setReference(e.target.value)} /></Field>}
        {m?.requires_verification && <div className="small muted">This payment will wait for verification again.</div>}
        <ErrorBox error={act.error} />
        <button className="primary" style={{ minHeight: 56 }} disabled={act.busy || !(Number(amount) > 0)} onClick={pay}>Take {money(amount || 0, sale.currency)}</button>
      </div>
    </Sheet>
  );
}
