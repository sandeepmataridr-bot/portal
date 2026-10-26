import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import {
  isBidirectionalMachineType,
  type CreateMachineInput,
  type FleetStatus,
  type MachineCommandSummary,
  type MachineSummary,
  type MachineType,
  type SendMachineCommandInput,
} from '@infusion/shared-types';
import { PrismaService } from '../prisma/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import { PasswordService } from '../auth/password.service.js';
import { InfusionCapService } from '../infusions/infusion-cap.service.js';
import type { AuthenticatedUser } from '../auth/types.js';
import { SyncOutboxService } from '../sync/sync-outbox.service.js';
import { SyncGateway } from '../sync/sync.gateway.js';

@Injectable()
export class MachinesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly syncOutbox: SyncOutboxService,
    private readonly gateway: SyncGateway,
    private readonly passwords: PasswordService,
    private readonly caps: InfusionCapService,
  ) {}

  async listAll(): Promise<MachineSummary[]> {
    const machines = await this.prisma.machine.findMany({
      include: {
        room: { select: { id: true, name: true } },
        patientAssignments: {
          where: { unassignedAt: null },
          select: { patientId: true, patient: { select: { roomId: true } } },
          take: 1,
        },
      },
      orderBy: { machineCode: 'asc' },
    });
    return machines.map((m) => {
      const assigned = m.patientAssignments[0];
      return {
        id: m.id,
        machineType: m.machineType as MachineType,
        machineCode: m.machineCode,
        location: m.room?.name,
        room: m.room,
        status: m.status,
        lastSeenAt: m.lastSeenAt ? m.lastSeenAt.toISOString() : null,
        assignedPatientId: assigned?.patientId ?? null,
        roomMismatch: !!assigned && assigned.patient.roomId !== m.roomId,
      };
    });
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
    const room = await this.prisma.room.findUnique({ where: { id: input.roomId } });
    if (!room || !room.active) throw new BadRequestException('Choose an active room');
    const machine = await this.prisma.machine.create({
      data: { machineCode: input.machineCode, machineType: input.machineType, roomId: room.id },
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
      location: room.name,
      room: { id: room.id, name: room.name },
      status: machine.status,
      lastSeenAt: null,
      assignedPatientId: null,
      roomMismatch: false,
    };
  }

  /**
   * Moves a machine to another room (admin). Refused while it is on a
   * patient in a different room: move the patient (their machines go with
   * them) or unassign it first.
   */
  async moveToRoom(machineId: string, roomId: string, actor: AuthenticatedUser) {
    const machine = await this.prisma.machine.findUnique({
      where: { id: machineId },
      include: {
        room: true,
        patientAssignments: { where: { unassignedAt: null }, include: { patient: { include: { room: true } } }, take: 1 },
      },
    });
    if (!machine) throw new NotFoundException('Machine not found');
    const room = await this.prisma.room.findUnique({ where: { id: roomId } });
    if (!room || !room.active) throw new BadRequestException('Choose an active room');
    if (machine.roomId === room.id) return this.listAll().then((all) => all.find((m) => m.id === machineId));
    const onPatient = machine.patientAssignments[0]?.patient;
    if (onPatient && onPatient.roomId !== room.id) {
      throw new ConflictException(
        `${machine.machineCode} is on ${onPatient.fullName} in ${onPatient.room?.name ?? 'no room'}. ` +
          `Move the patient (their machines move with them) or unassign ${machine.machineCode} first.`,
      );
    }
    await this.prisma.machine.update({ where: { id: machineId }, data: { roomId: room.id } });
    await this.audit.log({
      actorUserId: actor.id,
      actorType: 'user',
      action: 'MACHINE_MOVED',
      entityTable: 'machines',
      entityId: machineId,
      before: { room: machine.room?.name ?? null },
      after: { room: room.name },
    });
    return (await this.listAll()).find((m) => m.id === machineId);
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
    const machine = await this.prisma.machine.findUnique({ where: { id: machineId }, include: { room: true } });
    if (!machine) throw new NotFoundException('Machine not found');
    // A machine is only ever tagged to a patient in its own room.
    const target = await this.prisma.patient.findUnique({ where: { id: patientId }, include: { room: true } });
    if (!target) throw new NotFoundException('Patient not found');
    if (!machine.roomId) throw new ConflictException(`Set ${machine.machineCode}'s room first`);
    if (!target.roomId) throw new ConflictException(`Set ${target.fullName}'s room first`);
    if (machine.roomId !== target.roomId) {
      throw new ConflictException(
        `${machine.machineCode} is in ${machine.room?.name}; ${target.fullName} is in ${target.room?.name}. ` +
          'Move the machine or the patient first.',
      );
    }

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

  /**
   * The one deliberate exception to "machine always decides" (plan §
   * "Super-user remote commands") — real-time, online-only, never queued.
   * Every safeguard the plan calls for lives here: machineType gate,
   * password re-confirmation, online-only refusal, and a hard (not flag-only)
   * cap check on flow-rate changes, since this is server-INITIATED, unlike
   * machine-authored bedside actions.
   */
  async sendCommand(machineId: string, input: SendMachineCommandInput, actor: AuthenticatedUser): Promise<MachineCommandSummary> {
    // Explicit, hardcoded check rather than relying on @Roles('superuser') /
    // RolesGuard alone: RolesGuard has a pre-existing, separately-flagged
    // `admin` bypass that lets admin through every @Roles(...) list — correct
    // for account/fleet management, but the plan is explicit that direct
    // hardware control of a running infusion is "superuser only — no other
    // role gets these controls," full stop. This is the one endpoint in the
    // app where that distinction is enforced directly rather than deferred
    // to the shared guard.
    if (actor.role !== 'superuser') {
      throw new ForbiddenException('Remote machine commands are restricted to the superuser role');
    }

    const machine = await this.prisma.machine.findUnique({ where: { id: machineId } });
    if (!machine) throw new NotFoundException('Machine not found');
    if (machine.machineType !== 'INFUSION_PUMP') {
      throw new BadRequestException('Remote commands are only supported for infusion pumps');
    }

    const user = await this.prisma.user.findUnique({ where: { id: actor.id } });
    if (!user || !(await this.passwords.verify(user.passwordHash, input.password))) {
      throw new ForbiddenException('Password confirmation failed');
    }

    // Online-only, never queued — a stale stop/rate-change delivered whenever
    // the machine next reconnects could be dangerous by then.
    if (!this.gateway.isConnected(machineId)) {
      throw new ConflictException('Machine is not currently connected — command refused, never queued for later');
    }

    let payload: Record<string, unknown> | undefined;
    if (input.commandType === 'ADJUST_FLOW_RATE') {
      const liveStatus = await this.prisma.infusionLiveStatus.findUnique({ where: { machineId } });
      const step = liveStatus?.stepId ? await this.prisma.infusionStep.findUnique({ where: { id: liveStatus.stepId } }) : null;
      if (!step?.medicineId) {
        throw new ConflictException({
          code: 'MEDICINE_UNRESOLVED',
          message: 'Cannot verify dosage caps for the current step — medicine not resolved, resolve it in the reconciliation queue first',
        });
      }
      const capResult = await this.caps.check(step.medicineId, {
        volumeMl: step.plannedVolumeMl,
        rateMlPerH: input.flowRateMlPerH!,
      });
      if (!capResult.ok) {
        throw new BadRequestException({
          code: 'CAP_VIOLATION',
          message: 'Requested flow rate exceeds dosage/rate caps',
          violations: capResult.violations,
        });
      }
      payload = { flowRateMlPerH: input.flowRateMlPerH };
    }

    const command = await this.prisma.machineCommand.create({
      data: {
        machineId,
        commandType: input.commandType,
        payload: payload as Prisma.InputJsonValue | undefined,
        issuedById: actor.id,
        status: 'SENT',
      },
      include: { issuedBy: true },
    });

    this.gateway.emitToMachine(machineId, 'machine.command', {
      commandId: command.id,
      commandType: input.commandType,
      payload,
    });
    this.gateway.broadcastToDashboard('machine_command.updated', { machineId, commandId: command.id, status: 'SENT' });

    // Insert/status-update only, never deleted (DB-enforced, see the
    // immutable-audit-trail migration) — the single highest-stakes log entry
    // in the whole system, so this audit entry is written unconditionally,
    // never best-effort.
    await this.audit.log({
      actorUserId: actor.id,
      actorType: 'user',
      action: 'MACHINE_COMMAND_ISSUED',
      entityTable: 'machine_commands',
      entityId: command.id,
      after: { machineId, commandType: input.commandType, payload: payload ?? null } as Prisma.InputJsonValue,
    });

    return this.toCommandSummary(command);
  }

  async listCommands(machineId: string): Promise<MachineCommandSummary[]> {
    const commands = await this.prisma.machineCommand.findMany({
      where: { machineId },
      include: { issuedBy: true },
      orderBy: { issuedAt: 'desc' },
      take: 50,
    });
    return commands.map((c) => this.toCommandSummary(c));
  }

  private toCommandSummary(command: Prisma.MachineCommandGetPayload<{ include: { issuedBy: true } }>): MachineCommandSummary {
    return {
      id: command.id,
      machineId: command.machineId,
      commandType: command.commandType,
      payload: (command.payload as Record<string, unknown> | null) ?? null,
      issuedById: command.issuedById,
      issuedByLoginId: command.issuedBy.loginId,
      issuedAt: command.issuedAt.toISOString(),
      status: command.status as MachineCommandSummary['status'],
      respondedAt: command.respondedAt ? command.respondedAt.toISOString() : null,
      result: (command.result as Record<string, unknown> | null) ?? null,
    };
  }
}
