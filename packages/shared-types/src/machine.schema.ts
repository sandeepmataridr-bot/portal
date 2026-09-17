import { z } from 'zod';

/**
 * Every machine type the fleet can register, plus whether the sync channel
 * with it is bidirectional or receive-only:
 *
 * - INFUSION_PUMP is interactive/bidirectional — the server queues proposals
 *   in `sync_outbox` (new patient, new order, ...) that the machine pulls and
 *   accepts/rejects, exactly as described in docs/sync-contract.md.
 * - ECMO and EBOO are unidirectional — they only ever push telemetry/reports
 *   to the server (`sync_inbox_log`, with no `proposalId`). The server never
 *   queues anything in `sync_outbox` for them; there is no proposal/ack round
 *   trip because these devices are operated directly at the bedside, not
 *   remotely commanded. `PatientMachineAssignment.syncStatus` is therefore
 *   only meaningful for bidirectional types — for unidirectional ones, an
 *   assignment is just server-side bookkeeping (which patient this incoming
 *   telemetry belongs to) and is treated as immediately `accepted`, since
 *   there's no device round-trip to wait for.
 *
 * ECMO/EBOO have no dedicated order/step/live-status tables yet — this is
 * the "framework now, specifics later" placeholder; their own domain
 * modules (mirroring InfusionModule) get built once their clinical
 * parameters are defined.
 */
export const MACHINE_TYPES = ['INFUSION_PUMP', 'ECMO', 'EBOO'] as const;
export type MachineType = (typeof MACHINE_TYPES)[number];

export const MACHINE_TYPE_DIRECTIONALITY: Record<MachineType, 'bidirectional' | 'unidirectional'> = {
  INFUSION_PUMP: 'bidirectional',
  ECMO: 'unidirectional',
  EBOO: 'unidirectional',
};

export function isBidirectionalMachineType(type: MachineType): boolean {
  return MACHINE_TYPE_DIRECTIONALITY[type] === 'bidirectional';
}

export const createMachineSchema = z.object({
  machineCode: z.string().min(1, 'Machine code is required'),
  machineType: z.enum(MACHINE_TYPES),
  location: z.string().max(200).optional(),
});
export type CreateMachineInput = z.infer<typeof createMachineSchema>;

export const machineConnectionStatusSchema = z.enum(['online', 'offline']);
export type MachineConnectionStatus = z.infer<typeof machineConnectionStatusSchema>;

export const machineSchema = z.object({
  id: z.string().uuid(),
  machineType: z.enum(MACHINE_TYPES),
  machineCode: z.string().min(1),
  location: z.string().optional(),
  status: machineConnectionStatusSchema,
  lastSeenAt: z.string().datetime().nullable(),
  assignedPatientId: z.string().uuid().nullable(),
});
export type MachineSummary = z.infer<typeof machineSchema>;

/** What the dashboard shows fleet-wide — the "N total / M connected" view. */
export const fleetStatusSchema = z.object({
  totalMachines: z.number().int().nonnegative(),
  connectedMachines: z.number().int().nonnegative(),
  machines: z.array(machineSchema),
});
export type FleetStatus = z.infer<typeof fleetStatusSchema>;

export const liveInfusionStatusSchema = z.object({
  machineId: z.string().uuid(),
  patientId: z.string().uuid(),
  stepId: z.string().uuid().nullable(),
  currentMedicineName: z.string().nullable(),
  remainingVolumeMl: z.number().nonnegative(),
  dispensedVolumeMl: z.number().nonnegative(),
  flowRateMlPerH: z.number().nonnegative(),
  infusedTimeMin: z.number().nonnegative(),
  pumpState: z.enum(['RUNNING', 'PAUSED', 'STOPPED']),
  lastUpdateAt: z.string().datetime(),
});
export type LiveInfusionStatus = z.infer<typeof liveInfusionStatusSchema>;
