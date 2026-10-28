'use client';
import { useState } from 'react';
import { P } from '@ckh/shared';
import { VerifyPaymentSheet } from '@/components/PosPayments';
import { PosShell, usePos } from '@/components/PosShell';
import { Empty, ErrorBox, Loading, Page } from '@/components/ui';
import { ago, money } from '@/lib/format';
import { useApi } from '@/lib/hooks';

export default function PendingPaymentsPage() {
  return (
    <PosShell needRegister={false}>
      <Pending />
    </PosShell>
  );
}

function Pending() {
  const { ctx, can } = usePos();
  const { data, error, loading, reload } = useApi<any[]>(can(P.POS_PAYMENTS_VERIFY) ? '/pos/payments/pending' : null);
  const [verify, setVerify] = useState<any>(null);
  if (!can(P.POS_PAYMENTS_VERIFY)) return <Page title="Payments to verify"><div className="notice">Only supervisors and managers verify payments.</div></Page>;
  return (
    <Page title="Payments to verify" subtitle="Bank transfers and KHQR payments count as paid only after someone other than the cashier checks they arrived.">
      <ErrorBox error={error} />
      {loading && !data && <Loading />}
      {data?.length === 0 && <Empty>Nothing waiting. Every transfer and QR payment has been checked.</Empty>}
      {!!data?.length && (
        <div className="table-wrap">
          <table>
            <thead><tr><th>Sale</th><th>Taken</th><th>Register</th><th>Cashier</th><th>Method</th><th>Reference</th><th className="num">Amount</th><th /></tr></thead>
            <tbody>
              {data.map((p) => (
                <tr key={p.id}>
                  <td><a href={`/pos/sales/view/?id=${p.sale_id}`}>{p.sale_number}</a>{p.is_settlement && <div className="small muted">balance payment</div>}</td>
                  <td>{ago(p.created_at)}</td>
                  <td>{p.branch_name} · {p.register_code}</td>
                  <td>{p.cashier_name}</td>
                  <td>{p.method_name}</td>
                  <td>{p.reference}</td>
                  <td className="num">{money(p.amount, p.currency)}</td>
                  <td>{p.cashier_id === ctx.user.id && !p.is_settlement ? <span className="small muted">Your sale</span> : <button onClick={() => setVerify(p)}>Verify</button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {verify && <VerifyPaymentSheet payment={verify} currency={verify.currency} onClose={() => setVerify(null)} onDone={() => { setVerify(null); reload(); }} />}
    </Page>
  );
}
