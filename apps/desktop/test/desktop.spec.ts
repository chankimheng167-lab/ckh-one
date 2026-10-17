import { createServer, Server } from 'net';
import { mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { CUT, drawerPulse, encodeText, INIT, openDrawerBytes, receipt } from '../src/escpos';
import { sendRaw } from '../src/network-printer';
import { KeyWrapper, SecureStore } from '../src/secure-store';
import { loadConfig, sanitize, validApiUrl } from '../src/config';
import { csp, isAppUrl, resolveAppPath } from '../src/security';

const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');

describe('ESC/POS', () => {
  it('encodes a receipt with init, text, feed, cut and the drawer pulse', () => {
    const b = receipt('CKH ONE\nTotal  3.30', { openDrawer: true });
    const s = hex(b);
    expect(s.startsWith(hex(INIT))).toBe(true);
    expect(Buffer.from(b).toString('latin1')).toContain('CKH ONE\nTotal  3.30\n');
    expect(s).toContain(hex(CUT));
    expect(s.endsWith(hex(drawerPulse(0)))).toBe(true);
    expect(hex(drawerPulse(1))).toBe('1b700119fa');
  });
  it('refuses Khmer or Chinese text instead of printing garbage', () => {
    expect(() => encodeText('បង្កាន់ដៃ')).toThrow(/ASCII/);
    expect(() => receipt('收据')).toThrow(/HTML/);
  });
  it('sends bytes to a network printer and reports a printer that is not there', async () => {
    const got: Buffer[] = [];
    const server: Server = createServer((s) => s.on('data', (d) => got.push(d)));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as any).port;
    await sendRaw('127.0.0.1', port, openDrawerBytes(0));
    await new Promise((r) => setTimeout(r, 50));
    expect(hex(Buffer.concat(got))).toBe('1b401b700019fa');
    await new Promise<void>((r) => server.close(() => r()));
    await expect(sendRaw('127.0.0.1', port, INIT, 1000)).rejects.toThrow(/Printer 127.0.0.1/);
  });
});

describe('secure store', () => {
  // Stand-in for the OS key protection (Windows DPAPI through Electron safeStorage).
  const wrapper = (secret = 7): KeyWrapper => ({
    available: () => true,
    encrypt: (b) => Buffer.from(b.map((x) => x ^ secret)),
    decrypt: (b) => Buffer.from(b.map((x) => x ^ secret)),
  });
  it('round-trips values, encrypts them at rest and detects tampering', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ckh-'));
    const file = join(dir, 'secure.dat');
    const a = new SecureStore(file, wrapper());
    a.set('deviceSecret', 'not-in-plain-text-1234');
    a.set('queue', [{ id: 1 }]);
    expect(readFileSync(file, 'utf8')).not.toContain('not-in-plain-text');
    const b = new SecureStore(file, wrapper());
    expect(b.get('deviceSecret')).toBe('not-in-plain-text-1234');
    expect(b.get('queue')).toEqual([{ id: 1 }]);
    // Another Windows user (a different OS key) cannot read it.
    expect(() => new SecureStore(file, wrapper(9)).get('deviceSecret')).toThrow();
    const f = JSON.parse(readFileSync(file, 'utf8'));
    const data = Buffer.from(f.data, 'base64');
    data[0] ^= 1;
    writeFileSync(file, JSON.stringify({ ...f, data: data.toString('base64') }));
    expect(() => new SecureStore(file, wrapper()).get('deviceSecret')).toThrow();
  });
  it('refuses to work without operating-system encryption', () => {
    const s = new SecureStore(join(mkdtempSync(join(tmpdir(), 'ckh-')), 'x'), { ...wrapper(), available: () => false });
    expect(() => s.get('a')).toThrow(/not available/);
  });
});

describe('config and security rules', () => {
  it('accepts only https APIs, or http on this computer', () => {
    expect(validApiUrl('https://api.ckh.one/api/v1')).toBe(true);
    expect(validApiUrl('http://localhost:3001/api/v1')).toBe(true);
    expect(validApiUrl('http://192.168.1.10/api/v1')).toBe(false);
    expect(validApiUrl('https://user:pw@api.ckh.one')).toBe(false);
    expect(validApiUrl('javascript:alert(1)')).toBe(false);
  });
  it('cleans printer settings', () => {
    const c = sanitize({ apiUrl: 'http://evil.example', printer: { mode: 'network', host: 'http://x/', port: 99999, paper: '99', drawer: 'yes' } as any });
    expect(c.apiUrl).toBe('http://localhost:3001/api/v1');
    expect(c.printer).toMatchObject({ mode: 'network', host: '', port: 9100, paper: '80', drawer: false });
    const dir = mkdtempSync(join(tmpdir(), 'ckh-'));
    writeFileSync(join(dir, 'c.json'), '{not json');
    expect(loadConfig(join(dir, 'c.json')).printer.mode).toBe('system');
    // Built-for address, then this computer's config.json, then the development override.
    expect(loadConfig(join(dir, 'none.json'), 'https://api.shop.kh/api/v1/').apiUrl).toBe('https://api.shop.kh/api/v1');
    writeFileSync(join(dir, 'c.json'), JSON.stringify({ apiUrl: 'https://branch2.shop.kh/api/v1' }));
    expect(loadConfig(join(dir, 'c.json'), 'https://api.shop.kh/api/v1').apiUrl).toBe('https://branch2.shop.kh/api/v1');
    expect(loadConfig(join(dir, 'c.json'), 'https://api.shop.kh/api/v1', 'http://localhost:3001/api/v1').apiUrl).toBe('http://localhost:3001/api/v1');
  });
  it('serves only files inside the web build, and only the app origin is trusted', () => {
    expect(resolveAppPath('app://ckh/pos/')).toBe('pos/index.html');
    expect(resolveAppPath('app://ckh/pos/sell')).toBe('pos/sell/index.html');
    expect(resolveAppPath('app://ckh/_next/static/a.js')).toBe('_next/static/a.js');
    // Dot segments are normalised away by the URL parser; encoded slashes are refused.
    expect(resolveAppPath('app://ckh/%2e%2e/%2e%2e/secret.txt')).toBe('secret.txt');
    expect(resolveAppPath('app://ckh/x%2F..%2F..%2Fsecret.txt')).toBeNull();
    expect(isAppUrl('app://ckh/pos/')).toBe(true);
    expect(isAppUrl('https://evil.example/app://ckh/')).toBe(false);
    expect(csp('https://api.ckh.one/api/v1')).toContain("connect-src 'self' https://api.ckh.one");
  });
});
