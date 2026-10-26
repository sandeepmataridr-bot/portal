import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type {
  RegisterPatientInput,
  ReadmitPatientInput,
  DischargePatientInput,
  PatientClinicalUpdateInput,
  ChangePatientDoctorInput,
  UpdatePatientIdentityInput,
  LinkPatientsInput,
  UnlinkPatientInput,
  MovePatientInput,
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
  room: { select: { id: true, name: true } },
  linkedTo: { select: { id: true, ipNumber: true, fullName: true } },
  linkedPatients: {
    select: { id: true, ipNumber: true, fullName: true, history: { orderBy: { version: 'desc' as const } } },
    orderBy: { createdAt: 'asc' as const },
  },
} satisfies Prisma.PatientInclude;

/**
 * The next IP number: 6 digits, in sequence, from the patient_ip_seq database
 * sequence (migration 20261026172909), so concurrent registrations never
 * collide. Used for reception and bedside-created patients alike.
 */
async function nextIpNumber(tx: Prisma.TransactionClient): Promise<string> {
  const [row] = await tx.$queryRaw<{ ip: string }[]>`SELECT lpad(nextval('patient_ip_seq')::text, 6, '0') AS ip`;
  return row.ip;
}

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
    await this.requireActiveRoom(input.roomId);
    const patientId = await this.prisma.$transaction(async (tx) => {
      const created = await tx.patient.create({
        data: {
          ipNumber: await nextIpNumber(tx),
          roomId: input.roomId,
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
        ipNumber: await nextIpNumber(tx),
        fullName,
        age: Math.trunc(age),
        gender,
        mobile,
        aadhar,
        emergencyContact,
        roomOrBed,
        registeredByMachineId: actor.machineId,
        // Created at the bedside: the patient is in the machine's room.
        roomId: (await tx.machine.findUnique({ where: { id: actor.machineId }, select: { roomId: true } }))?.roomId ?? null,
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
                { linkedPatients: { some: { ipNumber: { contains: search, mode: 'insensitive' as const } } } },
              ],
            }
          : {}),
        ...(doctorId ? { doctorProfileId: doctorId } : {}),
        // Linked duplicates are reached through their main record.
        linkedToPatientId: null,
      },
      include: {
        doctor: true,
        insuranceClaims: { orderBy: { createdAt: 'desc' }, take: 1 },
        linkedPatients: { select: { ipNumber: true } },
        room: { select: { id: true, name: true } },
      },
      orderBy: { createdAt: 'desc' },
    });

    return patients.map((p) => ({
      id: p.id,
      ipNumber: p.ipNumber,
      fullName: p.fullName,
      doctorName: p.doctor?.name ?? null,
      discharged: p.discharged,
      claimStatus: p.insuranceClaims[0]?.status ?? null,
      linkedIpNumbers: p.linkedPatients.map((l) => l.ipNumber).filter((ip): ip is string => !!ip),
      room: p.room,
    }));
  }

  async getById(id: string) {
    const patient = await this.prisma.patient.findUnique({ where: { id }, include: patientInclude });
    if (!patient) throw new NotFoundException('Patient not found');
    // One timeline for the person: this record's history plus every linked
    // duplicate's, each entry tagged with the IP number it was written under.
    const history = [
      ...patient.history.map((h) => ({ ...h, ipNumber: patient.ipNumber })),
      ...patient.linkedPatients.flatMap((l) => l.history.map((h) => ({ ...h, ipNumber: l.ipNumber }))),
    ].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    return {
      ...patient,
      history,
      linkedPatients: patient.linkedPatients.map((l) => ({ id: l.id, ipNumber: l.ipNumber, fullName: l.fullName })),
    };
  }

  /**
   * Links duplicate records to one main record (admin). Each duplicate keeps
   * its own data and IP number; it is hidden from active lists and its
   * history appears in the main record's timeline. Links are one level deep.
   */
  async linkPatients(input: LinkPatientsInput, actor: AuthenticatedUser) {
    await this.prisma.$transaction(async (tx) => {
      const found = await tx.patient.findMany({
        where: { id: { in: [input.mainPatientId, ...input.duplicatePatientIds] } },
        include: {
          linkedPatients: { select: { id: true } },
          machineAssignments: { where: { unassignedAt: null }, include: { machine: { select: { machineCode: true } } } },
        },
      });
      const byId = new Map(found.map((p) => [p.id, p]));
      const main = byId.get(input.mainPatientId);
      if (!main) throw new NotFoundException('Main patient not found');
      if (main.linkedToPatientId) {
        throw new ConflictException(`IP ${main.ipNumber} is itself linked to another IP; choose that one as the main IP`);
      }
      const dups = input.duplicatePatientIds.map((d) => {
        const p = byId.get(d);
        if (!p) throw new NotFoundException('Duplicate patient not found');
        // Duplicates are the same person: their gender must match the main IP's.
        if (p.gender !== main.gender) {
          throw new ConflictException(`IP ${p.ipNumber} is ${p.gender} but main IP ${main.ipNumber} is ${main.gender}; they cannot be the same patient`);
        }
        if (p.linkedToPatientId) throw new ConflictException(`IP ${p.ipNumber} is already linked; delink it first`);
        if (p.linkedPatients.length) throw new ConflictException(`IP ${p.ipNumber} has its own linked IPs; delink those first`);
        if (p.machineAssignments.length) {
          const codes = p.machineAssignments.map((a) => a.machine.machineCode).join(', ');
          throw new ConflictException(`IP ${p.ipNumber} is still on ${codes}; move those machines to IP ${main.ipNumber} first`);
        }
        return p;
      });

      for (const d of dups) {
        const v = d.version + 1;
        const updated = await tx.patient.update({ where: { id: d.id }, data: { linkedToPatientId: main.id, version: v } });
        await tx.patientHistory.create({
          data: {
            patientId: d.id,
            version: v,
            action: 'IP_LINKED_TO',
            snapshot: toSnapshot({ ...updated, mainIpNumber: main.ipNumber, mainFullName: main.fullName, reason: input.reason }),
            actedBy: actor.loginId,
          },
        });
      }
      const mv = main.version + 1;
      const mainUpdated = await tx.patient.update({ where: { id: main.id }, data: { version: mv } });
      await tx.patientHistory.create({
        data: {
          patientId: main.id,
          version: mv,
          action: 'IP_LINKED',
          snapshot: toSnapshot({
            ...mainUpdated,
            linked: dups.map((d) => ({ id: d.id, ipNumber: d.ipNumber, fullName: d.fullName })),
            reason: input.reason,
          }),
          actedBy: actor.loginId,
        },
      });
    });

    await this.audit.log({
      actorUserId: actor.id,
      actorType: 'user',
      action: 'PATIENT_IPS_LINKED',
      entityTable: 'patients',
      entityId: input.mainPatientId,
      after: { duplicates: input.duplicatePatientIds, reason: input.reason },
    });
    return this.getById(input.mainPatientId);
  }

  /** Delinks one duplicate from its main record (admin); both timelines record it. */
  async unlinkPatient(id: string, input: UnlinkPatientInput, actor: AuthenticatedUser) {
    let mainId = '';
    await this.prisma.$transaction(async (tx) => {
      const dup = await tx.patient.findUnique({ where: { id }, include: { linkedTo: true } });
      if (!dup) throw new NotFoundException('Patient not found');
      if (!dup.linkedTo) throw new ConflictException(`IP ${dup.ipNumber} is not linked`);
      const main = dup.linkedTo;
      mainId = main.id;

      const v = dup.version + 1;
      const updated = await tx.patient.update({ where: { id }, data: { linkedToPatientId: null, version: v } });
      await tx.patientHistory.create({
        data: {
          patientId: id,
          version: v,
          action: 'IP_UNLINKED',
          snapshot: toSnapshot({ ...updated, otherIpNumber: main.ipNumber, otherFullName: main.fullName, reason: input.reason }),
          actedBy: actor.loginId,
        },
      });
      const mv = main.version + 1;
      const mainUpdated = await tx.patient.update({ where: { id: main.id }, data: { version: mv } });
      await tx.patientHistory.create({
        data: {
          patientId: main.id,
          version: mv,
          action: 'IP_UNLINKED',
          snapshot: toSnapshot({ ...mainUpdated, otherIpNumber: dup.ipNumber, otherFullName: dup.fullName, reason: input.reason }),
          actedBy: actor.loginId,
        },
      });
    });

    await this.audit.log({
      actorUserId: actor.id,
      actorType: 'user',
      action: 'PATIENT_IPS_UNLINKED',
      entityTable: 'patients',
      entityId: id,
      after: { mainPatientId: mainId, reason: input.reason },
    });
    return this.getById(id);
  }

  /**
   * Moves a patient to another room (reception, admin). The machines attached
   * to them go with them, so a machine and its patient are never in
   * different rooms. ROOM_CHANGED in the history lists the machines moved.
   */
  async moveToRoom(id: string, input: MovePatientInput, actor: AuthenticatedUser) {
    const room = await this.requireActiveRoom(input.roomId);
    let moved: string[] = [];
    let fromRoom: string | null = null;
    await this.prisma.$transaction(async (tx) => {
      const patient = await tx.patient.findUnique({
        where: { id },
        include: { room: true, machineAssignments: { where: { unassignedAt: null }, include: { machine: true } } },
      });
      if (!patient) throw new NotFoundException('Patient not found');
      if (patient.discharged) throw new ConflictException('Patient is discharged; readmit them to choose a room');
      if (patient.roomId === room.id) throw new ConflictException(`${patient.fullName} is already in ${room.name}`);
      fromRoom = patient.room?.name ?? null;
      const machineIds = patient.machineAssignments.map((a) => a.machineId);
      moved = patient.machineAssignments.map((a) => a.machine.machineCode);
      if (machineIds.length) await tx.machine.updateMany({ where: { id: { in: machineIds } }, data: { roomId: room.id } });

      const v = patient.version + 1;
      const updated = await tx.patient.update({ where: { id }, data: { roomId: room.id, version: v } });
      await tx.patientHistory.create({
        data: {
          patientId: id,
          version: v,
          action: 'ROOM_CHANGED',
          snapshot: toSnapshot({ ...updated, fromRoom, toRoom: room.name, machinesMoved: moved, note: input.note ?? null }),
          actedBy: actor.loginId,
        },
      });
    });

    await this.audit.log({
      actorUserId: actor.id,
      actorType: 'user',
      action: 'PATIENT_ROOM_CHANGED',
      entityTable: 'patients',
      entityId: id,
      before: { room: fromRoom },
      after: { room: room.name, machinesMoved: moved },
    });
    return this.getById(id);
  }

  private async requireActiveRoom(roomId: string) {
    const room = await this.prisma.room.findUnique({ where: { id: roomId } });
    if (!room || !room.active) throw new BadRequestException('Choose an active room');
    return room;
  }

  /** Every main record with its linked duplicates, for the admin page. */
  listLinks() {
    return this.prisma.patient.findMany({
      where: { linkedPatients: { some: {} } },
      select: {
        id: true,
        ipNumber: true,
        fullName: true,
        linkedPatients: { select: { id: true, ipNumber: true, fullName: true, updatedAt: true }, orderBy: { createdAt: 'asc' } },
      },
      orderBy: { ipNumber: 'asc' },
    });
  }

  async readmit(id: string, input: ReadmitPatientInput, actor: AuthenticatedUser) {
    const patient = await this.prisma.patient.findUnique({ where: { id } });
    if (!patient) throw new NotFoundException('Patient not found');
    if (!patient.discharged) throw new ConflictException('Patient is not discharged — nothing to readmit');
    if (input.roomId) await this.requireActiveRoom(input.roomId);

    const nextVersion = patient.version + 1;
    const updated = await this.prisma.$transaction(async (tx) => {
      const result = await tx.patient.update({
        where: { id },
        data: {
          discharged: false,
          dischargeDate: null,
          dischargeRemarks: null,
          doctorProfileId: input.doctorId,
          ...(input.roomId ? { roomId: input.roomId } : {}),
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

  /**
   * Corrects identity details (age, mobile, emergency contact, Aadhar,
   * address). IP number, full name and gender are never changed. The
   * IDENTITY_UPDATE history entry lists each changed field, before and after.
   */
  async updateIdentity(id: string, input: UpdatePatientIdentityInput, actor: AuthenticatedUser) {
    const fields = ['age', 'mobile', 'emergencyContact', 'aadhar', 'address'] as const;
    let changes: { field: string; from: unknown; to: unknown }[] = [];
    await this.prisma.$transaction(async (tx) => {
      const patient = await tx.patient.findUnique({ where: { id } });
      if (!patient) throw new NotFoundException('Patient not found');
      changes = fields
        .filter((f) => input[f] !== undefined && (input[f] ?? null) !== (patient[f] ?? null))
        .map((f) => ({ field: f, from: patient[f] ?? null, to: input[f] ?? null }));
      if (!changes.length) throw new ConflictException('Nothing changed');

      const nextVersion = patient.version + 1;
      const result = await tx.patient.update({
        where: { id },
        data: { ...Object.fromEntries(changes.map((c) => [c.field, c.to])), version: nextVersion },
      });
      await tx.patientHistory.create({
        data: {
          patientId: id,
          version: nextVersion,
          action: 'IDENTITY_UPDATE',
          snapshot: toSnapshot({ ...result, changes }),
          actedBy: actor.loginId,
        },
      });
    });

    await this.audit.log({
      actorUserId: actor.id,
      actorType: 'user',
      action: 'PATIENT_IDENTITY_UPDATE',
      entityTable: 'patients',
      entityId: id,
      after: { fields: changes.map((c) => c.field) },
    });

    return this.getById(id);
  }

  /**
   * Moves an admitted patient to another attending doctor. The DOCTOR_REASSIGNED
   * history entry keeps both doctors and the reason, so the timeline shows
   * who looked after the patient when, and why it changed.
   */
  async changeDoctor(id: string, input: ChangePatientDoctorInput, actor: AuthenticatedUser) {
    await this.prisma.$transaction(async (tx) => {
      const patient = await tx.patient.findUnique({ where: { id }, include: { doctor: true } });
      if (!patient) throw new NotFoundException('Patient not found');
      if (patient.discharged) throw new ConflictException('Patient is discharged; readmit them to choose a doctor');
      if (patient.doctorProfileId === input.doctorId) throw new ConflictException('The patient is already with this doctor');
      const doctor = await tx.doctorProfile.findUnique({ where: { id: input.doctorId }, include: { user: true } });
      if (!doctor || (doctor.user && !doctor.user.isActive)) throw new BadRequestException('Choose an active doctor');

      const nextVersion = patient.version + 1;
      const result = await tx.patient.update({
        where: { id },
        data: { doctorProfileId: doctor.id, version: nextVersion },
      });
      await tx.patientHistory.create({
        data: {
          patientId: id,
          version: nextVersion,
          action: 'DOCTOR_REASSIGNED',
          snapshot: toSnapshot({
            ...result,
            fromDoctorId: patient.doctorProfileId,
            fromDoctorName: patient.doctor?.name ?? null,
            toDoctorId: doctor.id,
            toDoctorName: doctor.name,
            reason: input.reason,
            note: input.note ?? null,
          }),
          actedBy: actor.loginId,
        },
      });
    });

    await this.audit.log({
      actorUserId: actor.id,
      actorType: 'user',
      action: 'PATIENT_DOCTOR_CHANGED',
      entityTable: 'patients',
      entityId: id,
      after: { doctorId: input.doctorId, reason: input.reason },
    });

    return this.getById(id);
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
      this.prisma.patient.count({ where: { createdAt: { gte: startOfToday }, linkedToPatientId: null } }),
      this.prisma.patient.count({ where: { discharged: true, linkedToPatientId: null } }),
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
