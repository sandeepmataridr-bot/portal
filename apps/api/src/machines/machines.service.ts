import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import {
  isBidirectionalMachineType,
  type CreateMachineInput,
  type FleetStatus,
  type MachineSummary,
  type MachineType,
} from '@infusion/shared-types';
import { PrismaService } from '../prisma/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import type { AuthenticatedUser } from '../auth/types.js';
import { SyncOutboxService } from '../sync/sync-outbox.service.js';

@Injectable()
export class MachinesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly syncOutbox: SyncOutboxService,
  ) {}

  async listAll(): Promise<MachineSummary[]> {
    const machines = await this.prisma.machine.findMany({
      include: {
        patientAssignments: { where: { unassignedAt: null }, select: { patientId: true }, take: 1 },
      },
      orderBy: { machineCode: 'asc' },
    });
    return machines.map((m) => ({
      id: m.id,
      machineType: m.machineType as MachineType,
      machineCode: m.machineCode,
      location: m.location ?? undefined,
      status: m.status,
      lastSeenAt: m.lastSeenAt ? m.lastSeenAt.toISOString() : null,
      assignedPatientId: m.patientAssignments[0]?.patientId ?? null,
    }));
  }

  async fleetStatus(): Promise<FleetStatus> {
    const machines = await this.listAll();
    return {
      totalMachines: machines.length,
      connectedMachines: machines.filter((m) => m.status === 'online').length,
      machines,
    };
  }

  async create(input: CreateMachineInput, actor: AuthenticatedUser): Promise<MachineSummary> {
    const machine = await this.prisma.machine.create({
      data: { machineCode: input.machineCode, machineType: input.machineType, location: input.location },
    });

    await this.audit.log({
      actorUserId: actor.id,
      actorType: 'user',
      action: 'MACHINE_REGISTERED',
      entityTable: 'machines',
      entityId: machine.id,
      after: { machineCode: machine.machineCode, machineType: machine.machineType },
    });

    return {
      id: machine.id,
      machineType: machine.machineType as MachineType,
      machineCode: machine.machineCode,
      location: machine.location ?? undefined,
      status: machine.status,
      lastSeenAt: null,
      assignedPatientId: null,
    };
  }

  /**
   * Tags a patient to a machine. A machine treats one patient at a time
   * (enforced here), while a patient may hold several concurrent
   * assignments across different machines — see the plan's "Multiple
   * machine types, multi-machine patients" note. For bidirectional machine
   * types this is a proposal the device can still reject once SyncModule
   * exists (M5); for unidirectional types (ECMO/EBOO) it's accepted
   * immediately since there's no device round-trip.
   */
  async assignPatientToMachine(patientId: string, machineId: string, actor: AuthenticatedUser) {
    const machine = await this.prisma.machine.findUnique({ where: { id: machineId } });
    if (!machine) throw new NotFoundException('Machine not found');

    const activeOnMachine = await this.prisma.patientMachineAssignment.findFirst({
      where: { machineId, unassignedAt: null },
    });
    if (activeOnMachine && activeOnMachine.patientId !== patientId) {
      throw new ConflictException(
        `Machine ${machine.machineCode} is already assigned to another patient — unassign it first`,
      );
    }
    if (activeOnMachine && activeOnMachine.patientId === patientId) {
      return activeOnMachine; // idempotent
    }

    const syncStatus = isBidirectionalMachineType(machine.machineType as MachineType)
      ? 'pending_machine_ack'
      : 'accepted';

    const assignment = await this.prisma.patientMachineAssignment.create({
      data: { patientId, machineId, assignedById: actor.id, syncStatus },
    });

    if (isBidirectionalMachineType(machine.machineType as MachineType)) {
      const patient = await this.prisma.patient.findUnique({ where: { id: patientId } });
      await this.syncOutbox.enqueue(machineId, 'patient', assignment.id, {
        patientId,
        fullName: patient?.fullName,
        ipNumber: patient?.ipNumber,
      });
    }

    await this.audit.log({
      actorUserId: actor.id,
      actorType: 'user',
      action: 'PATIENT_MACHINE_TAGGED',
      entityTable: 'patient_machine_assignments',
      entityId: assignment.id,
      after: { patientId, machineId, syncStatus },
    });

    return assignment;
  }

  async unassignPatientFromMachine(patientId: string, machineId: string, actor: AuthenticatedUser) {
    const assignment = await this.prisma.patientMachineAssignment.findFirst({
      where: { patientId, machineId, unassignedAt: null },
    });
    if (!assignment) throw new NotFoundException('No active assignment found for this patient/machine pair');

    const updated = await this.prisma.patientMachineAssignment.update({
      where: { id: assignment.id },
      data: { unassignedAt: new Date() },
    });

    await this.audit.log({
      actorUserId: actor.id,
      actorType: 'user',
      action: 'PATIENT_MACHINE_UNTAGGED',
      entityTable: 'patient_machine_assignments',
      entityId: assignment.id,
      before: { patientId, machineId },
    });

    return updated;
  }

  async activeAssignmentsForPatient(patientId: string) {
    return this.prisma.patientMachineAssignment.findMany({
      where: { patientId, unassignedAt: null },
      include: { machine: true },
    });
  }
}
