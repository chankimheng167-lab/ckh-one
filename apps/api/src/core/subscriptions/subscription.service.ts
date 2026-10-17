import { Injectable } from '@nestjs/common';
import { DatabaseService, Tx } from '../../db/database.service';

export interface TenantEntitlements {
  tenantStatus: string;
  subscriptionStatus: string | null;
  /** True when the tenant may use the platform right now. */
  active: boolean;
  reason?: 'TENANT_SUSPENDED' | 'NO_SUBSCRIPTION' | 'SUBSCRIPTION_EXPIRED';
  modules: Set<string>;
}

/**
 * Server-side source of truth for what a tenant has paid for. Evaluated on
 * every request (and again inside offline-sync processing), never trusted
 * from the client.
 */
@Injectable()
export class SubscriptionService {
  constructor(private readonly db: DatabaseService) {}

  async entitlements(tenantId: string, at: Date = new Date()): Promise<TenantEntitlements> {
    return this.db.withTenant(tenantId, null, (tx) => this.entitlementsTx(tx, at));
  }

  async entitlementsTx(tx: Tx, at: Date = new Date()): Promise<TenantEntitlements> {
    const tenant = await tx.maybeOne<{ status: string }>('SELECT status FROM tenants WHERE id = current_tenant_id()');
    if (!tenant) return { tenantStatus: 'UNKNOWN', subscriptionStatus: null, active: false, reason: 'TENANT_SUSPENDED', modules: new Set() };

    const sub = await tx.maybeOne<{ status: string; usable: boolean }>(
      `SELECT status,
              (ends_at IS NULL OR $1::timestamptz < COALESCE(grace_ends_at, ends_at)) AS usable
         FROM tenant_subscriptions
        WHERE tenant_id = current_tenant_id() AND status IN ('TRIAL', 'ACTIVE', 'PAST_DUE')
        ORDER BY starts_at DESC LIMIT 1`,
      [at.toISOString()],
    );

    const modules = new Set(
      (
        await tx.query<{ module_code: string }>(
          `SELECT module_code FROM tenant_modules
            WHERE tenant_id = current_tenant_id() AND enabled
              AND starts_at <= $1::timestamptz AND (ends_at IS NULL OR ends_at > $1::timestamptz)`,
          [at.toISOString()],
        )
      ).map((r) => r.module_code),
    );

    if (tenant.status !== 'ACTIVE') {
      return { tenantStatus: tenant.status, subscriptionStatus: sub?.status ?? null, active: false, reason: 'TENANT_SUSPENDED', modules };
    }
    if (!sub) return { tenantStatus: tenant.status, subscriptionStatus: null, active: false, reason: 'NO_SUBSCRIPTION', modules };
    if (!sub.usable) {
      return { tenantStatus: tenant.status, subscriptionStatus: sub.status, active: false, reason: 'SUBSCRIPTION_EXPIRED', modules };
    }
    return { tenantStatus: tenant.status, subscriptionStatus: sub.status, active: true, modules };
  }
}
