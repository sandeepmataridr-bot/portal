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

    const updated = await tx.infusionStep.update({
      where: { id: step.id },
      data: { status: toStatus, ...extraData },
    });

    await tx.infusionStepEvent.create({
      data: {
        stepId: step.id,
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
