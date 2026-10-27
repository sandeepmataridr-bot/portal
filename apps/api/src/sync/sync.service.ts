import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type {
  SyncEntityType,
  SyncOutboxStatus,
  SyncPullRequest,
  SyncPullResponse,
  SyncPushRequest,
  SyncPushResponse,
  SyncReport,
  SyncReportResult,
} from '@infusion/shared-types';
import { REALTIME_EVENTS } from '@infusion/shared-types';
import { PrismaService } from '../prisma/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import { PatientsService } from '../patients/patients.service.js';
import { InfusionsService } from '../infusions/infusions.service.js';
import { InfusionStepStateMachineService } from '../infusions/infusion-step-state-machine.service.js';
import { DoctorsService } from '../doctors/doctors.service.js';
import { SyncGateway } from './sync.gateway.js';

@Injectable()
export class SyncService {
  private readonly logger = new Logger(SyncService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly patients: PatientsService,
    private readonly infusions: InfusionsService,
    private readonly stateMachine: InfusionStepStateMachineService,
    private readonly doctors: DoctorsService,
    private readonly gateway: SyncGateway,
  ) {}

  async pull(authenticatedMachineId: string, input: SyncPullRequest): Promise<SyncPullResponse> {
    if (input.machineId !== authenticatedMachineId) {
      throw new ForbiddenException('machineId does not match the authenticated machine');
    }

    const entries = await this.prisma.syncOutboxEntry.findMany({
      where: { machineId: authenticatedMachineId, version: { gt: input.sinceVersion } },
      orderBy: { version: 'asc' },
    });

    const pendingIds = entries.filter((e) => e.status === 'pending').map((e) => e.id);
    if (pendingIds.length > 0) {
      await this.prisma.syncOutboxEntry.updateMany({
        where: { id: { in: pendingIds } },
        data: { status: 'delivered', deliveredAt: new Date() },
      });
    }

    const latestVersion = entries.length > 0 ? entries[entries.length - 1].version : input.sinceVersion;
    const doctors = await this.doctors.listForSyncPull();

    return {
      proposals: entries.map((e) => ({
        id: e.id,
        machineId: e.machineId,
        entityType: e.entityType as SyncEntityType,
        entityId: e.entityId,
        version: e.version,
        payload: e.payload as Record<string, unknown>,
        status: (pendingIds.includes(e.id) ? 'delivered' : e.status) as SyncOutboxStatus,
        createdAt: e.createdAt.toISOString(),
      })),
      latestVersion,
      doctors,
    };
  }

  async push(authenticatedMachineId: string, input: SyncPushRequest): Promise<SyncPushResponse> {
    if (input.machineId !== authenticatedMachineId) {
      throw new ForbiddenException('machineId does not match the authenticated machine');
    }

    const machine = await this.prisma.machine.findUnique({ where: { id: authenticatedMachineId } });
    if (!machine) throw new NotFoundException('Machine not found');
    const actor = { machineId: machine.id, machineCode: machine.machineCode };

    const results: SyncReportResult[] = [];

    // Each report gets its own transaction + try/catch — one bad report in
    // a batch must never abort or roll back the others (a real pre-existing
    // bug fixed here too: the old loop had no per-report isolation at all).
    for (const report of input.reports) {
      try {
        if (report.outcome === 'rejected' && !report.reason) {
          throw new BadRequestException('A reason is required when a report outcome is "rejected"');
        }

        await this.prisma.$transaction(async (tx) => {
          await tx.syncInboxLog.create({
            data: {
              machineId: authenticatedMachineId,
              proposalId: report.proposalId,
              entityType: report.entityType,
              entityId: report.entityId,
              outcome: report.outcome,
              reason: report.reason,
              payload: report.payload as Prisma.InputJsonValue | undefined,
              occurredAt: new Date(report.occurredAt),
            },
          });

          if (report.proposalId) {
            await this.handleProposalAck(tx, report, actor.machineId);
          } else if (report.outcome === 'reported') {
            await this.handleMachineOriginatedReport(tx, report, actor);
          }
        });

        results.push({ entityType: report.entityType, entityId: report.entityId, status: 'ok' });
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        this.logger.warn(`Report failed for machine ${authenticatedMachineId} (${report.entityType}/${report.entityId}): ${message}`);
        results.push({ entityType: report.entityType, entityId: report.entityId, status: 'error', message });
      }
    }

    return { received: input.reports.length, results };
  }

  /** accepted/rejected/modified — a response to something the server proposed. Unchanged behavior from before M7. */
  private async handleProposalAck(tx: Prisma.TransactionClient, report: SyncReport, machineId: string) {
    await tx.syncOutboxEntry.updateMany({
      where: { id: report.proposalId },
      data: { status: report.outcome === 'accepted' ? 'acked' : 'rejected', resolvedAt: new Date() },
    });

    // Reflect the machine's decision onto the entity's own syncStatus —
    // never re-derived or overridden server-side, just recorded.
    const newSyncStatus = report.outcome === 'accepted' ? 'accepted' : 'rejected';
    if (report.entityType === 'patient') {
      await tx.patientMachineAssignment.updateMany({ where: { id: report.entityId }, data: { syncStatus: newSyncStatus } });
    } else if (report.entityType === 'infusion_step') {
      await tx.infusionStep.updateMany({ where: { id: report.entityId }, data: { syncStatus: newSyncStatus } });
    }

    await this.audit.log({
      actorType: 'machine',
      actorMachineId: machineId,
      action: `SYNC_REPORT_${report.outcome.toUpperCase()}`,
      entityTable: report.entityType,
      entityId: report.entityId,
    });
  }

  /**
   * outcome:'reported', no proposalId — machine-originated, "this simply
   * exists/happened." Never gated: the machine already decided and (for
   * everything except telemetry) already ran it — the server's job is to
   * record and reflect it accurately, not re-litigate it. See the plan's M7
   * section for the full reasoning.
   */
  private async handleMachineOriginatedReport(
    tx: Prisma.TransactionClient,
    report: SyncReport,
    actor: { machineId: string; machineCode: string },
  ) {
    const payload = (report.payload ?? {}) as Record<string, unknown>;

    switch (report.entityType) {
      case 'patient': {
        // A discharge report reuses entityType:'patient' with an action
        // marker, distinguishing it from a brand-new patient create — see
        // the open naming question in the plan.
        if (payload.action === 'DISCHARGE') {
          await this.patients.dischargeFromMachine(tx, report.entityId, actor);
        } else {
          await this.patients.registerFromMachine(tx, report.entityId, payload, actor);
        }
        break;
      }
      case 'infusion_order': {
        const steps = Array.isArray(payload.steps) ? (payload.steps as Array<Record<string, unknown>>) : [];
        await this.infusions.createOrderFromMachine(
          tx,
          report.entityId,
          {
            patientId: String(payload.patientId ?? ''),
            clinicalNotes: typeof payload.clinicalNotes === 'string' ? payload.clinicalNotes : undefined,
            steps: steps.map((s) => ({
              id: String(s.id ?? ''),
              stepNumber: Number(s.stepNumber ?? 0),
              medicineId: typeof s.medicineId === 'string' ? s.medicineId : undefined,
              medicineName: typeof s.medicineName === 'string' ? s.medicineName : undefined,
              concentrationRaw: typeof s.concentrationRaw === 'string' ? s.concentrationRaw : undefined,
              plannedVolumeMl: Number(s.plannedVolumeMl ?? 0),
              plannedRateMlPerH: Number(s.plannedRateMlPerH ?? 0),
              status: typeof s.status === 'string' ? s.status : undefined,
            })),
          },
          actor,
        );
        break;
      }
      case 'infusion_step': {
        // A status update to a step that already exists (bedside-created
        // above, or previously staff-proposed) — the fix for the original
        // silent no-op this whole section replaces.
        const step = await tx.infusionStep.findUnique({ where: { id: report.entityId } });
        if (!step) {
          throw new NotFoundException(`Unknown step ${report.entityId} — send its parent infusion_order report first`);
        }
        const toStatus = typeof payload.status === 'string' ? payload.status : undefined;
        if (toStatus && toStatus !== step.status) {
          const extraData: Record<string, unknown> = {};
          if (toStatus === 'RUNNING') extraData.startedAt = new Date();
          if (toStatus === 'COMPLETED') extraData.completedAt = new Date();
          await this.stateMachine.recordMachineReport(tx, step, toStatus as never, actor.machineId, extraData);
        }
        break;
      }
      case 'infusion_live_status': {
        const patientId = typeof payload.patientId === 'string' ? payload.patientId : undefined;
        if (!patientId) throw new BadRequestException('infusion_live_status report requires patientId');
        const data = {
          patientId,
          stepId: typeof payload.stepId === 'string' ? payload.stepId : null,
          currentMedicineName: typeof payload.currentMedicineName === 'string' ? payload.currentMedicineName : null,
          remainingVolumeMl: Number(payload.remainingVolumeMl ?? 0),
          dispensedVolumeMl: Number(payload.dispensedVolumeMl ?? 0),
          flowRateMlPerH: Number(payload.flowRateMlPerH ?? 0),
          infusedTimeMin: Number(payload.infusedTimeMin ?? 0),
          pumpState: (typeof payload.pumpState === 'string' ? payload.pumpState : 'STOPPED') as 'RUNNING' | 'PAUSED' | 'STOPPED',
          workingMode: typeof payload.workingMode === 'string' ? payload.workingMode : null,
          workingStatusRaw: typeof payload.workingStatusRaw === 'string' ? payload.workingStatusRaw : null,
          pauseTimeSec: typeof payload.pauseTimeSec === 'number' ? payload.pauseTimeSec : null,
        };
        const saved = await tx.infusionLiveStatus.upsert({
          where: { machineId: actor.machineId },
          create: { machineId: actor.machineId, ...data, lastUpdateAt: new Date() },
          update: { ...data, lastUpdateAt: new Date() },
        });
        // Permanent append-only record, separate from the current-snapshot
        // row above — see InfusionTelemetryLog's schema comment.
        await tx.infusionTelemetryLog.create({
          data: {
            machineId: actor.machineId,
            stepId: data.stepId,
            flowRateMlPerH: data.flowRateMlPerH,
            dispensedVolumeMl: data.dispensedVolumeMl,
            remainingVolumeMl: data.remainingVolumeMl,
            pumpState: data.pumpState,
            workingMode: data.workingMode,
            workingStatusRaw: data.workingStatusRaw,
            pauseTimeSec: data.pauseTimeSec,
            recordedAt: new Date(report.occurredAt),
          },
        });
        // Live push to any staff dashboard watching this machine — REST
        // pull/push above already recorded it regardless, this is purely a
        // latency optimization, never the only delivery path. The saved row, so the
        // page gets the same fields as GET live-status (lastUpdateAt included).
        this.gateway.broadcastToDashboard(REALTIME_EVENTS.infusionLiveStatusUpdated, saved);
        break;
      }
      case 'doctor': {
        await this.doctors.createTemporaryFromMachine(tx, report.entityId, payload, actor);
        break;
      }
      case 'medicine':
        // Machines never originate a new Medicine — the catalog is
        // staff/pharmacy-authored only. Nothing to do here; reported for
        // completeness but not a real machine-creatable entity type.
        break;
    }
  }
}
