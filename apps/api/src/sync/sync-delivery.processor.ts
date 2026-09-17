import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Worker, type Job } from 'bullmq';
import { REALTIME_EVENTS } from '@infusion/shared-types';
import { PrismaService } from '../prisma/prisma.service.js';
import type { Env } from '../config/env.validation.js';
import { SyncGateway } from './sync.gateway.js';
import { SYNC_DELIVERY_QUEUE } from './sync-outbox.service.js';

@Injectable()
export class SyncDeliveryProcessor implements OnModuleInit, OnModuleDestroy {
  private worker?: Worker;
  private readonly logger = new Logger(SyncDeliveryProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly gateway: SyncGateway,
    private readonly config: ConfigService<Env, true>,
  ) {}

  onModuleInit() {
    this.worker = new Worker(
      SYNC_DELIVERY_QUEUE,
      async (job: Job<{ outboxEntryId: string }>) => {
        const entry = await this.prisma.syncOutboxEntry.findUnique({ where: { id: job.data.outboxEntryId } });
        if (!entry || entry.status !== 'pending') {
          return; // Already picked up via REST pull, or resolved — nothing to do.
        }

        if (this.gateway.isConnected(entry.machineId)) {
          this.gateway.emitToMachine(entry.machineId, REALTIME_EVENTS.syncProposalDelivered, {
            id: entry.id,
            entityType: entry.entityType,
            entityId: entry.entityId,
            version: entry.version,
            payload: entry.payload,
          });
          await this.prisma.syncOutboxEntry.update({
            where: { id: entry.id },
            data: { status: 'delivered', deliveredAt: new Date() },
          });
          this.logger.log(`Delivered outbox entry ${entry.id} to machine ${entry.machineId} over WebSocket`);
        } else {
          this.logger.log(`Machine ${entry.machineId} not connected — entry ${entry.id} stays pending for its next REST pull`);
        }
      },
      {
        connection: {
          host: this.config.get('REDIS_HOST', { infer: true }),
          port: this.config.get('REDIS_PORT', { infer: true }),
        },
      },
    );
  }

  async onModuleDestroy() {
    await this.worker?.close();
  }
}
