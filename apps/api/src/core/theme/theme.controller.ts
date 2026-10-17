import { Body, Controller, Get, Put, Query } from '@nestjs/common';
import { contrastRatio, P, themeCssVariables, ThemeTokens, validateThemeTokens } from '@ckh/shared';
import { z } from 'zod';
import { AuditService } from '../../common/audit.service';
import { CurrentUser, Public, RequirePermissions, TenantUser } from '../../common/auth-context';
import { DomainError } from '../../common/errors';
import { parse } from '../../common/validation';
import { DatabaseService, Tx } from '../../db/database.service';

const ThemeInput = z.object({
  tokens: z.record(z.string()),
  logoUrl: z.string().url().startsWith('https://').max(500).nullable().optional(),
  companyDisplayName: z.string().min(1).max(120).nullable().optional(),
});

async function load(tx: Tx) {
  const r = await tx.maybeOne<{ tokens: ThemeTokens; logo_url: string | null; company_display_name: string | null; updated_at: string | null }>(
    `SELECT s.tokens, s.logo_url, COALESCE(s.company_display_name, t.name) AS company_display_name, s.updated_at
       FROM tenants t LEFT JOIN tenant_theme_settings s ON s.tenant_id = t.id WHERE t.id = current_tenant_id()`,
  );
  const tokens = r?.tokens ?? {};
  return { tokens, cssVariables: themeCssVariables(tokens), logoUrl: r?.logo_url ?? null, companyDisplayName: r?.company_display_name ?? null, updatedAt: r?.updated_at ?? null };
}

function warnings(tokens: ThemeTokens): string[] {
  const vars = themeCssVariables(tokens);
  const out: string[] = [];
  const pair = (fg: string, bg: string, label: string) => {
    const ratio = contrastRatio(vars[fg], vars[bg]);
    if (ratio < 4.5) out.push(`${label} contrast is ${ratio.toFixed(2)}:1; at least 4.5:1 is recommended`);
  };
  pair('--ckh-primary-text', '--ckh-primary', 'Button text on primary');
  pair('--ckh-text', '--ckh-surface', 'Body text on cards');
  pair('--ckh-text', '--ckh-bg', 'Body text on background');
  return out;
}

/** Theme Studio: tenant branding as design tokens, served as CSS variables. */
@Controller()
export class ThemeController {
  constructor(private readonly db: DatabaseService, private readonly audit: AuditService) {}

  @Get('theme')
  get(@CurrentUser() user: TenantUser) {
    return this.db.withTenant(user.tenantId, user.userId, load);
  }

  /** For the sign-in page, before anyone is signed in. Returns defaults for unknown codes. */
  @Public()
  @Get('auth/theme')
  async publicTheme(@Query() query: unknown) {
    const { tenantCode } = parse(z.object({ tenantCode: z.string().min(1).max(60) }), query);
    const t = await this.db.withPlatform(null, (tx) => tx.maybeOne<{ id: string }>(`SELECT id FROM tenants WHERE lower(code) = lower($1) AND status = 'ACTIVE'`, [tenantCode]));
    if (!t) return { tokens: {}, cssVariables: themeCssVariables({}), logoUrl: null, companyDisplayName: null, updatedAt: null };
    return this.db.withTenant(t.id, null, load);
  }

  @Put('admin/theme')
  @RequirePermissions(P.TENANT_SETTINGS_MANAGE)
  put(@CurrentUser() user: TenantUser, @Body() body: unknown) {
    const i = parse(ThemeInput, body);
    const errors = validateThemeTokens(i.tokens);
    if (errors.length) throw new DomainError('INVALID_THEME', errors.join('; '), 422, { errors });
    return this.db.withTenant(user.tenantId, user.userId, async (tx) => {
      const before = await load(tx);
      await tx.query(
        `INSERT INTO tenant_theme_settings (tenant_id, tokens, logo_url, company_display_name, updated_by, updated_at)
         VALUES (current_tenant_id(), $1, $2, $3, $4, now())
         ON CONFLICT (tenant_id) DO UPDATE SET tokens = EXCLUDED.tokens,
           logo_url = CASE WHEN $5 THEN EXCLUDED.logo_url ELSE tenant_theme_settings.logo_url END,
           company_display_name = CASE WHEN $6 THEN EXCLUDED.company_display_name ELSE tenant_theme_settings.company_display_name END,
           updated_by = EXCLUDED.updated_by, updated_at = now()`,
        [JSON.stringify(i.tokens), i.logoUrl ?? null, i.companyDisplayName ?? null, user.userId, i.logoUrl !== undefined, i.companyDisplayName !== undefined],
      );
      const after = await load(tx);
      await this.audit.record(tx, { action: 'THEME_UPDATED', entityType: 'tenant_theme_settings', before: before.tokens, after: after.tokens });
      return { ...after, warnings: warnings(after.tokens) };
    });
  }
}
