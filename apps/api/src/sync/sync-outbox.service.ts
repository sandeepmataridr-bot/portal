import { Injectable, type OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Queue } from 'bullmq';
import type { Prisma } from '@prisma/client';
import type { SyncEntityType } from '@infusion/shared-types';
import { PrismaService } from '../prisma/prisma.service.js';
import type { Env } from '../config/env.validation.js';

export const SYNC_DELIVERY_QUEUE = 'sync-outbox-delivery';

/**
 * Every server-side change to a machine-owned entity gets queued here for
 * that machine to pick up — the `sync_outbox` from the plan's architecture.
 * Enqueuing also schedules a delayed BullMQ job that attempts a live WS push
 * if the machine happens to be connected; if not, the entry just waits for
 * the machine's next REST pull (see SyncDeliveryProcessor) — pull is the
 * primary, guaranteed path, the WS push is a latency optimization on top.
 */
@Injectable()
export class SyncOutboxService implements OnModuleDestroy {
  private readonly queue: Queue;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<Env, true>,
  ) {
    this.queue = new Queue(SYNC_DELIVERY_QUEUE, {
      connection: {
        host: this.config.get('REDIS_HOST', { infer: true }),
        port: this.config.get('REDIS_PORT', { infer: true }),
      },
    });
  }

  async enqueue(machineId: string, entityType: SyncEntityType, entityId: string, payload: Record<string, unknown>) {
    const last = await this.prisma.syncOutboxEntry.findFirst({ where: { machineId }, orderBy: { version: 'desc' } });
    const version = (last?.version ?? 0) + 1;

    const entry = await this.prisma.syncOutboxEntry.create({
      data: { machineId, entityType, entityId, payload: payload as Prisma.InputJsonValue, version, status: 'pending' },
    });

    await this.queue.add('deliver', { outboxEntryId: entry.id }, { delay: 3000, attempts: 1 });
    return entry;
  }

  async onModuleDestroy() {
    await this.queue.close();
  }
}
