/**
 * Resolves the operating mode (ADR-005) from the environment, once at start-up.
 *
 *   VIGIL_LIVE_MODE=false (default) -> TEST: simulated patient scenarios,
 *       simulated clock, identities must start with "sim", alerts tagged TEST
 *   VIGIL_LIVE_MODE=true            -> LIVE: real ECMO machines only (HL7 PCD-01
 *       via POST /vigil/ingest), wall clock, simulators refused, the LIVE
 *       identity must be complete and must not start with "sim"
 *
 * Switching modes means a restart, by design.
 */
import { SIGNALS } from './codes.js';
import { VIGIL_SPEEDS } from '@infusion/shared-types';

export class VigilConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VigilConfigError';
  }
}

export interface VigilConfig {
  liveMode: boolean;
  modeSource: string;
  tenantId: string;
  unitId: string;
  nodeId: string;
  tickSeconds: number;
  // TEST only
  scenario: string;
  speed: number;
  autostart: boolean;
  // LIVE only
  codeMaps: Record<string, Record<string, string>>;
  /** days of accepted device messages kept in the database (VIGIL_HISTORY_DAYS, default 30) */
  historyDays: number;
}

const TRUE = new Set(['1', 'true', 'yes', 'on']);
const FALSE = new Set(['0', 'false', 'no', 'off']);

function parseBool(value: string, where: string): boolean {
  const text = value.trim().toLowerCase();
  if (TRUE.has(text)) return true;
  if (FALSE.has(text)) return false;
  throw new VigilConfigError(`${where} must be true or false, got '${value}'`);
}

export function loadVigilConfig(env: Record<string, string | undefined> = process.env): VigilConfig {
  const get = (k: string) => (env[k] ?? '').trim();
  const raw = get('VIGIL_LIVE_MODE');
  const liveMode = raw ? parseBool(raw, 'VIGIL_LIVE_MODE') : false;
  const modeSource = raw ? 'environment VIGIL_LIVE_MODE' : 'default (VIGIL_LIVE_MODE unset)';
  const tickSeconds = get('VIGIL_TICK_SECONDS') ? Number(get('VIGIL_TICK_SECONDS')) : 1;
  if (!(tickSeconds > 0)) throw new VigilConfigError('VIGIL_TICK_SECONDS must be positive');

  if (!liveMode) {
    const tenantId = get('VIGIL_TEST_TENANT_ID') || 'sim-hospital';
    const unitId = get('VIGIL_TEST_UNIT_ID') || 'sim-icu-1';
    const nodeId = get('VIGIL_TEST_NODE_ID') || `${unitId}-core-a`;
    // Test identities must be recognisably synthetic so test data can never
    // be filed under a real hospital or unit.
    for (const [key, value] of [['VIGIL_TEST_TENANT_ID', tenantId], ['VIGIL_TEST_UNIT_ID', unitId]]) {
      if (!value.startsWith('sim')) throw new VigilConfigError(`${key} must start with 'sim' (got '${value}')`);
    }
    const speed = get('VIGIL_TEST_SPEED') ? Number(get('VIGIL_TEST_SPEED')) : 60;
    if (!(VIGIL_SPEEDS as readonly number[]).includes(speed)) {
      throw new VigilConfigError(`VIGIL_TEST_SPEED must be one of ${VIGIL_SPEEDS.join(', ')}`);
    }
    return {
      liveMode,
      modeSource,
      tenantId,
      unitId,
      nodeId,
      tickSeconds,
      scenario: get('VIGIL_TEST_SCENARIO') || 'ecmo/oxy_clot_01',
      speed,
      autostart: get('VIGIL_TEST_AUTOSTART') ? parseBool(get('VIGIL_TEST_AUTOSTART'), 'VIGIL_TEST_AUTOSTART') : true,
      codeMaps: {},
      historyDays: 0,
    };
  }

  const problems: string[] = [];
  const tenantId = get('VIGIL_LIVE_TENANT_ID');
  const unitId = get('VIGIL_LIVE_UNIT_ID');
  for (const [key, value] of [['VIGIL_LIVE_TENANT_ID', tenantId], ['VIGIL_LIVE_UNIT_ID', unitId]]) {
    if (!value) problems.push(`${key} is required`);
    else if (value.startsWith('sim')) problems.push(`${key} must not start with 'sim' (reserved for TEST mode)`);
  }
  const codeMaps: Record<string, Record<string, string>> = {};
  if (get('VIGIL_HL7_CODES')) {
    try {
      const parsed: unknown = JSON.parse(get('VIGIL_HL7_CODES'));
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
      const table: Record<string, string> = {};
      for (const [code, signal] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof signal !== 'string' || !(signal in SIGNALS)) {
          problems.push(`VIGIL_HL7_CODES '${code}' maps to unknown signal '${String(signal)}'`);
        } else {
          table[code] = signal;
        }
      }
      codeMaps.hl7_pcd01 = table;
    } catch {
      problems.push('VIGIL_HL7_CODES must be a JSON object of "<coding system>:<code>": "<SIGNAL>"');
    }
  }
  const historyDays = get('VIGIL_HISTORY_DAYS') ? Number(get('VIGIL_HISTORY_DAYS')) : 30;
  if (!(historyDays > 0)) problems.push('VIGIL_HISTORY_DAYS must be a positive number of days');
  if (problems.length) {
    throw new VigilConfigError(`LIVE mode configuration is incomplete:\n  - ${problems.join('\n  - ')}`);
  }
  return {
    liveMode,
    modeSource,
    tenantId,
    unitId,
    nodeId: get('VIGIL_LIVE_NODE_ID') || `${unitId}-core-a`,
    tickSeconds,
    scenario: '',
    speed: 0,
    autostart: false,
    codeMaps,
    historyDays,
  };
}

export function describeMode(cfg: VigilConfig): string[] {
  if (cfg.liveMode) {
    return [
      `Vigil mode: LIVE  (from ${cfg.modeSource})`,
      `  tenant ${cfg.tenantId}, unit ${cfg.unitId}, node ${cfg.nodeId}`,
      '  data: HL7 PCD-01 from registered ECMO machines (POST /vigil/ingest); simulators refused',
      '  associations: active patient-machine assignments; rules run only once confirmed',
      `  history: device messages kept ${cfg.historyDays} days; the last 6 h reload into the charts at start-up`,
    ];
  }
  return [
    `Vigil mode: TEST  (from ${cfg.modeSource})`,
    `  tenant ${cfg.tenantId}, unit ${cfg.unitId}, node ${cfg.nodeId}`,
    '  data: device simulators driven by a patient scenario, simulated clock',
    '  alarms: central station only, tagged TEST; machine ingest refused',
  ];
}
