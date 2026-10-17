import { Body, Controller, Get, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcryptjs';
import { z } from 'zod';
import { CurrentUser, Public, TenantUser } from '../../common/auth-context';
import { DomainError } from '../../common/errors';
import { parse } from '../../common/validation';
import { DatabaseService } from '../../db/database.service';
import type { JwtPayload } from './access.guard';

const TenantLogin = z.object({
  tenantCode: z.string().min(2).max(41),
  email: z.string().email(),
  password: z.string().min(1).max(200),
});
const PlatformLogin = z.object({ email: z.string().email(), password: z.string().min(1).max(200) });

// Constant-time-ish failure: always run one bcrypt compare.
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', 10);

@Controller('auth')
export class AuthController {
  constructor(
    private readonly db: DatabaseService,
    private readonly jwt: JwtService,
  ) {}

  @Public()
  @Post('login')
  @HttpCode(HttpStatus.OK)
  async login(@Body() body: unknown) {
    const input = parse(TenantLogin, body);
    const tenant = await this.db.withPlatform(null, (tx) =>
      tx.maybeOne<{ id: string; status: string }>('SELECT id, status FROM tenants WHERE code = $1', [input.tenantCode.toLowerCase()]),
    );
    const user = tenant
      ? await this.db.withTenant(tenant.id, null, (tx) =>
          tx.maybeOne<{ id: string; password_hash: string; status: string; full_name: string }>(
            'SELECT id, password_hash, status, full_name FROM users WHERE lower(email) = lower($1)',
            [input.email],
          ),
        )
      : null;
    const ok = await bcrypt.compare(input.password, user?.password_hash ?? DUMMY_HASH);
    if (!tenant || !user || !ok || user.status !== 'ACTIVE') {
      throw new DomainError('INVALID_CREDENTIALS', 'Company code, email or password is incorrect', HttpStatus.UNAUTHORIZED);
    }
    await this.db.withTenant(tenant.id, user.id, (tx) => tx.query('UPDATE users SET last_login_at = now() WHERE id = $1', [user.id]));
    const payload: JwtPayload = { sub: user.id, typ: 'user', tid: tenant.id };
    return { accessToken: await this.jwt.signAsync(payload), user: { id: user.id, fullName: user.full_name }, tenantId: tenant.id };
  }

  @Public()
  @Post('platform/login')
  @HttpCode(HttpStatus.OK)
  async platformLogin(@Body() body: unknown) {
    const input = parse(PlatformLogin, body);
    const admin = await this.db.withPlatform(null, (tx) =>
      tx.maybeOne<{ id: string; password_hash: string; is_active: boolean }>(
        'SELECT id, password_hash, is_active FROM platform_admins WHERE lower(email) = lower($1)',
        [input.email],
      ),
    );
    const ok = await bcrypt.compare(input.password, admin?.password_hash ?? DUMMY_HASH);
    if (!admin || !ok || !admin.is_active) {
      throw new DomainError('INVALID_CREDENTIALS', 'Email or password is incorrect', HttpStatus.UNAUTHORIZED);
    }
    const payload: JwtPayload = { sub: admin.id, typ: 'platform' };
    return { accessToken: await this.jwt.signAsync(payload) };
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
    };
  }
}
