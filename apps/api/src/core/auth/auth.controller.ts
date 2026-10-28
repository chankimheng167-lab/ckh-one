import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, Req } from '@nestjs/common';
import * as bcrypt from 'bcryptjs';
import { z } from 'zod';
import { AccountRoute, CurrentPrincipal, CurrentUser, Principal, Public, TenantUser } from '../../common/auth-context';
import { AuditService } from '../../common/audit.service';
import { DomainError, notFound } from '../../common/errors';
import { newPassword as NewPassword, parse } from '../../common/validation';
import { loadConfig } from '../../config';
import { DatabaseService, Tx } from '../../db/database.service';
import { DeviceInfo, SessionService } from './session.service';

const Device = {
  deviceId: z.string().min(1).max(200).optional(),
  deviceName: z.string().min(1).max(200).optional(),
};
const TenantLogin = z.object({
  tenantCode: z.string().min(2).max(41),
  email: z.string().email(),
  password: z.string().min(1).max(200),
  ...Device,
});
const PlatformLogin = z.object({ email: z.string().email(), password: z.string().min(1).max(200), ...Device });
const Refresh = z.object({ refreshToken: z.string().min(20).max(200) });
const ChangePassword = z.object({ currentPassword: z.string().min(1).max(200), newPassword: NewPassword });

// Constant-time-ish failure: always run one bcrypt compare.
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', 10);

interface Account {
  id: string;
  password_hash: string;
  active: boolean;
  locked: boolean;
}

function device(req: any, input: { deviceId?: string; deviceName?: string }): DeviceInfo {
  return { ...input, userAgent: req.headers?.['user-agent'], ip: req.ip };
}

@Controller('auth')
export class AuthController {
  private readonly cfg = loadConfig();

  constructor(
    private readonly db: DatabaseService,
    private readonly sessions: SessionService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Checks the password and applies the lockout policy: after
   * LOGIN_MAX_FAILURES wrong passwords the account is locked for
   * LOGIN_LOCK_MINUTES, even for the right password.
   */
  private async checkPassword(tx: Tx, table: 'users' | 'platform_admins', account: Account | null, password: string): Promise<boolean> {
    const ok = await bcrypt.compare(password, account?.password_hash ?? DUMMY_HASH);
    if (!account) return false;
    if (account.locked) {
      throw new DomainError('ACCOUNT_LOCKED', 'Too many failed sign-in attempts. Try again later or ask an administrator.', HttpStatus.TOO_MANY_REQUESTS);
    }
    if (ok) {
      await tx.query(`UPDATE ${table} SET failed_login_count = 0, locked_until = NULL WHERE id = $1`, [account.id]);
      return true;
    }
    await tx.query(
      `UPDATE ${table}
          SET failed_login_count = CASE WHEN failed_login_count + 1 >= $2 THEN 0 ELSE failed_login_count + 1 END,
              locked_until = CASE WHEN failed_login_count + 1 >= $2 THEN now() + make_interval(mins => $3) ELSE locked_until END
        WHERE id = $1`,
      [account.id, this.cfg.loginMaxFailures, this.cfg.loginLockMinutes],
    );
    return false;
  }

  @Public()
  @Post('login')
  @HttpCode(HttpStatus.OK)
  async login(@Body() body: unknown, @Req() req: any) {
    const input = parse(TenantLogin, body);
    const tenant = await this.db.withPlatform(null, (tx) =>
      tx.maybeOne<{ id: string; status: string }>('SELECT id, status FROM tenants WHERE code = $1', [input.tenantCode.toLowerCase()]),
    );
    const bad = () => new DomainError('INVALID_CREDENTIALS', 'Company code, email or password is incorrect', HttpStatus.UNAUTHORIZED);
    if (!tenant) {
      await bcrypt.compare(input.password, DUMMY_HASH);
      throw bad();
    }
    // Commit the failure counter even when sign-in is refused.
    const result = await this.db.withTenant(tenant.id, null, async (tx) => {
      const user = await tx.maybeOne<Account & { full_name: string }>(
        `SELECT id, password_hash, status = 'ACTIVE' AS active, COALESCE(locked_until > now(), false) AS locked, full_name
           FROM users WHERE lower(email) = lower($1)`,
        [input.email],
      );
      const ok = await this.checkPassword(tx, 'users', user, input.password);
      if (!user || !ok || !user.active) return null;
      await tx.query('UPDATE users SET last_login_at = now() WHERE id = $1', [user.id]);
      const tokens = await this.sessions.start(tx, { kind: 'user', tenantId: tenant.id, userId: user.id }, device(req, input));
      await this.audit.record(tx, { actorId: user.id, action: 'SIGNED_IN', entityType: 'auth_session', entityId: tokens.sessionId });
      return { ...tokens, user: { id: user.id, fullName: user.full_name }, tenantId: tenant.id };
    });
    if (!result) throw bad();
    return result;
  }

  @Public()
  @Post('platform/login')
  @HttpCode(HttpStatus.OK)
  async platformLogin(@Body() body: unknown, @Req() req: any) {
    const input = parse(PlatformLogin, body);
    const result = await this.db.withPlatform(null, async (tx) => {
      const admin = await tx.maybeOne<Account>(
        `SELECT id, password_hash, is_active AS active, COALESCE(locked_until > now(), false) AS locked
           FROM platform_admins WHERE lower(email) = lower($1)`,
        [input.email],
      );
      const ok = await this.checkPassword(tx, 'platform_admins', admin, input.password);
      if (!admin || !ok || !admin.active) return null;
      const tokens = await this.sessions.start(tx, { kind: 'platform', adminId: admin.id }, device(req, input));
      await this.audit.record(tx, { actorType: 'PLATFORM_ADMIN', actorId: admin.id, action: 'SIGNED_IN', entityType: 'auth_session', entityId: tokens.sessionId });
      return tokens;
    });
    if (!result) throw new DomainError('INVALID_CREDENTIALS', 'Email or password is incorrect', HttpStatus.UNAUTHORIZED);
    return result;
  }

  /** Rotates the refresh token: the old one stops working, reuse revokes the session. */
  @Public()
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  refresh(@Body() body: unknown) {
    return this.sessions.refresh(parse(Refresh, body).refreshToken);
  }

  /** Signs this device out. */
  @AccountRoute()
  @Post('logout')
  @HttpCode(HttpStatus.OK)
  logout(@CurrentPrincipal() p: Principal) {
    return this.inOwnScope(p, async (tx) => ({ revoked: await this.sessions.revoke(tx, { sessionId: p.sessionId }, 'SIGNED_OUT') }));
  }

  /** The caller's signed-in devices. */
  @AccountRoute()
  @Get('sessions')
  listSessions(@CurrentPrincipal() p: Principal) {
    return this.inOwnScope(p, (tx) => this.sessions.list(tx, p.kind === 'user' ? { userId: p.userId } : { adminId: p.adminId }, p.sessionId));
  }

  /** Signs one of the caller's devices out (e.g. a lost phone). */
  @AccountRoute()
  @Delete('sessions/:id')
  revokeSession(@CurrentPrincipal() p: Principal, @Param('id', ParseUUIDPipe) id: string) {
    return this.inOwnScope(p, async (tx) => {
      const owner = p.kind === 'user' ? { userId: p.userId } : { adminId: p.adminId };
      const n = await this.sessions.revoke(tx, { sessionId: id, ...owner }, 'REVOKED_BY_OWNER');
      if (!n) throw notFound('Session');
      return { revoked: n };
    });
  }

  /** Changes the caller's password and signs out every other device. */
  @AccountRoute()
  @Post('password')
  @HttpCode(HttpStatus.OK)
  changePassword(@CurrentPrincipal() p: Principal, @Body() body: unknown) {
    const input = parse(ChangePassword, body);
    const table = p.kind === 'user' ? 'users' : 'platform_admins';
    const id = p.kind === 'user' ? p.userId : p.adminId;
    return this.inOwnScope(p, async (tx) => {
      const row = await tx.one<{ password_hash: string }>(`SELECT password_hash FROM ${table} WHERE id = $1`, [id]);
      if (!(await bcrypt.compare(input.currentPassword, row.password_hash))) {
        throw new DomainError('INVALID_CREDENTIALS', 'Current password is incorrect', HttpStatus.UNPROCESSABLE_ENTITY);
      }
      await tx.query(`UPDATE ${table} SET password_hash = $2, password_changed_at = now() WHERE id = $1`, [id, await bcrypt.hash(input.newPassword, 10)]);
      const owner = p.kind === 'user' ? { userId: p.userId } : { adminId: p.adminId };
      const signedOut = await this.sessions.revoke(tx, { ...owner, exceptSessionId: p.sessionId }, 'PASSWORD_CHANGED');
      await this.audit.record(tx, {
        actorType: p.kind === 'user' ? 'USER' : 'PLATFORM_ADMIN',
        actorId: id,
        action: 'PASSWORD_CHANGED',
        entityType: table,
        entityId: id,
      });
      return { changed: true, otherSessionsSignedOut: signedOut };
    });
  }

  /** Who am I, what can I do, which modules are on — drives the app's navigation. */
  @Get('me')
  me(@CurrentUser() user: TenantUser) {
    return {
      userId: user.userId,
      tenantId: user.tenantId,
      email: user.email,
      fullName: user.fullName,
      permissions: [...user.permissions].sort(),
      approvalLevel: user.approvalLevel,
      modules: [...(user.modules ?? [])].sort(),
      timezone: user.timezone,
      sessionId: user.sessionId,
    };
  }

  private inOwnScope<T>(p: Principal, fn: (tx: Tx) => Promise<T>): Promise<T> {
    return p.kind === 'user' ? this.db.withTenant(p.tenantId, p.userId, fn) : this.db.withPlatform(p.adminId, fn);
  }
}
