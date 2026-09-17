import { BadRequestException, ForbiddenException, Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { SyncEntityType, SyncOutboxStatus, SyncPullRequest, SyncPullResponse, SyncPushRequest } from '@infusion/shared-types';
import { PrismaService } from '../prisma/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';

@Injectable()
export class SyncService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async pull(authenticatedMachineId: string, input: SyncPullRequest): Promise<SyncPullResponse> {
    if (input.machineId !== authenticatedMachineId) {
      throw new ForbiddenException('machineId does not match the authenticated machine');
    }

    const entries = await this.prisma.syncOutboxEntry.findMany({
      where: { machineId: authenticatedMachineId, version: { gt: input.sinceVersion } },
      orderBy: { version: 'asc' },
    });

    const pendingIds = entries.filter((e) => e.status === 'pending').map((e) => e.id);
    if (pendingIds.length > 0) {
      await this.prisma.syncOutboxEntry.updateMany({
        where: { id: { in: pendingIds } },
        data: { status: 'delivered', deliveredAt: new Date() },
      });
    }

    const latestVersion = entries.length > 0 ? entries[entries.length - 1].version : input.sinceVersion;

    return {
      proposals: entries.map((e) => ({
        id: e.id,
        machineId: e.machineId,
        entityType: e.entityType as SyncEntityType,
        entityId: e.entityId,
        version: e.version,
        payload: e.payload as Record<string, unknown>,
        status: (pendingIds.includes(e.id) ? 'delivered' : e.status) as SyncOutboxStatus,
        createdAt: e.createdAt.toISOString(),
      })),
      latestVersion,
    };
  }

  async push(authenticatedMachineId: string, input: SyncPushRequest) {
    if (input.machineId !== authenticatedMachineId) {
      throw new ForbiddenException('machineId does not match the authenticated machine');
    }

    for (const report of input.reports) {
      if (report.outcome === 'rejected' && !report.reason) {
        throw new BadRequestException('A reason is required when a report outcome is "rejected"');
      }

      await this.prisma.syncInboxLog.create({
        data: {
          machineId: authenticatedMachineId,
          proposalId: report.proposalId,
          entityType: report.entityType,
          entityId: report.entityId,
          outcome: report.outcome,
          reason: report.reason,
          payload: report.payload as Prisma.InputJsonValue | undefined,
          occurredAt: new Date(report.occurredAt),
        },
      });

      if (report.proposalId) {
        await this.prisma.syncOutboxEntry.updateMany({
          where: { id: report.proposalId },
          data: { status: report.outcome === 'accepted' ? 'acked' : 'rejected', resolvedAt: new Date() },
        });
      }

      // Reflect the machine's decision onto the entity's own syncStatus —
      // never re-derived or overridden server-side, just recorded.
      const newSyncStatus = report.outcome === 'accepted' ? 'accepted' : 'rejected';
      if (report.entityType === 'patient') {
        await this.prisma.patientMachineAssignment.updateMany({
          where: { id: report.entityId },
          data: { syncStatus: newSyncStatus },
        });
      } else if (report.entityType === 'infusion_step') {
        await this.prisma.infusionStep.updateMany({
          where: { id: report.entityId },
          data: { syncStatus: newSyncStatus },
        });
      }

      await this.audit.log({
        actorType: 'machine',
        action: `SYNC_REPORT_${report.outcome.toUpperCase()}`,
        entityTable: report.entityType,
        entityId: report.entityId,
      });
    }

    return { received: input.reports.length };
  }
}
