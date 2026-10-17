/** Thin client for the CKH ONE API. Every price and total shown after a save comes from the server. */
export const API_URL = (process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001/api/v1').replace(/\/$/, '');
const TOKEN_KEY = 'ckh.session';
const PLATFORM_TOKEN_KEY = 'ckh.platformSession';
const DEVICE_KEY = 'ckh.deviceId';

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: unknown) {
    super(message);
  }
  /** True when the request never reached the server (offline, DNS, CORS). */
  get isNetwork() {
    return this.status === 0;
  }
}

export interface IssuedTokens {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  sessionId: string;
}

function safe<T>(fn: () => T): T | null {
  try {
    return fn();
  } catch {
    return null;
  }
}

/**
 * Sign-in state for one kind of account.
 *
 * The access token is short-lived (minutes) and kept in memory only, so a
 * script that reads browser storage gets nothing it can use for long. The
 * refresh token is kept in local storage because a sales rep must be able to
 * reopen the app offline and sync later; it is single-use and rotated on
 * every refresh, and the server revokes the session if an old one is replayed.
 */
function storeFor(key: string) {
  let access: string | null = null;
  let refreshing: Promise<boolean> | null = null;
  const store = {
    get: () => access,
    refreshToken: () => (typeof window === 'undefined' ? null : safe(() => localStorage.getItem(key))),
    /** A refresh token exists: the device was signed in (it may still need to refresh). */
    hasSession: () => !!store.refreshToken(),
    set(t: IssuedTokens | null) {
      access = t?.accessToken ?? null;
      safe(() => (t ? localStorage.setItem(key, t.refreshToken) : localStorage.removeItem(key)));
    },
    /** Exchanges the refresh token once, even if several requests ask at the same moment. */
    refresh(): Promise<boolean> {
      if (!refreshing) {
        refreshing = (async () => {
          const refreshToken = store.refreshToken();
          if (!refreshToken) return false;
          let res: Response;
          try {
            res = await fetch(`${API_URL}/auth/refresh`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
              body: JSON.stringify({ refreshToken }),
            });
          } catch {
            throw new ApiError(0, 'NETWORK', 'You appear to be offline');
          }
          if (!res.ok) {
            if (res.status === 401) store.set(null);
            return false;
          }
          store.set((await res.json()) as IssuedTokens);
          return true;
        })().finally(() => {
          refreshing = null;
        });
      }
      return refreshing;
    },
  };
  return store;
}

export const tokenStore = storeFor(TOKEN_KEY);
// Long-lived tokens from earlier versions are no longer accepted; drop them.
if (typeof window !== 'undefined') safe(() => ['ckh.token', 'ckh.platformToken'].forEach((k) => localStorage.removeItem(k)));
/** Super Admin session, kept apart from the company user's so both can be signed in at once. */
export const platformTokenStore = storeFor(PLATFORM_TOKEN_KEY);
type Store = typeof tokenStore;

/** A stable id for this browser, so users can see and sign out each device. */
export function deviceInfo() {
  let deviceId = safe(() => localStorage.getItem(DEVICE_KEY));
  if (!deviceId) {
    deviceId = typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : String(Math.random()).slice(2);
    safe(() => localStorage.setItem(DEVICE_KEY, deviceId!));
  }
  const ua = typeof navigator === 'undefined' ? '' : navigator.userAgent;
  const kind = /Windows/.test(ua) ? 'Windows' : /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /Mac/.test(ua) ? 'Mac' : /Linux/.test(ua) ? 'Linux' : 'Web';
  return { deviceId, deviceName: `${kind} browser` };
}

async function send(method: string, path: string, body: unknown, token: string | null): Promise<Response> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  try {
    return await fetch(`${API_URL}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), keepalive: method !== 'GET' && JSON.stringify(body ?? '').length < 60_000 });
  } catch {
    throw new ApiError(0, 'NETWORK', 'You appear to be offline');
  }
}

async function request<T>(method: string, path: string, body?: unknown, store: Store = tokenStore, loginPath = '/login/'): Promise<T> {
  const isAuthCall = path.startsWith('/auth/login') || path.startsWith('/auth/platform/login') || path.startsWith('/auth/refresh');
  if (!isAuthCall && !store.get() && store.hasSession()) await store.refresh();
  let res = await send(method, path, body, store.get());
  // Access token expired: refresh once and retry.
  if (res.status === 401 && !isAuthCall && store.hasSession() && (await store.refresh())) {
    res = await send(method, path, body, store.get());
  }
  if (res.status === 401 && !isAuthCall) {
    store.set(null);
    if (typeof window !== 'undefined' && !location.pathname.startsWith(loginPath.replace(/\/$/, ''))) location.href = loginPath;
  }
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const e = data?.error ?? {};
    throw new ApiError(res.status, e.code ?? 'ERROR', e.message ?? res.statusText, e.details);
  }
  return data as T;
}

export const api = {
  get: <T = any>(p: string) => request<T>('GET', p),
  post: <T = any>(p: string, b: unknown = {}) => request<T>('POST', p, b),
  put: <T = any>(p: string, b: unknown = {}) => request<T>('PUT', p, b),
  del: <T = any>(p: string) => request<T>('DELETE', p),
  /** Downloads a report export and hands it to the browser. */
  async download(path: string, filename: string) {
    if (!tokenStore.get()) await tokenStore.refresh();
    let res = await send('GET', path, undefined, tokenStore.get());
    if (res.status === 401 && (await tokenStore.refresh())) res = await send('GET', path, undefined, tokenStore.get());
    if (!res.ok) throw new ApiError(res.status, 'DOWNLOAD_FAILED', 'Could not download the file');
    const url = URL.createObjectURL(await res.blob());
    const a = Object.assign(document.createElement('a'), { href: url, download: filename });
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  },
};

/** Super Admin (platform owner) calls; a rejected session sends the browser back to the /platform/ sign-in. */
export const platformApi = {
  get: <T = any>(p: string) => request<T>('GET', p, undefined, platformTokenStore, '/platform/'),
  post: <T = any>(p: string, b: unknown = {}) => request<T>('POST', p, b, platformTokenStore, '/platform/'),
  put: <T = any>(p: string, b: unknown = {}) => request<T>('PUT', p, b, platformTokenStore, '/platform/'),
  del: <T = any>(p: string) => request<T>('DELETE', p, undefined, platformTokenStore, '/platform/'),
};

export const qs = (o: Record<string, string | number | boolean | undefined | null>) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== null && v !== '') p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : '';
};
