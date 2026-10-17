-- Security hardening: device sessions with rotating refresh tokens, sign-in
-- lockout, validated tenant time zones, and Super Admin rows hidden from
-- tenant sessions.

-- ---------------------------------------------------------------------------
-- Sessions. One row per signed-in device. Access tokens are short-lived JWTs
-- that carry the session id; every request checks the session is still live,
-- so revoking a session (or all of a user's sessions) takes effect at once.
-- tenant_id is NULL for Super Admin sessions (visible to the platform only).
-- ---------------------------------------------------------------------------
CREATE TABLE auth_sessions (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid REFERENCES tenants(id) ON DELETE CASCADE,
  user_id            uuid,
  platform_admin_id  uuid REFERENCES platform_admins(id) ON DELETE CASCADE,
  device_id          text CHECK (device_id IS NULL OR length(device_id) <= 200),
  device_name        text CHECK (device_name IS NULL OR length(device_name) <= 200),
  user_agent         text,
  ip_address         text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  last_used_at       timestamptz NOT NULL DEFAULT now(),
  expires_at         timestamptz NOT NULL,
  revoked_at         timestamptz,
  revoked_reason     text,
  CHECK ((tenant_id IS NOT NULL AND user_id IS NOT NULL AND platform_admin_id IS NULL)
      OR (tenant_id IS NULL AND user_id IS NULL AND platform_admin_id IS NOT NULL)),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, user_id) REFERENCES users (tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX auth_sessions_user_idx ON auth_sessions (tenant_id, user_id) WHERE revoked_at IS NULL;
CREATE INDEX auth_sessions_admin_idx ON auth_sessions (platform_admin_id) WHERE revoked_at IS NULL;

-- Refresh tokens are stored only as SHA-256 hashes and are single-use: each
-- refresh marks the presented token used and issues a new one. Presenting a
-- used token again means it was copied, so the whole session is revoked.
CREATE TABLE auth_refresh_tokens (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid REFERENCES tenants(id) ON DELETE CASCADE,
  session_id  uuid NOT NULL REFERENCES auth_sessions(id) ON DELETE CASCADE,
  token_hash  text NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  created_at  timestamptz NOT NULL DEFAULT now(),
  used_at     timestamptz
);
CREATE INDEX auth_refresh_tokens_session_idx ON auth_refresh_tokens (session_id);

-- ---------------------------------------------------------------------------
-- Sign-in lockout after repeated failures.
-- ---------------------------------------------------------------------------
ALTER TABLE users
  ADD COLUMN failed_login_count integer NOT NULL DEFAULT 0,
  ADD COLUMN locked_until timestamptz,
  ADD COLUMN password_changed_at timestamptz;
ALTER TABLE platform_admins
  ADD COLUMN failed_login_count integer NOT NULL DEFAULT 0,
  ADD COLUMN locked_until timestamptz,
  ADD COLUMN password_changed_at timestamptz;

-- ---------------------------------------------------------------------------
-- Tenant business time zone (column exists since 0001; now validated).
-- Business dates — order dates, "today" in reports, visit days — are
-- computed in this zone, not UTC.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION validate_tenant_timezone() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_timezone_names WHERE name = NEW.timezone) THEN
    RAISE EXCEPTION 'Unknown time zone %', NEW.timezone USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER tenants_timezone_valid BEFORE INSERT OR UPDATE OF timezone ON tenants
  FOR EACH ROW EXECUTE FUNCTION validate_tenant_timezone();

-- ---------------------------------------------------------------------------
-- Every tenant has the CORE module (routes that declare no other module
-- require it, so licensing fails closed).
-- ---------------------------------------------------------------------------
SELECT set_config('app.platform_admin', 'on', true);
INSERT INTO tenant_modules (tenant_id, module_code)
SELECT t.id, 'CORE' FROM tenants t
 WHERE EXISTS (SELECT 1 FROM platform_modules WHERE code = 'CORE')
ON CONFLICT (tenant_id, module_code) DO UPDATE SET enabled = true, ends_at = NULL;
