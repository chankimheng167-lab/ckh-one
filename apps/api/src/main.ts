import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { loadConfig } from './config';

/**
 * CORS limited to the configured web origins (required in production), and
 * conservative security headers on every response. The API only serves
 * JSON and file downloads, so it never needs to be framed or sniffed.
 */
export function applySecurity(app: INestApplication) {
  const cfg = loadConfig();
  const production = cfg.nodeEnv === 'production';
  app.enableCors({
    origin: cfg.corsOrigins.length ? cfg.corsOrigins : true,
    credentials: false,
    allowedHeaders: ['Authorization', 'Content-Type', 'Accept', 'X-Device-Id'],
    maxAge: 600,
  });
  const http = app.getHttpAdapter().getInstance();
  http.disable?.('x-powered-by');
  if (production) http.set?.('trust proxy', 1);
  app.use((req: any, res: any, next: () => void) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    if (production) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    if (String(req.url).includes('/auth/')) res.setHeader('Cache-Control', 'no-store');
    next();
  });
}

export async function createApp() {
  const app = await NestFactory.create(AppModule, { logger: ['error', 'warn', 'log'] });
  app.setGlobalPrefix('api/v1');
  applySecurity(app);
  app.enableShutdownHooks();
  return app;
}

if (require.main === module) {
  createApp().then(async (app) => {
    const { port } = loadConfig();
    await app.listen(port);
    console.log(`CKH ONE API listening on :${port}/api/v1`);
  });
}
