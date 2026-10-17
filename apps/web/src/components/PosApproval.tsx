'use client';
import { useState } from 'react';
import { Keypad, Sheet } from '@/components/PosShell';
import { ErrorBox, Field } from '@/components/ui';
import { qs } from '@/lib/api';
import { useApi } from '@/lib/hooks';

const NEED_LABEL: Record<string, string> = {
  'pos.discount.apply': 'give a discount',
  'pos.discount.override': 'give a discount above the cashier limit',
  'pos.price.override': 'change a price',
  'pos.refunds.create': 'give a refund',
  'pos.receipts.reprint': 'reprint a receipt',
};

/** A supervisor approves on the cashier's screen with their own PIN. */
export function ApprovalSheet({ registerId, needs, onApprove, onClose }: { registerId: string; needs: string[]; onApprove: (a: { userId: string; pin: string }) => void; onClose: () => void }) {
  const { data, error } = useApi<any[]>(`/pos/approvers${qs({ registerId })}`);
  const [who, setWho] = useState<string>('');
  const [pin, setPin] = useState('');
  return (
    <Sheet title="Supervisor approval" onClose={onClose}>
      <p className="small">This sale needs someone allowed to {needs.map((n) => NEED_LABEL[n] ?? n).join(' and ')}.</p>
      <ErrorBox error={error} />
      <Field label="Supervisor">
        <select value={who} onChange={(e) => setWho(e.target.value)}>
          <option value="">Choose…</option>
          {(data ?? []).filter((u) => needs.every((n) => u.can?.includes(n))).map((u) => <option key={u.id} value={u.id}>{u.full_name}</option>)}
        </select>
      </Field>
      <Keypad value={pin} onChange={(v) => setPin(v.slice(0, 8))} decimals={false} mask />
      <button className="primary" disabled={!who || pin.length < 4} onClick={() => onApprove({ userId: who, pin })}>Approve</button>
    </Sheet>
  );
}

