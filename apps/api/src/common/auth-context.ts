import { createParamDecorator, ExecutionContext, SetMetadata } from '@nestjs/common';
import type { ModuleCode, PermissionCode } from '@ckh/shared';

export interface TenantUser {
  kind: 'user';
  userId: string;
  tenantId: string;
  email: string;
  fullName: string;
  permissions: Set<string>;
  /** Highest approval level across the user's roles (0–3). */
  approvalLevel: number;
  /** Enabled, in-date modules for the tenant (filled by the subscription guard). */
  modules?: Set<string>;
  /** Device session the access token belongs to. */
  sessionId: string;
  /** Tenant business time zone (IANA), e.g. Asia/Phnom_Penh. */
  timezone: string;
}

export interface PlatformAdmin {
  kind: 'platform';
  adminId: string;
  email: string;
  sessionId: string;
}

export type Principal = TenantUser | PlatformAdmin;

export const IS_PUBLIC = 'ckh:isPublic';
export const REQUIRED_PERMISSIONS = 'ckh:permissions';
export const REQUIRED_MODULES = 'ckh:modules';
export const PLATFORM_ONLY = 'ckh:platformOnly';
export const ACCOUNT_ROUTE = 'ckh:account';

/** Route needs no authentication. */
export const Public = () => SetMetadata(IS_PUBLIC, true);
/** Caller must hold ALL listed permissions. */
export const RequirePermissions = (...p: PermissionCode[]) => SetMetadata(REQUIRED_PERMISSIONS, p);
/** Caller's tenant must have ALL listed subscription modules active. */
export const RequireModules = (...m: ModuleCode[]) => SetMetadata(REQUIRED_MODULES, m);
/** Super Admin (platform owner) only. */
export const PlatformOnly = () => SetMetadata(PLATFORM_ONLY, true);
/**
 * The caller's own account (sign out, devices, password): any signed-in user
 * or Super Admin, even when the company's subscription has lapsed.
 */
export const AccountRoute = () => SetMetadata(ACCOUNT_ROUTE, true);

export const CurrentUser = createParamDecorator((_d: unknown, ctx: ExecutionContext): TenantUser => {
  const p = ctx.switchToHttp().getRequest().principal as Principal | undefined;
  if (!p || p.kind !== 'user') throw new Error('CurrentUser used on a route without a tenant user');
  return p;
});

export const CurrentAdmin = createParamDecorator((_d: unknown, ctx: ExecutionContext): PlatformAdmin => {
  const p = ctx.switchToHttp().getRequest().principal as Principal | undefined;
  if (!p || p.kind !== 'platform') throw new Error('CurrentAdmin used on a route without a platform admin');
  return p;
});

export const CurrentPrincipal = createParamDecorator((_d: unknown, ctx: ExecutionContext): Principal => {
  const p = ctx.switchToHttp().getRequest().principal as Principal | undefined;
  if (!p) throw new Error('CurrentPrincipal used on a public route');
  return p;
});

export function has(user: TenantUser, perm: PermissionCode): boolean {
  return user.permissions.has(perm);
}
