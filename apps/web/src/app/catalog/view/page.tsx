'use client';
import { Authed } from '@/components/Authed';
import { Card, Empty, ErrorBox, Loading, Page, StaleBadge } from '@/components/ui';
import { qs } from '@/lib/api';
import { date, human, money, num } from '@/lib/format';
import { useApi, useQueryParam } from '@/lib/hooks';
import { useSession } from '@/lib/session';

function Product() {
  const id = useQueryParam('id');
  const customerId = useQueryParam('customerId');
  const s = useSession();
  const { data: p, error, loading } = useApi(id && s.online ? `/sales/catalog/products/${id}${qs({ customerId })}` : null);
  const off = !s.online ? s.snapshot?.data.products.find((x: any) => x.id === id) : null;
  const prod = p ?? off;
  if (loading && !prod) return <Loading />;
  if (error) return <ErrorBox error={error} />;
  if (!prod) return <Empty>Product not available offline.</Empty>;
  return (
    <Page title={prod.name} subtitle={`${prod.sku}${prod.barcode ? ` · barcode ${prod.barcode}` : ''}`} actions={<>
      <StaleBadge asOf={p?.stockAsOf ?? s.snapshot?.snapshotAt} />
      {s.can('sales.orders.create') && <a className="btn primary" href={`/orders/new/?productId=${prod.id}${customerId ? `&customerId=${customerId}` : ''}`}>Add to order</a>}
    </>}>
      <div className="grid-2">
        <Card title="Details">
          {prod.image_urls?.length > 0 && <div className="row">{prod.image_urls.map((u: string) => <img key={u} src={u} alt="" style={{ height: 140, borderRadius: 6 }} />)}</div>}
          {prod.description && <p>{prod.description}</p>}
          <div className="small">Category: {prod.category_name ?? '–'} · Unit: {prod.unit_code} · VAT {num(prod.tax_rate_percent)}%</div>
          <div style={{ marginTop: 8 }}>List price <b>{money(prod.list_price)}</b></div>
          {p?.customerPrice && <div>Price for this customer <b>{money(p.customerPrice.unitPrice)}</b> <span className="muted small">({human(p.customerPrice.priceSource)})</span></div>}
        </Card>
        <Card title="Stock by warehouse">
          {(prod.stock ?? []).length === 0 ? <Empty>No stock in warehouses you can sell from.</Empty> : (
            <ul className="list small">{prod.stock.map((w: any) => <li key={w.warehouse_id ?? w.warehouseId} className="spread"><span>{w.warehouse}</span><b>{num(w.available)}</b></li>)}</ul>
          )}
        </Card>
        {p?.units?.length > 0 && <Card title="Units">{p.units.map((u: any) => <div key={u.id} className="small">{u.code ?? u.unit_code}: × {num(u.factor)}</div>)}</Card>}
        {p?.variants?.length > 0 && (
          <Card title="Variants">
            <ul className="list small">{p.variants.map((v: any) => <li key={v.id}><a href={`/catalog/view/?id=${v.id}`}>{v.name}</a> <span className="muted">{v.sku}</span></li>)}</ul>
          </Card>
        )}
        {p?.promotions?.length > 0 && (
          <Card title="Promotions">
            <ul className="list small">{p.promotions.map((x: any) => <li key={x.id}><b>{x.name}</b> · {x.discount_percent ? `${num(x.discount_percent)}% off` : ''} {x.min_quantity ? `from ${num(x.min_quantity)}` : ''} · until {date(x.valid_to)}</li>)}</ul>
          </Card>
        )}
      </div>
    </Page>
  );
}
export default function P() {
  return <Authed><Product /></Authed>;
}
