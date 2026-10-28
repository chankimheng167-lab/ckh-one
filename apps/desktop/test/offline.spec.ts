import { generateKeyPairSync, sign } from 'crypto';
import { KV, LicensePayload, OfflineVault, verifyLicense } from '../src/offline';

const keys = generateKeyPairSync('ed25519');
const other = generateKeyPairSync('ed25519');
const pem = (k: typeof keys) => k.publicKey.export({ type: 'spki', format: 'pem' }).toString();

/** Signs like apps/api/src/pos/pos-license.service.ts. */
function token(p: Partial<LicensePayload>, k = keys) {
  const payload: LicensePayload = {
    v: 1, tenantId: 't', tenantCode: 'demo', deviceId: 'dev-1', registerId: 'reg-1', branchId: 'b',
    issuedAt: new Date(T0).toISOString(), expiresAt: new Date(T0 + 72 * 3600_000).toISOString(), offlineMethods: ['cash'], ...p,
  };
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `ckhpos1.${body}.${sign(null, Buffer.from(`ckhpos1.${body}`), k.privateKey).toString('base64url')}`;
}

class MapKV implements KV {
  m = new Map<string, unknown>();
  get<T>(k: string) {
    return this.m.get(k) as T | undefined;
  }
  set(k: string, v: unknown) {
    this.m.set(k, JSON.parse(JSON.stringify(v)));
  }
  delete(k: string) {
    this.m.delete(k);
  }
}

const T0 = Date.parse('2026-10-17T03:00:00Z');
let now = T0;
const device = { deviceId: 'dev-1', deviceSecret: 's'.repeat(43), registerId: 'reg-1', apiUrl: 'https://api.test/api/v1', publicKey: pem(keys) };
const sale = (id = `evt-${Math.random().toString(36).slice(2)}`, methodId = 'cash') => ({
  idempotencyKey: id,
  userId: 'u1',
  deviceTotal: '5.50',
  sale: { clientSaleId: `sale-${id}`, registerId: 'reg-1', lines: [{ productId: 'p', quantity: '2', unitPrice: '2.5000' }], payments: [{ methodId, amount: '10.00' }] },
});

function vault(builtIn?: string) {
  now = T0;
  const kv = new MapKV();
  const v = new OfflineVault(kv, builtIn, () => now);
  return { v, kv };
}

describe('offline licence', () => {
  it('accepts only licences signed by the CKH ONE key', () => {
    expect(verifyLicense(token({}), pem(keys))?.deviceId).toBe('dev-1');
    expect(verifyLicense(token({}, other), pem(keys))).toBeNull();
    const [p, , s] = token({}).split('.');
    const forged = Buffer.from(JSON.stringify({ v: 1, deviceId: 'dev-1', expiresAt: '2099-01-01T00:00:00Z' })).toString('base64url');
    expect(verifyLicense(`${p}.${forged}.${s}`, pem(keys))).toBeNull();
    expect(verifyLicense('garbage', pem(keys))).toBeNull();
  });

  it('refuses activation with a key other than the one built into the app', () => {
    const { v } = vault(pem(other));
    expect(() => v.activate(device, { token: token({}) })).toThrow(/does not match/);
    const ok = vault(pem(keys)).v;
    ok.activate(device, { token: token({}) });
    expect(ok.license().valid).toBe(true);
  });

  it('allows offline selling until the licence expires, then stops', () => {
    const { v } = vault();
    expect(v.license()).toMatchObject({ valid: false, reason: 'NOT_ACTIVATED' });
    v.activate(device, { token: token({}) });
    expect(v.license()).toMatchObject({ valid: true, offlineMethods: ['cash'] });
    now = T0 + 72 * 3600_000;
    expect(v.license()).toMatchObject({ valid: false, reason: 'EXPIRED' });
    expect(() => v.enqueue(sale())).toThrow(/EXPIRED/);
  });

  it('notices the clock being turned back', () => {
    const { v } = vault();
    v.activate(device, { token: token({}) });
    now = T0 + 10 * 3600_000;
    expect(v.license().valid).toBe(true);
    // Back to before the last time seen: a cashier trying to stretch an expired licence.
    now = T0 + 9 * 3600_000;
    expect(v.license()).toMatchObject({ valid: false, reason: 'CLOCK_ROLLBACK' });
    // A few minutes of drift is fine.
    now = T0 + 10 * 3600_000 - 60_000;
    expect(v.license().valid).toBe(true);
  });

  it('renews only with a licence for this device, signed by the pinned key', () => {
    const { v } = vault();
    v.activate(device, { token: token({}) });
    expect(() => v.renew(token({}, other))).toThrow(/not signed/);
    expect(() => v.renew(token({ deviceId: 'dev-2' }))).toThrow(/another device/);
    expect(() => v.renew(token({}), pem(other))).toThrow(/changed/);
    now = T0 + 80 * 3600_000;
    expect(v.license().valid).toBe(false);
    const st = v.renew(token({ issuedAt: new Date(now).toISOString(), expiresAt: new Date(now + 3600_000).toISOString() }));
    expect(st.valid).toBe(true);
  });

  it('stops offline selling when revoked but keeps unsent sales', () => {
    const { v } = vault();
    v.activate(device, { token: token({}) });
    v.enqueue(sale('evt-keep-0001'));
    v.revoked();
    expect(v.license()).toMatchObject({ valid: false, reason: 'REVOKED' });
    expect(v.queue().map((e) => e.idempotencyKey)).toEqual(['evt-keep-0001']);
  });
});

describe('offline queue', () => {
  it('queues sales with this computer’s time, only for this register and offline methods', () => {
    const { v } = vault();
    v.activate(device, { token: token({}) });
    now = T0 + 3600_000;
    const e = v.enqueue(sale('evt-aaaa-0001'));
    expect(e).toMatchObject({ type: 'SALE', clientCreatedAt: new Date(now).toISOString() });
    expect(() => v.enqueue(sale('evt-aaaa-0001'))).toThrow(/already queued/);
    expect(() => v.enqueue(sale('evt-aaaa-0002', 'khqr'))).toThrow(/allowed offline/);
    expect(() => v.enqueue({ ...sale('evt-aaaa-0003'), sale: { ...sale().sale, registerId: 'reg-2' } })).toThrow(/another register/);
    expect(v.queue()).toHaveLength(1);
  });

  it('removes settled sales and keeps a log of refused ones; unanswered ones stay', () => {
    const { v } = vault();
    v.activate(device, { token: token({}) });
    for (const k of ['evt-a-00001', 'evt-b-00001', 'evt-c-00001', 'evt-d-00001']) v.enqueue(sale(k));
    const r = v.settle([
      { idempotencyKey: 'evt-a-00001', status: 'ACCEPTED', saleNumber: 'POS-1' },
      { idempotencyKey: 'evt-b-00001', status: 'ACCEPTED_WITH_CHANGES' },
      { idempotencyKey: 'evt-c-00001', status: 'REJECTED', error: { code: 'CLOCK_AHEAD', message: 'x' } },
    ]);
    expect(r).toEqual({ removed: 3, left: 1 });
    expect(v.queue().map((e) => e.idempotencyKey)).toEqual(['evt-d-00001']);
    expect(v.refused()).toEqual([expect.objectContaining({ idempotencyKey: 'evt-c-00001', status: 'REJECTED' })]);
    expect(v.status()).toMatchObject({ activated: true, queued: 1, refused: 1 });
  });
});
