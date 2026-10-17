'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import { PosShell, usePos } from '@/components/PosShell';
import { ApprovalSheet } from '@/components/PosApproval';
import { Card, ErrorBox, Field, Loading, Page } from '@/components/ui';
import { api, type ApiError } from '@/lib/api';
import { dateTime, money, num } from '@/lib/format';
import { useApi, useQueryParam } from '@/lib/hooks';
import { newKey } from '@/lib/pos';
import { printReceipt } from '@/lib/receipt';

export default function NewReturnPage() {
  return (
    <PosShell>
      <NewReturn />
    </PosShell>
  );
}

interface Pick { quantity: string; restock: boolean; serials: string[] }

/**
 * Return items from a sale. The refund is worked out by the server from what
 * was paid for each line; it goes back to the methods the customer paid with.
 */
function NewReturn() {
  const saleId = useQueryParam('saleId');
  const { ctx } = usePos();
  const { data, error, loading } = useApi(saleId ? `/pos/sales/${saleId}/returnable` : null);
  const [picks, setPicks] = useState<Record<string, Pick>>({});
  const [preview, setPreview] = useState<any>(null);
  const [previewError, setPreviewError] = useState<ApiError | null>(null);
  const [refunds, setRefunds] = useState<Record<string, { amount: string; reference: string }>>({});
  const [reason, setReason] = useState('');
  const [askPin, setAskPin] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState<any>(null);
  const clientReturnId = useRef(newKey());

  const chosen = useMemo(
    () => Object.entries(picks).filter(([, p]) => Number(p.quantity) > 0).map(([saleLineId, p]) => ({ saleLineId, quantity: p.quantity, restock: p.restock, serialNumbers: p.serials })),
    [picks],
  );

  useEffect(() => {
    if (!saleId || !chosen.length) {
      setPreview(null);
      return;
    }
    const t = setTimeout(async () => {
      try {
        const p = await api.post('/pos/returns/preview', { saleId, lines: chosen.map(({ saleLineId, quantity }) => ({ saleLineId, quantity })) });
        setPreview(p);
        setPreviewError(null);
        // Suggest the split: card/QR/bank first (back where it came from), the rest in cash.
        let left = Number(p.refundTotal);
        const next: Record<string, { amount: string; reference: string }> = {};
        const methods = [...(data?.methods ?? [])].sort((a: any, b: any) => (a.kind === 'CASH' ? 1 : 0) - (b.kind === 'CASH' ? 1 : 0));
        for (const m of methods) {
          const take = Math.min(left, Number(m.available));
          next[m.method_id] = { amount: take > 0 ? take.toFixed(2) : '', reference: refunds[m.method_id]?.reference ?? '' };
          left = Math.round((left - take) * 100) / 100;
        }
        setRefunds(next);
      } catch (e) {
        setPreviewError(e as ApiError);
      }
    }, 200);
    return () => clearTimeout(t);
  }, [saleId, JSON.stringify(chosen.map((c) => [c.saleLineId, c.quantity]))]); // eslint-disable-line react-hooks/exhaustive-deps

  if (error) return <ErrorBox error={error} />;
  if (loading || !data) return <Loading />;
  const s = data.sale;
  const cur = s.currency;
  const refundSum = Object.values(refunds).reduce((a, r) => a + Number(r.amount || 0), 0);
  const total = Number(preview?.refundTotal ?? 0);
  const balanced = Math.abs(refundSum - total) < 0.005 && total > 0;

  function setPick(id: string, p: Partial<Pick>) {
    setPicks((x) => ({ ...x, [id]: { ...{ quantity: '0', restock: true, serials: [] as string[] }, ...x[id], ...p } }));
  }

  async function submit(approval?: { userId: string; pin: string }) {
    setBusy(true);
    setErr(null);
    try {
      const r = await api.post('/pos/returns', {
        clientReturnId: clientReturnId.current,
        saleId,
        registerId: ctx.register!.id,
        reason,
        lines: chosen,
        refunds: Object.entries(refunds).filter(([, r]) => Number(r.amount) > 0).map(([methodId, r]) => ({ methodId, amount: Number(r.amount).toFixed(2), reference: r.reference || undefined })),
        approval,
      });
      setDone(r.return);
      void printReceipt({ returnId: r.return.id }).catch(() => undefined);
    } catch (e) {
      const ae = e as ApiError;
      if (ae.code === 'APPROVAL_REQUIRED') setAskPin(true);
      else {
        if (ae.code === 'IDEMPOTENCY_CONFLICT') clientReturnId.current = newKey();
        setErr(ae.message);
      }
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return (
      <div className="pos-center">
        <div className="notice ok"><h1 style={{ margin: 0 }}>Return {done.number} recorded</h1></div>
        <div className="card kv">
          <span>Refund</span><b className="big-total">{money(done.refund_total, cur)}</b>
          {done.refunds.map((r: any) => [<span key={`${r.id}l`}>{r.method_name}</span>, <span key={`${r.id}v`}>{money(r.amount, cur)}</span>])}
        </div>
        <div className="row">
          <a className="btn" href={`/pos/sales/view/receipt/?returnId=${done.id}`}>Refund slip</a>
          <a className="btn" href={`/pos/returns/view/?id=${done.id}`}>Details</a>
          <a className="btn primary" href="/pos/sell/">Back to selling</a>
        </div>
      </div>
    );
  }

  return (
    <Page title={`Return from sale ${s.number}`} subtitle={`${dateTime(s.sold_at)} · ${s.cashier_name} · ${s.customer_name ?? 'Walk-in customer'} · paid ${money(s.grand_total, cur)}`}>
      <Card title="Items">
        <div className="table-wrap">
          <table>
            <thead><tr><th>Item</th><th className="num">Sold</th><th className="num">Returned</th><th>Return</th><th>Back to shelf</th></tr></thead>
            <tbody>
              {data.lines.map((l: any) => {
                const p = picks[l.saleLineId];
                const max = Number(l.remaining);
                const serial = l.serialNumbers.length > 0 || (Number(l.quantity) > 0 && s.lines.find((x: any) => x.id === l.saleLineId)?.serial_numbers?.length > 0);
                return (
                  <tr key={l.saleLineId}>
                    <td>{l.description}<div className="small muted">{l.sku} · {money(l.lineTotal, cur)}</div></td>
                    <td className="num">{num(l.quantity, 4)}</td>
                    <td className="num">{Number(l.quantityReturned) > 0 ? num(l.quantityReturned, 4) : ''}</td>
                    <td>
                      {max <= 0 ? <span className="muted small">All returned</span> : serial ? (
                        <div className="stack small">
                          {l.serialNumbers.map((sn: string) => (
                            <label key={sn} className="row">
                              <input type="checkbox" checked={!!p?.serials.includes(sn)} onChange={(e) => {
                                const serials = e.target.checked ? [...(p?.serials ?? []), sn] : (p?.serials ?? []).filter((x) => x !== sn);
                                setPick(l.saleLineId, { serials, quantity: String(serials.length) });
                              }} /> {sn}
                            </label>
                          ))}
                        </div>
                      ) : (
                        <div className="qty">
                          <button onClick={() => setPick(l.saleLineId, { quantity: String(Math.max(0, Number(p?.quantity ?? 0) - 1)) })}>−</button>
                          <input inputMode="decimal" value={p?.quantity ?? '0'} onChange={(e) => setPick(l.saleLineId, { quantity: e.target.value })} aria-label={`Quantity of ${l.description}`} />
                          <button onClick={() => setPick(l.saleLineId, { quantity: String(Math.min(max, Number(p?.quantity ?? 0) + 1)) })}>＋</button>
                          <button className="link small" onClick={() => setPick(l.saleLineId, { quantity: l.remaining })}>all {num(max, 4)}</button>
                        </div>
                      )}
                    </td>
                    <td>{l.trackInventory && max > 0 && <input type="checkbox" aria-label="Back to shelf" checked={p?.restock ?? true} onChange={(e) => setPick(l.saleLineId, { restock: e.target.checked })} />}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <div className="small muted" style={{ marginTop: 6 }}>Untick “back to shelf” for damaged goods; they are not added to stock.</div>
      </Card>
      {previewError && <ErrorBox error={previewError} />}
      {preview && (
        <Card title={`Refund ${money(preview.refundTotal, cur)}`}>
          <div className="table-wrap">
            <table>
              <thead><tr><th>Back to</th><th className="num">Can refund</th><th>Amount</th><th>Reference</th></tr></thead>
              <tbody>
                {data.methods.map((m: any) => (
                  <tr key={m.method_id}>
                    <td>{m.name}{m.pending && <div className="small" style={{ color: 'var(--ckh-warning)' }}>Not verified yet: verify before refunding to it</div>}</td>
                    <td className="num">{money(m.available, cur)}</td>
                    <td><input inputMode="decimal" style={{ maxWidth: 120 }} value={refunds[m.method_id]?.amount ?? ''} onChange={(e) => setRefunds({ ...refunds, [m.method_id]: { ...{ reference: '' }, ...refunds[m.method_id], amount: e.target.value } })} /></td>
                    <td>{m.kind !== 'CASH' && <input style={{ maxWidth: 200 }} placeholder="Refund reference" value={refunds[m.method_id]?.reference ?? ''} onChange={(e) => setRefunds({ ...refunds, [m.method_id]: { ...{ amount: '' }, ...refunds[m.method_id], reference: e.target.value } })} />}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {!balanced && <div className="notice warn small">The refund amounts add up to {money(refundSum, cur)}; they must equal {money(total, cur)}.</div>}
          <Field label="Reason"><input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Wrong size, damaged, changed mind…" /></Field>
          {err && <div className="notice bad">{err}</div>}
          <button className="primary" style={{ minHeight: 56, marginTop: 8 }} disabled={busy || !balanced || !reason.trim()} onClick={() => submit()}>
            Refund {money(total, cur)}
          </button>
        </Card>
      )}
      {askPin && <ApprovalSheet registerId={ctx.register!.id} needs={['pos.refunds.create']} onClose={() => setAskPin(false)} onApprove={(a) => { setAskPin(false); void submit(a); }} />}
    </Page>
  );
}
