import { z } from 'zod';

/**
 * The "server proposes, machine decides" sync contract. This is the source
 * for docs/sync-contract.md — the shape the future Android pump-controller
 * app must implement against. Sync is machine-initiated: a machine connects
 * (WebSocket when live, REST delta-sync poll otherwise), pulls everything
 * queued for it, and pushes back what it decided/did locally.
 */
export const SYNC_ENTITY_TYPES = ['patient', 'infusion_order', 'infusion_step', 'medicine'] as const;
export type SyncEntityType = (typeof SYNC_ENTITY_TYPES)[number];

export const SYNC_OUTBOX_STATUSES = ['pending', 'delivered', 'acked', 'rejected', 'superseded'] as const;
export type SyncOutboxStatus = (typeof SYNC_OUTBOX_STATUSES)[number];

/** One row of what the server has queued for a machine to pick up. */
export const syncProposalSchema = z.object({
  id: z.string().uuid(),
  machineId: z.string().uuid(),
  entityType: z.enum(SYNC_ENTITY_TYPES),
  entityId: z.string().uuid(),
  version: z.number().int().positive(),
  payload: z.record(z.string(), z.unknown()),
  status: z.enum(SYNC_OUTBOX_STATUSES),
  createdAt: z.string().datetime(),
});
export type SyncProposal = z.infer<typeof syncProposalSchema>;

/** What a machine pulls on connect: everything since its last acked version. */
export const syncPullRequestSchema = z.object({
  machineId: z.string().uuid(),
  sinceVersion: z.number().int().nonnegative().default(0),
});
export type SyncPullRequest = z.infer<typeof syncPullRequestSchema>;

export const syncPullResponseSchema = z.object({
  proposals: z.array(syncProposalSchema),
  latestVersion: z.number().int().nonnegative(),
});
export type SyncPullResponse = z.infer<typeof syncPullResponseSchema>;

/** What a machine reports back: acceptance/rejection of a proposal, or a locally-originated change. */
export const SYNC_REPORT_OUTCOMES = ['accepted', 'rejected', 'modified'] as const;
export type SyncReportOutcome = (typeof SYNC_REPORT_OUTCOMES)[number];

// machineId is intentionally NOT part of a single report — every report in a
// push shares the request's top-level machineId (the authenticated machine),
// never duplicated per-item (same reasoning as dropping stepId from the
// infusion-step endpoints' bodies).
export const syncReportSchema = z.object({
  proposalId: z.string().uuid().optional(), // absent for a machine-originated push not tied to a prior proposal
  entityType: z.enum(SYNC_ENTITY_TYPES),
  entityId: z.string().uuid(),
  outcome: z.enum(SYNC_REPORT_OUTCOMES),
  reason: z.string().optional(), // required by the API layer when outcome = 'rejected'
  payload: z.record(z.string(), z.unknown()).optional(), // the machine's resulting state, e.g. a completed step
  occurredAt: z.string().datetime(),
});
export type SyncReport = z.infer<typeof syncReportSchema>;

export const syncPushRequestSchema = z.object({
  machineId: z.string().uuid(),
  reports: z.array(syncReportSchema).min(1),
});
export type SyncPushRequest = z.infer<typeof syncPushRequestSchema>;

/** Realtime event names emitted over the WebSocket gateway (RealtimeModule). */
export const REALTIME_EVENTS = {
  infusionStepTransitioned: 'infusion_step.transitioned',
  infusionLiveStatusUpdated: 'infusion_live_status.updated',
  machineStatusChanged: 'machine.status_changed',
  syncProposalDelivered: 'sync_proposal.delivered',
  syncReportReceived: 'sync_report.received',
} as const;
export type RealtimeEventName = (typeof REALTIME_EVENTS)[keyof typeof REALTIME_EVENTS];
