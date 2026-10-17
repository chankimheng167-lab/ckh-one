'use client';
import { useState } from 'react';
import { P } from '@ckh/shared';
import { PosShell, usePos } from '@/components/PosShell';
import { Card, ErrorBox, Field, Loading, Page, Stat } from '@/components/ui';
import { qs } from '@/lib/api';
import { dateTime, money } from '@/lib/format';
import { useApi } from '@/lib/hooks';

const LABELS: Record<string, [string, string]> = {
  SALES_POSTED_ONCE_AND_MATCH: ['Sales posted once, for the right amount', 'Each sale has one ledger entry equal to its payments, discounts and cost of goods.'],
  SALE_PAYMENTS_ADD_UP: ['Payments add up to each sale', 'Accepted and pending payments plus any balance due equal the sale total.'],
  RETURNS_POSTED_AND_MATCH: ['Returns posted and refunds add up', 'Each return has one balanced entry and its refunds equal the refund total.'],
  VERIFICATIONS_POSTED: ['Verified, rejected and balance payments posted', 'Every confirmed or rejected transfer/QR payment and every balance payment has its entry.'],
  SHIFT_CASH_ADDS_UP: ['Closed drawers add up', 'Expected cash equals the drawer movements, and every over/short was posted.'],
  PENDING_CLEARING_MATCHES: ['Pending-verification account matches', 'The ledger balance equals the payments still waiting for verification (all branches).'],
};

export default function ReconciliationPage() {
  return (
    <PosShell needRegister={false}>
      <Reconciliation />
    </PosShell>
  );
}

function Reconciliation() {
  const { ctx, can } = usePos();
  const [f, setF] = useState({ date: ctx.businessDate, to: ctx.businessDate });
  const { data: r, error, loading } = useApi<any>(can(P.POS_REPORTS_VIEW) ? `/pos/reconciliation${qs(f)}` : null);
  if (!can(P.POS_REPORTS_VIEW)) return <Page title="POS reconciliation"><div className="notice">Only supervisors and managers can see this.</div></Page>;
  const cur = ctx.currency;
  return (
    <Page title="POS reconciliation" subtitle="Checks that the books agree with the tills.">
      <div className="form-grid">
        <Field label="From"><input type="date" value={f.date} onChange={(e) => setF({ date: e.target.value, to: e.target.value > f.to ? e.target.value : f.to })} /></Field>
        <Field label="To"><input type="date" value={f.to} min={f.date} onChange={(e) => setF({ ...f, to: e.target.value })} /></Field>
      </div>
      <ErrorBox error={error} />
      {loading && !r && <Loading />}
      {r && (
        <>
          <div className={`notice ${r.ok ? 'ok' : 'bad'}`}>{r.ok ? 'Everything reconciles.' : 'Something does not reconcile: see the red checks below.'} <span className="small muted">Checked {dateTime(r.checkedAt)}</span></div>
          <div className="grid">
            <Stat label="Waiting for verification" value={money(r.summary.pending_amount, cur)} hint={`${r.summary.pending_payments} payments${r.summary.oldest_pending ? `, oldest ${dateTime(r.summary.oldest_pending)}` : ''}`} href="/pos/payments/" />
            <Stat label="Balances due" value={money(r.summary.balance_due_amount, cur)} hint={`${r.summary.balance_due_sales} sales`} />
            <Stat label="Rejected in period" value={r.summary.rejected_in_period} />
            <Stat label="Offline sales to review" value={r.summary.sales_to_review} href="/pos/sales/?reviewStatus=NEEDS_REVIEW" />
          </div>
          {r.checks.map((c: any) => (
            <Card key={c.code} title={<span>{c.ok ? '✓' : '✗'} {LABELS[c.code]?.[0] ?? c.code}</span>} tight>
              <div className="small muted">{LABELS[c.code]?.[1]}</div>
              {!c.ok && <pre className="small" style={{ whiteSpace: 'pre-wrap', margin: '6px 0 0' }}>{JSON.stringify(c.details, null, 2)}</pre>}
            </Card>
          ))}
        </>
      )}
    </Page>
  );
}
