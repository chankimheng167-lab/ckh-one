'use client';
import { api } from './api';

export interface PrintOptions {
  saleId?: string;
  returnId?: string;
  paper?: '58' | '80' | 'A4';
  language?: 'en' | 'km' | 'zh';
  approval?: { userId: string; pin: string };
  /** Pulse the cash drawer with the receipt (Windows POS app only). */
  openDrawer?: boolean;
}

/** What the Windows POS app's preload exposes (window.ckhPos). */
export interface DesktopPos {
  isDesktop: true;
  version: string;
  apiUrl: string;
  printerSettings(): Promise<{ mode: 'system' | 'network' | 'none'; deviceName: string; host: string; port: number; paper: '58' | '80' | 'A4'; drawer: boolean; drawerPin: 0 | 1 }>;
  savePrinterSettings(s: unknown): Promise<unknown>;
  printers(): Promise<{ name: string; isDefault: boolean }[]>;
  printHtml(html: string, opts?: { paper?: string }): Promise<{ printed: boolean; reason?: string }>;
  printText(text: string, opts?: { openDrawer?: boolean }): Promise<{ printed: boolean; drawer?: boolean }>;
  openDrawer(): Promise<{ opened: boolean; reason?: string }>;
  testPrint(): Promise<{ printed: boolean; reason?: string }>;
}

export const desktop = (): DesktopPos | null => (typeof window !== 'undefined' && (window as any).ckhPos?.isDesktop ? (window as any).ckhPos : null);
const escapeHtml = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

/**
 * Fetches a receipt as HTML (the server logs the print, and marks second and
 * later prints as reprints) and hands it to the browser's print dialog in a
 * sandboxed frame. The Windows POS app prints the same HTML silently.
 */
export async function printReceipt(o: PrintOptions): Promise<string> {
  const path = o.saleId ? `/pos/sales/${o.saleId}/receipt` : `/pos/returns/${o.returnId}/receipt`;
  const d = desktop();
  if (d) {
    const s = await d.printerSettings();
    if (s.mode === 'network') {
      // ESC/POS printers print the plain-text receipt (English); the drawer opens with it.
      const text = await api.postText(path, { format: 'text', paper: o.paper ?? (s.paper === 'A4' ? '80' : s.paper), language: o.language ?? 'en', approval: o.approval });
      await d.printText(text, { openDrawer: o.openDrawer });
      return `<pre style="font:12px/1.3 monospace">${escapeHtml(text)}</pre>`;
    }
    const html = await api.postText(path, { format: 'html', paper: o.paper ?? s.paper, language: o.language, approval: o.approval });
    const r = await d.printHtml(html, { paper: o.paper ?? s.paper });
    if (!r.printed && r.reason) throw new Error(r.reason);
    if (o.openDrawer) await d.openDrawer().catch(() => undefined);
    return html;
  }
  const html = await api.postText(path, { format: 'html', paper: o.paper, language: o.language, approval: o.approval });
  printHtml(html);
  return html;
}

export function printHtml(html: string) {
  const f = document.createElement('iframe');
  f.setAttribute('sandbox', 'allow-same-origin allow-modals');
  f.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;';
  f.srcdoc = html;
  f.onload = () => {
    try {
      f.contentWindow?.focus();
      f.contentWindow?.print();
    } finally {
      setTimeout(() => f.remove(), 60_000);
    }
  };
  document.body.appendChild(f);
}
