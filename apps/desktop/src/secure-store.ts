import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { dirname } from 'path';

/** Wraps and unwraps the data key with the operating system (Windows: DPAPI via Electron safeStorage). */
export interface KeyWrapper {
  available(): boolean;
  encrypt(plain: Buffer): Buffer;
  decrypt(wrapped: Buffer): Buffer;
}

interface FileShape {
  v: 1;
  key: string; // data key, wrapped by the OS, base64
  iv: string;
  tag: string;
  data: string; // AES-256-GCM ciphertext of the JSON map, base64
}

/**
 * A small encrypted key/value file for things that must survive restarts on
 * the till: the device secret, the signed offline licence, the offline sales
 * queue. Contents are AES-256-GCM encrypted with a random data key; the data
 * key itself is encrypted by the operating system for the signed-in Windows
 * user, so copying the file to another computer or account does not reveal
 * it. Writes go to a temporary file and are renamed into place.
 */
export class SecureStore {
  private cache: Record<string, unknown> | null = null;
  private key: Buffer | null = null;

  constructor(private readonly file: string, private readonly wrapper: KeyWrapper) {}

  private load(): Record<string, unknown> {
    if (this.cache) return this.cache;
    if (!this.wrapper.available()) throw new Error('Operating-system encryption is not available; the POS cannot store data securely');
    if (!existsSync(this.file)) {
      this.key = randomBytes(32);
      this.cache = {};
      return this.cache;
    }
    const f = JSON.parse(readFileSync(this.file, 'utf8')) as FileShape;
    if (f.v !== 1) throw new Error('Unknown secure store format');
    this.key = this.wrapper.decrypt(Buffer.from(f.key, 'base64'));
    const d = createDecipheriv('aes-256-gcm', this.key, Buffer.from(f.iv, 'base64'));
    d.setAuthTag(Buffer.from(f.tag, 'base64'));
    const plain = Buffer.concat([d.update(Buffer.from(f.data, 'base64')), d.final()]);
    this.cache = JSON.parse(plain.toString('utf8'));
    return this.cache!;
  }

  private save() {
    const iv = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', this.key!, iv);
    const data = Buffer.concat([c.update(Buffer.from(JSON.stringify(this.cache), 'utf8')), c.final()]);
    const f: FileShape = {
      v: 1,
      key: this.wrapper.encrypt(this.key!).toString('base64'),
      iv: iv.toString('base64'),
      tag: c.getAuthTag().toString('base64'),
      data: data.toString('base64'),
    };
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(f), { mode: 0o600 });
    renameSync(tmp, this.file);
  }

  get<T = unknown>(k: string): T | undefined {
    return this.load()[k] as T | undefined;
  }

  set(k: string, v: unknown) {
    this.load()[k] = v;
    this.save();
  }

  delete(k: string) {
    const m = this.load();
    if (k in m) {
      delete m[k];
      this.save();
    }
  }

  keys(): string[] {
    return Object.keys(this.load());
  }
}
