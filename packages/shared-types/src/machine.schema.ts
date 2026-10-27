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
 * - SPO2_MONITOR, TEMP_MONITOR and PATIENT_MONITOR (multi-parameter: SpO₂,
 *   heart rate, NIBP, temperature, respiration) are unidirectional too.
 *
 * ECMO/EBOO have no dedicated order/step/live-status tables yet — this is
 * the "framework now, specifics later" placeholder; their own domain
 * modules (mirroring InfusionModule) get built once their clinical
 * parameters are defined.
 */
export const MACHINE_TYPES = ['INFUSION_PUMP', 'ECMO', 'EBOO', 'SPO2_MONITOR', 'TEMP_MONITOR', 'PATIENT_MONITOR'] as const;
export type MachineType = (typeof MACHINE_TYPES)[number];

export const MACHINE_TYPE_DIRECTIONALITY: Record<MachineType, 'bidirectional' | 'unidirectional'> = {
  INFUSION_PUMP: 'bidirectional',
  ECMO: 'unidirectional',
  EBOO: 'unidirectional',
  SPO2_MONITOR: 'unidirectional',
  TEMP_MONITOR: 'unidirectional',
  PATIENT_MONITOR: 'unidirectional',
};

/** Human names for the screen. */
export const MACHINE_TYPE_LABEL: Record<MachineType, string> = {
  INFUSION_PUMP: 'Infusion pump',
  ECMO: 'ECMO',
  EBOO: 'EBOO',
  SPO2_MONITOR: 'SpO₂ monitor',
  TEMP_MONITOR: 'Temperature monitor',
  PATIENT_MONITOR: 'Multi-parameter monitor',
};

/**
 * Types whose readings arrive as HL7 PCD-01 messages at POST /vigil/ingest
 * and are shown by Vigil (central station, patient monitor page).
 */
export const VIGIL_MACHINE_TYPES = ['ECMO', 'EBOO', 'SPO2_MONITOR', 'TEMP_MONITOR', 'PATIENT_MONITOR'] as const satisfies readonly MachineType[];
export type VigilMachineType = (typeof VIGIL_MACHINE_TYPES)[number];

export function isVigilMachineType(type: string): type is VigilMachineType {
  return (VIGIL_MACHINE_TYPES as readonly string[]).includes(type);
}

/** The Vigil therapy each type's data belongs to; therapy rules (ECMO …) run only on their own type. */
export const VIGIL_THERAPY: Record<VigilMachineType, string> = {
  ECMO: 'ECMO',
  EBOO: 'EBOO',
  SPO2_MONITOR: 'VITALS',
  TEMP_MONITOR: 'VITALS',
  PATIENT_MONITOR: 'VITALS',
};

export function isBidirectionalMachineType(type: MachineType): boolean {
  return MACHINE_TYPE_DIRECTIONALITY[type] === 'bidirectional';
}

export const createMachineSchema = z.object({
  machineCode: z.string().min(1, 'Machine code is required'),
  machineType: z.enum(MACHINE_TYPES),
  /** The room it stands in (from the admin's room list). */
  roomId: z.string().uuid('Choose a room'),
});
export type CreateMachineInput = z.infer<typeof createMachineSchema>;

export const machineConnectionStatusSchema = z.enum(['online', 'offline']);

/** A machine heard from within this many seconds counts as online on the fleet screen. */
export const MACHINE_SENDING_WINDOW_S = 30;
export type MachineConnectionStatus = z.infer<typeof machineConnectionStatusSchema>;

export const machineSchema = z.object({
  id: z.string().uuid(),
  machineType: z.enum(MACHINE_TYPES),
  machineCode: z.string().min(1),
  /** The room's name (kept for older screens). */
  location: z.string().optional(),
  room: z.object({ id: z.string().uuid(), name: z.string() }).nullable(),
  /** Live WebSocket connection (the infusion pump app). Remote commands need it. */
  status: machineConnectionStatusSchema,
  /** Last authenticated contact: WebSocket, sync request or monitoring data. */
  lastSeenAt: z.string().datetime().nullable(),
  /**
   * Online on the fleet screen: connected, or sent something within
   * MACHINE_SENDING_WINDOW_S. ECMO and the monitors send HL7 over plain
   * requests and never hold a connection, so `status` alone would always say offline.
   */
  sendingData: z.boolean(),
  assignedPatientId: z.string().uuid().nullable(),
  /** The assigned patient is in a different room (an assignment made before rooms were enforced). */
  roomMismatch: z.boolean(),
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
