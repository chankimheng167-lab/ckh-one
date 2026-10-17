import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname } from 'path';

export interface PrinterConfig {
  /** system: Windows printer driver (HTML, any language); network: raw ESC/POS over TCP; none: do not print. */
  mode: 'system' | 'network' | 'none';
  /** Windows printer name for system mode (empty = default printer). */
  deviceName: string;
  host: string;
  port: number;
  paper: '58' | '80' | 'A4';
  /** Drawer on the receipt printer's kick port (network mode sends ESC p; system mode relies on the driver). */
  drawer: boolean;
  drawerPin: 0 | 1;
}

export interface DesktopConfig {
  /** CKH ONE API, e.g. https://api.example.com/api/v1. Only https is accepted unless it is localhost. */
  apiUrl: string;
  printer: PrinterConfig;
}

export const DEFAULTS: DesktopConfig = {
  apiUrl: 'http://localhost:3001/api/v1',
  printer: { mode: 'system', deviceName: '', host: '', port: 9100, paper: '80', drawer: false, drawerPin: 0 },
};

/** Only https APIs (or plain http on this computer, for development). */
export function validApiUrl(v: string): boolean {
  try {
    const u = new URL(v);
    if (u.username || u.password) return false;
    if (u.protocol === 'https:') return true;
    return u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
  } catch {
    return false;
  }
}

/** Printer hosts are LAN addresses or names, never URLs. */
export const validHost = (h: string) => /^[A-Za-z0-9.-]{1,253}$/.test(h);

export function sanitize(input: unknown, base: DesktopConfig = DEFAULTS): DesktopConfig {
  const i = (input ?? {}) as Partial<DesktopConfig> & { printer?: Partial<PrinterConfig> };
  const p = { ...base.printer, ...(i.printer ?? {}) };
  return {
    apiUrl: typeof i.apiUrl === 'string' && validApiUrl(i.apiUrl) ? i.apiUrl.replace(/\/$/, '') : base.apiUrl,
    printer: {
      mode: ['system', 'network', 'none'].includes(p.mode as string) ? p.mode : base.printer.mode,
      deviceName: typeof p.deviceName === 'string' ? p.deviceName.slice(0, 200) : '',
      host: typeof p.host === 'string' && (p.host === '' || validHost(p.host)) ? p.host : base.printer.host,
      port: Number.isInteger(p.port) && p.port > 0 && p.port < 65536 ? p.port : 9100,
      paper: ['58', '80', 'A4'].includes(p.paper as string) ? p.paper : '80',
      drawer: p.drawer === true,
      drawerPin: p.drawerPin === 1 ? 1 : 0,
    },
  };
}

/**
 * The computer's settings. The API address comes from, in order: the
 * development override, this computer's config.json (an administrator can
 * point one till elsewhere), then the address the installer was built for.
 */
export function loadConfig(file: string, builtFor?: string, devOverride?: string): DesktopConfig {
  const base = builtFor && validApiUrl(builtFor) ? { ...DEFAULTS, apiUrl: builtFor.replace(/\/$/, '') } : DEFAULTS;
  let c = base;
  if (existsSync(file)) {
    try {
      c = sanitize(JSON.parse(readFileSync(file, 'utf8')), base);
    } catch {
      c = base;
    }
  }
  if (devOverride && validApiUrl(devOverride)) c = { ...c, apiUrl: devOverride.replace(/\/$/, '') };
  return c;
}

export function saveConfig(file: string, c: DesktopConfig) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(c, null, 2), { mode: 0o600 });
}
