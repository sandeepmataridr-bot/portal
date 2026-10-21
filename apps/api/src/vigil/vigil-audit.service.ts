import { Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { nextRecord, verifyChain, type AuditRecord } from '@infusion/vigil';
import type { VigilAuditVerifyResult, VigilMode } from '@infusion/shared-types';
import { PrismaService } from '../prisma/prisma.service.js';

/**
 * Vigil's hash-chained audit ledger, one chain per operating mode, stored in
 * `vigil_audit_ledger` (UPDATE/DELETE blocked by a trigger). The engine
 * emits records synchronously; they are appended strictly in order through
 * a single promise chain so sequence numbers and `prev` hashes never race.
 *
 * Assumes one API instance owns Vigil (it also owns the in-memory rule
 * state); a second instance would fail on the (mode, seq) unique key rather
 * than fork the chain.
 */
@Injectable()
export class VigilAuditService {
  private readonly logger = new Logger(VigilAuditService.name);
  private readonly last = new Map<VigilMode, Pick<AuditRecord, 'seq' | 'hash'> | null>();
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly prisma: PrismaService) {}

  /** Queues one record; failures are logged, never thrown into the alarm path. */
  append(mode: VigilMode, kind: string, data: Record<string, unknown>): void {
    const at = new Date();
    this.queue = this.queue.then(() => this.write(mode, kind, data, at)).catch((e: unknown) => {
      this.logger.error(`audit record '${kind}' (${mode}) was not written: ${e instanceof Error ? e.message : e}`);
    });
  }

  /** Resolves once every record queued so far has been written (or has failed). */
  flush(): Promise<void> {
    return this.queue;
  }

  private async write(mode: VigilMode, kind: string, data: Record<string, unknown>, at: Date): Promise<void> {
    if (!this.last.has(mode)) {
      const row = await this.prisma.vigilAuditRecord.findFirst({ where: { mode }, orderBy: { seq: 'desc' } });
      this.last.set(mode, row ? { seq: row.seq, hash: row.hash } : null);
    }
    const rec = nextRecord(this.last.get(mode) ?? null, kind, data, at);
    await this.prisma.vigilAuditRecord.create({
      data: {
        mode,
        seq: rec.seq,
        at: new Date(rec.at),
        kind: rec.kind,
        data: rec.data as Prisma.InputJsonValue,
        prev: rec.prev,
        hash: rec.hash,
      },
    });
    this.last.set(mode, { seq: rec.seq, hash: rec.hash });
  }

  async verify(mode: VigilMode): Promise<VigilAuditVerifyResult> {
    await this.flush();
    const rows = await this.prisma.vigilAuditRecord.findMany({ where: { mode }, orderBy: { seq: 'asc' } });
    const result = verifyChain(
      rows.map((r) => ({ seq: r.seq, at: r.at.toISOString(), kind: r.kind, data: r.data, prev: r.prev, hash: r.hash })),
    );
    return { mode, ...result };
  }
}
