import { createPublicKey, verify } from 'crypto';

/** Same fields the API signs (apps/api/src/pos/pos-license.service.ts). */
export interface LicensePayload {
  v: 1;
  tenantId: string;
  tenantCode: string;
  deviceId: string;
  registerId: string;
  branchId: string;
  issuedAt: string;
  expiresAt: string;
  offlineMethods: string[];
}

export interface Device {
  deviceId: string;
  deviceSecret: string;
  registerId: string;
  apiUrl: string;
  /** Licence signing key: built into the app, or pinned when the device was activated. */
  publicKey: string;
  activatedAt: string;
}

export interface QueuedEvent {
  idempotencyKey: string;
  type: 'SALE';
  userId: string;
  clientCreatedAt: string;
  catalogSnapshotAt?: string;
  deviceTotal: string;
  sale: { clientSaleId: string; registerId: string; lines: unknown[]; payments: { methodId: string; amount: string }[] };
}

export interface SyncResult {
  idempotencyKey: string;
  status: 'ACCEPTED' | 'ACCEPTED_WITH_CHANGES' | 'REJECTED' | 'CONFLICT';
  saleNumber?: string;
  error?: { code: string; message: string };
}

export interface LicenseState {
  valid: boolean;
  /** Why offline selling is not allowed now. */
  reason?: 'NOT_ACTIVATED' | 'NO_LICENSE' | 'BAD_SIGNATURE' | 'WRONG_DEVICE' | 'EXPIRED' | 'CLOCK_ROLLBACK' | 'REVOKED';
  expiresAt?: string;
  offlineMethods?: string[];
}

/** Minimal storage interface (SecureStore in the app, a Map in tests). */
export interface KV {
  get<T = unknown>(k: string): T | undefined;
  set(k: string, v: unknown): void;
  delete(k: string): void;
}

/** Clock tolerance: the PC clock may drift this much backwards before it counts as being turned back. */
export const CLOCK_SLACK_MS = 5 * 60_000;
const MAX_QUEUE = 5000;
const MAX_REFUSED = 200;

/** Checks the Ed25519 signature of "ckhpos1.<payload>.<signature>" and returns the payload, or null. */
export function verifyLicense(token: string, publicKeyPem: string): LicensePayload | null {
  const parts = typeof token === 'string' ? token.split('.') : [];
  if (parts.length !== 3 || parts[0] !== 'ckhpos1') return null;
  try {
    const ok = verify(null, Buffer.from(`${parts[0]}.${parts[1]}`), createPublicKey(publicKeyPem), Buffer.from(parts[2], 'base64url'));
    if (!ok) return null;
    const p = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as LicensePayload;
    return p.v === 1 && typeof p.expiresAt === 'string' && typeof p.deviceId === 'string' ? p : null;
  } catch {
    return null;
  }
}

const samePem = (a: string, b: string) => {
  try {
    return createPublicKey(a).export({ type: 'spki', format: 'der' }).equals(createPublicKey(b).export({ type: 'spki', format: 'der' }));
  } catch {
    return false;
  }
};

/**
 * What the till keeps for offline selling, all in the encrypted store: the
 * device identity, its signed licence, the catalogue snapshot and the queue
 * of sales waiting to upload. Offline selling is allowed only while the
 * licence's signature checks out with the pinned key, it names this device,
 * it has not expired, and the computer clock has not been turned back past
 * the latest time this app has seen.
 */
export class OfflineVault {
  constructor(private readonly kv: KV, private readonly builtInKey?: string, private readonly now: () => number = Date.now) {}

  device(): Device | undefined {
    return this.kv.get<Device>('device');
  }

  /** Saves the identity returned by POST /pos/devices/activate. */
  activate(d: Omit<Device, 'activatedAt'>, license: { token: string }) {
    if (this.builtInKey && !samePem(this.builtInKey, d.publicKey)) throw new Error('The server’s licence key does not match the one built into this app');
    const payload = verifyLicense(license.token, d.publicKey);
    if (!payload || payload.deviceId !== d.deviceId) throw new Error('The server returned a licence this app cannot verify');
    this.kv.set('device', { ...d, activatedAt: new Date(this.now()).toISOString() } satisfies Device);
    this.kv.set('license', license.token);
    this.kv.delete('revoked');
    this.touch();
  }

  /** Stores a renewed licence from a heartbeat, after checking it. */
  renew(token: string, publicKey?: string): LicenseState {
    const d = this.device();
    if (!d) return { valid: false, reason: 'NOT_ACTIVATED' };
    if (publicKey && !samePem(publicKey, d.publicKey)) throw new Error('The server’s licence key changed; reactivate this device');
    const p = verifyLicense(token, d.publicKey);
    if (!p) throw new Error('The renewed licence is not signed by CKH ONE');
    if (p.deviceId !== d.deviceId) throw new Error('The renewed licence is for another device');
    this.kv.set('license', token);
    this.touch();
    return this.license();
  }

  /** The server said this device was revoked: stop offline selling, keep unsent sales. */
  revoked() {
    this.kv.delete('license');
    this.kv.set('revoked', true);
  }

  /** Remembers the latest time seen, so turning the clock back is noticed. */
  private touch() {
    const t = this.now();
    if (t > (this.kv.get<number>('lastSeen') ?? 0)) this.kv.set('lastSeen', t);
  }

  license(): LicenseState {
    const d = this.device();
    if (!d) return { valid: false, reason: 'NOT_ACTIVATED' };
    if (this.kv.get('revoked')) return { valid: false, reason: 'REVOKED' };
    const token = this.kv.get<string>('license');
    if (!token) return { valid: false, reason: 'NO_LICENSE' };
    const p = verifyLicense(token, d.publicKey);
    if (!p) return { valid: false, reason: 'BAD_SIGNATURE' };
    if (p.deviceId !== d.deviceId) return { valid: false, reason: 'WRONG_DEVICE' };
    const t = this.now();
    const base = { expiresAt: p.expiresAt, offlineMethods: p.offlineMethods };
    const lastSeen = this.kv.get<number>('lastSeen') ?? 0;
    if (t < lastSeen - CLOCK_SLACK_MS || t < new Date(p.issuedAt).getTime() - CLOCK_SLACK_MS) return { valid: false, reason: 'CLOCK_ROLLBACK', ...base };
    if (t >= new Date(p.expiresAt).getTime()) return { valid: false, reason: 'EXPIRED', ...base };
    this.touch();
    return { valid: true, ...base };
  }

  saveSnapshot(s: unknown) {
    const json = JSON.stringify(s);
    if (json.length > 20_000_000) throw new Error('Catalogue is too large to keep offline');
    this.kv.set('snapshot', JSON.parse(json));
  }

  snapshot<T = unknown>(): T | undefined {
    return this.kv.get<T>('snapshot');
  }

  /** Adds an offline sale. The time is this computer's, and only a valid licence allows it. */
  enqueue(e: Omit<QueuedEvent, 'clientCreatedAt' | 'type'>): QueuedEvent {
    const lic = this.license();
    if (!lic.valid) throw new Error(`Offline selling is not allowed on this computer now (${lic.reason})`);
    const d = this.device()!;
    if (!e || typeof e.idempotencyKey !== 'string' || !/^[A-Za-z0-9._:-]{8,100}$/.test(e.idempotencyKey)) throw new Error('Sale id is not valid');
    if (!e.sale || e.sale.registerId !== d.registerId) throw new Error('The sale is for another register than this device');
    if (!Array.isArray(e.sale.payments) || e.sale.payments.some((p) => !lic.offlineMethods!.includes(p.methodId))) {
      throw new Error('Only payment methods allowed offline can be taken without a connection');
    }
    const q = this.kv.get<QueuedEvent[]>('queue') ?? [];
    if (q.some((x) => x.idempotencyKey === e.idempotencyKey)) throw new Error('This sale is already queued');
    if (q.length >= MAX_QUEUE) throw new Error('Too many sales are waiting to upload; reconnect to the internet');
    const ev: QueuedEvent = { ...e, type: 'SALE', clientCreatedAt: new Date(this.now()).toISOString() };
    this.kv.set('queue', [...q, ev]);
    return ev;
  }

  queue(): QueuedEvent[] {
    return this.kv.get<QueuedEvent[]>('queue') ?? [];
  }

  /** Removes events the server has settled; refused ones are kept in a short log for the manager. */
  settle(results: SyncResult[]) {
    const done = new Map((Array.isArray(results) ? results : []).filter((r) => r && typeof r.idempotencyKey === 'string').map((r) => [r.idempotencyKey, r]));
    const q = this.queue();
    const left = q.filter((e) => !done.has(e.idempotencyKey));
    const refused = q
      .filter((e) => ['REJECTED', 'CONFLICT'].includes(done.get(e.idempotencyKey)?.status ?? ''))
      .map((e) => ({ idempotencyKey: e.idempotencyKey, clientCreatedAt: e.clientCreatedAt, deviceTotal: e.deviceTotal, ...done.get(e.idempotencyKey) }));
    this.kv.set('queue', left);
    if (refused.length) this.kv.set('refused', [...refused, ...this.refused()].slice(0, MAX_REFUSED));
    return { removed: q.length - left.length, left: left.length };
  }

  refused(): unknown[] {
    return this.kv.get<unknown[]>('refused') ?? [];
  }

  status() {
    const d = this.device();
    const snap = this.snapshot<{ snapshotAt?: string }>();
    return {
      activated: !!d,
      deviceId: d?.deviceId ?? null,
      registerId: d?.registerId ?? null,
      license: this.license(),
      queued: this.queue().length,
      refused: this.refused().length,
      snapshotAt: snap?.snapshotAt ?? null,
    };
  }
}
