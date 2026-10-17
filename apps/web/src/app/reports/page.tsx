'use client';
import { useState } from 'react';
import { Authed } from '@/components/Authed';
import { ErrorBox, Loading, Page } from '@/components/ui';
import { api, qs } from '@/lib/api';
import { money, monthStart, num, today } from '@/lib/format';
import { useAction, useApi } from '@/lib/hooks';

function Reports() {
  const { data: catalog, error: catErr } = useApi<any[]>('/sales/reports');
  const [code, setCode] = useState('sales-by-rep');
  const [from, setFrom] = useState(monthStart());
  const [to, setTo] = useState(today());
  const query = qs({ from, to });
  const { data: r, error, loading } = useApi(`/sales/reports/${code}${query}`);
  const dl = useAction();
  const cell = (type: string, v: unknown) => (type === 'money' ? money(v, r?.currency) : type === 'percent' ? (v === null || v === undefined ? '–' : `${num(v, 1)}%`) : type === 'number' ? num(v, 4) : String(v ?? '–'));
  return (
    <Page title="Sales reports" actions={r && <>
      <button disabled={dl.busy} onClick={() => dl.run(() => api.download(`/sales/reports/${code}${qs({ from, to, format: 'xlsx' })}`, `${code}_${from}_${to}.xlsx`))}>Excel</button>
      <button disabled={dl.busy} onClick={() => dl.run(() => api.download(`/sales/reports/${code}${qs({ from, to, format: 'pdf' })}`, `${code}_${from}_${to}.pdf`))}>PDF</button>
    </>}>
      <ErrorBox error={catErr ?? dl.error} />
      <div className="form-grid">
        <select value={code} onChange={(e) => setCode(e.target.value)} aria-label="Report">
          {(catalog ?? []).map((c) => <option key={c.code} value={c.code} disabled={!c.available}>{c.title}{c.available ? '' : ' (not in your plan)'}</option>)}
        </select>
        <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} aria-label="From" />
        <input type="date" value={to} onChange={(e) => setTo(e.target.value)} aria-label="To" />
      </div>
      <ErrorBox error={error} />
      {loading && !r ? <Loading /> : r && (
        <div className="table-wrap">
          <table>
            <thead><tr>{r.columns.map((c: any) => <th key={c.key} className={c.type === 'text' ? '' : 'num'}>{c.label}</th>)}</tr></thead>
            <tbody>
              {r.rows.length === 0 && <tr><td colSpan={r.columns.length} className="muted">No data for this period.</td></tr>}
              {r.rows.map((row: any, i: number) => <tr key={i}>{r.columns.map((c: any) => <td key={c.key} className={c.type === 'text' ? '' : 'num'}>{cell(c.type, row[c.key])}</td>)}</tr>)}
            </tbody>
            {r.totals && r.rows.length > 0 && <tfoot><tr>{r.columns.map((c: any, i: number) => <td key={c.key} className={c.type === 'text' ? '' : 'num'}>{i === 0 ? 'Total' : r.totals[c.key] !== undefined ? cell(c.type, r.totals[c.key]) : ''}</td>)}</tr></tfoot>}
          </table>
        </div>
      )}
    </Page>
  );
}
export default function P() {
  return <Authed><Reports /></Authed>;
}
