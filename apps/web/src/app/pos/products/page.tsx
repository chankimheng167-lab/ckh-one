'use client';
import { useEffect, useState } from 'react';
import { PosShell, Sheet, usePos } from '@/components/PosShell';
import { Empty, ErrorBox, Loading, Page } from '@/components/ui';
import { qs } from '@/lib/api';
import { money, num } from '@/lib/format';
import { useApi } from '@/lib/hooks';

export default function PosProductsPage() {
  return (
    <PosShell>
      <Products />
    </PosShell>
  );
}

/** Price and stock lookup for the register's warehouse (the product master itself is managed in CKH ONE). */
function Products() {
  const { ctx } = usePos();
  const [q, setQ] = useState('');
  const [term, setTerm] = useState('');
  const [cat, setCat] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  useEffect(() => {
    const t = setTimeout(() => setTerm(q.trim()), 250);
    return () => clearTimeout(t);
  }, [q]);
  const cats = useApi<any[]>('/pos/catalog/categories');
  const { data, error, loading } = useApi(`/pos/catalog${qs({ registerId: ctx.register!.id, q: term, categoryId: cat, limit: 200 })}`);
  return (
    <Page title="Product catalog" subtitle={`Prices for walk-in customers, stock in ${ctx.register!.warehouse_name}`}>
      <div className="form-grid">
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Name, SKU or barcode" aria-label="Search" />
        <select value={cat} onChange={(e) => setCat(e.target.value)} aria-label="Category">
          <option value="">All categories</option>
          {(cats.data ?? []).map((c) => <option key={c.id} value={c.id}>{c.name} ({c.product_count})</option>)}
        </select>
      </div>
      <ErrorBox error={error} />
      {loading && !data && <Loading />}
      {data?.items?.length === 0 && <Empty>No products match.</Empty>}
      {!!data?.items?.length && (
        <div className="table-wrap">
          <table>
            <thead><tr><th>Product</th><th>SKU</th><th>Barcode</th><th>Category</th><th className="num">Price</th><th className="num">Tax %</th><th className="num">Available</th><th /></tr></thead>
            <tbody>
              {data.items.map((p: any) => (
                <tr key={p.id}>
                  <td>{p.name}{p.name_local && <div className="small muted">{p.name_local}</div>}</td>
                  <td>{p.sku}</td>
                  <td>{p.barcode ?? ''}</td>
                  <td>{p.category_name ?? ''}</td>
                  <td className="num">{p.variant_count > 0 ? `${money(p.price_from, p.currency)} – ${money(p.price_to, p.currency)}` : money(p.price, p.currency)}</td>
                  <td className="num">{p.tax_rate_percent !== undefined ? num(p.tax_rate_percent) : ''}</td>
                  <td className="num">
                    {p.track_inventory ? num(p.available) : 'Not tracked'} {p.low_stock && <span className="badge warn">Low</span>}
                  </td>
                  <td><button onClick={() => setOpen(p.id)}>{p.variant_count > 0 ? `${p.variant_count} variants` : 'Details'}</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {open && <ProductSheet id={open} registerId={ctx.register!.id} onClose={() => setOpen(null)} />}
    </Page>
  );
}

function ProductSheet({ id, registerId, onClose }: { id: string; registerId: string; onClose: () => void }) {
  const { data: p, error } = useApi(`/pos/catalog/products/${id}${qs({ registerId })}`);
  return (
    <Sheet title={p?.name ?? 'Product'} onClose={onClose} wide>
      <ErrorBox error={error} />
      {!p && <Loading />}
      {p && (
        <>
          {p.image_urls?.[0] && <img src={p.image_urls[0]} alt="" style={{ maxHeight: 160, objectFit: 'contain' }} />}
          {p.description && <p className="small">{p.description}</p>}
          <div className="kv">
            <span>SKU</span><span>{p.sku}</span>
            {p.price && <><span>Price</span><span>{money(p.price, p.currency)}</span></>}
            {!p.variants.length && <><span>Available here</span><span>{num(p.available)}</span></>}
            {p.reorder_point && <><span>Reorder point</span><span>{num(p.reorder_point)}</span></>}
            {p.serial_tracked && <><span>Serial numbers</span><span>Required at sale</span></>}
          </div>
          {p.variants.length > 0 && (
            <table>
              <thead><tr><th>Variant</th><th>SKU</th><th>Barcode</th><th className="num">Price</th><th className="num">Available</th></tr></thead>
              <tbody>
                {p.variants.map((v: any) => (
                  <tr key={v.id}>
                    <td>{Object.entries(v.variant_attributes ?? {}).map(([k, x]) => `${k}: ${x}`).join(', ')}</td>
                    <td>{v.sku}</td><td>{v.barcode ?? ''}</td>
                    <td className="num">{money(v.price, p.currency)}</td>
                    <td className="num">{v.track_inventory ? num(v.available) : '–'} {v.low_stock && <span className="badge warn">Low</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {p.other_warehouses.length > 0 && (
            <div className="small">Other warehouses: {p.other_warehouses.map((w: any) => `${w.warehouse} (${num(w.available)})`).join(', ')}</div>
          )}
        </>
      )}
    </Sheet>
  );
}
