'use client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { P } from '@ckh/shared';
import { Keypad, PosShell, Sheet, usePos } from '@/components/PosShell';
import { ErrorBox, Field } from '@/components/ui';
import { api, ApiError, qs } from '@/lib/api';
import { money, num } from '@/lib/format';
import { useAction, useApi } from '@/lib/hooks';
import { type Cart, type CartLine, cartPayload, emptyCart, newKey, type PosMethod, posMessage, quickCash, takeResume } from '@/lib/pos';

const CART_KEY = 'ckh.pos.cart';

/** The till: product grid and scanner on the left, the cart and payment on the right. */
export default function SellPage() {
  return (
    <PosShell wide>
      <Till />
    </PosShell>
  );
}

function Till() {
  const pos = usePos();
  const { ctx } = pos;
  const registerId = ctx.register!.id;
  const cur = ctx.currency;
  const [cart, setCart] = useState<Cart>(emptyCart);
  const [quote, setQuote] = useState<any>(null);
  const [quoteError, setQuoteError] = useState<ApiError | null>(null);
  const [quoting, setQuoting] = useState(false);
  const [sel, setSel] = useState<string | null>(null);
  const [sheet, setSheet] = useState<null | 'customer' | 'discount' | 'pay' | 'hold' | 'line' | 'clear'>(null);
  const [variantOf, setVariantOf] = useState<string | null>(null);
  const [serialFor, setSerialFor] = useState<{ productId: string; sku: string; name: string } | null>(null);
  const [done, setDone] = useState<any>(null);
  const [flash, setFlash] = useState<{ tone: 'ok' | 'bad' | 'warn'; text: string } | null>(null);
  const loaded = useRef(false);

  // The cart survives a page reload on this device (not a sale until checked out).
  useEffect(() => {
    const resumed = takeResume();
    if (resumed) setCart(resumed);
    else {
      try {
        const saved = JSON.parse(sessionStorage.getItem(CART_KEY) ?? 'null');
        if (saved?.registerId === registerId) setCart(saved.cart);
      } catch {
        /* ignore */
      }
    }
    loaded.current = true;
  }, [registerId]);
  useEffect(() => {
    if (!loaded.current) return;
    try {
      sessionStorage.setItem(CART_KEY, JSON.stringify({ registerId, cart }));
    } catch {
      /* ignore */
    }
  }, [cart, registerId]);

  // Every cart change is priced by the server: the till never computes totals itself.
  const payloadJson = useMemo(() => JSON.stringify(cartPayload(registerId, cart)), [registerId, cart]);
  useEffect(() => {
    if (!cart.lines.length) {
      setQuote(null);
      setQuoteError(null);
      return;
    }
    let stale = false;
    setQuoting(true);
    const t = setTimeout(async () => {
      try {
        const q = await api.post('/pos/quote', JSON.parse(payloadJson));
        if (stale) return;
        setQuote(q);
        setQuoteError(null);
        // Names and SKUs from the server (resumed carts arrive without them).
        setCart((c) => {
          let changed = false;
          const lines = c.lines.map((l, i) => {
            const ql = q.lines[i];
            if (ql && ql.productId === l.productId && (l.name !== ql.name || l.sku !== ql.sku || l.serialTracked !== ql.serialTracked)) {
              changed = true;
              return { ...l, name: ql.name, sku: ql.sku, serialTracked: ql.serialTracked };
            }
            return l;
          });
          return changed ? { ...c, lines } : c;
        });
      } catch (e) {
        if (!stale) setQuoteError(e as ApiError);
      } finally {
        if (!stale) setQuoting(false);
      }
    }, 200);
    return () => {
      stale = true;
      clearTimeout(t);
    };
  }, [payloadJson, cart.lines.length]);

  const notify = (tone: 'ok' | 'bad' | 'warn', text: string) => {
    setFlash({ tone, text });
    setTimeout(() => setFlash((f) => (f?.text === text ? null : f)), 4000);
  };

  const addProduct = useCallback((p: { id: string; sku: string; name: string; serial_tracked?: boolean; image_urls?: string[] | null }, qty = '1', serial?: string) => {
    setCart((c) => {
      const same = !serial && !p.serial_tracked ? c.lines.find((l) => l.productId === p.id && !l.unitPrice && !l.serialNumbers.length) : null;
      if (same) {
        const lines = c.lines.map((l) => (l === same ? { ...l, quantity: String(Number(l.quantity) + Number(qty)) } : l));
        setSel(same.key);
        return { ...c, lines };
      }
      const serialLine = serial ? c.lines.find((l) => l.productId === p.id && l.serialNumbers.length) : null;
      if (serialLine && serial) {
        if (serialLine.serialNumbers.some((s) => s.toLowerCase() === serial.toLowerCase())) return c;
        const lines = c.lines.map((l) =>
          l === serialLine ? { ...l, serialNumbers: [...l.serialNumbers, serial], quantity: String(l.serialNumbers.length + 1) } : l,
        );
        setSel(serialLine.key);
        return { ...c, lines };
      }
      const line: CartLine = {
        key: newKey(),
        productId: p.id,
        sku: p.sku,
        name: p.name,
        quantity: serial ? '1' : qty,
        serialNumbers: serial ? [serial] : [],
        serialTracked: !!p.serial_tracked,
        image: p.image_urls?.[0] ?? null,
      };
      setSel(line.key);
      return { ...c, lines: [...c.lines, line] };
    });
  }, []);

  const pick = useCallback(
    (p: any, qty = '1') => {
      if (p.variant_count > 0) return setVariantOf(p.id);
      if (p.serial_tracked) return setSerialFor({ productId: p.id, sku: p.sku, name: p.name });
      addProduct(p, qty);
    },
    [addProduct],
  );

  const scan = useCallback(
    async (code: string): Promise<boolean> => {
      try {
        const p = await api.get(`/pos/catalog/barcode/${encodeURIComponent(code)}${qs({ registerId, customerId: cart.customer?.id })}`);
        pick(p, p.quantity);
        notify(p.low_stock ? 'warn' : 'ok', `${p.name}${p.low_stock ? ' (low stock)' : ''}`);
        return true;
      } catch (e) {
        const err = e as ApiError;
        if (err.code === 'VARIANT_REQUIRED') {
          setVariantOf((err.details as any)?.productId);
          return true;
        }
        if (err.code === 'BARCODE_NOT_FOUND') return false;
        notify('bad', err.message);
        return true;
      }
    },
    [registerId, cart.customer?.id, pick],
  );

  // Keyboard-wedge scanners type fast and end with Enter/Tab. Catch them even when no field has focus.
  useEffect(() => {
    let buf = '';
    let last = 0;
    const suffix = ctx.register?.hardware?.scannerSuffix ?? 'ENTER';
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT') || sheet || variantOf || serialFor) return;
      const now = Date.now();
      if (now - last > 60) buf = '';
      last = now;
      if ((e.key === 'Enter' && suffix !== 'TAB') || (e.key === 'Tab' && suffix === 'TAB')) {
        if (buf.length >= 3) {
          e.preventDefault();
          void scan(buf).then((ok) => !ok && notify('bad', `No product with barcode ${buf}`));
        }
        buf = '';
      } else if (e.key.length === 1) buf += e.key;
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [scan, sheet, variantOf, serialFor, ctx.register]);

  const updateLine = (key: string, patch: Partial<CartLine>) => setCart((c) => ({ ...c, lines: c.lines.map((l) => (l.key === key ? { ...l, ...patch } : l)) }));
  const removeLine = (key: string) => setCart((c) => ({ ...c, lines: c.lines.filter((l) => l.key !== key) }));
  const selected = cart.lines.find((l) => l.key === sel) ?? null;
  const qLine = (key: string) => quote?.lines?.[cart.lines.findIndex((l) => l.key === key)];
  const totals = quote?.totals;
  const needShift = ctx.settings.requireOpenShift && !ctx.shift;
  const othersShift = ctx.shift && ctx.shift.cashier_id !== ctx.user.id;
  const canPay = cart.lines.length > 0 && !!totals && !quoteError && !quoting && !needShift;

  if (done) {
    return (
      <Done
        result={done}
        onNext={() => {
          setDone(null);
          setCart(emptyCart());
          setQuote(null);
        }}
      />
    );
  }

  return (
    <div className="till">
      <section className="till-left">
        <Catalogue registerId={registerId} customerId={cart.customer?.id} currency={cur} onPick={pick} onScan={scan} />
      </section>

      <section className="till-right">
        {needShift && <OpenShiftInline />}
        {othersShift && (
          <div className="notice warn" style={{ margin: 8 }}>
            This register’s shift belongs to another cashier. Ask them to close it, or a supervisor must check out.
          </div>
        )}
        <div className="till-cust spread">
          <div>
            <div className="small muted">Customer</div>
            <b>{cart.customer ? cart.customer.name : 'Walk-in customer'}</b>
            {cart.customer?.phone && <span className="muted small"> · {cart.customer.phone}</span>}
          </div>
          <button onClick={() => setSheet('customer')}>{cart.customer ? 'Change' : 'Select'}</button>
        </div>

        <div className="till-lines">
          {cart.lines.length === 0 && <div className="muted" style={{ padding: 16 }}>Scan a barcode or tap a product to start a sale.</div>}
          {cart.lines.map((l) => {
            const ql = qLine(l.key);
            return (
              <div
                key={l.key}
                className={`cart-line${l.key === sel ? ' sel' : ''}`}
                onClick={() => {
                  setSel(l.key);
                  setSheet('line');
                }}
              >
                <div>
                  <b>{l.name || l.sku}</b>
                  <div className="small muted">
                    {num(l.quantity, 4)} × {ql ? money(ql.unitPrice, cur) : '…'}
                    {ql?.priceSource === 'OVERRIDE' && <span className="badge warn" style={{ marginLeft: 6 }}>Price changed</span>}
                    {ql && Number(ql.discountTotal) > 0 && <span className="badge info" style={{ marginLeft: 6 }}>−{money(ql.discountTotal, cur)}</span>}
                  </div>
                  {l.serialNumbers.length > 0 && <div className="small muted">S/N {l.serialNumbers.join(', ')}</div>}
                </div>
                <div className="amt">{ql ? money(ql.total, cur) : '…'}</div>
              </div>
            );
          })}
        </div>

        {quoteError && (
          <div style={{ padding: '0 12px' }}>
            <ErrorBox error={posMessage(quoteError)} />
          </div>
        )}
        {quote?.stockShortfalls?.length > 0 && (
          <div className="notice warn small" style={{ margin: '6px 12px' }}>
            {quote.stockShortfalls.map((s: any) => `${s.name}: ${num(s.available)} in stock, ${num(s.quantity)} in cart`).join('; ')}
          </div>
        )}
        {quote?.approvalRequired?.length > 0 && (
          <div className="notice warn small" style={{ margin: '6px 12px' }}>A supervisor will need to approve the discount or price change at payment.</div>
        )}

        <div className="till-totals">
          <div className="spread"><span>Subtotal</span><span>{totals ? money(totals.subtotal, cur) : '–'}</span></div>
          {totals && Number(totals.discountTotal) > 0 && (
            <div className="spread"><span>Discounts</span><span>−{money(totals.discountTotal, cur)}</span></div>
          )}
          <div className="spread">
            <span>Tax {ctx.settings.pricesIncludeTax && <span className="muted small">(included)</span>}</span>
            <span>{totals ? money(totals.taxTotal, cur) : '–'}</span>
          </div>
          <div className="spread grand"><span>Total</span><span>{totals ? money(totals.grandTotal, cur) : money(0, cur)}</span></div>
          {quoting && <div className="small muted">Pricing…</div>}
        </div>

        {flash && <div className={`notice ${flash.tone} small`} style={{ margin: '0 12px 6px' }}>{flash.text}</div>}

        <div className="till-actions">
          <button disabled={!cart.lines.length || !pos.can(P.POS_DISCOUNT_APPLY)} onClick={() => setSheet('discount')} title={pos.can(P.POS_DISCOUNT_APPLY) ? '' : 'You may not give discounts'}>
            Discount
          </button>
          <button disabled={!cart.lines.length} onClick={() => setSheet('hold')}>Hold</button>
          <button className="danger" disabled={!cart.lines.length} onClick={() => setSheet('clear')}>Cancel</button>
          <button className="primary pay" disabled={!canPay} onClick={() => setSheet('pay')}>
            Pay {totals ? money(totals.grandTotal, cur) : ''}
          </button>
        </div>
      </section>

      {variantOf && (
        <VariantSheet
          productId={variantOf}
          registerId={registerId}
          customerId={cart.customer?.id}
          currency={cur}
          onClose={() => setVariantOf(null)}
          onPick={(v) => {
            setVariantOf(null);
            pick(v);
          }}
        />
      )}
      {serialFor && (
        <SerialSheet
          product={serialFor}
          onClose={() => setSerialFor(null)}
          onAdd={(sn) => addProduct({ id: serialFor.productId, sku: serialFor.sku, name: serialFor.name, serial_tracked: true }, '1', sn)}
        />
      )}
      {sheet === 'line' && selected && (
        <LineSheet
          line={selected}
          quoted={qLine(selected.key)}
          currency={cur}
          canDiscount={pos.can(P.POS_DISCOUNT_APPLY)}
          canOverride={pos.can(P.POS_PRICE_OVERRIDE)}
          onChange={(p) => updateLine(selected.key, p)}
          onRemove={() => {
            removeLine(selected.key);
            setSheet(null);
          }}
          onClose={() => setSheet(null)}
        />
      )}
      {sheet === 'customer' && (
        <CustomerSheet
          canCreate={pos.can(P.POS_SALES_CREATE)}
          onClose={() => setSheet(null)}
          onPick={(c) => {
            setCart((x) => ({ ...x, customer: c }));
            setSheet(null);
          }}
        />
      )}
      {sheet === 'discount' && (
        <OrderDiscountSheet
          cart={cart}
          max={ctx.settings.cashierMaxDiscountPercent}
          onClose={() => setSheet(null)}
          onApply={(d) => {
            setCart((c) => ({ ...c, ...d }));
            setSheet(null);
          }}
        />
      )}
      {sheet === 'hold' && (
        <HoldSheet
          registerId={registerId}
          cart={cart}
          onClose={() => setSheet(null)}
          onHeld={() => {
            setSheet(null);
            setCart(emptyCart());
            notify('ok', 'Sale held. Find it under Held sales.');
          }}
        />
      )}
      {sheet === 'clear' && (
        <Sheet title="Cancel this sale?" onClose={() => setSheet(null)}>
          <p>The cart is cleared. Nothing has been charged and no stock has moved.</p>
          <div className="row">
            <button onClick={() => setSheet(null)}>Keep the sale</button>
            <button
              className="danger"
              onClick={() => {
                setCart(emptyCart());
                setSheet(null);
              }}
            >
              Cancel sale
            </button>
          </div>
        </Sheet>
      )}
      {sheet === 'pay' && totals && (
        <PaymentSheet
          registerId={registerId}
          cart={cart}
          grandTotal={totals.grandTotal}
          currency={cur}
          methods={ctx.paymentMethods}
          onClose={() => setSheet(null)}
          onRequote={() => setCart((c) => ({ ...c }))}
          onDone={(r) => {
            setSheet(null);
            setDone(r);
            try {
              sessionStorage.removeItem(CART_KEY);
            } catch {
              /* ignore */
            }
          }}
        />
      )}
    </div>
  );
}

function Catalogue({ registerId, customerId, currency, onPick, onScan }: {
  registerId: string; customerId?: string; currency: string; onPick: (p: any) => void; onScan: (code: string) => Promise<boolean>;
}) {
  const [q, setQ] = useState('');
  const [term, setTerm] = useState('');
  const [cat, setCat] = useState<string | null>(null);
  const cats = useApi<any[]>('/pos/catalog/categories');
  const list = useApi<any>(`/pos/catalog${qs({ registerId, q: term, categoryId: cat, customerId, limit: 120 })}`);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const t = setTimeout(() => setTerm(q.trim()), 250);
    return () => clearTimeout(t);
  }, [q]);
  useEffect(() => input.current?.focus(), []);

  async function enter() {
    const v = q.trim();
    if (!v) return;
    // A code without spaces is tried as a barcode/SKU first; otherwise it is a search.
    if (!/\s/.test(v) && (await onScan(v))) {
      setQ('');
      setTerm('');
      return;
    }
    const items = list.data?.items ?? [];
    if (items.length === 1) {
      onPick(items[0]);
      setQ('');
    }
  }

  return (
    <>
      <div className="till-search">
        <input
          ref={input}
          value={q}
          placeholder="Scan barcode or search products"
          aria-label="Scan or search"
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              void enter();
            }
          }}
        />
        {q && <button onClick={() => setQ('')}>Clear</button>}
      </div>
      <div className="till-cats">
        <button className={!cat ? 'on' : ''} onClick={() => setCat(null)}>All</button>
        {(cats.data ?? []).filter((c) => c.product_count > 0).map((c) => (
          <button key={c.id} className={cat === c.id ? 'on' : ''} onClick={() => setCat(c.id)}>{c.name}</button>
        ))}
      </div>
      <div className="till-grid">
        {list.error && <ErrorBox error={list.error} />}
        {list.loading && !list.data && <div className="muted">Loading products…</div>}
        {list.data?.items?.length === 0 && <div className="muted">No products match.</div>}
        {(list.data?.items ?? []).map((p: any) => {
          const out = p.track_inventory && p.product_type === 'STOCK' && Number(p.available) <= 0;
          return (
            <button key={p.id} className={`prod${out ? ' out' : ''}`} onClick={() => onPick(p)} title={p.sku}>
              <div className="img">{p.image_urls?.[0] ? <img src={p.image_urls[0]} alt="" loading="lazy" /> : (p.name?.[0] ?? '?')}</div>
              <div className="meta">
                <span className="name">{p.name}</span>
                <span className="price">
                  {p.variant_count > 0
                    ? p.price_from === p.price_to ? money(p.price_from, currency) : `${money(p.price_from, currency)}+`
                    : money(p.price, currency)}
                </span>
                <span className="small muted">
                  {p.variant_count > 0 ? `${p.variant_count} options · ` : ''}
                  {p.track_inventory && p.product_type === 'STOCK' ? (out ? 'Out of stock' : `${num(p.available)} in stock`) : 'Service'}
                  {p.low_stock && !out && <span className="badge warn" style={{ marginLeft: 4 }}>Low</span>}
                </span>
              </div>
            </button>
          );
        })}
      </div>
    </>
  );
}

function VariantSheet({ productId, registerId, customerId, currency, onClose, onPick }: {
  productId: string; registerId: string; customerId?: string; currency: string; onClose: () => void; onPick: (v: any) => void;
}) {
  const { data, error, loading } = useApi(`/pos/catalog/products/${productId}${qs({ registerId, customerId })}`);
  const [chosen, setChosen] = useState<Record<string, string>>({});
  const opts = (data?.variant_options ?? {}) as Record<string, string[]>;
  const matches = (data?.variants ?? []).filter((v: any) => Object.entries(chosen).every(([k, val]) => String(v.variant_attributes?.[k]) === val));
  return (
    <Sheet title={data?.name ?? 'Choose an option'} onClose={onClose} wide>
      {loading && <div className="muted">Loading…</div>}
      <ErrorBox error={error} />
      {Object.entries(opts).map(([k, values]) => (
        <div key={k}>
          <div className="small muted" style={{ textTransform: 'capitalize' }}>{k}</div>
          <div className="row">
            {values.map((v) => (
              <button key={v} className={chosen[k] === v ? 'primary' : ''} onClick={() => setChosen({ ...chosen, [k]: chosen[k] === v ? '' : v })}>{v}</button>
            ))}
          </div>
        </div>
      ))}
      <div className="pos-tiles">
        {matches.map((v: any) => {
          const out = v.track_inventory && Number(v.available) <= 0;
          return (
            <button key={v.id} className="pos-tile" disabled={false} onClick={() => onPick({ ...v, variant_count: 0 })}>
              <b>{Object.values(v.variant_attributes ?? {}).join(' / ') || v.sku}</b>
              <span>{money(v.price, currency)}</span>
              <span className={`small ${out ? '' : 'muted'}`} style={out ? { color: 'var(--ckh-danger)' } : undefined}>
                {v.track_inventory ? (out ? 'Out of stock' : `${num(v.available)} in stock`) : ''}
              </span>
            </button>
          );
        })}
      </div>
      {data?.other_warehouses?.length > 0 && (
        <div className="small muted">Also in stock at: {data.other_warehouses.map((w: any) => `${w.warehouse} (${num(w.available)})`).join(', ')}</div>
      )}
    </Sheet>
  );
}

function SerialSheet({ product, onClose, onAdd }: { product: { name: string }; onClose: () => void; onAdd: (sn: string) => void }) {
  const [sn, setSn] = useState('');
  const [added, setAdded] = useState<string[]>([]);
  const add = () => {
    const v = sn.trim();
    if (!v) return;
    onAdd(v);
    setAdded((a) => [...a, v]);
    setSn('');
  };
  return (
    <Sheet title={`Serial number: ${product.name}`} onClose={onClose}>
      <p className="small muted">Scan or type the serial number of each unit sold. Each serial can be sold once.</p>
      <input autoFocus value={sn} onChange={(e) => setSn(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), add())} placeholder="Serial number" />
      {added.length > 0 && <div className="small">Added: {added.join(', ')}</div>}
      <div className="row">
        <button className="primary" onClick={add} disabled={!sn.trim()}>Add unit</button>
        <button onClick={onClose}>Done</button>
      </div>
    </Sheet>
  );
}

function LineSheet({ line, quoted, currency, canDiscount, canOverride, onChange, onRemove, onClose }: {
  line: CartLine; quoted: any; currency: string; canDiscount: boolean; canOverride: boolean;
  onChange: (p: Partial<CartLine>) => void; onRemove: () => void; onClose: () => void;
}) {
  const [field, setField] = useState<'qty' | 'pct' | 'amt' | 'price'>('qty');
  const value = field === 'qty' ? line.quantity : field === 'pct' ? line.discountPercent ?? '' : field === 'amt' ? line.discountAmount ?? '' : line.unitPrice ?? '';
  const set = (v: string) => {
    if (field === 'qty') onChange({ quantity: v || '0' });
    else if (field === 'pct') onChange({ discountPercent: v, discountAmount: undefined });
    else if (field === 'amt') onChange({ discountAmount: v, discountPercent: undefined });
    else onChange({ unitPrice: v });
  };
  const serial = line.serialNumbers.length > 0;
  return (
    <Sheet title={line.name || line.sku} onClose={onClose}>
      <div className="small muted">{line.sku} · list price {quoted ? money(quoted.listUnitPrice, currency) : '…'}</div>
      {!serial && (
        <div className="qty">
          <button onClick={() => onChange({ quantity: String(Math.max(1, Number(line.quantity) - 1)) })} aria-label="One less">−</button>
          <b style={{ minWidth: 60, textAlign: 'center' }}>{num(line.quantity, 4)}</b>
          <button onClick={() => onChange({ quantity: String(Number(line.quantity) + 1) })} aria-label="One more">＋</button>
        </div>
      )}
      {serial && (
        <div>
          <div className="small muted">Serial numbers (quantity follows)</div>
          {line.serialNumbers.map((s) => (
            <div key={s} className="spread small">
              <span>{s}</span>
              <button
                className="link"
                onClick={() => {
                  const left = line.serialNumbers.filter((x) => x !== s);
                  if (!left.length) onRemove();
                  else onChange({ serialNumbers: left, quantity: String(left.length) });
                }}
              >
                Remove
              </button>
            </div>
          ))}
        </div>
      )}
      <div className="tabs">
        {!serial && <button className={field === 'qty' ? 'on' : ''} onClick={() => setField('qty')}>Quantity</button>}
        {canDiscount && <button className={field === 'pct' ? 'on' : ''} onClick={() => setField('pct')}>Discount %</button>}
        {canDiscount && <button className={field === 'amt' ? 'on' : ''} onClick={() => setField('amt')}>Discount {currency}</button>}
        {canOverride && <button className={field === 'price' ? 'on' : ''} onClick={() => setField('price')}>Price</button>}
      </div>
      {(field !== 'qty' || !serial) && <Keypad value={value} onChange={set} decimals />}
      {quoted && (
        <div className="kv small">
          <span>Line discount</span><span>{money(quoted.lineDiscount, currency)}</span>
          <span>Tax ({num(quoted.taxRatePercent)}%)</span><span>{money(quoted.tax, currency)}</span>
          <b>Line total</b><b>{money(quoted.total, currency)}</b>
        </div>
      )}
      <div className="row">
        <button className="danger" onClick={onRemove}>Remove item</button>
        {(line.discountPercent || line.discountAmount || line.unitPrice) && (
          <button onClick={() => onChange({ discountPercent: undefined, discountAmount: undefined, unitPrice: undefined })}>Reset price & discount</button>
        )}
        <button className="primary" onClick={onClose}>Done</button>
      </div>
    </Sheet>
  );
}

function OrderDiscountSheet({ cart, max, onApply, onClose }: { cart: Cart; max: string; onApply: (d: Partial<Cart>) => void; onClose: () => void }) {
  const [mode, setMode] = useState<'pct' | 'amt'>(cart.orderDiscountAmount ? 'amt' : 'pct');
  const [v, setV] = useState(cart.orderDiscountAmount ?? cart.orderDiscountPercent ?? '');
  return (
    <Sheet title="Discount on the whole sale" onClose={onClose}>
      <div className="tabs">
        <button className={mode === 'pct' ? 'on' : ''} onClick={() => setMode('pct')}>Percent</button>
        <button className={mode === 'amt' ? 'on' : ''} onClick={() => setMode('amt')}>Amount</button>
      </div>
      <Keypad value={v} onChange={setV} />
      <div className="small muted">You can give up to {num(max)}% yourself; more needs a supervisor’s PIN at payment.</div>
      <div className="row">
        <button onClick={() => onApply({ orderDiscountPercent: undefined, orderDiscountAmount: undefined })}>Remove discount</button>
        <button
          className="primary"
          onClick={() => onApply(mode === 'pct' ? { orderDiscountPercent: v || undefined, orderDiscountAmount: undefined } : { orderDiscountAmount: v || undefined, orderDiscountPercent: undefined })}
        >
          Apply
        </button>
      </div>
    </Sheet>
  );
}

function CustomerSheet({ canCreate, onPick, onClose }: { canCreate: boolean; onPick: (c: Cart['customer']) => void; onClose: () => void }) {
  const [q, setQ] = useState('');
  const [term, setTerm] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setTerm(q.trim()), 250);
    return () => clearTimeout(t);
  }, [q]);
  const { data, error, loading } = useApi<any[]>(`/pos/customers${qs({ q: term })}`);
  const [creating, setCreating] = useState(false);
  const [f, setF] = useState({ name: '', phone: '' });
  const act = useAction();
  async function create() {
    const c = await act.run(() => api.post('/pos/customers', { name: f.name, phone: f.phone || undefined }));
    if (c) onPick({ id: c.id, name: c.name, phone: c.phone });
  }
  return (
    <Sheet title="Customer" onClose={onClose}>
      {!creating ? (
        <>
          <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Name, phone or code" />
          <ErrorBox error={error} />
          <ul className="list">
            <li>
              <button className="link" onClick={() => onPick(null)}>Walk-in customer (no name)</button>
            </li>
            {loading && <li className="muted">Searching…</li>}
            {(data ?? []).map((c) => (
              <li key={c.id}>
                <button className="link" onClick={() => onPick({ id: c.id, name: c.name, phone: c.phone })}>
                  {c.name}
                </button>{' '}
                <span className="muted small">{[c.code, c.phone].filter(Boolean).join(' · ')}</span>
              </li>
            ))}
          </ul>
          {canCreate && <button onClick={() => { setCreating(true); setF({ name: q, phone: '' }); }}>New customer</button>}
        </>
      ) : (
        <>
          <Field label="Name"><input autoFocus value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
          <Field label="Phone"><input inputMode="tel" value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} /></Field>
          <ErrorBox error={act.error} />
          <div className="row">
            <button onClick={() => setCreating(false)}>Back</button>
            <button className="primary" disabled={!f.name.trim() || act.busy} onClick={create}>Save customer</button>
          </div>
        </>
      )}
    </Sheet>
  );
}

function HoldSheet({ registerId, cart, onHeld, onClose }: { registerId: string; cart: Cart; onHeld: () => void; onClose: () => void }) {
  const [label, setLabel] = useState(cart.customer?.name ?? '');
  const act = useAction();
  async function hold() {
    const r = await act.run(() => api.post('/pos/held-sales', { label: label.trim() || `Sale ${new Date().toLocaleTimeString()}`, cart: cartPayload(registerId, cart) }));
    if (r) onHeld();
  }
  return (
    <Sheet title="Hold this sale" onClose={onClose}>
      <p className="small muted">The cart is parked on this register so you can serve the next customer. Prices are checked again when it is resumed.</p>
      <Field label="Label (customer name or description)"><input autoFocus value={label} onChange={(e) => setLabel(e.target.value)} maxLength={80} /></Field>
      <ErrorBox error={act.error} />
      <button className="primary" disabled={act.busy} onClick={hold}>Hold sale</button>
    </Sheet>
  );
}

interface Tender {
  key: string;
  method: PosMethod;
  amount: string;
  reference?: string;
}

/**
 * Taking payment: one or more tenders. Cash may exceed what is due (change
 * is given); other methods may not. The server re-prices and re-checks
 * everything; the client sale id makes a retry safe after a dropped
 * connection (the same sale comes back, it is never recorded twice).
 */
function PaymentSheet({ registerId, cart, grandTotal, currency, methods, onClose, onDone, onRequote }: {
  registerId: string; cart: Cart; grandTotal: string; currency: string; methods: PosMethod[];
  onClose: () => void; onDone: (r: any) => void; onRequote: () => void;
}) {
  const due = Number(grandTotal);
  const [tenders, setTenders] = useState<Tender[]>([]);
  const [method, setMethod] = useState<PosMethod | null>(methods.find((m) => m.kind === 'CASH') ?? methods[0] ?? null);
  const [amount, setAmount] = useState('');
  const [reference, setReference] = useState('');
  const [approval, setApproval] = useState<{ userId: string; pin: string } | null>(null);
  const [askApproval, setAskApproval] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const clientSaleId = useRef(newKey());

  const paid = tenders.reduce((a, t) => a + Number(t.amount), 0);
  const remaining = Math.max(0, Math.round((due - paid) * 100) / 100);
  const cashPaid = tenders.filter((t) => t.method.kind === 'CASH').reduce((a, t) => a + Number(t.amount), 0);
  const change = Math.max(0, Math.round((paid - due) * 100) / 100);
  const ready = paid + 1e-9 >= due && change <= cashPaid + 1e-9;

  function add(m: PosMethod, amt: string, ref?: string) {
    setError(null);
    const n = Number(amt);
    if (!(n > 0)) return setError('Enter an amount.');
    if (m.kind !== 'CASH' && n > remaining + 1e-9) return setError(`${m.name} cannot be more than the ${money(remaining, currency)} still due.`);
    if (m.requires_reference && !ref?.trim()) return setError(`${m.name} needs the transaction reference.`);
    if (ref && /^\d[\d\s-]{11,}$/.test(ref.trim())) return setError('That looks like a card number. Enter the approval code or transaction id, never the card number.');
    setTenders((t) => [...t, { key: newKey(), method: m, amount: n.toFixed(2), reference: ref?.trim() || undefined }]);
    setAmount('');
    setReference('');
  }

  async function complete(withApproval = approval) {
    setBusy(true);
    setError(null);
    try {
      const r = await api.post('/pos/sales', {
        ...cartPayload(registerId, cart),
        clientSaleId: clientSaleId.current,
        expectedTotal: grandTotal,
        payments: tenders.map((t) => ({ methodId: t.method.id, amount: t.amount, reference: t.reference })),
        approval: withApproval ?? undefined,
      });
      onDone(r);
    } catch (e) {
      const err = e as ApiError;
      if (err.code === 'APPROVAL_REQUIRED') {
        setAskApproval(((err.details as any)?.missingPermissions as string[]) ?? []);
      } else if (err.code === 'TOTAL_CHANGED' || err.code === 'IDEMPOTENCY_CONFLICT') {
        clientSaleId.current = newKey();
        setError(posMessage(err));
        onRequote();
      } else {
        // Network errors keep the same client sale id, so pressing again cannot charge twice.
        setError(posMessage(err));
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet title="Payment" onClose={busy ? () => undefined : onClose} wide>
      <div className="grid-2">
        <div className="stack">
          <div>
            <div className="small muted">Total due</div>
            <div className="big-total">{money(due, currency)}</div>
            {tenders.length > 0 && (
              <div className="kv">
                {tenders.map((t) => (
                  <FragmentRow key={t.key} label={`${t.method.name}${t.reference ? ` · ${t.reference}` : ''}`} value={money(t.amount, currency)} onRemove={() => setTenders((x) => x.filter((y) => y !== t))} />
                ))}
                <b>{remaining > 0 ? 'Still due' : 'Change'}</b>
                <b style={{ fontSize: '1.3rem', color: remaining > 0 ? 'var(--ckh-danger)' : 'var(--ckh-success)' }}>{money(remaining > 0 ? remaining : change, currency)}</b>
              </div>
            )}
          </div>
          <div className="methods">
            {methods.map((m) => (
              <button key={m.id} className={method?.id === m.id ? 'on' : ''} onClick={() => setMethod(m)} disabled={remaining <= 0}>
                {m.name}
                {m.requires_verification && <span className="small" style={{ fontWeight: 400 }}>verified later</span>}
              </button>
            ))}
          </div>
          {method?.kind === 'CASH' && remaining > 0 && (
            <div className="row">
              {quickCash(remaining).map((v) => (
                <button key={v} onClick={() => add(method, String(v))}>{money(v, currency)}</button>
              ))}
            </div>
          )}
          {method && method.kind !== 'CASH' && method.requires_verification && (
            <div className="notice warn small">
              {method.name} is recorded as waiting for verification. It counts as paid only after someone confirms the money arrived in the account.
            </div>
          )}
        </div>
        <div className="stack">
          {method && remaining > 0 && (
            <>
              {method.requires_reference && (
                <Field label={method.kind === 'CARD' ? 'Approval code (never the card number)' : 'Transaction reference'}>
                  <input value={reference} onChange={(e) => setReference(e.target.value)} autoComplete="off" maxLength={120} />
                </Field>
              )}
              <Keypad value={amount} onChange={setAmount} />
              <div className="row">
                <button onClick={() => setAmount(remaining.toFixed(2))}>Exact {money(remaining, currency)}</button>
                <button className="primary" onClick={() => add(method, amount || remaining.toFixed(2), reference)}>Add {method.name}</button>
              </div>
            </>
          )}
          {error && <div className="notice bad">{error}</div>}
          {approval && <div className="notice ok small">Supervisor approval added.</div>}
          <button className="primary" style={{ minHeight: 64, fontSize: '1.2rem' }} disabled={!ready || busy} onClick={() => complete()}>
            {busy ? 'Recording…' : change > 0 ? `Complete · change ${money(change, currency)}` : 'Complete sale'}
          </button>
        </div>
      </div>
      {askApproval && (
        <ApprovalSheet
          registerId={registerId}
          needs={askApproval}
          onClose={() => setAskApproval(null)}
          onApprove={(a) => {
            setApproval(a);
            setAskApproval(null);
            void complete(a);
          }}
        />
      )}
    </Sheet>
  );
}

function FragmentRow({ label, value, onRemove }: { label: string; value: string; onRemove: () => void }) {
  return (
    <>
      <span>
        {label}{' '}
        <button className="link small" onClick={onRemove}>remove</button>
      </span>
      <span>{value}</span>
    </>
  );
}

const NEED_LABEL: Record<string, string> = {
  'pos.discount.apply': 'give a discount',
  'pos.discount.override': 'give a discount above the cashier limit',
  'pos.price.override': 'change a price',
};

/** A supervisor approves on the cashier's screen with their own PIN. */
function ApprovalSheet({ registerId, needs, onApprove, onClose }: { registerId: string; needs: string[]; onApprove: (a: { userId: string; pin: string }) => void; onClose: () => void }) {
  const { data, error } = useApi<any[]>(`/pos/approvers${qs({ registerId })}`);
  const [who, setWho] = useState<string>('');
  const [pin, setPin] = useState('');
  return (
    <Sheet title="Supervisor approval" onClose={onClose}>
      <p className="small">This sale needs someone allowed to {needs.map((n) => NEED_LABEL[n] ?? n).join(' and ')}.</p>
      <ErrorBox error={error} />
      <Field label="Supervisor">
        <select value={who} onChange={(e) => setWho(e.target.value)}>
          <option value="">Choose…</option>
          {(data ?? []).filter((u) => needs.every((n) => u.can?.includes(n))).map((u) => <option key={u.id} value={u.id}>{u.full_name}</option>)}
        </select>
      </Field>
      <Keypad value={pin} onChange={(v) => setPin(v.slice(0, 8))} decimals={false} mask />
      <button className="primary" disabled={!who || pin.length < 4} onClick={() => onApprove({ userId: who, pin })}>Approve</button>
    </Sheet>
  );
}

function OpenShiftInline() {
  const pos = usePos();
  const [float, setFloat] = useState('');
  const act = useAction();
  if (!pos.can(P.POS_SALES_CREATE)) return <div className="notice warn" style={{ margin: 8 }}>No shift is open on this register.</div>;
  async function open() {
    const r = await act.run(() => api.post('/pos/shifts/open', { registerId: pos.ctx.register!.id, openingFloat: float || '0' }));
    if (r) pos.reload();
  }
  return (
    <div className="notice warn" style={{ margin: 8 }}>
      <b>Open a shift to start selling.</b>
      <div className="row" style={{ marginTop: 6 }}>
        <input style={{ maxWidth: 160 }} inputMode="decimal" placeholder="Opening float" value={float} onChange={(e) => setFloat(e.target.value)} />
        <button className="primary" disabled={act.busy} onClick={open}>Open shift</button>
      </div>
      <ErrorBox error={act.error} />
    </div>
  );
}

function Done({ result, onNext }: { result: any; onNext: () => void }) {
  const s = result.sale;
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Enter' && onNext();
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onNext]);
  return (
    <div className="pos-center" style={{ maxWidth: 560 }}>
      <div className="notice ok">
        <h1 style={{ margin: 0 }}>Sale {s.number} recorded</h1>
        {result.replayed && <div className="small">This sale had already been recorded; nothing was charged twice.</div>}
      </div>
      <div className="card">
        <div className="kv">
          <span>Total</span><b>{money(s.grand_total, s.currency)}</b>
          <span>Paid</span><span>{money(s.amount_tendered, s.currency)}</span>
          <b>Change</b><b className="big-total">{money(s.change_due, s.currency)}</b>
        </div>
        {s.payment_status === 'PENDING_VERIFICATION' && (
          <div className="notice warn small" style={{ marginTop: 8 }}>A bank or QR payment is waiting for verification.</div>
        )}
      </div>
      {result.warnings?.map((w: any, i: number) => <div key={i} className="notice warn small">{w.message}</div>)}
      <div className="row">
        <a className="btn" href={`/pos/sales/view/?id=${s.id}&receipt=1`}>Receipt</a>
        <button className="primary" style={{ minHeight: 60, flex: 1 }} onClick={onNext}>New sale</button>
      </div>
    </div>
  );
}
