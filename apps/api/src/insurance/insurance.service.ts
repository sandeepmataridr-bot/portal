import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import {
  CLAIM_ACTIONABLE_STATUSES,
  CLAIM_REVOCABLE_STATUSES,
  type ClaimDecisionInput,
  type ClaimRevokeInput,
  type ClaimStatus,
} from '@infusion/shared-types';
import { PrismaService } from '../prisma/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import type { AuthenticatedUser } from '../auth/types.js';

const ACTION_TO_STATUS: Record<ClaimDecisionInput['action'], ClaimStatus> = {
  Approve: 'approved',
  'Partially Approve': 'partially_approved',
  Reject: 'rejected',
  'Request Documents': 'documents_required',
};

const ACTION_TO_HISTORY_ACTION: Record<ClaimDecisionInput['action'], string> = {
  Approve: 'INSURANCE_APPROVED',
  'Partially Approve': 'INSURANCE_PARTIALLY_APPROVED',
  Reject: 'INSURANCE_REJECTED',
  'Request Documents': 'INSURANCE_DOCUMENTS_REQUIRED',
};

function toSnapshot(record: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(record));
}

@Injectable()
export class InsuranceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  listCompanies() {
    return this.prisma.insuranceCompany.findMany({ orderBy: { name: 'asc' } });
  }

  listRejectionReasons() {
    return this.prisma.insuranceRejectionReason.findMany({ orderBy: { code: 'asc' } });
  }

  listClaims(status?: ClaimStatus, search?: string) {
    return this.prisma.insuranceClaim.findMany({
      where: {
        status,
        patient: search
          ? { OR: [{ fullName: { contains: search, mode: 'insensitive' } }, { ipNumber: { contains: search, mode: 'insensitive' } }] }
          : undefined,
      },
      include: { patient: true, insuranceCompany: true },
      orderBy: { createdAt: 'desc' },
    });
  }

  async decide(claimId: string, input: ClaimDecisionInput, actor: AuthenticatedUser) {
    const claim = await this.prisma.insuranceClaim.findUnique({ where: { id: claimId } });
    if (!claim) throw new NotFoundException('Claim not found');
    if (!CLAIM_ACTIONABLE_STATUSES.includes(claim.status)) {
      throw new ConflictException(`Claim in status "${claim.status}" cannot be decided — it is locked`);
    }

    const newStatus = ACTION_TO_STATUS[input.action];
    const remarks =
      input.action === 'Reject'
        ? [input.reasonCode, input.remarks].filter(Boolean).join(' — ')
        : input.remarks;

    const updated = await this.prisma.$transaction(async (tx) => {
      const result = await tx.insuranceClaim.update({
        where: { id: claimId },
        data: { status: newStatus, remarks, approvedById: actor.id },
      });

      const patient = await tx.patient.update({
        where: { id: claim.patientId },
        data: { version: { increment: 1 } },
      });

      await tx.patientHistory.create({
        data: {
          patientId: claim.patientId,
          version: patient.version,
          action: ACTION_TO_HISTORY_ACTION[input.action],
          snapshot: toSnapshot({ claimStatus: newStatus, approvalRemarks: remarks, approvedBy: actor.loginId }),
          actedBy: actor.loginId,
        },
      });

      return result;
    });

    await this.audit.log({
      actorUserId: actor.id,
      actorType: 'user',
      action: ACTION_TO_HISTORY_ACTION[input.action],
      entityTable: 'insurance_claims',
      entityId: claimId,
      before: { status: claim.status },
      after: { status: newStatus },
    });

    return updated;
  }

  async revoke(claimId: string, input: ClaimRevokeInput, actor: AuthenticatedUser) {
    const claim = await this.prisma.insuranceClaim.findUnique({ where: { id: claimId } });
    if (!claim) throw new NotFoundException('Claim not found');
    if (!CLAIM_REVOCABLE_STATUSES.includes(claim.status)) {
      throw new BadRequestException(`Claim in status "${claim.status}" cannot be revoked`);
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      const result = await tx.insuranceClaim.update({
        where: { id: claimId },
        data: { status: 'under_review', remarks: input.remarks },
      });

      const patient = await tx.patient.update({ where: { id: claim.patientId }, data: { version: { increment: 1 } } });

      await tx.patientHistory.create({
        data: {
          patientId: claim.patientId,
          version: patient.version,
          action: 'INSURANCE_REVOKED',
          snapshot: toSnapshot({ claimStatus: 'under_review', approvalRemarks: input.remarks, approvedBy: actor.loginId }),
          actedBy: actor.loginId,
        },
      });

      return result;
    });

    await this.audit.log({
      actorUserId: actor.id,
      actorType: 'user',
      action: 'INSURANCE_REVOKED',
      entityTable: 'insurance_claims',
      entityId: claimId,
      before: { status: claim.status },
      after: { status: 'under_review' },
    });

    return updated;
  }
}
