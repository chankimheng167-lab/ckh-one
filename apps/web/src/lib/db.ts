import Dexie, { type Table } from 'dexie';

/** What the device downloaded for offline work (one row, id = 'current'). */
export interface Snapshot {
  id: 'current';
  userId: string;
  snapshotAt: string;
  staleAfter: string;
  maxAgeHours: number;
  data: any;
}

export type OutboxStatus = 'PENDING' | 'SYNCING' | 'ACCEPTED' | 'ACCEPTED_WITH_CHANGES' | 'REJECTED' | 'CONFLICT';
export interface OutboxItem {
  idempotencyKey: string;
  entityType: 'SALES_ORDER' | 'COLLECTION' | 'VISIT' | 'VISIT_NOTE';
  payload: Record<string, unknown>;
  clientCreatedAt: string;
  /** Short label for the queue screen, e.g. "Order for Sunrise Mart". */
  label: string;
  status: OutboxStatus;
  attempts: number;
  result?: any;
  lastError?: string;
  userId: string;
}

class CkhDb extends Dexie {
  snapshot!: Table<Snapshot, string>;
  outbox!: Table<OutboxItem, string>;
  constructor() {
    super('ckh-one-sales');
    this.version(1).stores({
      snapshot: 'id',
      outbox: 'idempotencyKey, status, clientCreatedAt, userId',
    });
  }
}

let _db: CkhDb | null = null;
/** IndexedDB can be missing (private mode, old browsers); callers treat null as "online only". */
export function db(): CkhDb | null {
  if (typeof window === 'undefined' || !('indexedDB' in window)) return null;
  if (!_db) _db = new CkhDb();
  return _db;
}

export const newKey = () => (crypto.randomUUID ? `web-${crypto.randomUUID()}` : `web-${Date.now()}-${Math.random().toString(36).slice(2)}`);
