import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { loadConfig } from './config';

export async function createApp() {
  const app = await NestFactory.create(AppModule, { logger: ['error', 'warn', 'log'] });
  app.setGlobalPrefix('api/v1');
  app.enableCors({ origin: process.env.CORS_ORIGINS?.split(',') ?? true, credentials: true });
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
