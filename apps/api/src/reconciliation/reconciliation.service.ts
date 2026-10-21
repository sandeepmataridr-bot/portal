import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { ReconciliationKind, ReconciliationCandidate, ResolveReconciliationItemInput } from '@infusion/shared-types';
import { PrismaService } from '../prisma/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import type { AuthenticatedUser } from '../auth/types.js';

interface PatientCandidateInput {
  fullName: string;
  age: number;
  gender: string;
  aadhar?: string | null;
}

/**
 * Naive exact/contains matching, not fuzzy/trigram (pg_trgm isn't enabled)
 * — acceptable because a human confirms every hit here, this is a review
 * queue, not an auto-merge. See the plan's "naive dedup" deferred item.
 */
@Injectable()
export class ReconciliationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async findPatientDuplicates(candidate: PatientCandidateInput): Promise<ReconciliationCandidate[]> {
    if (candidate.aadhar) {
      const exact = await this.prisma.patient.findMany({
        where: { aadhar: candidate.aadhar, deletedAt: null },
        select: { id: true, fullName: true, ipNumber: true },
      });
      if (exact.length > 0) {
        return exact.map((p) => ({ id: p.id, label: `${p.fullName} (${p.ipNumber ?? 'no IP#'})`, score: 1 }));
      }
    }

    const candidates = await this.prisma.patient.findMany({
      where: {
        deletedAt: null,
        fullName: { contains: candidate.fullName, mode: 'insensitive' },
        gender: candidate.gender,
        age: { gte: candidate.age - 1, lte: candidate.age + 1 },
      },
      select: { id: true, fullName: true, ipNumber: true },
      take: 5,
    });
    return candidates.map((p) => ({ id: p.id, label: `${p.fullName} (${p.ipNumber ?? 'no IP#'})`, score: 0.6 }));
  }

  async findMedicineMatches(nameRaw: string, concentrationRaw?: string | null): Promise<ReconciliationCandidate[]> {
    const candidates = await this.prisma.medicine.findMany({
      where: {
        status: 'ACTIVE',
        OR: [
          { name: { contains: nameRaw, mode: 'insensitive' } },
          { genericName: { contains: nameRaw, mode: 'insensitive' } },
          { brand: { contains: nameRaw, mode: 'insensitive' } },
        ],
      },
      select: { id: true, name: true, concentration: true },
      take: 5,
    });
    return candidates.map((m) => ({
      id: m.id,
      label: `${m.name} (${m.concentration})`,
      score: concentrationRaw && m.concentration.toLowerCase() === concentrationRaw.toLowerCase() ? 0.9 : 0.6,
    }));
  }

  async record(
    tx: Prisma.TransactionClient,
    kind: ReconciliationKind,
    machineId: string,
    entityType: string,
    entityId: string,
    rawPayload: Record<string, unknown>,
    candidates: ReconciliationCandidate[],
  ) {
    return tx.reconciliationItem.create({
      data: {
        kind,
        machineId,
        entityType,
        entityId,
        rawPayload: rawPayload as Prisma.InputJsonValue,
        candidates: candidates.length > 0 ? (candidates as unknown as Prisma.InputJsonValue) : undefined,
      },
    });
  }

  list(status?: string, kind?: string) {
    return this.prisma.reconciliationItem.findMany({
      where: { ...(status ? { status: status as 'pending' | 'resolved' } : {}), ...(kind ? { kind: kind as 'patient_duplicate' | 'medicine_match' } : {}) },
      include: { machine: { select: { machineCode: true } } },
      orderBy: { createdAt: 'asc' },
    });
  }

  async getById(id: string) {
    const item = await this.prisma.reconciliationItem.findUnique({
      where: { id },
      include: { machine: { select: { machineCode: true } } },
    });
    if (!item) throw new NotFoundException('Reconciliation item not found');
    return item;
  }

  async resolve(id: string, input: ResolveReconciliationItemInput, actor: AuthenticatedUser) {
    const item = await this.prisma.reconciliationItem.findUnique({ where: { id } });
    if (!item) throw new NotFoundException('Reconciliation item not found');
    if (item.status === 'resolved') throw new BadRequestException('This item is already resolved');

    if (item.kind === 'medicine_match' && input.linkedMedicineId) {
      await this.prisma.infusionStep.update({
        where: { id: item.entityId },
        data: { medicineId: input.linkedMedicineId, medicineNameRaw: null, concentrationRaw: null },
      });
    }
    // patient_duplicate: v1 is review/documentation only, no merge tooling —
    // see the plan's deferred items. Resolving just records the decision.

    const updated = await this.prisma.reconciliationItem.update({
      where: { id },
      data: { status: 'resolved', resolvedById: actor.id, resolution: input.resolution, resolvedAt: new Date() },
    });

    await this.audit.log({
      actorUserId: actor.id,
      actorType: 'user',
      action: 'RECONCILIATION_RESOLVED',
      entityTable: 'reconciliation_items',
      entityId: id,
      after: { kind: item.kind, resolution: input.resolution, linkedMedicineId: input.linkedMedicineId },
    });

    return updated;
  }
}
