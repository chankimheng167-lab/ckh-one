import { CanActivate, ExecutionContext, HttpStatus, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { MODULES } from '@ckh/shared';
import {
  ACCOUNT_ROUTE,
  IS_PUBLIC,
  PLATFORM_ONLY,
  Principal,
  REQUIRED_MODULES,
  REQUIRED_PERMISSIONS,
} from '../../common/auth-context';
import { DomainError } from '../../common/errors';
import { DatabaseService } from '../../db/database.service';
import { SubscriptionService } from '../subscriptions/subscription.service';
import { JwtPayload, SessionService } from './session.service';

export type { JwtPayload } from './session.service';

/**
 * Single global guard, run on every route, in this order:
 *   1. authenticate the bearer token, check its device session is still live,
 *      and reload the user from the database (so disabled users, revoked
 *      sessions and removed roles take effect immediately);
 *   2. platform-only routes accept Super Admins only; account routes
 *      (@AccountRoute: sign out, devices, password) accept anyone signed in;
 *   3. tenant routes require an active subscription and every module the
 *      route declares (@RequireModules). A route that declares none requires
 *      CORE, so a route can never be reachable without a licence;
 *   4. the user must hold every permission the route declares
 *      (@RequirePermissions).
 * Services re-check record-level rules (e.g. "is this customer assigned to
 * me") inside their own transactions.
 */
@Injectable()
export class AccessGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly sessions: SessionService,
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
      payload = await this.sessions.verify(header.slice(7));
    } catch {
      throw new DomainError('UNAUTHENTICATED', 'Invalid or expired token', HttpStatus.UNAUTHORIZED);
    }
    if (!payload.sid) throw new DomainError('UNAUTHENTICATED', 'Invalid token', HttpStatus.UNAUTHORIZED);
    const sessionEnded = () => new DomainError('SESSION_REVOKED', 'This session has been signed out. Please sign in again.', HttpStatus.UNAUTHORIZED);

    const platformOnly = this.reflector.getAllAndOverride<boolean>(PLATFORM_ONLY, targets) ?? false;
    const accountRoute = this.reflector.getAllAndOverride<boolean>(ACCOUNT_ROUTE, targets) ?? false;
    let principal: Principal;

    if (payload.typ === 'platform') {
      const admin = await this.db.withPlatform(payload.sub, (tx) =>
        tx.maybeOne<{ id: string; email: string; is_active: boolean; session_live: boolean }>(
          `SELECT a.id, a.email, a.is_active,
                  EXISTS (SELECT 1 FROM auth_sessions s WHERE s.id = $2 AND s.platform_admin_id = a.id
                             AND s.revoked_at IS NULL AND s.expires_at > now()) AS session_live
             FROM platform_admins a WHERE a.id = $1`,
          [payload.sub, payload.sid],
        ),
      );
      if (!admin?.is_active) throw new DomainError('UNAUTHENTICATED', 'Account disabled', HttpStatus.UNAUTHORIZED);
      if (!admin.session_live) throw sessionEnded();
      principal = { kind: 'platform', adminId: admin.id, email: admin.email, sessionId: payload.sid };
      req.principal = principal;
      if (!platformOnly && !accountRoute) throw new DomainError('FORBIDDEN', 'Super Admin accounts cannot call tenant APIs', HttpStatus.FORBIDDEN);
      return true;
    }

    if (platformOnly) throw new DomainError('FORBIDDEN', 'Super Admin only', HttpStatus.FORBIDDEN);
    if (!payload.tid) throw new DomainError('UNAUTHENTICATED', 'Invalid token', HttpStatus.UNAUTHORIZED);

    const loaded = await this.db.withTenant(payload.tid, payload.sub, async (tx) => {
      const user = await tx.maybeOne<{ id: string; email: string; full_name: string; status: string; session_live: boolean }>(
        `SELECT u.id, u.email, u.full_name, u.status,
                EXISTS (SELECT 1 FROM auth_sessions s WHERE s.id = $2 AND s.user_id = u.id
                           AND s.revoked_at IS NULL AND s.expires_at > now()) AS session_live
           FROM users u WHERE u.id = $1`,
        [payload.sub, payload.sid],
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
      return { user, perms, ent, timezone: tx.timezone };
    });

    if (!loaded || loaded.user.status !== 'ACTIVE') {
      throw new DomainError('UNAUTHENTICATED', 'Account disabled', HttpStatus.UNAUTHORIZED);
    }
    const { user, perms, ent, timezone } = loaded;
    if (!user.session_live) throw sessionEnded();

    principal = {
      kind: 'user',
      userId: user.id,
      tenantId: payload.tid,
      email: user.email,
      fullName: user.full_name,
      permissions: new Set(perms.map((p) => p.permission_code).filter(Boolean)),
      approvalLevel: perms.reduce((m, p) => Math.max(m, Number(p.approval_level)), 0),
      modules: ent.modules,
      sessionId: payload.sid,
      timezone,
    };
    req.principal = principal;
    if (accountRoute) return true;

    if (!ent.active) {
      throw new DomainError(ent.reason ?? 'SUBSCRIPTION_INACTIVE', subscriptionMessage(ent.reason), HttpStatus.PAYMENT_REQUIRED);
    }

    const declared = this.reflector.getAllAndMerge<string[]>(REQUIRED_MODULES, targets) ?? [];
    // Fail closed: a route that names no module still needs the CORE licence.
    const needModules = declared.length ? declared : [MODULES.CORE];
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
