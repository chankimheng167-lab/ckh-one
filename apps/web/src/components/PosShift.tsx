'use client';
import { useState } from 'react';
import { Keypad, Sheet } from '@/components/PosShell';
import { ErrorBox, Field } from '@/components/ui';
import { api } from '@/lib/api';
import { money } from '@/lib/format';
import { useAction } from '@/lib/hooks';

/** Notes and coins the drawer is counted in, per currency. */
const DENOMS: Record<string, number[]> = {
  USD: [100, 50, 20, 10, 5, 2, 1, 0.5, 0.25, 0.1, 0.05, 0.01],
  KHR: [200000, 100000, 50000, 20000, 10000, 5000, 2000, 1000, 500, 200, 100],
};

export function OpenShiftSheet({ registerId, onClose, onDone }: { registerId: string; onClose: () => void; onDone: () => void }) {
  const [float, setFloat] = useState('');
  const [notes, setNotes] = useState('');
  const act = useAction();
  return (
    <Sheet title="Open shift" onClose={onClose}>
      <div className="small muted">Count the cash put in the drawer to start with (the float).</div>
      <Keypad value={float} onChange={setFloat} />
      <Field label="Notes (optional)"><input value={notes} onChange={(e) => setNotes(e.target.value)} /></Field>
      <ErrorBox error={act.error} />
      <button className="primary" disabled={act.busy} onClick={async () => (await act.run(() => api.post('/pos/shifts/open', { registerId, openingFloat: float || '0', notes: notes || undefined }))) && onDone()}>
        Open shift with {money(float || 0)}
      </button>
    </Sheet>
  );
}

export function CashMovementSheet({ shiftId, type, onClose, onDone }: { shiftId: string; type: 'CASH_IN' | 'CASH_OUT'; onClose: () => void; onDone: () => void }) {
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const act = useAction();
  return (
    <Sheet title={type === 'CASH_IN' ? 'Put cash in the drawer' : 'Take cash out of the drawer'} onClose={onClose}>
      <Keypad value={amount} onChange={setAmount} />
      <Field label="Reason"><input value={reason} onChange={(e) => setReason(e.target.value)} placeholder={type === 'CASH_IN' ? 'Extra change from the safe' : 'Paid supplier for ice'} /></Field>
      <ErrorBox error={act.error} />
      <button
        className="primary"
        disabled={act.busy || !(Number(amount) > 0) || reason.trim().length < 3}
        onClick={async () => (await act.run(() => api.post(`/pos/shifts/${shiftId}/cash-movements`, { type, amount, reason }))) && onDone()}
      >
        Record {money(amount || 0)}
      </button>
    </Sheet>
  );
}

/**
 * Closing count. The expected amount is not shown while counting (a blind
 * count), so the cashier counts what is really there; the difference is
 * shown after the shift is closed.
 */
export function CloseShiftSheet({ shift, currency, onClose, onDone }: { shift: any; currency: string; onClose: () => void; onDone: (r: any) => void }) {
  const denoms = DENOMS[currency] ?? DENOMS.USD;
  const [counts, setCounts] = useState<Record<string, string>>({});
  const [manual, setManual] = useState('');
  const [notes, setNotes] = useState('');
  const act = useAction();
  const fromCounts = denoms.reduce((a, d) => a + d * Number(counts[String(d)] || 0), 0);
  const total = manual !== '' ? Number(manual) : Math.round(fromCounts * 100) / 100;
  async function close() {
    const countDetails = Object.fromEntries(Object.entries(counts).filter(([, v]) => Number(v) > 0).map(([k, v]) => [k, Number(v)]));
    const r = await act.run(() =>
      api.post(`/pos/shifts/${shift.id}/close`, { countedCash: total.toFixed(2), countDetails: Object.keys(countDetails).length ? countDetails : undefined, notes: notes || undefined }),
    );
    if (r) onDone(r);
  }
  return (
    <Sheet title={`Close shift ${shift.number}`} onClose={onClose} wide>
      <div className="small muted">Count the notes and coins in the drawer. You will see any difference after closing.</div>
      <div className="form-grid">
        {denoms.map((d) => (
          <Field key={d} label={`${money(d, currency)} ×`}>
            <input inputMode="numeric" value={counts[String(d)] ?? ''} onChange={(e) => { setManual(''); setCounts({ ...counts, [String(d)]: e.target.value.replace(/\D/g, '') }); }} />
          </Field>
        ))}
      </div>
      <Field label="Or enter the counted total"><input inputMode="decimal" value={manual} onChange={(e) => setManual(e.target.value)} /></Field>
      <div className="big-total">{money(total, currency)}</div>
      <Field label="Notes"><input value={notes} onChange={(e) => setNotes(e.target.value)} /></Field>
      <ErrorBox error={act.error} />
      <button className="primary" disabled={act.busy || !(total >= 0) || Number.isNaN(total)} onClick={close}>Close shift</button>
    </Sheet>
  );
}

export function ApproveShiftSheet({ shift, currency, onClose, onDone }: { shift: any; currency: string; onClose: () => void; onDone: () => void }) {
  const [notes, setNotes] = useState('');
  const act = useAction();
  const diff = Number(shift.cash_difference);
  return (
    <Sheet title={`Approve shift ${shift.number}`} onClose={onClose}>
      <div className="kv">
        <span>Expected cash</span><span>{money(shift.expected_cash, currency)}</span>
        <span>Counted</span><span>{money(shift.counted_cash, currency)}</span>
        <b>Difference</b><b style={{ color: diff === 0 ? 'var(--ckh-success)' : 'var(--ckh-danger)' }}>{money(diff, currency)}</b>
      </div>
      {shift.closing_notes && <div className="small">Cashier’s note: {shift.closing_notes}</div>}
      <Field label="Approval notes (required when the difference is above the tolerance)"><input value={notes} onChange={(e) => setNotes(e.target.value)} /></Field>
      <ErrorBox error={act.error} />
      <button className="primary" disabled={act.busy} onClick={async () => (await act.run(() => api.post(`/pos/shifts/${shift.id}/approve`, { notes: notes || undefined }))) && onDone()}>
        Approve
      </button>
    </Sheet>
  );
}
