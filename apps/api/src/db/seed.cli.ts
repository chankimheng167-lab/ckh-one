import { loadConfig, PUBLIC_DEMO_PASSWORD } from '../config';
import { newPassword } from '../common/validation';
import { platformTx, seedDemoTenant, seedPlatform } from './seed';

/**
 * Production never uses the public demo password: the Super Admin password
 * must be supplied (and pass the password policy), and demo data is only
 * seeded when asked for explicitly, with its own non-public password.
 */
export function seedOptions(env: NodeJS.ProcessEnv = process.env) {
  const production = (env.NODE_ENV ?? 'development') === 'production';
  const strong = (name: string, value: string | undefined) => {
    if (!value) throw new Error(`Set ${name}`);
    if (value === PUBLIC_DEMO_PASSWORD) throw new Error(`${name} must not be the public demo password`);
    const r = newPassword.safeParse(value);
    if (!r.success) throw new Error(`${name}: ${r.error.issues.map((i) => i.message).join('; ')}`);
    return value;
  };
  const superAdminPassword = production ? strong('SUPERADMIN_PASSWORD', env.SUPERADMIN_PASSWORD) : env.SUPERADMIN_PASSWORD ?? PUBLIC_DEMO_PASSWORD;
  const seedDemo = env.SEED_DEMO ? env.SEED_DEMO === 'true' : !production;
  const demoPassword = seedDemo && production ? strong('DEMO_PASSWORD', env.DEMO_PASSWORD) : env.DEMO_PASSWORD ?? PUBLIC_DEMO_PASSWORD;
  return { email: env.SUPERADMIN_EMAIL ?? 'superadmin@ckh.one', superAdminPassword, seedDemo, demoPassword };
}

async function main() {
  const url = loadConfig().migrationDatabaseUrl;
  const o = seedOptions();
  await platformTx(url, (tx) => seedPlatform(tx, { email: o.email, password: o.superAdminPassword, fullName: 'CKH Super Admin' }));
  if (o.seedDemo) await platformTx(url, (tx) => seedDemoTenant(tx, o.demoPassword));
  console.log('seed complete');
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
