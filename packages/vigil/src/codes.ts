/**
 * Terminology tables: units, Vigil signal definitions, therapies.
 *
 * Signals use the VIGIL code system until a standard code (MDC / LOINC) exists
 * for the concept; ECMO circuit parameters mostly have none today.
 */

export const CODE_SYSTEM = 'VIGIL';

/** Rule-language unit symbol -> UCUM code. */
export const UNITS: Record<string, string> = {
  mmHg: 'mm[Hg]',
  kPa: 'kPa',
  'L/min': 'L/min',
  '%': '%',
};

export const TIME_UNITS: Record<string, number> = { ms: 0.001, s: 1.0, min: 60.0, h: 3600.0 };

const MMHG_PER_KPA = 7.500615758;
const CONVERSIONS: Record<string, (v: number) => number> = {
  'kPa>mm[Hg]': (v) => v * MMHG_PER_KPA,
  'mm[Hg]>kPa': (v) => v / MMHG_PER_KPA,
  'mL/min>L/min': (v) => v / 1000.0,
};

/** MDC dimension codes seen in HL7 PCD-01 OBX-6. */
export const MDC_DIM_TO_UCUM: Record<string, string> = {
  MDC_DIM_MMHG: 'mm[Hg]',
  MDC_DIM_KILO_PASCAL: 'kPa',
  MDC_DIM_L_PER_MIN: 'L/min',
  MDC_DIM_PERCENT: '%',
};

export class UnitConversionError extends Error {}

export function convert(value: number, fromUcum: string, toUcum: string): number {
  if (fromUcum === toUcum) return value;
  const fn = CONVERSIONS[`${fromUcum}>${toUcum}`];
  if (!fn) throw new UnitConversionError(`no conversion from '${fromUcum}' to '${toUcum}'`);
  return fn(value);
}

export enum SignalKind {
  /** periodic device measurement */
  NUMERIC = 'numeric',
  /** device setting chosen by a clinician */
  SETTING = 'setting',
  /** sporadic result, e.g. blood gas */
  LAB = 'lab',
}

export interface Signal {
  name: string;
  /** rule-language unit symbol, key of UNITS */
  unit: string;
  kind: SignalKind;
  /** outside this range the sample is an artifact */
  plausible: [number, number];
  description: string;
  /** jump size treated as flush/step artifact */
  stepArtifact: number | null;
  ucum: string;
}

function signal(
  name: string,
  unit: string,
  kind: SignalKind,
  plausible: [number, number],
  description: string,
  stepArtifact: number | null = null,
): Signal {
  return { name, unit, kind, plausible, description, stepArtifact, ucum: UNITS[unit] };
}

export const SIGNALS: Record<string, Signal> = Object.fromEntries(
  [
    signal('ECMO_BLOOD_FLOW', 'L/min', SignalKind.NUMERIC, [0.0, 10.0], 'ECMO circuit blood flow'),
    signal(
      'ECMO_OXY_DELTA_P',
      'mmHg',
      SignalKind.NUMERIC,
      [-20.0, 300.0],
      'Pressure drop across the oxygenator (pre minus post)',
      30.0,
    ),
    signal('ECMO_SWEEP_FLOW', 'L/min', SignalKind.SETTING, [0.0, 15.0], 'Sweep gas flow setting'),
    signal('BG_POST_OXY_PO2', 'mmHg', SignalKind.LAB, [0.0, 800.0], 'Post-oxygenator blood gas PO2'),
  ].map((s) => [s.name, s]),
);

export const THERAPIES = new Set(['ECMO', 'IABP']);
