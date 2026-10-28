'use client';
import { useCallback, useEffect, useState } from 'react';
import { api, ApiError, qs } from './api';

/** The till this browser works as. Each register is a physical checkout; pick it once per device. */
const REGISTER_KEY = 'ckh.pos.register';
const RESUME_KEY = 'ckh.pos.resume';

export function storedRegisterId(): string | null {
  try {
    return localStorage.getItem(REGISTER_KEY);
  } catch {
    return null;
  }
}
export function storeRegisterId(id: string | null) {
  try {
    if (id) localStorage.setItem(REGISTER_KEY, id);
    else localStorage.removeItem(REGISTER_KEY);
  } catch {
    /* storage unavailable */
  }
}

export interface PosRegister {
  id: string;
  code: string;
  name: string;
  branch_id: string;
  branch_name: string;
  warehouse_id: string;
  warehouse_name: string;
  hardware: Record<string, any>;
}
export interface PosMethod {
  id: string;
  code: string;
  name: string;
  kind: 'CASH' | 'BANK_TRANSFER' | 'QR' | 'CARD' | 'OTHER';
  requires_reference: boolean;
  requires_verification: boolean;
  provider: string | null;
  allow_offline: boolean;
}
export interface PosContext {
  company: { name: string; display_name: string; base_currency: string; timezone: string; logo_url: string | null };
  currency: string;
  user: { id: string; fullName: string; permissions: string[] };
  settings: {
    pricesIncludeTax: boolean;
    cashierMaxDiscountPercent: string;
    overrideMaxDiscountPercent: string;
    allowNegativeStock: boolean;
    requireOpenShift: boolean;
    walkInCustomerId: string | null;
    receipt: Record<string, any>;
  };
  registers: PosRegister[];
  register: PosRegister | null;
  shift: { id: string; number: string; cashier_id: string; opened_at: string } | null;
  paymentMethods: PosMethod[];
  license: { maxBranches: number | null; maxRegisters: number | null; maxDevices: number | null; offlineValidityHours: number };
  serverTime: string;
  businessDate: string;
}

/** Loads the till context for the stored register (falls back to the only register, if there is one). */
export function usePosContext() {
  const [registerId, setRegisterId] = useState<string | null>(null);
  const [ctx, setCtx] = useState<PosContext | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async (rid: string | null) => {
    setLoading(true);
    try {
      let c = await api.get<PosContext>(`/pos/context${qs({ registerId: rid })}`);
      if (!c.register && c.registers.length === 1) {
        storeRegisterId(c.registers[0].id);
        c = await api.get<PosContext>(`/pos/context${qs({ registerId: c.registers[0].id })}`);
      }
      setCtx(c);
      setError(null);
    } catch (e) {
      // A register that was removed or is in another branch: forget it and ask again.
      if (rid && e instanceof ApiError && (e.status === 404 || e.status === 403)) {
        storeRegisterId(null);
        setRegisterId(null);
        return load(null);
      }
      setError(e as ApiError);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const rid = storedRegisterId();
    setRegisterId(rid);
    void load(rid);
  }, [load]);

  const choose = useCallback(
    (id: string | null) => {
      storeRegisterId(id);
      setRegisterId(id);
      void load(id);
    },
    [load],
  );
  const can = useCallback((p: string) => !!ctx?.user.permissions.includes(p), [ctx]);
  return { ctx, error, loading, registerId: ctx?.register?.id ?? registerId, choose, reload: () => load(ctx?.register?.id ?? registerId), can };
}

/** A line as the till keeps it before checkout. Prices and totals always come back from the server quote. */
export interface CartLine {
  key: string;
  productId: string;
  sku: string;
  name: string;
  quantity: string;
  discountPercent?: string;
  discountAmount?: string;
  unitPrice?: string;
  serialNumbers: string[];
  serialTracked?: boolean;
  image?: string | null;
}
export interface Cart {
  customer: { id: string; name: string; phone?: string | null } | null;
  lines: CartLine[];
  orderDiscountPercent?: string;
  orderDiscountAmount?: string;
}
export const emptyCart = (): Cart => ({ customer: null, lines: [] });

/** What the API takes for a cart (no UI-only fields). */
export function cartPayload(registerId: string, c: Cart) {
  return {
    registerId,
    customerId: c.customer?.id ?? null,
    orderDiscountPercent: c.orderDiscountPercent || undefined,
    orderDiscountAmount: c.orderDiscountAmount || undefined,
    lines: c.lines.map((l) => ({
      productId: l.productId,
      quantity: l.quantity,
      discountPercent: l.discountPercent || undefined,
      discountAmount: l.discountAmount || undefined,
      unitPrice: l.unitPrice || undefined,
      serialNumbers: l.serialNumbers,
    })),
  };
}

/** A held cart handed from the Held Sales page to the till. */
export function stashResume(cart: Cart) {
  try {
    sessionStorage.setItem(RESUME_KEY, JSON.stringify(cart));
  } catch {
    /* ignore */
  }
}
export function takeResume(): Cart | null {
  try {
    const v = sessionStorage.getItem(RESUME_KEY);
    sessionStorage.removeItem(RESUME_KEY);
    return v ? (JSON.parse(v) as Cart) : null;
  } catch {
    return null;
  }
}

export const newKey = () =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now()}-${String(Math.random()).slice(2)}`;

/** Messages for the error codes a cashier can act on. */
export function posMessage(e: unknown): string {
  const err = e as ApiError;
  switch (err?.code) {
    case 'SHIFT_NOT_OPEN':
      return 'Open a shift on this register before selling.';
    case 'INSUFFICIENT_STOCK':
      return `Not enough stock. ${err.message}`;
    case 'TOTAL_CHANGED':
      return 'Prices changed since the cart was priced. Check the new total and take payment again.';
    case 'NETWORK':
      return 'No connection to the server. The sale was not recorded; try again when you are back online.';
    default:
      return err?.message ?? String(e);
  }
}

/** Quick cash amounts for a total: exact, then the next round notes. */
export function quickCash(due: number): number[] {
  const out = new Set<number>([Math.round(due * 100) / 100]);
  for (const step of [1, 5, 10, 20, 50, 100]) {
    const v = Math.ceil(due / step) * step;
    if (v > due) out.add(v);
    if (out.size >= 5) break;
  }
  return [...out].sort((a, b) => a - b);
}
