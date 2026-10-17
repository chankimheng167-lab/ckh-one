'use client';
import { useEffect, useMemo, useState } from 'react';
import { priceLine } from '@ckh/shared';
import { Authed } from '@/components/Authed';
import { Card, ErrorBox, Field, Page, StaleBadge } from '@/components/ui';
import { api, ApiError } from '@/lib/api';
import { newKey } from '@/lib/db';
import { money, num, today } from '@/lib/format';
import { enqueue } from '@/lib/sync';
import { useSession } from '@/lib/session';

interface Line { productId: string; quantity: string; discountPercent: string; unitPrice?: string; notes?: string }

/**
 * Order entry. Online, totals are previewed from the catalogue and the
 * server re-prices on save. Offline, the order is queued with the device's
 * indicative total; the server re-validates everything on sync.
 */
function NewOrder() {
  const s = useSession();
  const snap = s.snapshot?.data;
  const [customers, setCustomers] = useState<any[]>(snap?.customers ?? []);
  const [products, setProducts] = useState<any[]>(snap?.products ?? []);
  const [ref, setRef] = useState<any>(null);
  const [customerId, setCustomerId] = useState('');
  const [lines, setLines] = useState<Line[]>([]);
  const [header, setHeader] = useState({ orderDate: today(), requestedDeliveryDate: '', deliveryAddressId: '', paymentTermsDays: '', warehouseId: '', branchId: '', notes: '' });
  const [visitId, setVisitId] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | string | null>(null);
  const [pick, setPick] = useState('');
  const [prices, setPrices] = useState<Record<string, any>>({});
  const [clientReference] = useState(newKey);

  useEffect(() => {
    const p = new URLSearchParams(location.search);
    if (p.get('customerId')) setCustomerId(p.get('customerId')!);
    if (p.get('visitId')) setVisitId(p.get('visitId')!);
    if (p.get('productId')) setLines([{ productId: p.get('productId')!, quantity: '1', discountPercent: '0' }]);
  }, []);
  // The offline snapshot loads from IndexedDB after the first render.
  useEffect(() => {
    if (!snap) return;
    setCustomers((c) => (c.length ? c : snap.customers));
    setProducts((p) => (p.length ? p : snap.products));
  }, [snap]);
  useEffect(() => {
    if (!s.online) return;
    api.get('/sales/customers?limit=200').then(setCustomers).catch(() => undefined);
    if (!products.length) api.get('/sales/catalog/products?limit=500').then((rows) => setProducts((p) => (p.length ? p : rows))).catch(() => undefined);
    api.get('/masterdata/reference').then(setRef).catch(() => undefined);
  }, [s.online]);
  // Customer-specific prices: from the server when online, from the snapshot's price lists offline.
  useEffect(() => {
    if (!customerId) return;
    if (s.online) {
      api.get(`/sales/catalog/products?customerId=${customerId}&limit=500`).then((rows) => {
        setProducts(rows);
        setPrices(Object.fromEntries(rows.map((r: any) => [r.id, { unitPrice: r.customer_price ?? r.list_price, tax: r.tax_rate_percent ?? 0 }])));
      }).catch(() => undefined);
    } else if (snap) {
      const c = snap.customers.find((x: any) => x.id === customerId);
      const list = snap.priceLists.find((l: any) => l.id === c?.price_list_id) ?? snap.priceLists[snap.priceLists.length - 1];
      const tax = snap.taxCodes.find((t: any) => t.is_default)?.rate_percent ?? 0;
      setPrices(Object.fromEntries(snap.products.map((p: any) => {
        const item = list?.items.find((i: any) => i.product_id === p.id && Number(i.min_quantity) <= 1);
        return [p.id, { unitPrice: item?.unit_price ?? p.list_price, tax }];
      })));
    }
  }, [customerId, s.online]); // eslint-disable-line react-hooks/exhaustive-deps

  const customer = customers.find((c) => c.id === customerId);
  const addresses: any[] = customer?.addresses ?? snap?.customers.find((c: any) => c.id === customerId)?.addresses ?? [];
  const preview = useMemo(() => {
    let subtotal = 0, discount = 0, tax = 0, total = 0;
    const rows = lines.map((l) => {
      const pr = prices[l.productId];
      if (!pr || !Number(l.quantity)) return null;
      let r;
      try {
        r = priceLine({ quantity: l.quantity, unitPrice: l.unitPrice ?? pr.unitPrice, discountPercent: l.discountPercent || '0', taxRatePercent: pr.tax ?? 0 }, 'USD');
      } catch {
        return null;
      }
      subtotal += Number(r.grossAmount); discount += Number(r.discountAmount); tax += Number(r.taxAmount); total += Number(r.lineTotal);
      return r;
    });
    return { rows, subtotal, discount, tax, total };
  }, [lines, prices]);

  const productOptions = products.filter((p) => `${p.sku} ${p.name} ${p.barcode ?? ''}`.toLowerCase().includes(pick.toLowerCase())).slice(0, 8);
  const setLine = (i: number, patch: Partial<Line>) => setLines(lines.map((l, j) => (j === i ? { ...l, ...patch } : l)));

  function payload() {
    const opt = (v: string) => (v ? v : undefined);
    return {
      customerId,
      clientReference,
      orderDate: opt(header.orderDate),
      requestedDeliveryDate: opt(header.requestedDeliveryDate),
      deliveryAddressId: opt(header.deliveryAddressId),
      paymentTermsDays: header.paymentTermsDays ? Number(header.paymentTermsDays) : undefined,
      warehouseId: opt(header.warehouseId),
      branchId: opt(header.branchId),
      notes: opt(header.notes),
      visitId,
      lines: lines.filter((l) => Number(l.quantity) > 0).map((l) => ({ productId: l.productId, quantity: l.quantity, discountPercent: l.discountPercent || '0', unitPrice: l.unitPrice, notes: l.notes })),
    };
  }

  async function save(submit: boolean) {
    if (!customerId || !lines.length) return setError('Choose a customer and add at least one product.');
    setBusy(true);
    setError(null);
    try {
      if (!s.online) {
        const { clientReference: _c, visitId: v, ...p } = payload();
        await enqueue(s.me!.userId, { entityType: 'SALES_ORDER', label: `Order for ${customer?.name ?? 'customer'}`, payload: { ...p, visitId: v, submit, deviceGrandTotal: preview.total.toFixed(2) } });
        await s.refreshQueue();
        location.href = '/sync/?queued=1';
        return;
      }
      const created = await api.post('/sales/orders', { ...payload(), source: 'MOBILE' });
      if (submit) await api.post(`/sales/orders/${created.order.id}/submit`);
      location.href = `/orders/view/?id=${created.order.id}`;
    } catch (e) {
      setError(e as ApiError);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Page title="New sales order" subtitle={s.online ? 'Prices, tax, credit and stock are checked by the server when you save.' : 'Offline: the order is queued and checked by the server when you reconnect.'} actions={<StaleBadge />}>
      <Card title="Customer">
        <div className="form-grid">
          <Field label="Customer">
            <select value={customerId} onChange={(e) => setCustomerId(e.target.value)} required>
              <option value="">Choose…</option>
              {customers.map((c) => <option key={c.id} value={c.id}>{c.name} ({c.code})</option>)}
            </select>
          </Field>
          <Field label="Order date"><input type="date" value={header.orderDate} onChange={(e) => setHeader({ ...header, orderDate: e.target.value })} /></Field>
          <Field label="Requested delivery"><input type="date" value={header.requestedDeliveryDate} onChange={(e) => setHeader({ ...header, requestedDeliveryDate: e.target.value })} /></Field>
          <Field label="Delivery address">
            <select value={header.deliveryAddressId} onChange={(e) => setHeader({ ...header, deliveryAddressId: e.target.value })}>
              <option value="">Default</option>
              {addresses.filter((a) => (a.address_type ?? a.type) === 'DELIVERY').map((a) => <option key={a.id} value={a.id}>{a.line1}</option>)}
            </select>
          </Field>
          <Field label="Payment terms (days)"><input inputMode="numeric" placeholder={String(customer?.payment_terms_days ?? 'Customer default')} value={header.paymentTermsDays} onChange={(e) => setHeader({ ...header, paymentTermsDays: e.target.value.replace(/\D/g, '') })} /></Field>
          {ref && (
            <>
              <Field label="Branch"><select value={header.branchId} onChange={(e) => setHeader({ ...header, branchId: e.target.value })}><option value="">My default</option>{ref.branches.map((b: any) => <option key={b.id} value={b.id}>{b.name}</option>)}</select></Field>
              <Field label="Warehouse"><select value={header.warehouseId} onChange={(e) => setHeader({ ...header, warehouseId: e.target.value })}><option value="">My default</option>{ref.warehouses.map((w: any) => <option key={w.id} value={w.id}>{w.name}</option>)}</select></Field>
            </>
          )}
        </div>
        {customer?.credit_hold && <div className="notice bad" style={{ marginTop: 10 }}>This customer is on credit hold; the order will need approval.</div>}
      </Card>

      <Card title="Products">
        <input placeholder="Search product to add (name, SKU, barcode)" value={pick} onChange={(e) => setPick(e.target.value)} />
        {pick && (
          <ul className="list" style={{ marginBottom: 8 }}>
            {productOptions.map((p) => (
              <li key={p.id}><button type="button" className="link" onClick={() => { setLines([...lines, { productId: p.id, quantity: '1', discountPercent: '0' }]); setPick(''); }}>{p.name} <span className="muted small">{p.sku}</span></button></li>
            ))}
          </ul>
        )}
        <div className="table-wrap" style={{ marginTop: 8 }}>
          <table>
            <thead><tr><th>Product</th><th className="num">Qty</th><th>Unit</th><th className="num">Unit price</th><th className="num">Disc %</th><th className="num">Tax</th><th className="num">Total</th><th>Stock</th><th /></tr></thead>
            <tbody>
              {lines.map((l, i) => {
                const p = products.find((x) => x.id === l.productId);
                const r = preview.rows[i];
                const avail = (p?.stock ?? []).reduce((t: number, w: any) => t + Number(w.available), 0);
                return (
                  <tr key={i}>
                    <td>{p?.name ?? 'Unknown'}<div className="muted small">{p?.sku}</div></td>
                    <td className="num"><input style={{ width: 80 }} inputMode="decimal" value={l.quantity} onChange={(e) => setLine(i, { quantity: e.target.value })} /></td>
                    <td>{p?.unit_code}</td>
                    <td className="num">{money(prices[l.productId]?.unitPrice ?? p?.list_price)}</td>
                    <td className="num"><input style={{ width: 70 }} inputMode="decimal" value={l.discountPercent} onChange={(e) => setLine(i, { discountPercent: e.target.value })} /></td>
                    <td className="num">{r ? money(r.taxAmount) : '–'}</td>
                    <td className="num"><b>{r ? money(r.lineTotal) : '–'}</b></td>
                    <td>{p?.track_inventory ? <span className={`badge ${avail >= Number(l.quantity) ? 'ok' : 'warn'}`}>{num(avail)}</span> : '–'}</td>
                    <td><button type="button" className="link" aria-label="Remove" onClick={() => setLines(lines.filter((_, j) => j !== i))}>✕</button></td>
                  </tr>
                );
              })}
              {lines.length === 0 && <tr><td colSpan={9} className="muted">No products yet.</td></tr>}
            </tbody>
            {lines.length > 0 && (
              <tfoot>
                <tr><td colSpan={6} className="num">Subtotal {money(preview.subtotal)} · Discount −{money(preview.discount)} · Tax {money(preview.tax)}</td><td className="num">{money(preview.total)}</td><td colSpan={2} className="muted small">estimate</td></tr>
              </tfoot>
            )}
          </table>
        </div>
        <Field label="Notes"><textarea rows={2} value={header.notes} onChange={(e) => setHeader({ ...header, notes: e.target.value })} /></Field>
      </Card>
      <ErrorBox error={error as any} />
      <div className="row">
        <button disabled={busy} onClick={() => save(false)}>Save draft</button>
        <button className="primary" disabled={busy} onClick={() => save(true)}>{s.online ? 'Submit order' : 'Queue order'}</button>
      </div>
    </Page>
  );
}
export default function P() {
  return <Authed><NewOrder /></Authed>;
}
