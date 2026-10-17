'use client';
import { api } from './api';

export interface PrintOptions {
  saleId?: string;
  returnId?: string;
  paper?: '58' | '80' | 'A4';
  language?: 'en' | 'km' | 'zh';
  approval?: { userId: string; pin: string };
}

/**
 * Fetches a receipt as HTML (the server logs the print, and marks second and
 * later prints as reprints) and hands it to the browser's print dialog in a
 * sandboxed frame. The Windows POS app prints the same HTML silently.
 */
export async function printReceipt(o: PrintOptions): Promise<string> {
  const path = o.saleId ? `/pos/sales/${o.saleId}/receipt` : `/pos/returns/${o.returnId}/receipt`;
  const html = await api.postText(path, { format: 'html', paper: o.paper, language: o.language, approval: o.approval });
  const desktop = (window as any).ckhPos;
  if (desktop?.printHtml) {
    await desktop.printHtml(html);
    return html;
  }
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
