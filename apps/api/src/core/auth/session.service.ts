import { HttpStatus, Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { createHash, randomBytes } from 'crypto';
import { AuditService } from '../../common/audit.service';
import { DomainError } from '../../common/errors';
import { loadConfig } from '../../config';
import { DatabaseService, Tx } from '../../db/database.service';

export interface JwtPayload {
  sub: string;
  typ: 'user' | 'platform';
  tid?: string;
  /** Device session id; checked on every request so revocation is immediate. */
  sid: string;
}

export interface DeviceInfo {
  deviceId?: string;
  deviceName?: string;
  userAgent?: string;
  ip?: string;
}

export interface IssuedTokens {
  accessToken: string;
  refreshToken: string;
  /** Access token lifetime in seconds. */
  expiresIn: number;
  sessionId: string;
}

export const JWT_ISSUER = 'ckh-one';
export const JWT_AUDIENCE = 'ckh-one-api';

const hash = (token: string) => createHash('sha256').update(token).digest('hex');
const newRefreshToken = () => randomBytes(32).toString('base64url');

/**
 * Device sessions with rotating, single-use refresh tokens.
 *
 * - Access tokens are short-lived JWTs carrying the session id.
 * - Refresh tokens are random, stored only as hashes, and replaced on every
 *   use. Presenting an already-used refresh token means it was copied: the
 *   whole session is revoked (reuse detection). A short grace period
 *   (REFRESH_REUSE_GRACE_SECONDS) tolerates two tabs refreshing at once or a
 *   page closed mid-refresh.
 * - Sessions slide: each refresh pushes expiry out by REFRESH_TTL_DAYS.
 */
@Injectable()
export class SessionService {
  private readonly cfg = loadConfig();

  constructor(
    private readonly db: DatabaseService,
    private readonly jwt: JwtService,
    private readonly audit: AuditService,
  ) {}

  private expiry(): Date {
    return new Date(Date.now() + this.cfg.refreshTtlDays * 86400_000);
  }

  private async sign(payload: JwtPayload): Promise<string> {
    return this.jwt.signAsync(payload, { expiresIn: this.cfg.jwtTtlSeconds, issuer: JWT_ISSUER, audience: JWT_AUDIENCE, algorithm: 'HS256' });
  }

  async verify(token: string): Promise<JwtPayload> {
    return this.jwt.verifyAsync<JwtPayload>(token, { issuer: JWT_ISSUER, audience: JWT_AUDIENCE, algorithms: ['HS256'] });
  }

  /** Creates a session inside the caller's transaction (tenant or platform). */
  async start(
    tx: Tx,
    who: { kind: 'user'; tenantId: string; userId: string } | { kind: 'platform'; adminId: string },
    device: DeviceInfo,
  ): Promise<IssuedTokens> {
    const refreshToken = newRefreshToken();
    const tenantId = who.kind === 'user' ? who.tenantId : null;
    const { id } = await tx.one<{ id: string }>(
      `INSERT INTO auth_sessions (tenant_id, user_id, platform_admin_id, device_id, device_name, user_agent, ip_address, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
      [
        tenantId,
        who.kind === 'user' ? who.userId : null,
        who.kind === 'platform' ? who.adminId : null,
        device.deviceId ?? null,
        device.deviceName ?? null,
        device.userAgent?.slice(0, 500) ?? null,
        device.ip ?? null,
        this.expiry(),
      ],
    );
    await tx.query('INSERT INTO auth_refresh_tokens (tenant_id, session_id, token_hash) VALUES ($1, $2, $3)', [tenantId, id, hash(refreshToken)]);
    const payload: JwtPayload =
      who.kind === 'user' ? { sub: who.userId, typ: 'user', tid: who.tenantId, sid: id } : { sub: who.adminId, typ: 'platform', sid: id };
    return { accessToken: await this.sign(payload), refreshToken, expiresIn: this.cfg.jwtTtlSeconds, sessionId: id };
  }

  /** Exchanges a refresh token for a new access + refresh token pair. */
  async refresh(refreshToken: string): Promise<IssuedTokens> {
    const invalid = () => new DomainError('INVALID_REFRESH_TOKEN', 'Your session has ended. Please sign in again.', HttpStatus.UNAUTHORIZED);
    // Looked up as the platform: the token alone identifies the session, whichever tenant it belongs to.
    const outcome = await this.db.withPlatform(null, async (tx) => {
      const row = await tx.maybeOne<{
        token_id: string;
        used_at: string | null;
        session_id: string;
        tenant_id: string | null;
        user_id: string | null;
        platform_admin_id: string | null;
        revoked_at: string | null;
        expired: boolean;
        within_grace: boolean;
      }>(
        `SELECT r.id AS token_id, r.used_at, s.id AS session_id, s.tenant_id, s.user_id, s.platform_admin_id, s.revoked_at,
                s.expires_at <= now() AS expired,
                COALESCE(r.used_at > now() - make_interval(secs => $2), false) AS within_grace
           FROM auth_refresh_tokens r JOIN auth_sessions s ON s.id = r.session_id
          WHERE r.token_hash = $1
          FOR UPDATE OF r, s`,
        [hash(refreshToken), this.cfg.refreshReuseGraceSeconds],
      );
      if (!row || row.revoked_at || row.expired) return { ok: false as const };
      // A token used moments ago is a benign race (two tabs refreshing at once, or a
      // page closed before it stored the new token): answer it with a fresh token.
      // Anything older is a copied token: end the session.
      if (row.used_at && !row.within_grace) {
        await tx.query(`UPDATE auth_sessions SET revoked_at = now(), revoked_reason = 'REFRESH_TOKEN_REUSE' WHERE id = $1`, [row.session_id]);
        await this.audit.record(tx, {
          actorType: 'SYSTEM',
          tenantId: row.tenant_id,
          action: 'SESSION_REVOKED_TOKEN_REUSE',
          entityType: 'auth_session',
          entityId: row.session_id,
        });
        return { ok: false as const };
      }
      // The account itself must still be allowed in.
      const active = row.user_id
        ? await tx.maybeOne<{ ok: boolean }>(`SELECT (status = 'ACTIVE') AS ok FROM users WHERE id = $1`, [row.user_id])
        : await tx.maybeOne<{ ok: boolean }>('SELECT is_active AS ok FROM platform_admins WHERE id = $1', [row.platform_admin_id]);
      if (!active?.ok) return { ok: false as const };

      const next = newRefreshToken();
      await tx.query('UPDATE auth_refresh_tokens SET used_at = COALESCE(used_at, now()) WHERE id = $1', [row.token_id]);
      await tx.query('INSERT INTO auth_refresh_tokens (tenant_id, session_id, token_hash) VALUES ($1, $2, $3)', [row.tenant_id, row.session_id, hash(next)]);
      await tx.query('UPDATE auth_sessions SET last_used_at = now(), expires_at = $2 WHERE id = $1', [row.session_id, this.expiry()]);
      const payload: JwtPayload = row.user_id
        ? { sub: row.user_id, typ: 'user', tid: row.tenant_id!, sid: row.session_id }
        : { sub: row.platform_admin_id!, typ: 'platform', sid: row.session_id };
      return { ok: true as const, payload, next, sessionId: row.session_id };
    });
    if (!outcome.ok) throw invalid();
    return { accessToken: await this.sign(outcome.payload), refreshToken: outcome.next, expiresIn: this.cfg.jwtTtlSeconds, sessionId: outcome.sessionId };
  }

  /** Lists a principal's live sessions (devices). */
  async list(tx: Tx, who: { userId?: string; adminId?: string }, currentSessionId?: string) {
    const rows = await tx.query<{ id: string }>(
      `SELECT id, device_id, device_name, user_agent, ip_address, created_at, last_used_at, expires_at
         FROM auth_sessions
        WHERE revoked_at IS NULL AND expires_at > now()
          AND (($1::uuid IS NOT NULL AND user_id = $1) OR ($2::uuid IS NOT NULL AND platform_admin_id = $2))
        ORDER BY last_used_at DESC`,
      [who.userId ?? null, who.adminId ?? null],
    );
    return rows.map((r) => ({ ...r, current: r.id === currentSessionId }));
  }

  /** Revokes one session, or all of a principal's sessions (optionally keeping one). */
  async revoke(
    tx: Tx,
    filter: { sessionId?: string; userId?: string; adminId?: string; exceptSessionId?: string },
    reason: string,
  ): Promise<number> {
    if (!filter.sessionId && !filter.userId && !filter.adminId) throw new Error('revoke() needs a session, user or admin filter');
    const rows = await tx.query(
      `UPDATE auth_sessions SET revoked_at = now(), revoked_reason = $5
        WHERE revoked_at IS NULL
          AND ($1::uuid IS NULL OR id = $1)
          AND ($2::uuid IS NULL OR user_id = $2)
          AND ($3::uuid IS NULL OR platform_admin_id = $3)
          AND ($4::uuid IS NULL OR id <> $4)
        RETURNING id`,
      [filter.sessionId ?? null, filter.userId ?? null, filter.adminId ?? null, filter.exceptSessionId ?? null, reason],
    );
    return rows.length;
  }
}
