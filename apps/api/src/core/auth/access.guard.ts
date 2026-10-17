import { CanActivate, ExecutionContext, HttpStatus, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import {
  IS_PUBLIC,
  PLATFORM_ONLY,
  Principal,
  REQUIRED_MODULES,
  REQUIRED_PERMISSIONS,
} from '../../common/auth-context';
import { DomainError } from '../../common/errors';
import { DatabaseService } from '../../db/database.service';
import { SubscriptionService } from '../subscriptions/subscription.service';

export interface JwtPayload {
  sub: string;
  typ: 'user' | 'platform';
  tid?: string;
}

/**
 * Single global guard, run on every route, in this order:
 *   1. authenticate the bearer token and reload the user from the database
 *      (so disabled users / revoked roles take effect immediately);
 *   2. platform-only routes accept Super Admins only;
 *   3. tenant routes require an active subscription and every module the
 *      route declares (@RequireModules);
 *   4. the user must hold every permission the route declares
 *      (@RequirePermissions).
 * Services re-check record-level rules (e.g. "is this customer assigned to
 * me") inside their own transactions.
 */
@Injectable()
export class AccessGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly jwt: JwtService,
    private readonly db: DatabaseService,
    private readonly subscriptions: SubscriptionService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const targets = [ctx.getHandler(), ctx.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, targets)) return true;

    const req = ctx.switchToHttp().getRequest();
    const header: string | undefined = req.headers['authorization'];
    if (!header?.startsWith('Bearer ')) throw new DomainError('UNAUTHENTICATED', 'Missing bearer token', HttpStatus.UNAUTHORIZED);

    let payload: JwtPayload;
    try {
      payload = await this.jwt.verifyAsync<JwtPayload>(header.slice(7));
    } catch {
      throw new DomainError('UNAUTHENTICATED', 'Invalid or expired token', HttpStatus.UNAUTHORIZED);
    }

    const platformOnly = this.reflector.getAllAndOverride<boolean>(PLATFORM_ONLY, targets) ?? false;
    let principal: Principal;

    if (payload.typ === 'platform') {
      const admin = await this.db.withPlatform(payload.sub, (tx) =>
        tx.maybeOne<{ id: string; email: string; is_active: boolean }>(
          'SELECT id, email, is_active FROM platform_admins WHERE id = $1',
          [payload.sub],
        ),
      );
      if (!admin?.is_active) throw new DomainError('UNAUTHENTICATED', 'Account disabled', HttpStatus.UNAUTHORIZED);
      principal = { kind: 'platform', adminId: admin.id, email: admin.email };
      req.principal = principal;
      if (!platformOnly) throw new DomainError('FORBIDDEN', 'Super Admin accounts cannot call tenant APIs', HttpStatus.FORBIDDEN);
      return true;
    }

    if (platformOnly) throw new DomainError('FORBIDDEN', 'Super Admin only', HttpStatus.FORBIDDEN);
    if (!payload.tid) throw new DomainError('UNAUTHENTICATED', 'Invalid token', HttpStatus.UNAUTHORIZED);

    const loaded = await this.db.withTenant(payload.tid, payload.sub, async (tx) => {
      const user = await tx.maybeOne<{ id: string; email: string; full_name: string; status: string }>(
        'SELECT id, email, full_name, status FROM users WHERE id = $1',
        [payload.sub],
      );
      if (!user) return null;
      const perms = await tx.query<{ permission_code: string; approval_level: number }>(
        `SELECT rp.permission_code, r.approval_level
           FROM user_roles ur
           JOIN roles r ON r.id = ur.role_id
           LEFT JOIN role_permissions rp ON rp.role_id = r.id
          WHERE ur.user_id = $1`,
        [payload.sub],
      );
      const ent = await this.subscriptions.entitlementsTx(tx);
      return { user, perms, ent };
    });

    if (!loaded || loaded.user.status !== 'ACTIVE') {
      throw new DomainError('UNAUTHENTICATED', 'Account disabled', HttpStatus.UNAUTHORIZED);
    }
    const { user, perms, ent } = loaded;

    principal = {
      kind: 'user',
      userId: user.id,
      tenantId: payload.tid,
      email: user.email,
      fullName: user.full_name,
      permissions: new Set(perms.map((p) => p.permission_code).filter(Boolean)),
      approvalLevel: perms.reduce((m, p) => Math.max(m, Number(p.approval_level)), 0),
      modules: ent.modules,
    };
    req.principal = principal;

    if (!ent.active) {
      throw new DomainError(ent.reason ?? 'SUBSCRIPTION_INACTIVE', subscriptionMessage(ent.reason), HttpStatus.PAYMENT_REQUIRED);
    }

    const needModules = this.reflector.getAllAndMerge<string[]>(REQUIRED_MODULES, targets) ?? [];
    const missingModules = needModules.filter((m) => !ent.modules.has(m));
    if (missingModules.length) {
      throw new DomainError('MODULE_NOT_SUBSCRIBED', `Your subscription does not include: ${missingModules.join(', ')}`, HttpStatus.PAYMENT_REQUIRED, {
        missingModules,
      });
    }

    const needPerms = this.reflector.getAllAndMerge<string[]>(REQUIRED_PERMISSIONS, targets) ?? [];
    const missingPerms = needPerms.filter((p) => !principal.permissions.has(p));
    if (missingPerms.length) {
      throw new DomainError('FORBIDDEN', 'You do not have permission to perform this action', HttpStatus.FORBIDDEN, {
        missingPermissions: missingPerms,
      });
    }
    return true;
  }
}

function subscriptionMessage(reason?: string): string {
  switch (reason) {
    case 'TENANT_SUSPENDED':
      return 'This company account is suspended. Please contact CKH ONE support.';
    case 'NO_SUBSCRIPTION':
      return 'This company has no active subscription.';
    case 'SUBSCRIPTION_EXPIRED':
      return 'The subscription has expired. Please renew to continue.';
    default:
      return 'Subscription inactive';
  }
}
