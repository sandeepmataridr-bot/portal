import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { assertStepTransition, type InfusionStepStatus } from '@infusion/shared-types';

type Tx = Prisma.TransactionClient;

interface TransitionActor {
  actorType: 'user' | 'machine' | 'system';
  actorUserId?: string;
  actorMachineId?: string;
}

/**
 * Wraps the shared, exhaustively-unit-tested `assertStepTransition` (see
 * packages/shared-types/src/infusion.schema.ts) with the DB-transaction and
 * audit-trail side effects — this class never re-derives the transition
 * table itself. An invalid transition throws `InvalidStepTransitionError`,
 * which a global exception filter converts to a 409 with a machine-readable
 * code (see src/common/filters/invalid-step-transition.filter.ts).
 */
@Injectable()
export class InfusionStepStateMachineService {
  async transition(
    tx: Tx,
    step: { id: string; status: string },
    toStatus: InfusionStepStatus,
    actor: TransitionActor,
    extraData: Record<string, unknown> = {},
    reason?: string,
  ) {
    const fromStatus = step.status as InfusionStepStatus;
    assertStepTransition(fromStatus, toStatus);
    return this.applyTransition(tx, step.id, fromStatus, toStatus, actor, extraData, reason);
  }

  /**
   * Machine-reported status — skips assertStepTransition deliberately. An
   * offline machine may legitimately report DRAFT -> COMPLETED in one shot
   * (it ran the whole thing while disconnected); the server's job here is
   * to record what happened, not gate it — "machine is always correct" (see
   * the plan's M7 section). Writes the exact same step-update + event-write
   * shape as transition() so the audit trail looks identical either way.
   */
  async recordMachineReport(
    tx: Tx,
    step: { id: string; status: string },
    toStatus: InfusionStepStatus,
    machineId: string,
    extraData: Record<string, unknown> = {},
    reason?: string,
  ) {
    const fromStatus = step.status as InfusionStepStatus;
    return this.applyTransition(tx, step.id, fromStatus, toStatus, { actorType: 'machine', actorMachineId: machineId }, extraData, reason);
  }

  private async applyTransition(
    tx: Tx,
    stepId: string,
    fromStatus: InfusionStepStatus,
    toStatus: InfusionStepStatus,
    actor: TransitionActor,
    extraData: Record<string, unknown>,
    reason?: string,
  ) {
    const updated = await tx.infusionStep.update({
      where: { id: stepId },
      data: { status: toStatus, ...extraData },
    });

    await tx.infusionStepEvent.create({
      data: {
        stepId,
        fromStatus,
        toStatus,
        actorType: actor.actorType,
        actorUserId: actor.actorUserId,
        actorMachineId: actor.actorMachineId,
        reason,
      },
    });

    return updated;
  }
}
