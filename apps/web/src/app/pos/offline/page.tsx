'use client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { P, pricePosCart, settlePayments, type PosPricedCart } from '@ckh/shared';
import { Keypad, Sheet } from '@/components/PosShell';
import { ErrorBox } from '@/components/ui';
import { desktopOffline, type DesktopOffline, type DeviceStatus, LICENSE_REASONS, uploadQueue } from '@/lib/device';
import { money, num } from '@/lib/format';
import { newKey, quickCash } from '@/lib/pos';
import { desktop } from '@/lib/receipt';
import { useSession } from '@/lib/session';

/** The catalogue the server handed this device (GET /pos/sync/bootstrap). */
interface Snapshot {
  snapshotAt: string;
  currency: string;
  register: { id: string; code: string; name: string; branch_name: string; hardware: Record<string, any> };
  shift: { id: string; number: string; cashier_id: string } | null;
  settings: { pricesIncludeTax: boolean };
  company: { display_name: string; vat_tin: string | null };
  methods: { id: string; code: string; name: string; kind: string }[];
  categories: { id: string; name: string }[];
  products: {
    id: string; sku: string; barcode: string | null; name: string; parent_name: string | null; category_id: string | null;
    serial_tracked: boolean; packs: { barcode: string; quantity: string }[]; price: string; tax_rate_percent: string;
  }[];
}
type Product = Snapshot['products'][number];
interface Line { product: Product; quantity: string }
interface DoneSale { ref: string; at: string; lines: Line[]; totals: PosPricedCart; tendered: string; change: string }

const label = (p: Product) => (p.parent_name && !p.name.startsWith(p.parent_name) ? `${p.parent_name} · ${p.name}` : p.name);

/**
 * The offline till of the Windows POS app. It sells from the catalogue
 * snapshot at the snapshot's walk-in prices, for cash only, with the same
 * arithmetic as the server (pricePosCart), and queues each sale on this
 * computer. The server replays the queue when the connection is back and
 * flags anything it would have priced or stocked differently for review.
 * Only allowed while this computer holds a valid signed offline licence.
 */
export default function OfflineTill() {
  const s = useSession();
  // Read after mount: the page is prerendered without the Windows app around it.
  const [d, setD] = useState<DesktopOffline | null | undefined>(undefined);
  useEffect(() => setD(desktopOffline()), []);
  const [status, setStatus] = useState<DeviceStatus | null>(null);
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [loaded, setLoaded] = useState(false);

  const refresh = useCallback(async () => {
    if (!d) return;
    setStatus(await d.device.status());
    setSnap(await d.offline.snapshot<Snapshot>());
    setLoaded(true);
  }, [d]);
  useEffect(() => {
    void refresh();
  }, [refresh]);

  if (d === undefined) return <Centre>Loading…</Centre>;
  if (!d) return <Centre>The offline till works only in the CKH ONE POS app for Windows.</Centre>;
  if (s.loading && !s.me) return <Centre>Loading…</Centre>;
  if (!s.me) return <Centre>Sign in once while online before selling offline.</Centre>;
  if (!s.can(P.POS_SALES_CREATE)) return <Centre>Your account cannot record sales.</Centre>;
  if (!loaded || !status) return <Centre>Loading the offline till…</Centre>;
  if (!status.license.valid) return <Centre>{LICENSE_REASONS[status.license.reason ?? 'NO_LICENSE']}</Centre>;
  if (!snap || snap.register.id !== status.registerId) return <Centre>This computer has no catalogue for offline selling yet. Open the till once while online.</Centre>;
  return <Till snap={snap} status={status} userId={s.me.userId} cashier={s.me.fullName} onChange={refresh} />;
}

function Centre({ children }: { children: React.ReactNode }) {
  return (
    <div className="pos-center">
      <div className="notice warn">{children}</div>
      <a href="/pos/">Back to the till</a>
    </div>
  );
}

function Till({ snap, status, userId, cashier, onChange }: { snap: Snapshot; status: DeviceStatus; userId: string; cashier: string; onChange: () => Promise<void> }) {
  const cur = snap.currency;
  const [q, setQ] = useState('');
  const [cat, setCat] = useState<string | null>(null);
  const [lines, setLines] = useState<Line[]>([]);
  const [paying, setPaying] = useState(false);
  const [done, setDone] = useState<DoneSale | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const cash = snap.methods.find((m) => m.kind === 'CASH' && status.license.offlineMethods?.includes(m.id));

  const totals = useMemo(() => {
    if (!lines.length) return null;
    return pricePosCart({
      lines: lines.map((l) => ({ quantity: l.quantity, unitPrice: l.product.price, taxRatePercent: l.product.tax_rate_percent })),
      pricesIncludeTax: snap.settings.pricesIncludeTax,
      currency: cur,
    });
  }, [lines, snap, cur]);

  const shown = useMemo(() => {
    const t = q.trim().toLowerCase();
    return snap.products
      .filter((p) => !cat || p.category_id === cat)
      .filter((p) => !t || label(p).toLowerCase().includes(t) || p.sku.toLowerCase().includes(t) || p.barcode === q.trim())
      .slice(0, 200);
  }, [snap, q, cat]);

  function add(p: Product, qty = '1') {
    setMsg(null);
    if (p.serial_tracked) return setMsg(`${label(p)} needs serial numbers; sell it when the till is online.`);
    setLines((ls) => {
      const i = ls.findIndex((l) => l.product.id === p.id);
      if (i < 0) return [...ls, { product: p, quantity: qty }];
      const next = [...ls];
      next[i] = { ...next[i], quantity: String(Number(next[i].quantity) + Number(qty)) };
      return next;
    });
  }
  function setQty(id: string, delta: number) {
    setLines((ls) => ls.flatMap((l) => (l.product.id !== id ? [l] : Number(l.quantity) + delta <= 0 ? [] : [{ ...l, quantity: String(Number(l.quantity) + delta) }])));
  }
  /** Enter in the search box: an exact barcode (item or pack) adds it; one match adds it. */
  function enter() {
    const code = q.trim();
    if (!code) return;
    const item = snap.products.find((p) => p.barcode === code);
    const pack = !item && snap.products.find((p) => p.packs.some((k) => k.barcode === code));
    if (item) add(item);
    else if (pack) add(pack, pack.packs.find((k) => k.barcode === code)!.quantity);
    else if (shown.length === 1) add(shown[0]);
    else return setMsg(`No product with barcode ${code} in the offline catalogue.`);
    setQ('');
  }

  if (done) {
    return (
      <Frame snap={snap} status={status} cashier={cashier}>
        <DoneView sale={done} snap={snap} cashier={cashier} onNext={() => { setDone(null); setLines([]); void onChange(); input.current?.focus(); }} />
      </Frame>
    );
  }

  return (
    <Frame snap={snap} status={status} cashier={cashier} onUploaded={onChange} userId={userId}>
      <div className="till">
        <section className="till-left">
          <div className="till-search">
            <input
              ref={input}
              autoFocus
              value={q}
              placeholder="Scan barcode or search products"
              aria-label="Scan or search"
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  enter();
                }
              }}
            />
            {q && <button onClick={() => setQ('')}>Clear</button>}
          </div>
          <div className="till-cats">
            <button className={!cat ? 'on' : ''} onClick={() => setCat(null)}>All</button>
            {snap.categories.filter((c) => snap.products.some((p) => p.category_id === c.id)).map((c) => (
              <button key={c.id} className={cat === c.id ? 'on' : ''} onClick={() => setCat(c.id)}>{c.name}</button>
            ))}
          </div>
          <div className="till-grid">
            {shown.length === 0 && <div className="muted">No products match.</div>}
            {shown.map((p) => (
              <button key={p.id} className={`prod${p.serial_tracked ? ' out' : ''}`} onClick={() => add(p)} title={p.sku}>
                <div className="img">{label(p)[0] ?? '?'}</div>
                <div className="meta">
                  <span className="name">{label(p)}</span>
                  <span className="price">{money(p.price, cur)}</span>
                  <span className="small muted">{p.serial_tracked ? 'Online only (serial numbers)' : p.sku}</span>
                </div>
              </button>
            ))}
          </div>
        </section>
        <section className="till-right">
          {!snap.shift && <div className="notice warn small" style={{ margin: 8 }}>No shift was open when the catalogue was saved. Sales will be recorded and flagged for a supervisor.</div>}
          {msg && <div className="notice warn small" style={{ margin: 8 }}>{msg}</div>}
          <div className="till-lines">
            {lines.length === 0 && <div className="muted" style={{ padding: 16 }}>Scan a barcode or tap a product to start a sale.</div>}
            {lines.map((l, i) => (
              <div key={l.product.id} className="cart-line">
                <div>
                  <b>{label(l.product)}</b>
                  <div className="small muted">{num(l.quantity, 3)} × {money(l.product.price, cur)}</div>
                </div>
                <div className="amt">{totals ? money(totals.lines[i].total, cur) : ''}</div>
                <div className="qty">
                  <button aria-label={`One less ${label(l.product)}`} onClick={() => setQty(l.product.id, -1)}>−</button>
                  <button aria-label={`One more ${label(l.product)}`} onClick={() => setQty(l.product.id, 1)}>+</button>
                </div>
              </div>
            ))}
          </div>
          <div className="till-totals">
            <div className="spread"><span>Subtotal</span><span>{totals ? money(totals.subtotal, cur) : '–'}</span></div>
            <div className="spread"><span>Tax {snap.settings.pricesIncludeTax && <span className="muted small">(included)</span>}</span><span>{totals ? money(totals.taxTotal, cur) : '–'}</span></div>
            <div className="spread grand"><span>Total</span><span>{money(totals?.grandTotal ?? 0, cur)}</span></div>
          </div>
          <div className="till-actions">
            <button className="danger" disabled={!lines.length} onClick={() => setLines([])}>Cancel</button>
            <button className="primary pay" disabled={!totals || !cash} onClick={() => setPaying(true)}>
              {cash ? `Cash ${totals ? money(totals.grandTotal, cur) : ''}` : 'Cash is not allowed offline'}
            </button>
          </div>
        </section>
      </div>
      {paying && totals && cash && (
        <PaySheet
          totals={totals}
          currency={cur}
          onClose={() => setPaying(false)}
          onPaid={async (tendered, change) => {
            const ref = newKey();
            await desktopOffline()!.offline.enqueue({
              idempotencyKey: `evt-${ref}`,
              userId,
              catalogSnapshotAt: snap.snapshotAt,
              deviceTotal: totals.grandTotal,
              sale: {
                clientSaleId: ref,
                registerId: snap.register.id,
                lines: lines.map((l) => ({ productId: l.product.id, quantity: l.quantity, unitPrice: l.product.price })),
                payments: [{ methodId: cash.id, amount: tendered }],
              },
            });
            setPaying(false);
            setDone({ ref, at: new Date().toISOString(), lines, totals, tendered, change });
          }}
        />
      )}
    </Frame>
  );
}

function Frame({ snap, status, cashier, children, onUploaded, userId }: { snap: Snapshot; status: DeviceStatus; cashier: string; children: React.ReactNode; onUploaded?: () => Promise<void>; userId?: string }) {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  async function upload() {
    if (!userId) return;
    setBusy(true);
    setNote(null);
    try {
      const r = await uploadQueue(userId);
      const refused = r.results.filter((x) => x.status === 'REJECTED' || x.status === 'CONFLICT').length;
      setNote(`Uploaded ${r.sent} sale${r.sent === 1 ? '' : 's'}${refused ? `, ${refused} refused (see POS devices)` : ''}. ${r.left} waiting.`);
      await onUploaded?.();
    } catch (e) {
      setNote((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="pos">
      <header className="pos-top">
        <span className="brand"><span className="logo">C1</span><span>{snap.company.display_name}</span></span>
        <div className="pos-top-info">
          <span>{snap.register.branch_name}</span>
          <span>{snap.register.code} · {snap.register.name}</span>
          <span>{cashier}</span>
          <span className="badge bad">Offline till</span>
          <span className="muted small">Licence until {new Date(status.license.expiresAt!).toLocaleString()}</span>
        </div>
      </header>
      <div className="notice warn pos-banner spread">
        <span>
          Selling offline from the catalogue saved {new Date(snap.snapshotAt).toLocaleString()}. Cash only. {status.queued} sale{status.queued === 1 ? '' : 's'} waiting to upload.
          {note && <b> {note}</b>}
        </span>
        <span className="row">
          {userId && status.queued > 0 && <button disabled={busy} onClick={upload}>{busy ? 'Uploading…' : 'Upload now'}</button>}
          <a className="btn" href="/pos/sell/">Back to the online till</a>
        </span>
      </div>
      <main className="pos-main wide">{children}</main>
    </div>
  );
}

function PaySheet({ totals, currency, onClose, onPaid }: { totals: PosPricedCart; currency: string; onClose: () => void; onPaid: (tendered: string, change: string) => Promise<void> }) {
  const [amount, setAmount] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const due = totals.grandTotal;
  async function pay(v: string) {
    setError(null);
    try {
      const st = settlePayments(due, [{ kind: 'CASH', amount: v }], currency);
      setBusy(true);
      await onPaid(st.payments[0].tendered, st.changeDue);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }
  return (
    <Sheet title="Cash payment (offline)" onClose={onClose}>
      <div className="small muted">Total due</div>
      <div className="big-total">{money(due, currency)}</div>
      <div className="methods">
        {quickCash(Number(due)).map((v) => (
          <button key={v} disabled={busy} onClick={() => void pay(v.toFixed(2))}>{money(v, currency)}</button>
        ))}
      </div>
      <Keypad value={amount} onChange={setAmount} />
      <ErrorBox error={error} />
      <button className="primary" disabled={busy || !amount} onClick={() => void pay(amount)} style={{ minHeight: 56 }}>Take {amount ? money(amount, currency) : 'cash'}</button>
    </Sheet>
  );
}

const pad = (l: string, r: string, w: number) => `${l.slice(0, w - r.length - 1)}${' '.repeat(Math.max(1, w - Math.min(l.length, w - r.length - 1) - r.length))}${r}`;
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

/** A provisional receipt printed on the till; the sale number is given when the sale uploads. */
function offlineReceipt(sale: DoneSale, snap: Snapshot, cashier: string, width: number) {
  const cur = snap.currency;
  const m = (v: string) => `${new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Number(v))}`;
  const rows = [
    snap.company.display_name,
    snap.company.vat_tin ? `VAT TIN ${snap.company.vat_tin}` : '',
    `${snap.register.branch_name} - ${snap.register.code}`,
    '-'.repeat(width),
    'OFFLINE SALE (provisional receipt)',
    `Ref ${sale.ref.slice(0, 13).toUpperCase()}`,
    new Date(sale.at).toLocaleString('en-GB'),
    `Cashier ${cashier}`,
    '-'.repeat(width),
    ...sale.lines.flatMap((l, i) => [label(l.product), pad(`  ${num(l.quantity, 3)} x ${m(l.product.price)}`, m(sale.totals.lines[i].total), width)]),
    '-'.repeat(width),
    pad('Subtotal', m(sale.totals.subtotal), width),
    pad(`Tax${snap.settings.pricesIncludeTax ? ' (incl.)' : ''}`, m(sale.totals.taxTotal), width),
    pad(`TOTAL ${cur}`, m(sale.totals.grandTotal), width),
    pad('Cash', m(sale.tendered), width),
    pad('Change', m(sale.change), width),
    '-'.repeat(width),
    'Sale number follows when the till',
    'reconnects. Keep this receipt.',
  ].filter((r) => r !== '');
  // ESC/POS printers take ASCII only: drop anything else (product names in Khmer or Chinese print as "?").
  const text = rows.map((r) => r.replace(/[^\x20-\x7e]/g, '?')).join('\n');
  const html = `<!doctype html><meta charset="utf-8"><body style="margin:0;padding:4mm;font:12px/1.35 monospace;white-space:pre-wrap">${esc(rows.join('\n'))}</body>`;
  return { text, html };
}

function DoneView({ sale, snap, cashier, onNext }: { sale: DoneSale; snap: Snapshot; cashier: string; onNext: () => void }) {
  const [printError, setPrintError] = useState<string | null>(null);
  const [printed, setPrinted] = useState(false);
  const hw = snap.register.hardware ?? {};
  const print = useCallback(async (openDrawer: boolean) => {
    setPrintError(null);
    const dp = desktop();
    if (!dp) return;
    try {
      const st = await dp.printerSettings();
      const r = offlineReceipt(sale, snap, cashier, st.paper === '58' ? 32 : 42);
      if (st.mode === 'network') await dp.printText(r.text, { openDrawer });
      else if (st.mode === 'system') {
        const res = await dp.printHtml(r.html, { paper: st.paper });
        if (!res.printed && res.reason) throw new Error(res.reason);
        if (openDrawer) await dp.openDrawer().catch(() => undefined);
      } else if (openDrawer) await dp.openDrawer().catch(() => undefined);
      setPrinted(true);
    } catch (e) {
      setPrintError((e as Error).message);
    }
  }, [sale, snap, cashier]);
  const auto = useRef(false);
  useEffect(() => {
    if (auto.current) return;
    auto.current = true;
    if (hw.autoPrint !== false) void print(hw.openDrawerOnCash !== false);
  }, [print, hw.autoPrint, hw.openDrawerOnCash]);
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Enter' && onNext();
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onNext]);
  return (
    <div className="pos-center" style={{ textAlign: 'center' }}>
      <div className="small muted">Change</div>
      <div className="big-total" data-testid="offline-change">{money(sale.change, snap.currency)}</div>
      <div className="notice ok">Sale saved on this computer. It uploads when the till is back online.</div>
      {printed && <div className="small muted">Receipt printed.</div>}
      <ErrorBox error={printError} />
      <div className="row" style={{ justifyContent: 'center' }}>
        <button onClick={() => void print(false)}>Print receipt</button>
        <button className="primary" onClick={onNext} style={{ minHeight: 56, minWidth: 200 }}>Next sale</button>
      </div>
    </div>
  );
}
