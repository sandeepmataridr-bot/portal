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
  rpm: '{rpm}',
  degC: 'Cel',
  bar: 'bar',
  /** 0 = normal / off, 1 = active / on */
  flag: '{flag}',
  /** heart or pulse beats per minute */
  bpm: '{beats}/min',
  /** breaths per minute */
  brpm: '{breaths}/min',
};

export const TIME_UNITS: Record<string, number> = { ms: 0.001, s: 1.0, min: 60.0, h: 3600.0 };

const MMHG_PER_KPA = 7.500615758;
const CONVERSIONS: Record<string, (v: number) => number> = {
  'kPa>mm[Hg]': (v) => v * MMHG_PER_KPA,
  'mm[Hg]>kPa': (v) => v / MMHG_PER_KPA,
  'mL/min>L/min': (v) => v / 1000.0,
  // Monitors often send rates as plain "/min".
  '/min>{beats}/min': (v) => v,
  '/min>{breaths}/min': (v) => v,
  '[degF]>Cel': (v) => ((v - 32) * 5) / 9,
};

/** MDC dimension codes seen in HL7 PCD-01 OBX-6. */
export const MDC_DIM_TO_UCUM: Record<string, string> = {
  MDC_DIM_MMHG: 'mm[Hg]',
  MDC_DIM_KILO_PASCAL: 'kPa',
  MDC_DIM_L_PER_MIN: 'L/min',
  MDC_DIM_PERCENT: '%',
  MDC_DIM_DEGC: 'Cel',
  MDC_DIM_BEAT_PER_MIN: '{beats}/min',
  MDC_DIM_RESP_PER_MIN: '{breaths}/min',
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
  /**
   * device-reported state or alarm flag (unit `flag`: 0 normal, 1 active).
   * Holding one value for hours is normal, so it gets the range check only,
   * never the flatline check.
   */
  STATUS = 'status',
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
    // ECMO console
    signal('ECMO_PUMP_SPEED', 'rpm', SignalKind.NUMERIC, [0.0, 6000.0], 'ECMO pump speed'),
    signal('ECMO_P_VENOUS', 'mmHg', SignalKind.NUMERIC, [-300.0, 100.0], 'Venous (drainage) pressure, before the pump'),
    signal('ECMO_P_PRE_OXY', 'mmHg', SignalKind.NUMERIC, [-50.0, 700.0], 'Pressure before the oxygenator'),
    signal('ECMO_P_POST_OXY', 'mmHg', SignalKind.NUMERIC, [-50.0, 700.0], 'Pressure after the oxygenator (return)'),
    signal('ECMO_FIO2', '%', SignalKind.SETTING, [21.0, 100.0], 'Sweep gas oxygen fraction (FiO2)'),
    signal('ECMO_BLOOD_TEMP', 'degC', SignalKind.NUMERIC, [15.0, 45.0], 'Blood temperature'),
    signal('ECMO_BUBBLE_ALARM', 'flag', SignalKind.STATUS, [0.0, 1.0], 'Air bubble detector'),
    signal('ECMO_LEVEL_ALARM', 'flag', SignalKind.STATUS, [0.0, 1.0], 'Level sensor alarm'),
    // Heater unit (its water circuit warms the oxygenator; HU_WATER_FLOW is
    // that water, never the patient's blood flow)
    signal('HU_WATER_TEMP', 'degC', SignalKind.NUMERIC, [0.0, 45.0], 'Heater unit water temperature'),
    signal('HU_SET_TEMP', 'degC', SignalKind.SETTING, [0.0, 45.0], 'Heater unit set temperature'),
    signal('HU_WATER_LEVEL', '%', SignalKind.NUMERIC, [0.0, 100.0], 'Heater unit water level'),
    signal('HU_WATER_FLOW', 'L/min', SignalKind.NUMERIC, [0.0, 30.0], 'Heater unit water flow'),
    signal('HU_WATER_PRESSURE', 'bar', SignalKind.NUMERIC, [0.0, 3.0], 'Heater unit water pressure'),
    signal('HU_GT38_ON', 'flag', SignalKind.SETTING, [0.0, 1.0], 'Heater unit above-38 °C mode'),
    signal('HU_LOW_WATER', 'flag', SignalKind.STATUS, [0.0, 1.0], 'Heater unit low-water alarm'),
    // Patient monitors (SpO₂, temperature, multi-parameter)
    signal('VITAL_SPO2', '%', SignalKind.NUMERIC, [0.0, 100.0], 'Oxygen saturation (SpO₂)'),
    signal('VITAL_PULSE_RATE', 'bpm', SignalKind.NUMERIC, [0.0, 350.0], 'Pulse rate (oximeter)'),
    signal('VITAL_HEART_RATE', 'bpm', SignalKind.NUMERIC, [0.0, 350.0], 'Heart rate (ECG)'),
    signal('VITAL_NIBP_SYS', 'mmHg', SignalKind.NUMERIC, [0.0, 300.0], 'Blood pressure, systolic (NIBP)'),
    signal('VITAL_NIBP_DIA', 'mmHg', SignalKind.NUMERIC, [0.0, 250.0], 'Blood pressure, diastolic (NIBP)'),
    signal('VITAL_NIBP_MEAN', 'mmHg', SignalKind.NUMERIC, [0.0, 250.0], 'Blood pressure, mean (NIBP)'),
    signal('VITAL_RESP_RATE', 'brpm', SignalKind.NUMERIC, [0.0, 150.0], 'Respiration rate'),
    signal('VITAL_TEMP', 'degC', SignalKind.NUMERIC, [25.0, 45.0], 'Body temperature'),
    signal('VITAL_PERFUSION_INDEX', '%', SignalKind.NUMERIC, [0.0, 30.0], 'Perfusion index (oximeter)'),
  ].map((s) => [s.name, s]),
);

/** Coding system the 0dh.in device firmware uses in HL7 OBX-3: the code is the signal name. */
export const DEVICE_CODE_SYSTEM = '0DH';

/**
 * IEEE 11073 (MDC) codes that standard bedside monitors send in HL7 OBX-3,
 * by number and by reference id, so real monitors map without site config.
 */
export const MDC_VITAL_CODES: Record<string, string> = {
  '150456': 'VITAL_SPO2',
  MDC_PULS_OXIM_SAT_O2: 'VITAL_SPO2',
  '149530': 'VITAL_PULSE_RATE',
  MDC_PULS_OXIM_PULS_RATE: 'VITAL_PULSE_RATE',
  '147842': 'VITAL_HEART_RATE',
  MDC_ECG_HEART_RATE: 'VITAL_HEART_RATE',
  '150021': 'VITAL_NIBP_SYS',
  MDC_PRESS_BLD_NONINV_SYS: 'VITAL_NIBP_SYS',
  '150022': 'VITAL_NIBP_DIA',
  MDC_PRESS_BLD_NONINV_DIA: 'VITAL_NIBP_DIA',
  '150023': 'VITAL_NIBP_MEAN',
  MDC_PRESS_BLD_NONINV_MEAN: 'VITAL_NIBP_MEAN',
  '151562': 'VITAL_RESP_RATE',
  MDC_RESP_RATE: 'VITAL_RESP_RATE',
  '150364': 'VITAL_TEMP',
  MDC_TEMP_BODY: 'VITAL_TEMP',
  '150488': 'VITAL_PERFUSION_INDEX',
  MDC_PULS_OXIM_PERF_REL: 'VITAL_PERFUSION_INDEX',
};

/** EBOO shares the ECMO circuit signals; VITALS is patient monitoring (no therapy rules yet). */
export const THERAPIES = new Set(['ECMO', 'IABP', 'EBOO', 'VITALS']);
