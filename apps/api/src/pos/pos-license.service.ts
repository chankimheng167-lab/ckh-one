import { Injectable, Logger } from '@nestjs/common';
import { createPrivateKey, createPublicKey, generateKeyPairSync, KeyObject, sign, verify } from 'crypto';
import { DomainError } from '../common/errors';

export interface OfflineLicense {
  v: 1;
  tenantId: string;
  tenantCode: string;
  deviceId: string;
  registerId: string;
  branchId: string;
  /** ISO times. The device may sell offline only between these. */
  issuedAt: string;
  expiresAt: string;
  /** Cash only, within the cashier's own discount limit. */
  offlineMethods: string[];
}

const PREFIX = 'ckhpos1';
const b64u = (b: Buffer) => b.toString('base64url');

/**
 * Signs offline licences for Windows POS devices with Ed25519.
 *
 * The private key lives only on the server (POS_LICENSE_PRIVATE_KEY, PKCS#8
 * PEM). Devices get the public key and check the signature and expiry before
 * selling offline, so a licence cannot be extended or moved to another
 * device or company without the server. Outside production, a temporary key
 * is generated at start-up when none is configured (licences then stop
 * verifying after a restart).
 */
@Injectable()
export class PosLicenseService {
  private readonly log = new Logger('PosLicense');
  private key: KeyObject | null = null;
  private pub: KeyObject | null = null;

  constructor() {
    const pem = process.env.POS_LICENSE_PRIVATE_KEY;
    if (pem) {
      this.key = createPrivateKey(pem.includes('BEGIN') ? pem : Buffer.from(pem, 'base64').toString('utf8'));
      if (this.key.asymmetricKeyType !== 'ed25519') throw new Error('POS_LICENSE_PRIVATE_KEY must be an Ed25519 private key');
    } else if (process.env.NODE_ENV !== 'production') {
      this.key = generateKeyPairSync('ed25519').privateKey;
      this.log.warn('POS_LICENSE_PRIVATE_KEY is not set: using a temporary key (development only)');
    }
    this.pub = this.key ? createPublicKey(this.key) : null;
  }

  private need(): KeyObject {
    if (!this.key) throw new DomainError('OFFLINE_LICENSING_NOT_CONFIGURED', 'Offline licences are not set up on this server', 503);
    return this.key;
  }

  /** The public key devices verify with (SPKI PEM). */
  publicKeyPem(): string {
    this.need();
    return this.pub!.export({ type: 'spki', format: 'pem' }).toString();
  }

  sign(l: OfflineLicense): string {
    const body = `${PREFIX}.${b64u(Buffer.from(JSON.stringify(l), 'utf8'))}`;
    return `${body}.${b64u(sign(null, Buffer.from(body), this.need()))}`;
  }

  /** Verifies a licence (server-side tests and diagnostics; devices run the same check). */
  verify(token: string, now = new Date()): OfflineLicense | null {
    const parts = token.split('.');
    if (parts.length !== 3 || parts[0] !== PREFIX || !this.pub) return null;
    const ok = verify(null, Buffer.from(`${parts[0]}.${parts[1]}`), this.pub, Buffer.from(parts[2], 'base64url'));
    if (!ok) return null;
    const l = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as OfflineLicense;
    return new Date(l.expiresAt) > now ? l : null;
  }
}
