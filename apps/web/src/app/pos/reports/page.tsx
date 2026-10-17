'use client';
import { useState } from 'react';
import { P } from '@ckh/shared';
import { PosShell, usePos } from '@/components/PosShell';
import { Card, Empty, ErrorBox, Field, Loading, Page, Stat } from '@/components/ui';
import { api, qs } from '@/lib/api';
import { dateTime, human, money, num } from '@/lib/format';
import { useAction, useApi } from '@/lib/hooks';

export default function PosReportsPage() {
  return (
    <PosShell needRegister={false}>
      <Reports />
    </PosShell>
  );
}

function Reports() {
  const { ctx, can } = usePos();
  const [f, setF] = useState({ date: ctx.businessDate, to: ctx.businessDate, registerId: '' });
  const query = qs({ date: f.date, to: f.to, registerId: f.registerId || undefined });
  const { data: r, error, loading } = useApi<any>(can(P.POS_REPORTS_VIEW) ? `/pos/reports/daily${query}` : null);
  const act = useAction();
  if (!can(P.POS_REPORTS_VIEW)) return <Page title="Sales reports"><div className="notice">Only supervisors and managers can see POS reports.</div></Page>;
  const cur = r?.currency ?? ctx.currency;
  const m = (v: unknown) => money(v, cur);
  return (
    <Page
      title="Daily sales report"
      actions={<button disabled={!r || act.busy} onClick={() => act.run(() => api.download(`/pos/reports/daily${qs({ date: f.date, to: f.to, registerId: f.registerId || undefined, format: 'csv' })}`, `pos-report-${f.date}${f.to !== f.date ? `-to-${f.to}` : ''}.csv`))}>Download CSV</button>}
    >
      <div className="form-grid">
        <Field label="From"><input type="date" value={f.date} onChange={(e) => setF({ ...f, date: e.target.value, to: e.target.value > f.to ? e.target.value : f.to })} /></Field>
        <Field label="To"><input type="date" value={f.to} min={f.date} onChange={(e) => setF({ ...f, to: e.target.value })} /></Field>
        <Field label="Register">
          <select value={f.registerId} onChange={(e) => setF({ ...f, registerId: e.target.value })}>
            <option value="">All registers</option>
            {ctx.registers.map((g) => <option key={g.id} value={g.id}>{g.branch_name} · {g.code} {g.name}</option>)}
          </select>
        </Field>
      </div>
      <ErrorBox error={error ?? act.error} />
      {loading && !r && <Loading />}
      {r && (
        <>
          <div className="grid">
            <Stat label="Sales (incl. VAT)" value={m(r.summary.gross_sales)} hint={`${r.summary.receipts} receipts, average ${m(r.summary.average_sale)}`} />
            <Stat label="Refunds" value={m(r.summary.refunds)} hint={`${r.summary.refund_count} returns`} />
            <Stat label="Net after refunds" value={m(r.summary.net_after_refunds)} />
            <Stat label="VAT after refunds" value={m(r.summary.tax_after_refunds)} />
            <Stat label="Discounts" value={m(r.summary.discounts)} />
            {r.summary.gross_margin !== undefined && <Stat label="Gross margin" value={m(r.summary.gross_margin)} hint="Net sales less cost, after returns" />}
            {r.summary.offline_receipts > 0 && <Stat label="Offline receipts" value={r.summary.offline_receipts} />}
          </div>
          <Table title="By payment method" rows={r.byMethod} cols={[['name', 'Method'], ['sales', 'Confirmed', m], ['pending', 'Waiting for verification', m], ['refunds', 'Refunded', m], ['net', 'Net', m]]} />
          <Table title="By register" rows={r.byRegister} cols={[['branch', 'Branch'], ['code', 'Register'], ['receipts', 'Receipts'], ['discounts', 'Discounts', m], ['total', 'Sales', m]]} />
          <Table title="By cashier" rows={r.byCashier} cols={[['cashier', 'Cashier'], ['receipts', 'Receipts'], ['discounts', 'Discounts', m], ['refunds', 'Refunds', m], ['total', 'Sales', m]]} />
          <Table title="Tax" rows={r.tax} cols={[['rate', 'Rate %', (v) => num(v)], ['taxable', 'Taxable', m], ['tax', 'VAT', m], ['returned_taxable', 'Returned taxable', m], ['returned_tax', 'Returned VAT', m]]} />
          <Table title="By category" rows={r.byCategory} cols={[['category', 'Category'], ['quantity', 'Quantity', (v) => num(v, 3)], ['total', 'Sales', m]]} />
          <Table title="Top products" rows={r.topProducts} cols={[['sku', 'SKU'], ['description', 'Product'], ['quantity', 'Sold', (v) => num(v, 3)], ['returned', 'Returned', (v) => num(v, 3)], ['total', 'Sales', m]]} />
          <Table title="By hour" rows={r.byHour} cols={[['hour', 'Hour (company time)', (v) => `${String(v).padStart(2, '0')}:00`], ['receipts', 'Receipts'], ['total', 'Sales', m]]} />
          <Table title="Shifts" rows={r.shifts} cols={[['number', 'Shift', (v, x) => <a href={`/pos/shifts/view/?id=${x.id}`}>{v}</a>], ['register', 'Register'], ['cashier', 'Cashier'], ['status', 'Status', (v) => human(v)], ['opened_at', 'Opened', dateTime], ['expected_cash', 'Expected cash', m], ['counted_cash', 'Counted', m], ['cash_difference', 'Difference', m]]} />
          <Table title="Discounts approved" rows={r.approvedDiscounts} cols={[['approved_by', 'Approved by'], ['receipts', 'Receipts'], ['discounts', 'Discounts', m]]} />
        </>
      )}
    </Page>
  );
}

const isNum = (v: unknown) => v !== null && v !== '' && typeof v !== 'boolean' && !Number.isNaN(Number(v)) && !/^\d{4}-\d{2}-\d{2}/.test(String(v));

type Col = [string, string, ((v: any, row: any) => React.ReactNode)?];

function Table({ title, rows, cols }: { title: string; rows: any[]; cols: Col[] }) {
  return (
    <Card title={title} tight>
      {!rows.length ? (
        <Empty>Nothing in this period.</Empty>
      ) : (
        <div className="table-wrap">
          <table>
            <thead><tr>{cols.map(([k, label]) => <th key={k} className={isNum(rows[0][k]) ? 'num' : undefined}>{label}</th>)}</tr></thead>
            <tbody>
              {rows.map((row, i) => (
                <tr key={i}>
                  {cols.map(([k, , fmt]) => <td key={k} className={isNum(row[k]) ? 'num' : undefined}>{fmt ? fmt(row[k], row) : row[k] ?? ''}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}
