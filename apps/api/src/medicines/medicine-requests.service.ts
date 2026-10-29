import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import type { CreateMedicineRequestInput } from '@infusion/shared-types';
import { PrismaService } from '../prisma/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import type { AuthenticatedUser } from '../auth/types.js';

@Injectable()
export class MedicineRequestsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async create(input: CreateMedicineRequestInput, actor: AuthenticatedUser) {
    const created = await this.prisma.medicineRequest.create({
      data: { patientId: input.patientId, medicineName: input.medicineName, notes: input.notes, requestedBy: actor.loginId },
    });
    await this.audit.log({
      actorUserId: actor.id,
      actorType: 'user',
      action: 'MEDICINE_REQUEST_CREATED',
      entityTable: 'medicine_requests',
      entityId: created.id,
      after: { patientId: created.patientId, medicineName: created.medicineName },
    });
    return created;
  }

  list() {
    return this.prisma.medicineRequest.findMany({
      include: { patient: true, medicine: true },
      orderBy: { createdAt: 'desc' },
    });
  }

  async updateStatus(id: string, status: 'fulfilled' | 'rejected', actor: AuthenticatedUser) {
    const existing = await this.prisma.medicineRequest.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Request not found');
    if (existing.status !== 'pending') throw new ConflictException('This request has already been resolved');

    // Only while still pending: two pharmacists answering at once can't both resolve it.
    const { count } = await this.prisma.medicineRequest.updateMany({
      where: { id, status: 'pending' },
      data: { status, resolvedBy: actor.loginId, resolvedAt: new Date() },
    });
    if (count === 0) throw new ConflictException('This request has already been resolved');
    const updated = await this.prisma.medicineRequest.findUniqueOrThrow({ where: { id } });

    await this.audit.log({
      actorUserId: actor.id,
      actorType: 'user',
      action: status === 'fulfilled' ? 'MEDICINE_REQUEST_FULFILLED' : 'MEDICINE_REQUEST_REJECTED',
      entityTable: 'medicine_requests',
      entityId: id,
    });
    return updated;
  }
}
