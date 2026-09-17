import { Injectable, NotFoundException } from '@nestjs/common';
import type { CreateDoctorInput, UpdateDoctorInput, DoctorSummary } from '@infusion/shared-types';
import { PrismaService } from '../prisma/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import { PasswordService } from '../auth/password.service.js';
import { slugifyLoginId, generateTempPassword } from '../common/credentials.util.js';
import type { AuthenticatedUser } from '../auth/types.js';

type UserWithDoctorProfile = {
  id: string;
  loginId: string;
  isActive: boolean;
  doctorProfile: { id: string; name: string; qualification: string | null; specialty: string | null } | null;
};

function toDoctorSummary(user: UserWithDoctorProfile): DoctorSummary {
  if (!user.doctorProfile) {
    throw new NotFoundException('Doctor profile not found');
  }
  return {
    id: user.doctorProfile.id,
    userId: user.id,
    loginId: user.loginId,
    name: user.doctorProfile.name,
    qualification: user.doctorProfile.qualification,
    specialty: user.doctorProfile.specialty,
    isActive: user.isActive,
  };
}

@Injectable()
export class DoctorsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly passwords: PasswordService,
  ) {}

  async listActive(): Promise<DoctorSummary[]> {
    const users = await this.prisma.user.findMany({
      where: { role: 'doctor', isActive: true },
      include: { doctorProfile: true },
      orderBy: { doctorProfile: { name: 'asc' } },
    });
    return users.filter((u) => u.doctorProfile).map(toDoctorSummary);
  }

  async listAll(includeInactive: boolean): Promise<DoctorSummary[]> {
    const users = await this.prisma.user.findMany({
      where: { role: 'doctor', ...(includeInactive ? {} : { isActive: true }) },
      include: { doctorProfile: true },
      orderBy: { doctorProfile: { name: 'asc' } },
    });
    return users.filter((u) => u.doctorProfile).map(toDoctorSummary);
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

    return { doctor: toDoctorSummary(user), loginId, tempPassword };
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

    return toDoctorSummary({ ...updated.user, doctorProfile: updated });
  }

  async setActive(doctorProfileId: string, isActive: boolean, actor: AuthenticatedUser): Promise<DoctorSummary> {
    const profile = await this.prisma.doctorProfile.findUnique({ where: { id: doctorProfileId } });
    if (!profile) throw new NotFoundException('Doctor not found');

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

    return toDoctorSummary(user);
  }

  async resetPassword(doctorProfileId: string, actor: AuthenticatedUser) {
    const profile = await this.prisma.doctorProfile.findUnique({ where: { id: doctorProfileId } });
    if (!profile) throw new NotFoundException('Doctor not found');

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
