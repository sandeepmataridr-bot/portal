import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import type {
  CreateInfusionOrderInput,
  VerifyPharmacyDispenseInput,
  OverrideStepInput,
} from '@infusion/shared-types';
import { PrismaService } from '../prisma/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import type { AuthenticatedUser } from '../auth/types.js';
import { InfusionCapService } from './infusion-cap.service.js';
import { InfusionStepStateMachineService } from './infusion-step-state-machine.service.js';
import { SyncOutboxService } from '../sync/sync-outbox.service.js';

@Injectable()
export class InfusionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly caps: InfusionCapService,
    private readonly stateMachine: InfusionStepStateMachineService,
    private readonly syncOutbox: SyncOutboxService,
  ) {}

  async createOrder(input: CreateInfusionOrderInput, actor: AuthenticatedUser) {
    const patient = await this.prisma.patient.findUnique({ where: { id: input.patientId } });
    if (!patient) throw new NotFoundException('Patient not found');

    const activeAssignment = await this.prisma.patientMachineAssignment.findFirst({
      where: { patientId: input.patientId, machineId: input.machineId, unassignedAt: null },
    });
    if (!activeAssignment) {
      throw new ConflictException('Patient is not currently assigned to this machine — tag the machine first');
    }

    // Pre-proposal validation: every step's caps are checked before the
    // order is even created, so obviously-invalid data never reaches a
    // device. Collect ALL violations, not just the first, for a useful error.
    const violations: string[] = [];
    for (const step of input.steps) {
      const result = await this.caps.check(step.medicineId, {
        volumeMl: step.plannedVolumeMl,
        rateMlPerH: step.plannedRateMlPerH,
      });
      if (!result.ok) {
        violations.push(...result.violations.map((v) => `Step ${step.stepNumber}: ${v}`));
      }
    }
    if (violations.length > 0) {
      throw new BadRequestException({ code: 'CAP_VIOLATION', message: 'One or more steps exceed dosage/rate caps', violations });
    }

    const order = await this.prisma.$transaction(async (tx) => {
      const created = await tx.infusionOrder.create({
        data: {
          patientId: input.patientId,
          machineId: input.machineId,
          orderedById: actor.id,
          clinicalNotes: input.clinicalNotes,
          status: 'draft',
          steps: {
            create: input.steps.map((s) => ({
              stepNumber: s.stepNumber,
              medicineId: s.medicineId,
              rackNo: s.rackNo,
              channelNo: s.channelNo,
              plannedVolumeMl: s.plannedVolumeMl,
              plannedRateMlPerH: s.plannedRateMlPerH,
              status: 'DRAFT',
            })),
          },
        },
        include: { steps: true },
      });
      return created;
    });

    await this.audit.log({
      actorUserId: actor.id,
      actorType: 'user',
      action: 'INFUSION_ORDER_CREATED',
      entityTable: 'infusion_orders',
      entityId: order.id,
      after: { patientId: input.patientId, machineId: input.machineId, stepCount: order.steps.length },
    });

    return order;
  }

  async submitOrder(orderId: string, actor: AuthenticatedUser) {
    const order = await this.prisma.infusionOrder.findUnique({ where: { id: orderId }, include: { steps: true } });
    if (!order) throw new NotFoundException('Order not found');
    if (order.status !== 'draft') throw new ConflictException(`Order is already "${order.status}"`);

    await this.prisma.$transaction(async (tx) => {
      await tx.infusionOrder.update({ where: { id: orderId }, data: { status: 'submitted', version: { increment: 1 } } });
      for (const step of order.steps) {
        await this.stateMachine.transition(tx, step, 'PENDING_PHARMACY_VERIFICATION', {
          actorType: 'user',
          actorUserId: actor.id,
        });
      }
    });

    // Machine-owned data changed — queue it for the machine to pick up.
    for (const step of order.steps) {
      await this.syncOutbox.enqueue(order.machineId, 'infusion_step', step.id, {
        orderId: order.id,
        stepNumber: step.stepNumber,
        medicineId: step.medicineId,
        plannedVolumeMl: step.plannedVolumeMl,
        plannedRateMlPerH: step.plannedRateMlPerH,
      });
    }

    await this.audit.log({
      actorUserId: actor.id,
      actorType: 'user',
      action: 'INFUSION_ORDER_SUBMITTED',
      entityTable: 'infusion_orders',
      entityId: orderId,
    });

    return this.getOrder(orderId);
  }

  async verifyDispense(input: VerifyPharmacyDispenseInput, actor: AuthenticatedUser) {
    const step = await this.prisma.infusionStep.findUnique({
      where: { id: input.stepId },
      include: { medicine: true },
    });
    if (!step) throw new NotFoundException('Step not found');

    // The literal cross-role validation chain: what pharmacy is dispensing
    // must match exactly what the doctor ordered.
    if (step.medicineId !== input.dispensedMedicineId || step.plannedVolumeMl !== input.dispensedVolumeMl) {
      throw new ConflictException({
        code: 'DISPENSE_MISMATCH',
        message: 'Dispensed medicine/volume does not match the ordered step',
      });
    }

    // Always PENDING_PHARMACY_VERIFICATION -> PHARMACY_VERIFIED first (that's
    // literally what verification means), then auto-advance: high-alert
    // medicines need a second confirmer, everything else goes straight to
    // READY. Two chained transitions, not one jump — PHARMACY_VERIFIED is a
    // real, auditable state each step passes through.
    const updated = await this.prisma.$transaction(async (tx) => {
      const verified = await this.stateMachine.transition(
        tx,
        step,
        'PHARMACY_VERIFIED',
        { actorType: 'user', actorUserId: actor.id },
        { pharmacyVerifiedById: actor.id, pharmacyVerifiedAt: new Date() },
      );

      if (step.medicine.highAlert) {
        return this.stateMachine.transition(tx, verified, 'PENDING_SECOND_CONFIRMATION', {
          actorType: 'user',
          actorUserId: actor.id,
        });
      }
      return this.stateMachine.transition(tx, verified, 'READY', { actorType: 'user', actorUserId: actor.id });
    });

    await this.audit.log({
      actorUserId: actor.id,
      actorType: 'user',
      action: 'INFUSION_STEP_VERIFIED',
      entityTable: 'infusion_steps',
      entityId: step.id,
    });
    return updated;
  }

  async confirmHighAlert(stepId: string, actor: AuthenticatedUser) {
    const step = await this.prisma.infusionStep.findUnique({ where: { id: stepId }, include: { medicine: true } });
    if (!step) throw new NotFoundException('Step not found');
    if (!step.medicine.highAlert) throw new BadRequestException('This medicine does not require a second confirmation');
    if (step.pharmacyVerifiedById === actor.id) {
      throw new ForbiddenException('High-alert confirmation must come from a different staff member than the pharmacy verifier');
    }

    const updated = await this.prisma.$transaction((tx) =>
      this.stateMachine.transition(tx, step, 'READY', { actorType: 'user', actorUserId: actor.id }, {
        highAlertConfirmedById: actor.id,
        highAlertConfirmedAt: new Date(),
      }),
    );

    await this.audit.log({
      actorUserId: actor.id,
      actorType: 'user',
      action: 'INFUSION_STEP_HIGH_ALERT_CONFIRMED',
      entityTable: 'infusion_steps',
      entityId: step.id,
    });
    return updated;
  }

  async startStep(stepId: string, actor: AuthenticatedUser) {
    const step = await this.prisma.infusionStep.findUnique({
      where: { id: stepId },
      include: { medicine: true, order: true },
    });
    if (!step) throw new NotFoundException('Step not found');

    // Defense in depth: re-check caps at execution time, not just at authoring.
    const capResult = await this.caps.check(step.medicineId, {
      volumeMl: step.plannedVolumeMl,
      rateMlPerH: step.plannedRateMlPerH,
    });
    if (!capResult.ok) {
      throw new BadRequestException({ code: 'CAP_VIOLATION', message: 'Step exceeds dosage/rate caps', violations: capResult.violations });
    }

    if (step.stepNumber > 1) {
      const previous = await this.prisma.infusionStep.findFirst({
        where: { orderId: step.orderId, stepNumber: step.stepNumber - 1 },
      });
      if (previous && previous.status !== 'COMPLETED') {
        throw new ConflictException(`Step ${previous.stepNumber} must be completed before starting step ${step.stepNumber}`);
      }
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      const result = await this.stateMachine.transition(tx, step, 'RUNNING', { actorType: 'user', actorUserId: actor.id }, {
        startedAt: new Date(),
      });

      await tx.infusionLiveStatus.upsert({
        where: { machineId: step.order.machineId },
        create: {
          patientId: step.order.patientId,
          machineId: step.order.machineId,
          stepId: step.id,
          currentMedicineName: step.medicine.name,
          remainingVolumeMl: step.plannedVolumeMl,
          dispensedVolumeMl: 0,
          flowRateMlPerH: step.plannedRateMlPerH,
          pumpState: 'RUNNING',
        },
        update: {
          patientId: step.order.patientId,
          stepId: step.id,
          currentMedicineName: step.medicine.name,
          remainingVolumeMl: step.plannedVolumeMl,
          dispensedVolumeMl: 0,
          flowRateMlPerH: step.plannedRateMlPerH,
          pumpState: 'RUNNING',
          lastUpdateAt: new Date(),
        },
      });

      return result;
    });

    await this.audit.log({ actorUserId: actor.id, actorType: 'user', action: 'INFUSION_STEP_STARTED', entityTable: 'infusion_steps', entityId: step.id });
    return updated;
  }

  async pauseStep(stepId: string, actor: AuthenticatedUser) {
    return this.simpleTransition(stepId, 'PAUSED', actor, { pumpState: 'PAUSED' });
  }

  async resumeStep(stepId: string, actor: AuthenticatedUser) {
    return this.simpleTransition(stepId, 'RUNNING', actor, { pumpState: 'RUNNING' });
  }

  async completeStep(stepId: string, actor: AuthenticatedUser) {
    const step = await this.prisma.infusionStep.findUnique({ where: { id: stepId }, include: { order: true } });
    if (!step) throw new NotFoundException('Step not found');

    const updated = await this.prisma.$transaction(async (tx) => {
      const result = await this.stateMachine.transition(tx, step, 'COMPLETED', { actorType: 'user', actorUserId: actor.id }, {
        completedAt: new Date(),
      });
      await tx.infusionLiveStatus.updateMany({
        where: { machineId: step.order.machineId },
        data: { pumpState: 'STOPPED', dispensedVolumeMl: step.plannedVolumeMl, remainingVolumeMl: 0, lastUpdateAt: new Date() },
      });
      return result;
    });

    await this.audit.log({ actorUserId: actor.id, actorType: 'user', action: 'INFUSION_STEP_COMPLETED', entityTable: 'infusion_steps', entityId: stepId });
    return updated;
  }

  async rejectStep(stepId: string, reason: string, actor: AuthenticatedUser) {
    return this.simpleTransition(stepId, 'REJECTED', actor, {}, reason);
  }

  async cancelStep(stepId: string, reason: string, actor: AuthenticatedUser) {
    return this.simpleTransition(stepId, 'CANCELLED', actor, {}, reason);
  }

  private async simpleTransition(
    stepId: string,
    toStatus: 'PAUSED' | 'RUNNING' | 'REJECTED' | 'CANCELLED',
    actor: AuthenticatedUser,
    liveStatusPatch: Record<string, unknown> = {},
    reason?: string,
  ) {
    const step = await this.prisma.infusionStep.findUnique({ where: { id: stepId }, include: { order: true } });
    if (!step) throw new NotFoundException('Step not found');

    const updated = await this.prisma.$transaction(async (tx) => {
      const result = await this.stateMachine.transition(tx, step, toStatus, { actorType: 'user', actorUserId: actor.id }, {}, reason);
      if (Object.keys(liveStatusPatch).length > 0) {
        await tx.infusionLiveStatus.updateMany({
          where: { machineId: step.order.machineId },
          data: { ...liveStatusPatch, lastUpdateAt: new Date() },
        });
      }
      return result;
    });

    await this.audit.log({
      actorUserId: actor.id,
      actorType: 'user',
      action: `INFUSION_STEP_${toStatus}`,
      entityTable: 'infusion_steps',
      entityId: stepId,
    });
    return updated;
  }

  /**
   * Overrides bypass the normal transition table but NEVER the absolute,
   * non-overridable cap ceiling — see checkInfusionCaps' `hardBlocked` flag.
   * Always reason-required and dual-logged (event + audit), per the plan.
   */
  async overrideStep(input: OverrideStepInput, actor: AuthenticatedUser) {
    const step = await this.prisma.infusionStep.findUnique({ where: { id: input.stepId }, include: { medicine: true } });
    if (!step) throw new NotFoundException('Step not found');

    if (input.targetStatus === 'RUNNING') {
      const capResult = await this.caps.check(step.medicineId, {
        volumeMl: step.plannedVolumeMl,
        rateMlPerH: step.plannedRateMlPerH,
      });
      if (capResult.hardBlocked) {
        throw new BadRequestException({
          code: 'CAP_VIOLATION_ABSOLUTE',
          message: 'Absolute dosage/rate ceiling cannot be overridden under any circumstances',
          violations: capResult.violations,
        });
      }
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      const result = await tx.infusionStep.update({ where: { id: step.id }, data: { status: input.targetStatus } });
      await tx.infusionStepEvent.create({
        data: {
          stepId: step.id,
          fromStatus: step.status,
          toStatus: input.targetStatus,
          actorType: 'user',
          actorUserId: actor.id,
          reason: input.reason,
          payload: { override: true },
        },
      });
      return result;
    });

    await this.audit.log({
      actorUserId: actor.id,
      actorType: 'user',
      action: 'INFUSION_STEP_OVERRIDDEN',
      entityTable: 'infusion_steps',
      entityId: step.id,
      before: { status: step.status },
      after: { status: input.targetStatus, reason: input.reason },
    });
    return updated;
  }

  getOrder(id: string) {
    return this.prisma.infusionOrder.findUniqueOrThrow({
      where: { id },
      include: { steps: { orderBy: { stepNumber: 'asc' }, include: { medicine: true, events: { orderBy: { createdAt: 'desc' } } } } },
    });
  }

  listOrdersForPatient(patientId: string) {
    return this.prisma.infusionOrder.findMany({
      where: { patientId },
      include: { steps: { orderBy: { stepNumber: 'asc' }, include: { medicine: true } } },
      orderBy: { createdAt: 'desc' },
    });
  }

  getLiveStatus(machineId: string) {
    return this.prisma.infusionLiveStatus.findUnique({ where: { machineId } });
  }
}
