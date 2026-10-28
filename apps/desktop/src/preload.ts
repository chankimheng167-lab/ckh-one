// Runs in the sandboxed preload: only 'electron' can be required, and only the
// functions below reach the web app, as window.ckhPos.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { contextBridge, ipcRenderer } = require('electron') as typeof import('electron');

const boot = ipcRenderer.sendSync('ckh:boot') as { apiUrl: string; version: string; platform: string };

contextBridge.exposeInMainWorld('ckhPos', {
  isDesktop: true,
  version: boot.version,
  platform: boot.platform,
  apiUrl: boot.apiUrl,
  /** Printer settings of this computer (mode, printer name, paper, drawer). */
  printerSettings: () => ipcRenderer.invoke('ckh:printer:get'),
  savePrinterSettings: (s: unknown) => ipcRenderer.invoke('ckh:printer:save', s),
  printers: () => ipcRenderer.invoke('ckh:printers'),
  /** Prints a receipt rendered by the API as HTML (system printer) without a dialog. */
  printHtml: (html: string, opts?: { paper?: string }) => ipcRenderer.invoke('ckh:print:html', html, opts ?? {}),
  /** Prints a plain-text (English) receipt as ESC/POS on the network printer. */
  printText: (text: string, opts?: { openDrawer?: boolean }) => ipcRenderer.invoke('ckh:print:text', text, opts ?? {}),
  openDrawer: () => ipcRenderer.invoke('ckh:drawer:open'),
  testPrint: () => ipcRenderer.invoke('ckh:print:test'),
  /** This computer as a POS device: activation and its signed offline licence. */
  device: {
    status: () => ipcRenderer.invoke('ckh:device:status'),
    activate: (accessToken: string, body: { registerId: string; name: string }) => ipcRenderer.invoke('ckh:device:activate', accessToken, body),
    renew: (token: string, publicKey?: string) => ipcRenderer.invoke('ckh:device:renew', token, publicKey),
    revoked: () => ipcRenderer.invoke('ckh:device:revoked'),
  },
  /** Offline selling: catalogue snapshot and the queue of sales waiting to upload. */
  offline: {
    saveSnapshot: (s: unknown) => ipcRenderer.invoke('ckh:offline:snapshot:save', s),
    snapshot: () => ipcRenderer.invoke('ckh:offline:snapshot'),
    enqueue: (e: unknown) => ipcRenderer.invoke('ckh:offline:enqueue', e),
    queue: () => ipcRenderer.invoke('ckh:offline:queue'),
    settle: (results: unknown) => ipcRenderer.invoke('ckh:offline:settle', results),
    refused: () => ipcRenderer.invoke('ckh:offline:refused'),
  },
});
