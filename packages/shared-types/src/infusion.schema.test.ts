import { describe, it, expect } from 'vitest';
import {
  isValidStepTransition,
  assertStepTransition,
  InvalidStepTransitionError,
  checkInfusionCaps,
  INFUSION_STEP_STATUSES,
  type InfusionStepStatus,
} from './infusion.schema.js';

describe('infusion step state machine', () => {
  const allPairs: [InfusionStepStatus, InfusionStepStatus][] = INFUSION_STEP_STATUSES.flatMap((from) =>
    INFUSION_STEP_STATUSES.map((to): [InfusionStepStatus, InfusionStepStatus] => [from, to]),
  );

  it('allows every transition explicitly listed in the table', () => {
    expect(isValidStepTransition('DRAFT', 'PENDING_PHARMACY_VERIFICATION')).toBe(true);
    expect(isValidStepTransition('PENDING_PHARMACY_VERIFICATION', 'PHARMACY_VERIFIED')).toBe(true);
    expect(isValidStepTransition('PHARMACY_VERIFIED', 'PENDING_SECOND_CONFIRMATION')).toBe(true);
    expect(isValidStepTransition('PHARMACY_VERIFIED', 'READY')).toBe(true);
    expect(isValidStepTransition('PENDING_SECOND_CONFIRMATION', 'READY')).toBe(true);
    expect(isValidStepTransition('READY', 'RUNNING')).toBe(true);
    expect(isValidStepTransition('RUNNING', 'PAUSED')).toBe(true);
    expect(isValidStepTransition('PAUSED', 'RUNNING')).toBe(true);
    expect(isValidStepTransition('RUNNING', 'COMPLETED')).toBe(true);
  });

  it('rejects every transition that skips a required step', () => {
    expect(isValidStepTransition('DRAFT', 'READY')).toBe(false);
    expect(isValidStepTransition('DRAFT', 'RUNNING')).toBe(false);
    expect(isValidStepTransition('PENDING_PHARMACY_VERIFICATION', 'RUNNING')).toBe(false);
    expect(isValidStepTransition('PHARMACY_VERIFIED', 'COMPLETED')).toBe(false);
  });

  it('never allows a transition out of a terminal state', () => {
    for (const terminal of ['COMPLETED', 'REJECTED', 'CANCELLED', 'OVERRIDDEN'] as const) {
      for (const to of INFUSION_STEP_STATUSES) {
        expect(isValidStepTransition(terminal, to)).toBe(false);
      }
    }
  });

  it('exhaustively agrees with assertStepTransition for every possible pair', () => {
    for (const [from, to] of allPairs) {
      if (isValidStepTransition(from, to)) {
        expect(() => assertStepTransition(from, to)).not.toThrow();
      } else {
        expect(() => assertStepTransition(from, to)).toThrow(InvalidStepTransitionError);
      }
    }
  });
});

describe('infusion dosage/rate capping', () => {
  const caps = { maxFlowRateMlPerH: 100, maxSingleDoseMl: 500, absoluteMaxFlowRateMlPerH: 150 };

  it('passes a request within all caps', () => {
    const result = checkInfusionCaps(caps, { volumeMl: 200, rateMlPerH: 80 });
    expect(result).toEqual({ ok: true, hardBlocked: false, violations: [] });
  });

  it('flags exceeding the soft flow-rate cap as overridable', () => {
    const result = checkInfusionCaps(caps, { volumeMl: 200, rateMlPerH: 120 });
    expect(result.ok).toBe(false);
    expect(result.hardBlocked).toBe(false);
    expect(result.violations[0]).toMatch(/exceeds the configured maximum/);
  });

  it('flags exceeding the absolute ceiling as hard-blocked, never overridable', () => {
    const result = checkInfusionCaps(caps, { volumeMl: 200, rateMlPerH: 200 });
    expect(result.ok).toBe(false);
    expect(result.hardBlocked).toBe(true);
    expect(result.violations[0]).toMatch(/exceeds the absolute maximum/);
  });

  it('flags exceeding the max single dose', () => {
    const result = checkInfusionCaps(caps, { volumeMl: 600, rateMlPerH: 50 });
    expect(result.ok).toBe(false);
    expect(result.violations.some((v) => v.includes('maximum single dose'))).toBe(true);
  });

  it('treats null caps as "no limit configured", never as zero', () => {
    const noCaps = { maxFlowRateMlPerH: null, maxSingleDoseMl: null, absoluteMaxFlowRateMlPerH: null };
    const result = checkInfusionCaps(noCaps, { volumeMl: 100000, rateMlPerH: 100000 });
    expect(result.ok).toBe(true);
  });
});
