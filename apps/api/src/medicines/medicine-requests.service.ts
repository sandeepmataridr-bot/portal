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

  create(input: CreateMedicineRequestInput, actor: AuthenticatedUser) {
    return this.prisma.medicineRequest.create({
      data: { patientId: input.patientId, medicineName: input.medicineName, notes: input.notes },
    });
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

    const updated = await this.prisma.medicineRequest.update({ where: { id }, data: { status } });

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
