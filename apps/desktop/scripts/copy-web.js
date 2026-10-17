// Copies the static web build (apps/web/out) into build/web so the installer can bundle it.
// Build the web app first with the production API address, e.g.
//   $env:NEXT_PUBLIC_API_URL="https://api.example.com/api/v1"; pnpm --filter @ckh/web build
const { cpSync, existsSync, rmSync, writeFileSync } = require('fs');
const { join } = require('path');
const src = join(__dirname, '..', '..', 'web', 'out');
const dest = join(__dirname, '..', 'build', 'web');
if (!existsSync(join(src, 'index.html'))) {
  console.error(`No web build at ${src}. Run "pnpm --filter @ckh/web build" first.`);
  process.exit(1);
}
const apiUrl = process.env.NEXT_PUBLIC_API_URL;
if (!apiUrl || !/^https:\/\//.test(apiUrl)) {
  console.error('Set NEXT_PUBLIC_API_URL to the https API address the web build was made with.');
  process.exit(1);
}
rmSync(dest, { recursive: true, force: true });
cpSync(src, dest, { recursive: true });
// The public half of the API's offline-licence key (POS_LICENSE_PRIVATE_KEY). Built in, the app
// refuses licences signed by any other key; without it the key is pinned when the till is activated.
const licensePublicKey = process.env.CKH_LICENSE_PUBLIC_KEY ? process.env.CKH_LICENSE_PUBLIC_KEY.replace(/\\n/g, '\n') : undefined;
if (licensePublicKey && !/BEGIN PUBLIC KEY/.test(licensePublicKey)) {
  console.error('CKH_LICENSE_PUBLIC_KEY must be a PEM public key (GET /api/v1/pos/license/public-key).');
  process.exit(1);
}
if (!licensePublicKey) console.warn('CKH_LICENSE_PUBLIC_KEY is not set: the licence key will be pinned at activation instead.');
writeFileSync(join(dest, 'ckh-desktop.json'), JSON.stringify({ apiUrl, licensePublicKey }));
console.log(`Copied ${src} -> ${dest}`);
