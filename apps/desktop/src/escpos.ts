/**
 * ESC/POS byte encoding for thermal receipt printers (Epson TM, Xprinter,
 * Rongta and compatible). Only printable ASCII is sent: Khmer and Chinese need
 * the printer's own fonts or raster images, so those receipts print as HTML
 * through the Windows printer driver instead.
 */
const ESC = 0x1b;
const GS = 0x1d;

export interface EscPosOptions {
  /** Feed and cut the paper after the receipt (partial cut). */
  cut?: boolean;
  /** Pulse the cash drawer connected to the printer's kick port. */
  openDrawer?: boolean;
  /** Drawer pin: 0 = pin 2 (most drawers), 1 = pin 5. */
  drawerPin?: 0 | 1;
}

export const INIT = Uint8Array.of(ESC, 0x40);
/** ESC p m t1 t2: pulse pin m for t1×2 ms on, t2×2 ms off. */
export const drawerPulse = (pin: 0 | 1 = 0) => Uint8Array.of(ESC, 0x70, pin, 25, 250);
/** GS V 66 n: feed n lines then partial cut. */
export const CUT = Uint8Array.of(GS, 0x56, 66, 3);

/** True when the text can be printed as-is in the printer's ASCII code page. */
export const isPrintableAscii = (s: string) => /^[\x20-\x7e\n\r\t]*$/.test(s);

export function encodeText(text: string): Uint8Array {
  if (!isPrintableAscii(text)) {
    throw new Error('ESC/POS text printing supports English (ASCII) only; print Khmer or Chinese receipts as HTML');
  }
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i);
  return out;
}

export function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** A plain-text receipt (as rendered by the API at 32 or 48 columns) as printer bytes. */
export function receipt(text: string, o: EscPosOptions = {}): Uint8Array {
  const body = text.replace(/\r\n/g, '\n').replace(/\n*$/, '\n');
  const parts = [INIT, encodeText(body)];
  if (o.cut !== false) parts.push(encodeText('\n\n\n'), CUT);
  if (o.openDrawer) parts.push(drawerPulse(o.drawerPin ?? 0));
  return concat(parts);
}

/** Only the drawer pulse (no paper used). */
export const openDrawerBytes = (pin: 0 | 1 = 0) => concat([INIT, drawerPulse(pin)]);
