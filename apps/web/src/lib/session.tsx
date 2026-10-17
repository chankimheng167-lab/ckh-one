'use client';
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { themeCssVariables } from '@ckh/shared';
import { api, ApiError, deviceInfo, type IssuedTokens, tokenStore } from './api';
import { flushOutbox, isStale, loadSnapshot, outboxCounts, refreshSnapshot } from './sync';
import type { Snapshot } from './db';

export interface Me {
  userId: string;
  tenantId: string;
  email: string;
  fullName: string;
  permissions: string[];
  approvalLevel: number | null;
  modules: string[];
  /** Company business time zone, e.g. Asia/Phnom_Penh. */
  timezone?: string;
}

interface Session {
  me: Me | null;
  loading: boolean;
  online: boolean;
  snapshot: Snapshot | null;
  stale: boolean;
  queue: { pending: number; problems: number };
  can: (perm: string) => boolean;
  hasModule: (m: string) => boolean;
  login: (tenantCode: string, email: string, password: string) => Promise<void>;
  logout: () => void;
  syncNow: () => Promise<void>;
  refreshQueue: () => Promise<void>;
  applyTheme: (vars: Record<string, string>) => void;
}

const Ctx = createContext<Session | null>(null);
const ME_KEY = 'ckh.me';
const THEME_KEY = 'ckh.theme';

const read = <T,>(k: string): T | null => {
  try {
    const v = localStorage.getItem(k);
    return v ? (JSON.parse(v) as T) : null;
  } catch {
    return null;
  }
};
const write = (k: string, v: unknown) => {
  try {
    if (v === null) localStorage.removeItem(k);
    else localStorage.setItem(k, JSON.stringify(v));
  } catch {
    /* storage unavailable: online-only */
  }
};

function setCssVars(vars: Record<string, string>) {
  const root = document.documentElement;
  for (const [k, v] of Object.entries(vars)) root.style.setProperty(k, v);
}

export function SessionProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);
  const [online, setOnline] = useState(true);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [queue, setQueue] = useState({ pending: 0, problems: 0 });

  const applyTheme = useCallback((vars: Record<string, string>) => {
    setCssVars(vars);
    write(THEME_KEY, vars);
  }, []);

  const refreshQueue = useCallback(async () => {
    if (me) setQueue(await outboxCounts(me.userId));
  }, [me]);

  const syncNow = useCallback(async () => {
    if (!me || !navigator.onLine) return;
    await flushOutbox(me.userId).catch(() => undefined);
    if (me.modules.includes('SALES_OFFLINE_ORDERING')) {
      setSnapshot(await refreshSnapshot(me.userId).catch(() => snapshot));
    }
    setQueue(await outboxCounts(me.userId));
  }, [me, snapshot]);

  // Boot: cached identity and theme first, so the app opens offline.
  useEffect(() => {
    setOnline(navigator.onLine);
    const cachedTheme = read<Record<string, string>>(THEME_KEY);
    setCssVars(cachedTheme ?? themeCssVariables({}));
    if (!tokenStore.hasSession()) {
      setLoading(false);
      return;
    }
    const cached = read<Me>(ME_KEY);
    if (cached) setMe(cached);
    api
      .get<Me>('/auth/me')
      .then((m) => {
        setMe(m);
        write(ME_KEY, m);
        return api.get('/theme').then((t) => applyTheme(t.cssVariables));
      })
      .catch((e) => {
        if (e instanceof ApiError && !e.isNetwork) {
          setMe(null);
          write(ME_KEY, null);
        }
      })
      .finally(() => setLoading(false));
  }, [applyTheme]);

  useEffect(() => {
    if (!me) return;
    loadSnapshot(me.userId).then(setSnapshot);
    outboxCounts(me.userId).then(setQueue);
  }, [me]);

  // Flush the outbox whenever the connection comes back, and every two minutes while online.
  useEffect(() => {
    const on = () => {
      setOnline(true);
      void syncNow();
    };
    const off = () => setOnline(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    const t = setInterval(() => navigator.onLine && me && flushOutbox(me.userId).then(() => outboxCounts(me.userId).then(setQueue)), 120_000);
    return () => {
      window.removeEventListener('online', on);
      window.removeEventListener('offline', off);
      clearInterval(t);
    };
  }, [me, syncNow]);

  const value = useMemo<Session>(
    () => ({
      me,
      loading,
      online,
      snapshot,
      stale: isStale(snapshot),
      queue,
      can: (p) => !!me?.permissions.includes(p),
      hasModule: (m) => !!me?.modules.includes(m),
      async login(tenantCode, email, password) {
        const r = await api.post<IssuedTokens>('/auth/login', { tenantCode, email, password, ...deviceInfo() });
        tokenStore.set(r);
        const m = await api.get<Me>('/auth/me');
        write(ME_KEY, m);
        setMe(m);
        const t = await api.get('/theme').catch(() => null);
        if (t) applyTheme(t.cssVariables);
        if (m.modules.includes('SALES_OFFLINE_ORDERING')) setSnapshot(await refreshSnapshot(m.userId).catch(() => null));
      },
      logout() {
        // End the session on the server too, so the refresh token is dead even if it was copied.
        void api.post('/auth/logout').catch(() => undefined);
        tokenStore.set(null);
        write(ME_KEY, null);
        setMe(null);
        location.href = '/login/';
      },
      syncNow,
      refreshQueue,
      applyTheme,
    }),
    [me, loading, online, snapshot, queue, syncNow, refreshQueue, applyTheme],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useSession() {
  const s = useContext(Ctx);
  if (!s) throw new Error('useSession outside SessionProvider');
  return s;
}
