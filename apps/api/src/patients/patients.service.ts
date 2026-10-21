import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type {
  RegisterPatientInput,
  ReadmitPatientInput,
  DischargePatientInput,
  PatientClinicalUpdateInput,
} from '@infusion/shared-types';
import { PrismaService } from '../prisma/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import { ReconciliationService } from '../reconciliation/reconciliation.service.js';
import type { AuthenticatedUser } from '../auth/types.js';

interface MachineActor {
  machineId: string;
  machineCode: string;
}

const patientInclude = {
  doctor: true,
  history: { orderBy: { version: 'desc' as const } },
  insuranceClaims: { orderBy: { createdAt: 'desc' as const }, take: 1 },
  machineAssignments: { where: { unassignedAt: null }, include: { machine: true } },
} satisfies Prisma.PatientInclude;

function toSnapshot(record: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(record));
}

@Injectable()
export class PatientsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly reconciliation: ReconciliationService,
  ) {}

  async register(input: RegisterPatientInput, actor: AuthenticatedUser) {
    const existing = await this.prisma.patient.findUnique({ where: { ipNumber: input.ipNumber } });
    if (existing) throw new ConflictException(`IP Number ${input.ipNumber} is already registered`);

    const patientId = await this.prisma.$transaction(async (tx) => {
      const created = await tx.patient.create({
        data: {
          ipNumber: input.ipNumber,
          fullName: input.fullName,
          age: input.age,
          gender: input.gender,
          mobile: input.mobile,
          emergencyContact: input.emergencyContact,
          aadhar: input.aadhar,
          address: input.address,
          weightKg: input.weightKg,
          heightCm: input.heightCm,
          bpSystolic: input.bpSystolic,
          bpDiastolic: input.bpDiastolic,
          heartRate: input.heartRate,
          temperatureF: input.temperatureF,
          diagnosis: input.diagnosis,
          doctorProfileId: input.doctorId,
          insured: input.conditions.insured,
          diabetic: input.conditions.diabetic,
          diabeticYears: input.conditions.diabeticYears,
          hypertensive: input.conditions.hypertensive,
          hypertensiveYears: input.conditions.hypertensiveYears,
          cva: input.conditions.cva,
          cad: input.conditions.cad,
          seizures: input.conditions.seizures,
          thyroid: input.conditions.thyroid,
          othersText: input.conditions.othersText,
          registeredById: actor.id,
        },
      });

      if (input.conditions.insured && input.insurance) {
        await tx.insuranceClaim.create({
          data: {
            patientId: created.id,
            insuranceCompanyId: input.insurance.insuranceCompanyId,
            insuranceType: input.insurance.insuranceType,
            policyNumber: input.insurance.policyNumber,
            memberId: input.insurance.memberId,
            relationship: input.insurance.relationship,
            policyStart: input.insurance.policyStart ? new Date(input.insurance.policyStart) : undefined,
            policyEnd: input.insurance.policyEnd ? new Date(input.insurance.policyEnd) : undefined,
            tpaName: input.insurance.tpaName,
            status: 'draft',
          },
        });
      }

      await tx.patientHistory.create({
        data: { patientId: created.id, version: 1, action: 'REGISTER', snapshot: toSnapshot(created), actedBy: actor.loginId },
      });

      return created.id;
    });

    await this.audit.log({
      actorUserId: actor.id,
      actorType: 'user',
      action: 'PATIENT_REGISTERED',
      entityTable: 'patients',
      entityId: patientId,
    });

    return this.getById(patientId);
  }

  /**
   * Bedside-originated patient — "machine is always correct," this only
   * ever records what the machine reports, never rejects it (see the plan's
   * M7 section). Runs inside SyncService's per-report transaction, not its
   * own — one bad report in a push batch must not roll back the others.
   * Idempotent on entityId: a retried push after a dropped connection must
   * not double-create or error.
   */
  async registerFromMachine(
    tx: Prisma.TransactionClient,
    entityId: string,
    payload: Record<string, unknown>,
    actor: MachineActor,
  ) {
    const existing = await tx.patient.findUnique({ where: { id: entityId } });
    if (existing) return existing; // idempotent replay of an earlier push

    const fullName = typeof payload.fullName === 'string' ? payload.fullName.trim() : '';
    const age = typeof payload.age === 'number' ? payload.age : Number(payload.age);
    const gender = typeof payload.gender === 'string' ? payload.gender : '';
    if (!fullName || !Number.isFinite(age) || age <= 0 || !gender) {
      throw new BadRequestException('Bedside patient report requires at least fullName, age, and gender');
    }
    const mobile = typeof payload.mobile === 'string' ? payload.mobile : undefined;
    const aadhar = typeof payload.aadhar === 'string' ? payload.aadhar : undefined;
    const emergencyContact = typeof payload.emergencyContact === 'string' ? payload.emergencyContact : undefined;
    const roomOrBed = typeof payload.roomOrBed === 'string' ? payload.roomOrBed : undefined;

    const created = await tx.patient.create({
      data: {
        id: entityId,
        fullName,
        age: Math.trunc(age),
        gender,
        mobile,
        aadhar,
        emergencyContact,
        roomOrBed,
        registeredByMachineId: actor.machineId,
        needsReceptionCompletion: true,
      },
    });

    await tx.patientHistory.create({
      data: {
        patientId: created.id,
        version: 1,
        action: 'REGISTER',
        snapshot: toSnapshot(created),
        actorType: 'machine',
        actorMachineId: actor.machineId,
        actedBy: actor.machineCode,
      },
    });

    const candidates = await this.reconciliation.findPatientDuplicates({ fullName, age: Math.trunc(age), gender, aadhar });
    if (candidates.length > 0) {
      await this.reconciliation.record(tx, 'patient_duplicate', actor.machineId, 'patient', created.id, { fullName, age, gender, aadhar }, candidates);
    }

    await this.audit.log({
      actorType: 'machine',
      actorMachineId: actor.machineId,
      action: 'PATIENT_REGISTERED',
      entityTable: 'patients',
      entityId: created.id,
      after: { fullName, age, gender },
    });

    return created;
  }

  async list(search?: string, doctorId?: string) {
    const patients = await this.prisma.patient.findMany({
      where: {
        ...(search
          ? {
              OR: [
                { fullName: { contains: search, mode: 'insensitive' as const } },
                { ipNumber: { contains: search, mode: 'insensitive' as const } },
              ],
            }
          : {}),
        ...(doctorId ? { doctorProfileId: doctorId } : {}),
      },
      include: { doctor: true, insuranceClaims: { orderBy: { createdAt: 'desc' }, take: 1 } },
      orderBy: { createdAt: 'desc' },
    });

    return patients.map((p) => ({
      id: p.id,
      ipNumber: p.ipNumber,
      fullName: p.fullName,
      doctorName: p.doctor?.name ?? null,
      discharged: p.discharged,
      claimStatus: p.insuranceClaims[0]?.status ?? null,
    }));
  }

  async getById(id: string) {
    const patient = await this.prisma.patient.findUnique({ where: { id }, include: patientInclude });
    if (!patient) throw new NotFoundException('Patient not found');
    return patient;
  }

  async readmit(id: string, input: ReadmitPatientInput, actor: AuthenticatedUser) {
    const patient = await this.prisma.patient.findUnique({ where: { id } });
    if (!patient) throw new NotFoundException('Patient not found');
    if (!patient.discharged) throw new ConflictException('Patient is not discharged — nothing to readmit');

    const nextVersion = patient.version + 1;
    const updated = await this.prisma.$transaction(async (tx) => {
      const result = await tx.patient.update({
        where: { id },
        data: {
          discharged: false,
          dischargeDate: null,
          dischargeRemarks: null,
          doctorProfileId: input.doctorId,
          address: input.address,
          weightKg: input.weightKg,
          heightCm: input.heightCm,
          bpSystolic: input.bpSystolic,
          bpDiastolic: input.bpDiastolic,
          heartRate: input.heartRate,
          temperatureF: input.temperatureF,
          diagnosis: input.diagnosis,
          insured: input.conditions.insured,
          diabetic: input.conditions.diabetic,
          diabeticYears: input.conditions.diabeticYears,
          hypertensive: input.conditions.hypertensive,
          hypertensiveYears: input.conditions.hypertensiveYears,
          cva: input.conditions.cva,
          cad: input.conditions.cad,
          seizures: input.conditions.seizures,
          thyroid: input.conditions.thyroid,
          othersText: input.conditions.othersText,
          version: nextVersion,
        },
      });

      await tx.patientHistory.create({
        data: { patientId: id, version: nextVersion, action: 'READMIT', snapshot: toSnapshot(result), actedBy: actor.loginId },
      });

      return result;
    });

    await this.audit.log({
      actorUserId: actor.id,
      actorType: 'user',
      action: 'PATIENT_READMITTED',
      entityTable: 'patients',
      entityId: id,
    });

    return this.getById(updated.id);
  }

  async discharge(id: string, input: DischargePatientInput, actor: AuthenticatedUser) {
    await this.dischargeCore(id, input.remarks, { actorType: 'user', actorUserId: actor.id, actedBy: actor.loginId });

    await this.audit.log({
      actorUserId: actor.id,
      actorType: 'user',
      action: 'PATIENT_DISCHARGED',
      entityTable: 'patients',
      entityId: id,
    });

    return this.getById(id);
  }

  /**
   * Bedside discharge — travels as a `patient` sync report with a payload
   * action marker (see SyncService.handleMachineOriginatedReport), reusing
   * the exact same core write path as the staff-driven discharge above so
   * the machine-assignment-closeout fix applies to both callers identically.
   * Runs inside SyncService's own transaction, not its own.
   */
  async dischargeFromMachine(tx: Prisma.TransactionClient, id: string, actor: { machineId: string; machineCode: string }) {
    await this.dischargeCore(id, undefined, { actorType: 'machine', actorMachineId: actor.machineId, actedBy: actor.machineCode }, tx);

    await this.audit.log({
      actorType: 'machine',
      actorMachineId: actor.machineId,
      action: 'PATIENT_DISCHARGED',
      entityTable: 'patients',
      entityId: id,
    });
  }

  private async dischargeCore(
    id: string,
    remarks: string | undefined,
    actorFields: { actorType: 'user' | 'machine'; actorUserId?: string; actorMachineId?: string; actedBy: string },
    existingTx?: Prisma.TransactionClient,
  ) {
    const run = async (tx: Prisma.TransactionClient) => {
      const patient = await tx.patient.findUnique({ where: { id } });
      if (!patient) throw new NotFoundException('Patient not found');
      if (patient.discharged) throw new ConflictException('Patient is already discharged');

      const nextVersion = patient.version + 1;
      const result = await tx.patient.update({
        where: { id },
        data: { discharged: true, dischargeDate: new Date(), dischargeRemarks: remarks, version: nextVersion },
      });
      await tx.patientHistory.create({
        data: {
          patientId: id,
          version: nextVersion,
          action: 'DISCHARGE',
          snapshot: toSnapshot(result),
          actorType: actorFields.actorType,
          actorMachineId: actorFields.actorMachineId,
          actedBy: actorFields.actedBy,
        },
      });
      // A discharged patient must not keep showing as "actively assigned" to
      // a machine indefinitely — close out every active assignment here
      // rather than leaving it to whoever remembers to untag manually.
      await tx.patientMachineAssignment.updateMany({
        where: { patientId: id, unassignedAt: null },
        data: { unassignedAt: new Date() },
      });
    };

    if (existingTx) {
      await run(existingTx);
    } else {
      await this.prisma.$transaction(run);
    }
  }

  async updateClinical(id: string, input: PatientClinicalUpdateInput, actor: AuthenticatedUser) {
    const patient = await this.prisma.patient.findUnique({ where: { id } });
    if (!patient) throw new NotFoundException('Patient not found');

    const nextVersion = patient.version + 1;
    await this.prisma.$transaction(async (tx) => {
      const result = await tx.patient.update({
        where: { id },
        data: {
          address: input.address,
          weightKg: input.weightKg,
          heightCm: input.heightCm,
          bpSystolic: input.bpSystolic,
          bpDiastolic: input.bpDiastolic,
          heartRate: input.heartRate,
          temperatureF: input.temperatureF,
          diagnosis: input.diagnosis,
          ...(input.conditions ?? {}),
          version: nextVersion,
        },
      });
      await tx.patientHistory.create({
        data: {
          patientId: id,
          version: nextVersion,
          action: 'DOCTOR_UPDATE',
          snapshot: toSnapshot({ ...result, doctorNotes: input.doctorNotes }),
          actedBy: actor.loginId,
        },
      });
    });

    await this.audit.log({
      actorUserId: actor.id,
      actorType: 'user',
      action: 'PATIENT_CLINICAL_UPDATE',
      entityTable: 'patients',
      entityId: id,
    });

    return this.getById(id);
  }

  /** Stat tiles for the reception dashboard (reception.html: Today's Patients, Insurance Pending, Approved, Rejected, Discharged). */
  async dashboard() {
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);

    const [todayPatients, discharged, claims] = await Promise.all([
      this.prisma.patient.count({ where: { createdAt: { gte: startOfToday } } }),
      this.prisma.patient.count({ where: { discharged: true } }),
      this.prisma.insuranceClaim.groupBy({ by: ['status'], _count: true }),
    ]);

    const countFor = (statuses: string[]) =>
      claims.filter((c) => statuses.includes(c.status)).reduce((sum, c) => sum + c._count, 0);

    return {
      todayPatients,
      insurancePending: countFor(['draft', 'submitted', 'under_review', 'documents_required']),
      approved: countFor(['approved', 'partially_approved']),
      rejected: countFor(['rejected']),
      discharged,
    };
  }
}
