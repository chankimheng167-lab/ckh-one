'use client';
import { api, ApiError } from './api';
import { desktop } from './receipt';

/** This computer as a POS device, as the Windows app's main process reports it. */
export interface DeviceStatus {
  activated: boolean;
  deviceId: string | null;
  registerId: string | null;
  apiMatches?: boolean;
  license: {
    valid: boolean;
    reason?: 'NOT_ACTIVATED' | 'NO_LICENSE' | 'BAD_SIGNATURE' | 'WRONG_DEVICE' | 'EXPIRED' | 'CLOCK_ROLLBACK' | 'REVOKED';
    expiresAt?: string;
    offlineMethods?: string[];
  };
  queued: number;
  refused: number;
  snapshotAt: string | null;
}

export interface OfflineEvent {
  idempotencyKey: string;
  type: 'SALE';
  userId: string;
  clientCreatedAt: string;
  catalogSnapshotAt?: string;
  deviceTotal: string;
  sale: { clientSaleId: string; registerId: string; lines: { productId: string; quantity: string; unitPrice: string }[]; payments: { methodId: string; amount: string }[] };
}

export interface SyncResult {
  idempotencyKey: string;
  status: 'ACCEPTED' | 'ACCEPTED_WITH_CHANGES' | 'REJECTED' | 'CONFLICT';
  saleId?: string;
  saleNumber?: string;
  error?: { code: string; message: string };
}

/** What the Windows app exposes for offline selling (window.ckhPos.device / .offline). */
export interface DesktopOffline {
  device: {
    status(): Promise<DeviceStatus>;
    activate(accessToken: string, body: { registerId: string; name: string }): Promise<DeviceStatus>;
    renew(token: string, publicKey?: string): Promise<DeviceStatus['license']>;
    revoked(): Promise<DeviceStatus>;
  };
  offline: {
    saveSnapshot(s: unknown): Promise<void>;
    snapshot<T = any>(): Promise<T | null>;
    enqueue(e: Omit<OfflineEvent, 'type' | 'clientCreatedAt'>): Promise<OfflineEvent>;
    queue(): Promise<OfflineEvent[]>;
    settle(results: SyncResult[]): Promise<{ removed: number; left: number }>;
    refused(): Promise<any[]>;
  };
}

/** The Windows app's offline API, or null in a browser (or an older app). */
export const desktopOffline = (): DesktopOffline | null => {
  const d = desktop() as any;
  return d?.device && d?.offline ? (d as DesktopOffline) : null;
};

export const LICENSE_REASONS: Record<string, string> = {
  NOT_ACTIVATED: 'This computer is not activated as a POS device.',
  NO_LICENSE: 'This computer has no offline licence yet; connect to the internet once.',
  BAD_SIGNATURE: 'The offline licence on this computer is not valid; connect to the internet to renew it.',
  WRONG_DEVICE: 'The offline licence is for another computer.',
  EXPIRED: 'The offline licence has expired; connect to the internet to renew it.',
  CLOCK_ROLLBACK: 'The computer clock was turned back. Set the correct time, then connect to the internet.',
  REVOKED: 'A manager revoked this computer. Offline selling is off.',
};

const BATCH = 50;

/**
 * Uploads this cashier's queued offline sales. Each settled event leaves the
 * queue (the server keeps a record of refused ones too); events the server did
 * not answer stay queued for the next try. Sales by another cashier wait for
 * that cashier to sign in, because the server only accepts a sale from the
 * person who made it.
 */
export async function uploadQueue(userId: string): Promise<{ sent: number; left: number; results: SyncResult[] }> {
  const d = desktopOffline();
  if (!d) return { sent: 0, left: 0, results: [] };
  const mine = (await d.offline.queue()).filter((e) => e.userId === userId);
  const all: SyncResult[] = [];
  for (let i = 0; i < mine.length; i += BATCH) {
    const r = await api.post<{ results: SyncResult[] }>('/pos/sync', { events: mine.slice(i, i + BATCH) });
    await d.offline.settle(r.results);
    all.push(...r.results);
  }
  const left = (await d.offline.queue()).length;
  return { sent: all.length, left, results: all };
}

/**
 * While online: checks in (renewing the signed offline licence), refreshes the
 * catalogue the till sells from offline, and uploads waiting sales. Safe to
 * call often; does nothing in a browser or on a computer that is not activated.
 */
export async function refreshDevice(userId: string, canSell: boolean): Promise<DeviceStatus | null> {
  const d = desktopOffline();
  if (!d) return null;
  const st = await d.device.status();
  if (!st.activated || st.license.reason === 'REVOKED') return st;
  // A licence that fails to renew must not hold back the sales waiting to upload.
  let failed: unknown = null;
  try {
    const hb = await api.post<{ license: { token: string }; publicKey: string }>('/pos/devices/heartbeat', { appVersion: desktop()?.version });
    await d.device.renew(hb.license.token, hb.publicKey);
  } catch (e) {
    const err = e as ApiError;
    if (err instanceof ApiError && (err.code === 'DEVICE_REVOKED' || err.code === 'DEVICE_UNKNOWN')) return d.device.revoked();
    if (err instanceof ApiError && err.isNetwork) throw e;
    failed = e;
  }
  if (canSell) {
    await uploadQueue(userId);
    if (!failed) await d.offline.saveSnapshot(await api.get('/pos/sync/bootstrap'));
  }
  if (failed) throw failed;
  return d.device.status();
}
