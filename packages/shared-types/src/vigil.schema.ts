import { z } from 'zod';

/**
 * Vigil critical-care monitoring (ECMO): the contract between the API's
 * VigilModule and the web central station. Design: docs/vigil/ (plan,
 * ADR-004/005/006). The engine itself lives in packages/vigil.
 *
 * Vigil is a SECONDARY alarm display: the bedside devices' own alarms stay
 * primary. Rule thresholds are placeholders pending clinical sign-off.
 */

/** IEC 60601-1-8 alarm priorities, highest first. */
export const VIGIL_PRIORITIES = ['HIGH', 'MEDIUM', 'LOW', 'ADVISORY'] as const;
export type VigilPriority = (typeof VIGIL_PRIORITIES)[number];

export const VIGIL_ALERT_STATES = ['ACTIVE', 'ACKNOWLEDGED', 'ESCALATED', 'RESOLVED', 'DISMISSED'] as const;
export type VigilAlertStateName = (typeof VIGIL_ALERT_STATES)[number];

/** Where a rule runs: the safety floor (Class C functions only) or the full core rule set. */
export const VIGIL_PLACEMENTS = ['safety_floor', 'core'] as const;
export type VigilPlacement = (typeof VIGIL_PLACEMENTS)[number];

/** TEST = simulated patient scenarios; LIVE = real ECMO machines only (ADR-005). */
export const VIGIL_MODES = ['test', 'live'] as const;
export type VigilMode = (typeof VIGIL_MODES)[number];

/** Simulated seconds per wall second offered by the TEST-mode controller. */
export const VIGIL_SPEEDS = [1, 10, 60, 300, 600] as const;
/** Chart windows in seconds: 15 min, 30 min, 1 h, 6 h. */
export const VIGIL_WINDOWS = [900, 1800, 3600, 21600] as const;
export const VIGIL_DEFAULT_WINDOW = 1800;

/** Plan §3.1: a stream gap over 5 s greys the tile and says "no live data". */
export const VIGIL_STALE_S = 5;
/** Samples below this signal-quality index are drawn hollow and ignored by trend rules. */
export const VIGIL_GOOD_SQI = 0.8;

export const VIGIL_MACHINE_STATUSES = ['ok', 'waiting', 'no_data', 'unconfirmed', 'unassociated'] as const;
export type VigilMachineStatus = (typeof VIGIL_MACHINE_STATUSES)[number];

/** [time (s), value (canonical unit), signal quality 0..1] */
export type VigilPoint = [number, number, number];

export interface VigilSignalState {
  code: string;
  label: string;
  unit: string;
  kind: 'numeric' | 'setting' | 'lab';
  value: number;
  t: number;
  age: number;
  sqi: number;
  flags: string[];
  changedAt: number;
  points: VigilPoint[];
}

export interface VigilMachineState {
  deviceId: string;
  /** Registered fleet machine id (LIVE mode); null for simulated devices. */
  machineId: string | null;
  driver: string;
  kind: string;
  status: VigilMachineStatus;
  /** Seconds since the last sample, null if never seen. */
  age: number | null;
  unmapped: number;
  encounterId: string | null;
  patientLabel: string | null;
  associationId: string | null;
  therapy: string | null;
  therapyDetail: string;
  confirmedBy: string;
  alertPriority: VigilPriority | null;
  signals: VigilSignalState[];
}

export interface VigilAlertView {
  /** Short id shown on screen (last 8 hex digits of the UUIDv7). */
  id: string;
  alertId: string;
  priority: VigilPriority;
  state: VigilAlertStateName;
  rule: string;
  version: string;
  placement: VigilPlacement;
  encounter: string;
  patientLabel: string | null;
  explanation: string;
  raised: number;
  acknowledgedBy: string;
  testMode: boolean;
}

export interface VigilLogEntry {
  kind: 'raised' | 'resolved' | 'acknowledged';
  at: number;
  id: string;
  priority: VigilPriority;
  rule: string;
  encounter: string;
  explanation: string;
  by: string;
}

export interface VigilRuleInfo {
  key: string;
  priority: VigilPriority;
  placement: VigilPlacement;
  owner: string;
  tests: number;
}

export interface VigilScenarioInfo {
  name: string;
  description: string;
  duration: number;
  annotations: { at: number; label: string }[];
}

export interface VigilControllerState {
  scenario: string;
  speed: number;
  speeds: number[];
  scenarios: string[];
  error: string;
  running: boolean;
}

export type VigilState =
  | {
      ready: false;
      mode: VigilMode;
      controller: VigilControllerState | null;
      windows: number[];
      /** Why Vigil is not running (e.g. incomplete LIVE configuration); empty while starting. */
      error: string;
    }
  | {
      ready: true;
      runId: number;
      mode: VigilMode;
      tenantId: string;
      unitId: string;
      nodeId: string;
      /** Seconds: since scenario start (TEST) or Unix epoch (LIVE). */
      now: number;
      simulatedClock: boolean;
      window: number;
      windows: number[];
      scenario: VigilScenarioInfo | null;
      finished: boolean;
      stopped: boolean;
      /**
       * Server-side part of the operating level (0 full, 1 degraded, 2 safety
       * floor only). Level 3 (screen cut off from the server) is set by the
       * browser itself when polling fails for more than VIGIL_STALE_S.
       */
      operatingLevel: 0 | 1 | 2;
      operatingReasons: string[];
      rules: VigilRuleInfo[];
      alerts: VigilAlertView[];
      log: VigilLogEntry[];
      machines: VigilMachineState[];
      stats: { observations: number; flush: number; driverFaults: number };
      controller: VigilControllerState | null;
    };

export interface VigilAuditVerifyResult {
  mode: VigilMode;
  ok: boolean;
  count: number;
  error: string;
}

export const vigilStateQuerySchema = z.object({
  window: z.coerce
    .number()
    .refine((w) => (VIGIL_WINDOWS as readonly number[]).includes(w), 'Unsupported chart window')
    .default(VIGIL_DEFAULT_WINDOW),
});
export type VigilStateQuery = z.infer<typeof vigilStateQuerySchema>;

const speedSchema = z.coerce
  .number()
  .refine((s) => (VIGIL_SPEEDS as readonly number[]).includes(s), `Speed must be one of ${VIGIL_SPEEDS.join(', ')}`);

export const vigilRunSchema = z.object({
  scenario: z.string().min(1).max(100).optional(),
  speed: speedSchema.optional(),
});
export type VigilRunInput = z.infer<typeof vigilRunSchema>;

export const vigilSpeedSchema = z.object({ speed: speedSchema });
export type VigilSpeedInput = z.infer<typeof vigilSpeedSchema>;

/**
 * LIVE-mode device data from a registered ECMO machine (machine credential
 * auth, same as /sync/push). Each frame is one HL7 v2 ORU^R01 message (IHE
 * PCD-01). Every sample in the push is attributed to the authenticated
 * machine, whatever device id the message itself carries, so one machine can
 * never report data into another machine's patient.
 */
export const VIGIL_INGEST_DRIVERS = ['hl7_pcd01'] as const;
export const vigilIngestSchema = z.object({
  driver: z.enum(VIGIL_INGEST_DRIVERS),
  frames: z.array(z.string().min(1).max(65_536)).min(1).max(200),
});
export type VigilIngestInput = z.infer<typeof vigilIngestSchema>;

export interface VigilIngestResult {
  accepted: number;
  rejected: number;
  /** One HL7 ACK per frame (MSA|AA or MSA|AE), in order. */
  acks: string[];
}
