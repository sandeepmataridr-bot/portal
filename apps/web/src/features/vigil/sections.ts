/**
 * How a machine card groups its signals, in the HMI's own sections. Signals
 * arrive in the server's display order (packages/vigil SIGNAL_ORDER), which
 * already follows these groups; the card only adds the headings.
 */
const ALARM_INPUTS = new Set(['ECMO_BUBBLE_ALARM', 'ECMO_LEVEL_ALARM', 'HU_LOW_WATER']);

export function signalGroup(code: string): string {
  if (code.startsWith('LIMIT_')) return 'Alarm limits';
  if (code.startsWith('LAB_') || code.startsWith('BG_')) return 'Labs';
  if (ALARM_INPUTS.has(code)) return 'Alarm inputs';
  if (code.startsWith('HU_')) return 'Heater unit';
  if (code.startsWith('ECMO_AV_')) return 'Air vent';
  if (code.startsWith('ECMO_SWEEP') || code.startsWith('ECMO_FIO2') || code.startsWith('ECMO_GAS_')) return 'Sweep gas';
  if (code.startsWith('EBOO_')) return 'EBOO';
  if (code.startsWith('VITAL_')) return 'Patient';
  return 'Circuit';
}

/** The machine's alarm limits (HMI Alarm limits page) as table rows: parameter, low limit, high limit. */
export const LIMIT_ROWS: [label: string, low: string | null, high: string | null][] = [
  ['Blood flow', 'LIMIT_FLOW_LO', 'LIMIT_FLOW_HI'],
  ['Pump speed', null, 'LIMIT_PUMP_HI'],
  ['Venous pressure Pv', 'LIMIT_PV_LO', null],
  ['Arterial pressure Pa', null, 'LIMIT_PA_HI'],
  ['Inlet pressure Pin', null, 'LIMIT_PIN_HI'],
  ['Pressure drop dP', null, 'LIMIT_DP_HI'],
  ['Arterial temperature', 'LIMIT_TEMP_LO', 'LIMIT_TEMP_HI'],
  ['SvO2', 'LIMIT_SVO2_LO', null],
  ['FiO2', 'LIMIT_FIO2_LO', null],
  ['Gas supply pressure', 'LIMIT_GASP_LO', null],
];
