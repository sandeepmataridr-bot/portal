import { z } from 'zod';

/**
 * The infusion step state machine from the approved plan's "Clinical Safety
 * Interlock Design" section:
 *
 *   DRAFT -> PENDING_PHARMACY_VERIFICATION -> PHARMACY_VERIFIED
 *         -> [if high_alert] PENDING_SECOND_CONFIRMATION -> READY
 *         -> RUNNING <-> PAUSED -> COMPLETED
 *   (+ REJECTED / CANCELLED / OVERRIDDEN from applicable pre-RUNNING states)
 *
 * This file is the single source of truth for valid transitions. The NestJS
 * InfusionStepStateMachine service wraps `isValidStepTransition` with the
 * DB-transaction + audit-log side effects; the React UI uses the same
 * function to enable/disable action buttons instead of guessing client-side
 * rules. Neither side re-derives the transition table.
 */
export const INFUSION_STEP_STATUSES = [
  'DRAFT',
  'PENDING_PHARMACY_VERIFICATION',
  'PHARMACY_VERIFIED',
  'PENDING_SECOND_CONFIRMATION',
  'READY',
  'RUNNING',
  'PAUSED',
  'COMPLETED',
  'REJECTED',
  'CANCELLED',
  'OVERRIDDEN',
] as const;
export type InfusionStepStatus = (typeof INFUSION_STEP_STATUSES)[number];

export const INFUSION_STEP_TRANSITIONS: Record<InfusionStepStatus, readonly InfusionStepStatus[]> = {
  DRAFT: ['PENDING_PHARMACY_VERIFICATION', 'CANCELLED'],
  PENDING_PHARMACY_VERIFICATION: ['PHARMACY_VERIFIED', 'REJECTED', 'CANCELLED'],
  PHARMACY_VERIFIED: ['PENDING_SECOND_CONFIRMATION', 'READY', 'REJECTED', 'CANCELLED'],
  PENDING_SECOND_CONFIRMATION: ['READY', 'REJECTED', 'CANCELLED'],
  READY: ['RUNNING', 'CANCELLED', 'OVERRIDDEN'],
  RUNNING: ['PAUSED', 'COMPLETED', 'OVERRIDDEN'],
  PAUSED: ['RUNNING', 'COMPLETED', 'OVERRIDDEN'],
  COMPLETED: [],
  REJECTED: [],
  CANCELLED: [],
  OVERRIDDEN: [],
};

export function isValidStepTransition(from: InfusionStepStatus, to: InfusionStepStatus): boolean {
  return INFUSION_STEP_TRANSITIONS[from]?.includes(to) ?? false;
}

export class InvalidStepTransitionError extends Error {
  readonly code = 'STEP_TRANSITION_INVALID';
  readonly from: InfusionStepStatus;
  readonly to: InfusionStepStatus;

  constructor(from: InfusionStepStatus, to: InfusionStepStatus) {
    super(`Cannot transition infusion step from ${from} to ${to}`);
    this.from = from;
    this.to = to;
  }
}

export function assertStepTransition(from: InfusionStepStatus, to: InfusionStepStatus): void {
  if (!isValidStepTransition(from, to)) {
    throw new InvalidStepTransitionError(from, to);
  }
}

/**
 * Dosage/rate capping — defense in depth per the plan's "Dosage/Rate Capping
 * Design" section. Hard reject by default; no silent clamping. Both server
 * pre-proposal validation and the React form call this with the same numbers
 * (sourced from the medicine record), so they can never drift apart.
 */
export interface MedicineCaps {
  maxFlowRateMlPerH: number | null;
  maxSingleDoseMl: number | null;
  /** Non-overridable — never bypassable even via the override flow. */
  absoluteMaxFlowRateMlPerH: number | null;
}

export interface RequestedDose {
  volumeMl: number;
  rateMlPerH: number;
}

export interface CapCheckResult {
  ok: boolean;
  /** True only when the absolute ceiling was hit — this can never be overridden. */
  hardBlocked: boolean;
  violations: string[];
}

export function checkInfusionCaps(caps: MedicineCaps, requested: RequestedDose): CapCheckResult {
  const violations: string[] = [];
  let hardBlocked = false;

  if (caps.absoluteMaxFlowRateMlPerH != null && requested.rateMlPerH > caps.absoluteMaxFlowRateMlPerH) {
    violations.push(
      `Flow rate ${requested.rateMlPerH} ml/h exceeds the absolute maximum of ${caps.absoluteMaxFlowRateMlPerH} ml/h`,
    );
    hardBlocked = true;
  } else if (caps.maxFlowRateMlPerH != null && requested.rateMlPerH > caps.maxFlowRateMlPerH) {
    violations.push(
      `Flow rate ${requested.rateMlPerH} ml/h exceeds the configured maximum of ${caps.maxFlowRateMlPerH} ml/h (override requires a doctor-justified reason)`,
    );
  }

  if (caps.maxSingleDoseMl != null && requested.volumeMl > caps.maxSingleDoseMl) {
    violations.push(
      `Volume ${requested.volumeMl} ml exceeds the configured maximum single dose of ${caps.maxSingleDoseMl} ml (override requires a doctor-justified reason)`,
    );
  }

  return { ok: violations.length === 0, hardBlocked, violations };
}

export const infusionStepInputSchema = z.object({
  stepNumber: z.number().int().positive(),
  medicineId: z.string().uuid(),
  rackNo: z.number().int().positive().optional(),
  channelNo: z.number().int().positive().optional(),
  plannedVolumeMl: z.number().positive(),
  plannedRateMlPerH: z.number().positive(),
});
export type InfusionStepInput = z.infer<typeof infusionStepInputSchema>;

export const createInfusionOrderSchema = z.object({
  patientId: z.string().uuid(),
  machineId: z.string().uuid(),
  clinicalNotes: z.string().max(2000).optional(),
  steps: z.array(infusionStepInputSchema).min(1, 'An order needs at least one step'),
});
export type CreateInfusionOrderInput = z.infer<typeof createInfusionOrderSchema>;

// stepId is intentionally NOT part of these schemas — it comes from the URL
// path param on every route that uses them (e.g. POST
// /infusion-steps/:id/verify), never duplicated into the body.
export const verifyPharmacyDispenseSchema = z.object({
  dispensedMedicineId: z.string().uuid(),
  dispensedVolumeMl: z.number().positive(),
});
export type VerifyPharmacyDispenseInput = z.infer<typeof verifyPharmacyDispenseSchema> & { stepId: string };

export const overrideStepSchema = z.object({
  targetStatus: z.enum(['RUNNING', 'CANCELLED']),
  reason: z.string().min(10, 'An override requires a specific, written justification'),
});
export type OverrideStepInput = z.infer<typeof overrideStepSchema> & { stepId: string };

export const rejectStepSchema = z.object({
  reason: z.string().min(3, 'A reason is required'),
});
export type RejectStepInput = z.infer<typeof rejectStepSchema>;

/**
 * Super-user remote commands — the one deliberate, narrow exception to
 * "machine always decides" (plan § "Super-user remote commands"). A free
 * string on the Prisma model itself (matching Machine.machineType's own
 * reasoning: ECMO/EBOO will define their own vocabularies later without a
 * migration), but this app only ever accepts this fixed set today, gated to
 * machineType === 'INFUSION_PUMP' at the service layer.
 */
export const INFUSION_COMMAND_TYPES = ['PAUSE', 'RESUME', 'STOP', 'ADJUST_FLOW_RATE'] as const;
export type InfusionCommandType = (typeof INFUSION_COMMAND_TYPES)[number];

export const MACHINE_COMMAND_STATUSES = ['SENT', 'ACKNOWLEDGED', 'FAILED', 'TIMED_OUT'] as const;
export type MachineCommandStatus = (typeof MACHINE_COMMAND_STATUSES)[number];

// Password re-confirmation travels with the command itself, not a separate
// call — reuses the existing login password-verification path (no new
// mechanism), and makes an accidental click structurally impossible rather
// than just unlikely, matching the weight of directly affecting a running
// infusion.
export const sendMachineCommandSchema = z
  .object({
    commandType: z.enum(INFUSION_COMMAND_TYPES),
    flowRateMlPerH: z.number().positive().optional(),
    password: z.string().min(1, 'Password confirmation is required'),
  })
  .refine((v) => v.commandType !== 'ADJUST_FLOW_RATE' || v.flowRateMlPerH != null, {
    message: 'flowRateMlPerH is required for ADJUST_FLOW_RATE',
    path: ['flowRateMlPerH'],
  });
export type SendMachineCommandInput = z.infer<typeof sendMachineCommandSchema>;

export interface MachineCommandSummary {
  id: string;
  machineId: string;
  commandType: string;
  payload: Record<string, unknown> | null;
  issuedById: string;
  issuedByLoginId: string;
  issuedAt: string;
  status: MachineCommandStatus;
  respondedAt: string | null;
  result: Record<string, unknown> | null;
}
