'use client';
import { useEffect, useRef, useState } from 'react';
import 'leaflet/dist/leaflet.css';
import { Authed } from '@/components/Authed';
import { Card, ErrorBox, Loading, Page } from '@/components/ui';
import { qs } from '@/lib/api';
import { money, monthStart, today } from '@/lib/format';
import { useApi } from '@/lib/hooks';

const PALETTE = ['#1f6feb', '#1a7f37', '#bf3989', '#9a6700', '#8250df', '#cf222e', '#0a7c86', '#6e7781'];

function TerritoryMap() {
  const [from, setFrom] = useState(monthStart());
  const [to, setTo] = useState(today());
  const [visits, setVisits] = useState(false);
  const { data, error, loading } = useApi(`/sales/territory-map${qs({ from, to, includeVisits: visits })}`);
  const el = useRef<HTMLDivElement>(null);
  const map = useRef<any>(null);
  const layer = useRef<any>(null);

  useEffect(() => {
    if (!data || !el.current) return;
    let cancelled = false;
    (async () => {
      const L = (await import('leaflet')).default;
      if (cancelled) return;
      if (!map.current) {
        map.current = L.map(el.current!).setView([11.56, 104.92], 7);
        L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap contributors' }).addTo(map.current);
      }
      layer.current?.remove();
      layer.current = L.layerGroup().addTo(map.current);
      const color = (tid: string | null) => (tid ? PALETTE[data.territories.findIndex((t: any) => t.id === tid) % PALETTE.length] : '#999');
      const maxSales = Math.max(1, ...data.customers.map((c: any) => Number(c.net_sales)));
      const pts: [number, number][] = [];
      for (const c of data.customers) {
        const ll: [number, number] = [Number(c.latitude), Number(c.longitude)];
        pts.push(ll);
        L.circleMarker(ll, { radius: 5 + 12 * Math.sqrt(Number(c.net_sales) / maxSales), color: color(c.territory_id), weight: 2, fillOpacity: 0.45 })
          .bindPopup(`<b>${escapeHtml(c.name)}</b><br>${escapeHtml(c.code)}<br>Sales ${money(c.net_sales)}<br>Outstanding ${money(c.outstanding)}<br><a href="/customers/view/?id=${c.customer_id}">Open customer</a>`)
          .addTo(layer.current);
      }
      for (const v of data.visits) {
        L.circleMarker([Number(v.latitude), Number(v.longitude)], { radius: 3, color: '#111', weight: 1, fillOpacity: 1 }).bindPopup(`Visit check-in ${new Date(v.checked_in_at).toLocaleString()}`).addTo(layer.current);
      }
      if (pts.length) map.current.fitBounds(pts, { padding: [30, 30], maxZoom: 13 });
    })();
    return () => { cancelled = true; };
  }, [data]);

  return (
    <Page title="Sales territory map" subtitle="Customers with a mapped delivery address; circle size shows sales in the period" actions={<>
      <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} aria-label="From" />
      <input type="date" value={to} onChange={(e) => setTo(e.target.value)} aria-label="To" />
      <label className="row small"><input type="checkbox" checked={visits} onChange={(e) => setVisits(e.target.checked)} /> Visit check-ins</label>
    </>}>
      <ErrorBox error={error} />
      {loading && !data && <Loading />}
      <div ref={el} className="map" />
      {data && (
        <Card title="Territories">
          <div className="table-wrap"><table>
            <thead><tr><th>Territory</th><th>Type</th><th>Representatives</th><th className="num">Mapped customers</th><th className="num">Sales</th></tr></thead>
            <tbody>{data.territories.map((t: any, i: number) => (
              <tr key={t.id}><td><span style={{ display: 'inline-block', width: 10, height: 10, borderRadius: 5, background: PALETTE[i % PALETTE.length], marginRight: 6 }} />{t.name} <span className="muted small">{t.code}</span></td>
                <td>{t.territory_type}</td><td>{(t.representatives ?? []).map((r: any) => `${r.name}${r.role === 'BACKUP' ? ' (backup)' : ''}`).join(', ') || '–'}</td>
                <td className="num">{t.customers}</td><td className="num">{money(t.netSales)}</td></tr>
            ))}</tbody>
          </table></div>
        </Card>
      )}
    </Page>
  );
}
function escapeHtml(s: string) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}
export default function P() {
  return <Authed><TerritoryMap /></Authed>;
}
