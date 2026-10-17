import { loadConfig } from '../config';
import { platformTx, seedDemoTenant, seedPlatform } from './seed';

async function main() {
  const url = loadConfig().migrationDatabaseUrl;
  const email = process.env.SUPERADMIN_EMAIL ?? 'superadmin@ckh.one';
  const password = process.env.SUPERADMIN_PASSWORD;
  if (!password && process.env.NODE_ENV === 'production') throw new Error('Set SUPERADMIN_PASSWORD');
  await platformTx(url, (tx) => seedPlatform(tx, { email, password: password ?? 'ChangeMe!2026', fullName: 'CKH Super Admin' }));
  if (process.env.SEED_DEMO !== 'false') await platformTx(url, (tx) => seedDemoTenant(tx));
  console.log('seed complete');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
