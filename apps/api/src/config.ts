export interface AppConfig {
  port: number;
  databaseUrl: string;
  /** Owner connection used only for migrations and seeding. */
  migrationDatabaseUrl: string;
  jwtSecret: string;
  /** Access token lifetime. Short: sessions are kept alive with refresh tokens. */
  jwtTtlSeconds: number;
  /** How long a device session lives without being used (sliding). Offline reps need days, not hours. */
  refreshTtlDays: number;
  /** A refresh token presented again within this many seconds is a race, not theft. */
  refreshReuseGraceSeconds: number;
  /** Failed sign-ins before an account is locked, and for how long. */
  loginMaxFailures: number;
  loginLockMinutes: number;
  /** Allowed browser origins. Empty means any origin (development only). */
  corsOrigins: string[];
  nodeEnv: string;
}

/** The password printed in the README for local demo data; never accepted in production. */
export const PUBLIC_DEMO_PASSWORD = 'ChangeMe!2026';

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const nodeEnv = env.NODE_ENV ?? 'development';
  const production = nodeEnv === 'production';
  const jwtSecret = env.JWT_SECRET ?? (production ? '' : 'dev-only-insecure-secret-change-me');
  if (!jwtSecret || (production && jwtSecret.length < 32)) {
    throw new Error('JWT_SECRET must be set to at least 32 characters in production');
  }
  const corsOrigins = (env.CORS_ORIGINS ?? '')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);
  if (production && corsOrigins.length === 0) {
    throw new Error('CORS_ORIGINS must list the web app origin(s) in production');
  }
  const databaseUrl = env.DATABASE_URL ?? 'postgres://ckh_app_user:ckh_app_pass@localhost:5432/ckh_one';
  return {
    port: Number(env.PORT ?? 3001),
    databaseUrl,
    migrationDatabaseUrl: env.MIGRATION_DATABASE_URL ?? databaseUrl,
    jwtSecret,
    jwtTtlSeconds: Number(env.JWT_TTL_SECONDS ?? 60 * 15),
    refreshTtlDays: Number(env.REFRESH_TTL_DAYS ?? 30),
    refreshReuseGraceSeconds: Number(env.REFRESH_REUSE_GRACE_SECONDS ?? 30),
    loginMaxFailures: Number(env.LOGIN_MAX_FAILURES ?? 5),
    loginLockMinutes: Number(env.LOGIN_LOCK_MINUTES ?? 15),
    corsOrigins,
    nodeEnv,
  };
}
