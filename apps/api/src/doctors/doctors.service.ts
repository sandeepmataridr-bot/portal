import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { CreateDoctorInput, UpdateDoctorInput, DoctorSummary, SyncDoctorRef } from '@infusion/shared-types';
import { PrismaService } from '../prisma/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import { PasswordService } from '../auth/password.service.js';
import { slugifyLoginId, generateTempPassword } from '../common/credentials.util.js';
import type { AuthenticatedUser } from '../auth/types.js';

interface MachineActor {
  machineId: string;
  machineCode: string;
}

type DoctorProfileWithUser = {
  id: string;
  name: string;
  qualification: string | null;
  specialty: string | null;
  isTemporary: boolean;
  user: { id: string; loginId: string; isActive: boolean } | null;
};

// DoctorProfile-first, not User-first — a temporary, machine-created doctor
// (see docs/sync-contract.md) has no User row at all, so building a summary
// from User outward would never be able to represent one.
function toDoctorSummary(profile: DoctorProfileWithUser): DoctorSummary {
  return {
    id: profile.id,
    userId: profile.user?.id ?? null,
    loginId: profile.user?.loginId ?? null,
    name: profile.name,
    qualification: profile.qualification,
    specialty: profile.specialty,
    isActive: profile.user?.isActive ?? true,
    isTemporary: profile.isTemporary,
  };
}

@Injectable()
export class DoctorsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly passwords: PasswordService,
  ) {}

  // Active means "not archived": a real doctor with isActive:true, OR a
  // temporary machine-created reference (no archive concept of its own yet
  // — it simply exists until admin promotes or removes it).
  async listActive(): Promise<DoctorSummary[]> {
    const profiles = await this.prisma.doctorProfile.findMany({
      where: { OR: [{ user: { isActive: true } }, { userId: null }] },
      include: { user: true },
      orderBy: { name: 'asc' },
    });
    return profiles.map(toDoctorSummary);
  }

  async listAll(includeInactive: boolean): Promise<DoctorSummary[]> {
    const profiles = await this.prisma.doctorProfile.findMany({
      where: includeInactive ? {} : { OR: [{ user: { isActive: true } }, { userId: null }] },
      include: { user: true },
      orderBy: { name: 'asc' },
    });
    return profiles.map(toDoctorSummary);
  }

  async create(input: CreateDoctorInput, actor: AuthenticatedUser) {
    const baseSlug = slugifyLoginId(input.name);
    let loginId = baseSlug;
    let suffix = 1;
    while (await this.prisma.user.findUnique({ where: { loginId } })) {
      suffix += 1;
      loginId = `${baseSlug}${suffix}`;
    }

    const tempPassword = generateTempPassword();
    const passwordHash = await this.passwords.hash(tempPassword);

    const user = await this.prisma.user.create({
      data: {
        loginId,
        role: 'doctor',
        passwordHash,
        mustChangePassword: true,
        doctorProfile: {
          create: { name: input.name, qualification: input.qualification, specialty: input.specialty },
        },
      },
      include: { doctorProfile: true },
    });

    await this.audit.log({
      actorUserId: actor.id,
      actorType: 'user',
      action: 'DOCTOR_CREATED',
      entityTable: 'users',
      entityId: user.id,
      after: { loginId, name: input.name },
    });

    return {
      doctor: toDoctorSummary({
        ...user.doctorProfile!,
        user: { id: user.id, loginId: user.loginId, isActive: user.isActive },
      }),
      loginId,
      tempPassword,
    };
  }

  async update(doctorProfileId: string, input: UpdateDoctorInput, actor: AuthenticatedUser): Promise<DoctorSummary> {
    const existing = await this.prisma.doctorProfile.findUnique({
      where: { id: doctorProfileId },
      include: { user: true },
    });
    if (!existing) throw new NotFoundException('Doctor not found');

    const updated = await this.prisma.doctorProfile.update({
      where: { id: doctorProfileId },
      data: { name: input.name, qualification: input.qualification, specialty: input.specialty },
      include: { user: true },
    });

    await this.audit.log({
      actorUserId: actor.id,
      actorType: 'user',
      action: 'DOCTOR_UPDATED',
      entityTable: 'doctor_profiles',
      entityId: doctorProfileId,
      before: { name: existing.name, qualification: existing.qualification, specialty: existing.specialty },
      after: { name: input.name, qualification: input.qualification, specialty: input.specialty },
    });

    return toDoctorSummary(updated);
  }

  async setActive(doctorProfileId: string, isActive: boolean, actor: AuthenticatedUser): Promise<DoctorSummary> {
    const profile = await this.prisma.doctorProfile.findUnique({ where: { id: doctorProfileId } });
    if (!profile) throw new NotFoundException('Doctor not found');
    if (!profile.userId) throw new NotFoundException('This is a temporary doctor reference with no account to archive — promote it first');

    const user = await this.prisma.user.update({
      where: { id: profile.userId },
      data: { isActive },
      include: { doctorProfile: true },
    });

    if (!isActive) {
      await this.prisma.refreshToken.updateMany({
        where: { userId: user.id, revokedAt: null },
        data: { revokedAt: new Date() },
      });
    }

    await this.audit.log({
      actorUserId: actor.id,
      actorType: 'user',
      action: isActive ? 'DOCTOR_UNARCHIVED' : 'DOCTOR_ARCHIVED',
      entityTable: 'users',
      entityId: user.id,
    });

    return toDoctorSummary({ ...user.doctorProfile!, user });
  }

  async resetPassword(doctorProfileId: string, actor: AuthenticatedUser) {
    const profile = await this.prisma.doctorProfile.findUnique({ where: { id: doctorProfileId } });
    if (!profile) throw new NotFoundException('Doctor not found');
    if (!profile.userId) throw new NotFoundException('This is a temporary doctor reference with no account to reset — promote it first');

    const tempPassword = generateTempPassword();
    const passwordHash = await this.passwords.hash(tempPassword);

    const user = await this.prisma.user.update({
      where: { id: profile.userId },
      data: { passwordHash, mustChangePassword: true },
    });

    await this.prisma.refreshToken.updateMany({
      where: { userId: user.id, revokedAt: null },
      data: { revokedAt: new Date() },
    });

    await this.audit.log({
      actorUserId: actor.id,
      actorType: 'user',
      action: 'DOCTOR_PASSWORD_RESET',
      entityTable: 'users',
      entityId: user.id,
    });

    return { loginId: user.loginId, tempPassword };
  }

  /** The `doctors` reference-data list on every /sync/pull response — see packages/shared-types/src/sync.schema.ts. */
  async listForSyncPull(): Promise<SyncDoctorRef[]> {
    const profiles = await this.prisma.doctorProfile.findMany({
      where: { OR: [{ user: { isActive: true } }, { userId: null }] },
      select: { id: true, name: true, qualification: true, specialty: true },
      orderBy: { name: 'asc' },
    });
    return profiles;
  }

  /**
   * Emergency, offline case: a bedside doctor not already in the machine's
   * synced roster (on-call/substitute) — a lightweight reference, NOT a
   * login-capable account (userId stays null). Idempotent on entityId.
   */
  async createTemporaryFromMachine(
    tx: Prisma.TransactionClient,
    entityId: string,
    payload: { name?: unknown; qualification?: unknown; specialty?: unknown },
    actor: MachineActor,
  ) {
    const existing = await tx.doctorProfile.findUnique({ where: { id: entityId } });
    if (existing) return existing; // idempotent replay of an earlier push

    const name = typeof payload.name === 'string' ? payload.name.trim() : '';
    if (!name) throw new BadRequestException('Bedside doctor report requires a name');
    const qualification = typeof payload.qualification === 'string' ? payload.qualification : undefined;
    const specialty = typeof payload.specialty === 'string' ? payload.specialty : undefined;

    const created = await tx.doctorProfile.create({
      data: { id: entityId, name, qualification, specialty, isTemporary: true, createdByMachineId: actor.machineId },
    });

    await this.audit.log({
      actorType: 'machine',
      actorMachineId: actor.machineId,
      action: 'TEMPORARY_DOCTOR_CREATED',
      entityTable: 'doctor_profiles',
      entityId: created.id,
      after: { name, qualification, specialty },
    });

    return created;
  }

  /** Admin turns a temporary, machine-created doctor reference into a real login-capable account. */
  async promote(doctorProfileId: string, actor: AuthenticatedUser): Promise<{ doctor: DoctorSummary; loginId: string; tempPassword: string }> {
    const profile = await this.prisma.doctorProfile.findUnique({ where: { id: doctorProfileId } });
    if (!profile) throw new NotFoundException('Doctor not found');
    if (!profile.isTemporary || profile.userId) throw new BadRequestException('This doctor is not a temporary reference awaiting promotion');

    const baseSlug = slugifyLoginId(profile.name);
    let loginId = baseSlug;
    let suffix = 1;
    while (await this.prisma.user.findUnique({ where: { loginId } })) {
      suffix += 1;
      loginId = `${baseSlug}${suffix}`;
    }

    const tempPassword = generateTempPassword();
    const passwordHash = await this.passwords.hash(tempPassword);

    const updated = await this.prisma.doctorProfile.update({
      where: { id: doctorProfileId },
      data: {
        isTemporary: false,
        user: { create: { loginId, role: 'doctor', passwordHash, mustChangePassword: true } },
      },
      include: { user: true },
    });

    await this.audit.log({
      actorUserId: actor.id,
      actorType: 'user',
      action: 'TEMPORARY_DOCTOR_PROMOTED',
      entityTable: 'doctor_profiles',
      entityId: doctorProfileId,
      after: { loginId },
    });

    return { doctor: toDoctorSummary(updated), loginId, tempPassword };
  }

  /** Activity history for the manage_doctors.html-style history modal — login events plus everything this doctor acted on. */
  async getHistory(doctorProfileId: string) {
    const profile = await this.prisma.doctorProfile.findUnique({ where: { id: doctorProfileId } });
    if (!profile) throw new NotFoundException('Doctor not found');

    return this.prisma.auditLog.findMany({
      where: { actorUserId: profile.userId },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
  }
}
