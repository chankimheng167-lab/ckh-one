# Deploying CKH ONE

This covers the database, the API, the web app and the Windows POS app. Server commands are shown for a Linux
host (bash); every step also has a PowerShell version at the end, for Windows machines and local development.

## 1. Database (PostgreSQL 14+, 16 recommended)

```bash
# As the database owner (never the API's login):
psql -U postgres -c "CREATE DATABASE ckh_one"
MIGRATION_DATABASE_URL=postgres://owner:***@db:5432/ckh_one pnpm db:migrate

# Restricted login the API uses. It is a member of ckh_app and is subject to row-level security.
psql -U postgres -d ckh_one -c "CREATE ROLE ckh_app_user LOGIN PASSWORD '<strong password>' IN ROLE ckh_app"
```

Check the API login can never bypass row-level security:

```sql
SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = 'ckh_app_user';  -- both must be false
```

Run migrations on every deploy before starting the new API version. They are idempotent, take an advisory
lock, and re-apply `db/repeatable/R__rls.sql` so new tables get row-level security.

## 2. First Super Admin

```bash
NODE_ENV=production \
MIGRATION_DATABASE_URL=postgres://owner:***@db:5432/ckh_one \
SUPERADMIN_EMAIL=owner@yourcompany.com \
SUPERADMIN_PASSWORD='<at least 10 characters, letters and numbers>' \
pnpm db:seed
```

In production the seed refuses to run without `SUPERADMIN_PASSWORD`, refuses the public demo password, and
does not create the demo company unless you set `SEED_DEMO=true` and a private `DEMO_PASSWORD`.

## 3. API

```bash
pnpm install --frozen-lockfile
pnpm --filter @ckh/shared build
pnpm --filter @ckh/api build
NODE_ENV=production node apps/api/dist/main.js
```

Required environment:

| Variable | Value |
|---|---|
| `NODE_ENV` | `production` |
| `DATABASE_URL` | the restricted `ckh_app_user` login |
| `JWT_SECRET` | ≥ 32 random characters (`openssl rand -base64 48`) |
| `CORS_ORIGINS` | the web app origin(s), e.g. `https://app.ckh.one`, plus `app://ckh` if Windows POS tills are used |
| `POS_LICENSE_PRIVATE_KEY` | Ed25519 key that signs offline licences for Windows tills (see section 6); without it, offline selling is off |

The API refuses to start in production without a strong `JWT_SECRET` and `CORS_ORIGINS`. Optional: `JWT_TTL_SECONDS`
(900), `REFRESH_TTL_DAYS` (30), `REFRESH_REUSE_GRACE_SECONDS` (30), `LOGIN_MAX_FAILURES` (5), `LOGIN_LOCK_MINUTES` (15), `PORT` (3001).

Put it behind a TLS-terminating reverse proxy (nginx, Caddy, a cloud load balancer). The API trusts one proxy
hop for client IPs in production. Add per-IP rate limiting on `/api/v1/auth/` at the proxy, for example nginx:

```nginx
limit_req_zone $binary_remote_addr zone=ckh_auth:10m rate=10r/m;
location /api/v1/auth/ { limit_req zone=ckh_auth burst=20 nodelay; proxy_pass http://ckh_api; }
location /api/v1/      { proxy_pass http://ckh_api; }
```

Health check: `GET /api/v1/health`.

## 4. Web app

```bash
cd apps/web
NEXT_PUBLIC_API_URL=https://api.ckh.one/api/v1 pnpm build   # static files in apps/web/out
```

Serve `apps/web/out` from any static host or CDN over HTTPS. `NEXT_PUBLIC_API_URL` is baked in at build time
and also sets the page's Content-Security-Policy `connect-src`, so rebuild when the API address changes.
Make sure the host does not cache `sw.js` for long (it controls offline updates).

## 5. POS Sales for a company

POS is a separate module. As the Super Admin:

1. Turn on `POS_SALES` for the company (Platform → company → modules) and set its limits:
   `PUT /api/v1/platform/tenants/:id/pos-license` with `maxBranches`, `maxRegisters`, `maxDevices` (null = no limit)
   and `offlineValidityHours` (default 72). An offline licence never lasts beyond the subscription or module end date.
2. The company administrator then, in the app under POS → Settings:
   - creates registers (POS → Registers) and assigns cashiers to branches (Registers → staff);
   - reviews the payment methods (only cash is allowed offline by default; bank transfer and KHQR always need
     verification; cards need the terminal approval code, never the card number);
   - checks the ledger accounts POS posts to (1000 cash, 1010 bank, 1020 card clearing, 1030 payments pending
     verification, 6900 cash over/short, plus sales, discounts, VAT output, cost of sales, inventory). **Have an
     accountant confirm the VAT treatment and receipt wording for Cambodia before going live**;
   - sets the receipt header, footer and languages (POS → Receipt settings) and each supervisor sets a PIN.
3. Check the books after the first day: `GET /api/v1/pos/reconciliation` and `/accounting/integrity` must be `ok`.

## 6. Windows POS app

The Windows app is the web app bundled into an installer, pointed at one API address. It holds no private keys.

**Offline licence key (once per installation of CKH ONE).** Generate it on a trusted machine and keep it with the
other server secrets; anyone with it can sign offline licences:

```bash
node -e "const k=require('crypto').generateKeyPairSync('ed25519');console.log(Buffer.from(k.privateKey.export({type:'pkcs8',format:'pem'})).toString('base64'))"
```

Set the output as `POS_LICENSE_PRIVATE_KEY` on the API. Changing it later invalidates every till's licence until the
till is online again (and, if the public key was built into the installer, until the new installer is deployed).

**Build the installer** on Windows (PowerShell), with the production API address and the matching public key:

```powershell
$env:NEXT_PUBLIC_API_URL = "https://api.example.com/api/v1"
pnpm install --frozen-lockfile
pnpm --filter @ckh/shared build
pnpm --filter @ckh/web build
$env:CKH_LICENSE_PUBLIC_KEY = (Invoke-RestMethod "$env:NEXT_PUBLIC_API_URL/pos/license/public-key").publicKey
$env:CSC_LINK = "C:\certs\ckh-codesign.pfx"; $env:CSC_KEY_PASSWORD = "<password>"
$env:CKH_PUBLISHER_NAME = "Your Company Co., Ltd."     # must match the certificate's subject
$env:CKH_UPDATE_URL = "https://downloads.example.com/pos/"
pnpm --filter @ckh/desktop dist:win
```

The signed installer and `latest.yml` are written to `apps/desktop/release/`; upload both to `CKH_UPDATE_URL`
(HTTPS). Tills check for updates on start and install only when the cashier restarts. A build without `CSC_LINK`
is unsigned and is for testing only: Windows SmartScreen warns about it and update signature checks cannot work.

**On each till computer**: install, sign in as a manager, open POS → Device management and activate the computer
for its register. Then set the printer under POS → Printer settings → This computer. The app's settings are in
`%APPDATA%\CKH ONE POS\config.json`; its encrypted data (device secret, licence, offline catalogue and unsent
sales) is in `secure.dat` in the same folder and is readable only by the same Windows user on the same computer.
Do not copy it between computers; activate each computer instead. To retire a till, revoke it in Device
management first so any unsent sales are seen (POS → Offline sync).

## 7. After deploying

- Sign in at `/platform/` as the Super Admin and create the first company.
- Check the ledger for each company: `GET /api/v1/accounting/integrity` as an accountant should return `"ok": true`.
- Back up the database daily (`pg_dump -Fc`) and test a restore.

## Windows (PowerShell)

Production API on a Windows server, the same steps as sections 1–3:

```powershell
$env:NODE_ENV = "production"
$env:MIGRATION_DATABASE_URL = "postgres://owner:<password>@db:5432/ckh_one"
pnpm db:migrate
$env:SUPERADMIN_EMAIL = "owner@yourcompany.com"; $env:SUPERADMIN_PASSWORD = "<strong password>"
pnpm db:seed
$env:DATABASE_URL = "postgres://ckh_app_user:<password>@db:5432/ckh_one"
$env:JWT_SECRET = "<48+ random characters>"
$env:CORS_ORIGINS = "https://app.example.com,app://ckh"
$env:POS_LICENSE_PRIVATE_KEY = "<base64 key from section 6>"
pnpm --filter @ckh/shared build; pnpm --filter @ckh/api build
node apps/api/dist/main.js
```

Generate secrets in PowerShell:

```powershell
node -e "console.log(require('crypto').randomBytes(48).toString('base64'))"   # JWT_SECRET
node -e "const k=require('crypto').generateKeyPairSync('ed25519');console.log(Buffer.from(k.privateKey.export({type:'pkcs8',format:'pem'})).toString('base64'))"   # POS_LICENSE_PRIVATE_KEY
```

Local development (API on 3001, web on 3100, Postgres in Docker on 5433):

```powershell
$env:MIGRATION_DATABASE_URL = "postgres://postgres:postgres@localhost:5433/ckh_one"
pnpm db:migrate
pnpm db:seed
$env:DATABASE_URL = "postgres://ckh_app_user:change-me@localhost:5433/ckh_one"
$env:CORS_ORIGINS = "http://localhost:3100,app://ckh"
pnpm --filter @ckh/api dev
# Without POS_LICENSE_PRIVATE_KEY the development API uses a temporary key: tills must be online again after each API restart.

# Windows POS app against the local API:
pnpm --filter @ckh/web build
$env:CKH_API_URL = "http://localhost:3001/api/v1"
pnpm --filter @ckh/desktop start
```

Demo sign-ins (development seed only, company code `demo`, password `ChangeMe!2026`): `cashier@demo.ckh.one`,
`possupervisor@demo.ckh.one` (PIN 2468), `posmanager@demo.ckh.one` (PIN 1357).
