/**
 * Hash-chained audit records (reference: core/audit_ledger). Each record
 * carries the SHA-256 of the previous one, so any edit, deletion or
 * reordering breaks verification from that point on. Storage is the caller's
 * concern (the API keeps the chain in Postgres behind an immutability
 * trigger); this module only defines the chain.
 */
import { createHash } from 'node:crypto';

export const GENESIS = '0'.repeat(64);

export interface AuditRecord {
  seq: number;
  /** ISO-8601 timestamp */
  at: string;
  kind: string;
  data: unknown;
  prev: string;
  hash: string;
}

/** JSON with sorted object keys and no whitespace: one byte string per value. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'number' && !Number.isFinite(value)) return 'null';
    return JSON.stringify(value) ?? 'null';
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

export function digest(record: Omit<AuditRecord, 'hash'>): string {
  const body = { seq: record.seq, at: record.at, kind: record.kind, data: record.data, prev: record.prev };
  return createHash('sha256').update(canonicalJson(body)).digest('hex');
}

/** Builds the next record of a chain whose last record is `last` (or none). */
export function nextRecord(last: Pick<AuditRecord, 'seq' | 'hash'> | null, kind: string, data: unknown, at = new Date()): AuditRecord {
  const base = { seq: (last?.seq ?? 0) + 1, at: at.toISOString(), kind, data, prev: last?.hash ?? GENESIS };
  return { ...base, hash: digest(base) };
}

export interface VerifyResult {
  ok: boolean;
  count: number;
  error: string;
}

/** Verifies records in sequence order. */
export function verifyChain(records: Iterable<AuditRecord>): VerifyResult {
  let prev = GENESIS;
  let count = 0;
  for (const rec of records) {
    if (rec.prev !== prev || rec.seq !== count + 1) return { ok: false, count, error: `seq ${rec.seq}: chain broken` };
    if (digest(rec) !== rec.hash) return { ok: false, count, error: `seq ${rec.seq}: hash mismatch` };
    prev = rec.hash;
    count += 1;
  }
  return { ok: true, count, error: '' };
}
