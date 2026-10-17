export interface AppConfig {
  port: number;
  databaseUrl: string;
  /** Owner connection used only for migrations and seeding. */
  migrationDatabaseUrl: string;
  jwtSecret: string;
  jwtTtlSeconds: number;
  nodeEnv: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const nodeEnv = env.NODE_ENV ?? 'development';
  const jwtSecret = env.JWT_SECRET ?? (nodeEnv === 'production' ? '' : 'dev-only-insecure-secret-change-me');
  if (!jwtSecret || (nodeEnv === 'production' && jwtSecret.length < 32)) {
    throw new Error('JWT_SECRET must be set to at least 32 characters in production');
  }
  const databaseUrl = env.DATABASE_URL ?? 'postgres://ckh_app_user:ckh_app_pass@localhost:5432/ckh_one';
  return {
    port: Number(env.PORT ?? 3001),
    databaseUrl,
    migrationDatabaseUrl: env.MIGRATION_DATABASE_URL ?? databaseUrl,
    jwtSecret,
    jwtTtlSeconds: Number(env.JWT_TTL_SECONDS ?? 60 * 60 * 8),
    nodeEnv,
  };
}
