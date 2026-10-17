/** The app's own pages are served from this origin; nothing else may load in the window. */
export const APP_ORIGIN = 'app://ckh';

export const isAppUrl = (u: string) => {
  try {
    return new URL(u).origin === APP_ORIGIN || u.startsWith(`${APP_ORIGIN}/`);
  } catch {
    return false;
  }
};

/** Content Security Policy for every app page: scripts only from the app, network only to the API. */
export function csp(apiUrl: string): string {
  const api = new URL(apiUrl).origin;
  return [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline'",
    `img-src 'self' data: blob: ${api} https:`,
    "font-src 'self' data:",
    `connect-src 'self' ${api}`,
    "frame-src 'self' data: about:",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; ');
}

/** Maps an app:// URL to a file inside the bundled web build, refusing anything that escapes it. */
export function resolveAppPath(url: string): string | null {
  const u = new URL(url);
  let p = decodeURIComponent(u.pathname);
  if (p.includes('\0') || p.split('/').includes('..')) return null;
  if (p.endsWith('/')) p += 'index.html';
  else if (!/\.[a-z0-9]+$/i.test(p)) p += '/index.html';
  return p.replace(/^\/+/, '');
}
