import { Injectable } from '@nestjs/common';
import { createHash, randomBytes, timingSafeEqual } from 'crypto';
import { z } from 'zod';
import type { TenantUser } from '../common/auth-context';
import { AuditService } from '../common/audit.service';
import { conflict, DomainError, notFound } from '../common/errors';
import { uuid } from '../common/validation';
import type { Tx } from '../db/database.service';
import { PosContextService } from './pos-context.service';
import { PosLicenseService } from './pos-license.service';

export const ActivateInput = z.object({
  registerId: uuid,
  /** Installation id the app generated on first start. */
  deviceKey: z.string().min(8).max(200).regex(/^[A-Za-z0-9._:-]+$/),
  name: z.string().trim().min(1).max(80),
  platform: z.string().max(40).optional(),
  appVersion: z.string().max(40).optional(),
});

export const HeartbeatInput = z.object({ appVersion: z.string().max(40).optional() });

export interface PosDevice {
  id: string;
  register_id: string;
  branch_id: string;
  warehouse_id: string;
  name: string;
  status: string;
  license_expires_at: string | null;
  created_at: string;
}

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

/**
 * Windows POS devices. A manager activates a device for one register; the
 * server returns a random device secret once (the app keeps it encrypted)
 * and stores only its SHA-256. Every device call sends "X-POS-Device:
 * <id>:<secret>" alongside the signed-in user's token. The device's offline
 * licence is renewed on each heartbeat and never outlives the company's
 * subscription or POS module.
 */
@Injectable()
export class PosDevicesService {
  constructor(
    private readonly ctx: PosContextService,
    private readonly licenses: PosLicenseService,
    private readonly audit: AuditService,
  ) {}

  async activate(tx: Tx, user: TenantUser, i: z.infer<typeof ActivateInput>) {
    const reg = await this.ctx.register(tx, user, i.registerId);
    await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))', [`pos-devices:${tx.tenantId}`]);
    const lic = await this.ctx.license(tx);
    const active = (await tx.one<{ n: number }>(`SELECT count(*)::int AS n FROM pos_devices WHERE status = 'ACTIVE'`)).n;
    if (lic.maxDevices !== null && active >= lic.maxDevices) {
      throw new DomainError('LICENSE_LIMIT_REACHED', `Your plan allows ${lic.maxDevices} POS devices; revoke one or ask CKH ONE for more`, 403);
    }
    const dup = await tx.maybeOne(`SELECT id FROM pos_devices WHERE device_key = $1 AND status = 'ACTIVE'`, [i.deviceKey]);
    if (dup) throw conflict('DEVICE_ALREADY_ACTIVE', 'This computer is already activated; revoke it first to move it to another register');
    const secret = randomBytes(32).toString('base64url');
    const d = await tx.one<PosDevice>(
      `INSERT INTO pos_devices (tenant_id, register_id, device_key, name, platform, app_version, secret_hash, activated_by, last_seen_at)
       VALUES (current_tenant_id(), $1, $2, $3, $4, $5, $6, $7, now()) RETURNING *`,
      [reg.id, i.deviceKey, i.name, i.platform ?? null, i.appVersion ?? null, sha(secret), user.userId],
    );
    const license = await this.issue(tx, { id: d.id, register_id: reg.id, branch_id: reg.branch_id });
    await this.audit.record(tx, { action: 'POS_DEVICE_ACTIVATED', entityType: 'pos_device', entityId: d.id, after: { name: i.name, register: reg.code } });
    return { deviceId: d.id, deviceSecret: secret, registerId: reg.id, license, publicKey: this.licenses.publicKeyPem() };
  }

  /** Checks the X-POS-Device header against the stored hash. */
  async authenticate(tx: Tx, header: string | undefined): Promise<PosDevice> {
    const m = /^([0-9a-f-]{36}):([A-Za-z0-9_-]{20,100})$/.exec(header ?? '');
    if (!m) throw new DomainError('DEVICE_REQUIRED', 'This call must come from an activated CKH ONE POS device', 403);
    const d = await tx.maybeOne<PosDevice & { secret_hash: string }>(
      `SELECT d.*, r.branch_id, r.warehouse_id FROM pos_devices d JOIN pos_registers r ON r.id = d.register_id WHERE d.id = $1`,
      [m[1]],
    );
    const given = Buffer.from(sha(m[2]), 'hex');
    const ok = !!d && timingSafeEqual(given, Buffer.from(d.secret_hash, 'hex'));
    if (!ok) throw new DomainError('DEVICE_UNKNOWN', 'This device is not recognised; activate it again', 403);
    if (d!.status !== 'ACTIVE') throw new DomainError('DEVICE_REVOKED', 'This device was revoked by a manager', 403);
    const { secret_hash: _s, ...device } = d!;
    return device;
  }

  async heartbeat(tx: Tx, user: TenantUser, device: PosDevice, i: z.infer<typeof HeartbeatInput>) {
    await this.ctx.register(tx, user, device.register_id, { allowInactive: true });
    await tx.query('UPDATE pos_devices SET last_seen_at = now(), app_version = COALESCE($2, app_version) WHERE id = $1', [device.id, i.appVersion ?? null]);
    return { deviceId: device.id, status: 'ACTIVE', serverTime: new Date().toISOString(), license: await this.issue(tx, device), publicKey: this.licenses.publicKeyPem() };
  }

  /** Devices on registers in the branches the user works in (all, for company-wide roles). */
  async list(tx: Tx, user: TenantUser) {
    const branches = await this.ctx.branchIds(tx, user);
    return tx.query(
      `SELECT d.id, d.name, d.platform, d.app_version, d.status, d.license_issued_at, d.license_expires_at, d.last_seen_at, d.last_sync_at,
              d.created_at, d.revoked_at, r.code AS register_code, r.name AS register_name, b.name AS branch_name,
              a.full_name AS activated_by_name, rv.full_name AS revoked_by_name,
              (SELECT count(*)::int FROM pos_sync_events e WHERE e.device_id = d.id) AS synced_events,
              (SELECT count(*)::int FROM pos_sync_events e WHERE e.device_id = d.id AND e.status IN ('REJECTED', 'CONFLICT')) AS refused_events
         FROM pos_devices d JOIN pos_registers r ON r.id = d.register_id JOIN branches b ON b.id = r.branch_id
         LEFT JOIN users a ON a.id = d.activated_by LEFT JOIN users rv ON rv.id = d.revoked_by
        WHERE ($1::uuid[] IS NULL OR r.branch_id = ANY($1))
        ORDER BY d.status, d.created_at DESC`,
      [branches],
    );
  }

  async revoke(tx: Tx, user: TenantUser, id: string) {
    const d = await tx.maybeOne(
      `SELECT d.*, r.branch_id FROM pos_devices d JOIN pos_registers r ON r.id = d.register_id WHERE d.id = $1 FOR UPDATE OF d`,
      [id],
    );
    if (!d) throw notFound('Device');
    await this.ctx.assertBranch(tx, user, d.branch_id);
    if (d.status === 'REVOKED') return d;
    const after = await tx.one(
      `UPDATE pos_devices SET status = 'REVOKED', revoked_by = $2, revoked_at = now(), license_expires_at = LEAST(license_expires_at, now())
        WHERE id = $1 RETURNING id, name, status, revoked_at`,
      [id, user.userId],
    );
    await this.audit.record(tx, { action: 'POS_DEVICE_REVOKED', entityType: 'pos_device', entityId: id, before: { status: d.status }, after });
    return after;
  }

  /** Signs a fresh offline licence: the shorter of the tenant's offline window and its paid-up period. */
  private async issue(tx: Tx, d: Pick<PosDevice, 'id' | 'register_id' | 'branch_id'>) {
    const lic = await this.ctx.license(tx);
    const t = await tx.one<{ code: string; limit_at: string | null }>(
      `SELECT t.code,
              LEAST(
                (SELECT COALESCE(s.grace_ends_at, s.ends_at) FROM tenant_subscriptions s
                  WHERE s.tenant_id = t.id AND s.status IN ('TRIAL', 'ACTIVE', 'PAST_DUE') LIMIT 1),
                (SELECT m.ends_at FROM tenant_modules m WHERE m.tenant_id = t.id AND m.module_code = 'POS_SALES')
              ) AS limit_at
         FROM tenants t WHERE t.id = current_tenant_id()`,
    );
    const now = new Date();
    let expires = new Date(now.getTime() + lic.offlineValidityHours * 3600_000);
    if (t.limit_at && new Date(t.limit_at) < expires) expires = new Date(t.limit_at);
    const methods = (await this.ctx.paymentMethods(tx)).filter((m) => m.allow_offline).map((m) => m.id);
    const token = this.licenses.sign({
      v: 1,
      tenantId: tx.tenantId as string,
      tenantCode: t.code,
      deviceId: d.id,
      registerId: d.register_id,
      branchId: d.branch_id,
      issuedAt: now.toISOString(),
      expiresAt: expires.toISOString(),
      offlineMethods: methods,
    });
    await tx.query('UPDATE pos_devices SET license_issued_at = $2, license_expires_at = $3 WHERE id = $1', [d.id, now.toISOString(), expires.toISOString()]);
    return { token, issuedAt: now.toISOString(), expiresAt: expires.toISOString() };
  }
}
