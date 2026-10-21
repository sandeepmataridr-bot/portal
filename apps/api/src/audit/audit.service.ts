import { Injectable } from '@nestjs/common';
import type { AuditActorType, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';

export interface AuditEntry {
  actorUserId?: string | null;
  actorType: AuditActorType;
  actorMachineId?: string | null;
  action: string;
  entityTable: string;
  entityId?: string | null;
  before?: Prisma.InputJsonValue | null;
  after?: Prisma.InputJsonValue | null;
}

@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  async log(entry: AuditEntry): Promise<void> {
    await this.prisma.auditLog.create({
      data: {
        actorUserId: entry.actorUserId ?? null,
        actorType: entry.actorType,
        actorMachineId: entry.actorMachineId ?? null,
        action: entry.action,
        entityTable: entry.entityTable,
        entityId: entry.entityId ?? null,
        before: entry.before ?? undefined,
        after: entry.after ?? undefined,
      },
    });
  }
}
