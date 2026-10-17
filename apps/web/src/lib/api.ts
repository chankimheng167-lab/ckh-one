/** Thin client for the CKH ONE API. Every price and total shown after a save comes from the server. */
export const API_URL = (process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001/api/v1').replace(/\/$/, '');
const TOKEN_KEY = 'ckh.token';

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: unknown) {
    super(message);
  }
  /** True when the request never reached the server (offline, DNS, CORS). */
  get isNetwork() {
    return this.status === 0;
  }
}

export const tokenStore = {
  get: () => (typeof window === 'undefined' ? null : safe(() => localStorage.getItem(TOKEN_KEY))),
  set: (t: string | null) => safe(() => (t ? localStorage.setItem(TOKEN_KEY, t) : localStorage.removeItem(TOKEN_KEY))),
};
function safe<T>(fn: () => T): T | null {
  try {
    return fn();
  } catch {
    return null;
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  const token = tokenStore.get();
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  let res: Response;
  try {
    res = await fetch(`${API_URL}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  } catch {
    throw new ApiError(0, 'NETWORK', 'You appear to be offline');
  }
  if (res.status === 401) {
    tokenStore.set(null);
    if (typeof window !== 'undefined' && !location.pathname.startsWith('/login')) location.href = '/login/';
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
    const res = await fetch(`${API_URL}${path}`, { headers: { Authorization: `Bearer ${tokenStore.get() ?? ''}` } });
    if (!res.ok) throw new ApiError(res.status, 'DOWNLOAD_FAILED', 'Could not download the file');
    const url = URL.createObjectURL(await res.blob());
    const a = Object.assign(document.createElement('a'), { href: url, download: filename });
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  },
};

export const qs = (o: Record<string, string | number | boolean | undefined | null>) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== null && v !== '') p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : '';
};
