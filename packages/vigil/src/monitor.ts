/**
 * Monitor hub (reference: apps/central_station/hub.py): watches an engine and
 * builds the central-station snapshot. Keeps the latest value and a short
 * history per machine and signal.
 */
import {
  VIGIL_GOOD_SQI,
  VIGIL_STALE_S,
  type VigilAlertView,
  type VigilControllerState,
  type VigilLogEntry,
  type VigilMachineState,
  type VigilMachineStatus,
  type VigilPoint,
  type VigilPriority,
  type VigilSignalState,
  type VigilState,
} from '@infusion/shared-types';
import { PRIORITY_ORDER, shortId, type Transition } from './alerts.js';
import { CODE_SYSTEM, SIGNALS, SignalKind } from './codes.js';
import { Origin, type Envelope } from './contracts.js';
import { DRIVER_LABELS } from './drivers.js';
import type { VigilEngine } from './engine.js';
import type { Scenario } from './sim/scenario.js';

/** numeric history kept per signal */
export const HISTORY_S = 6 * 3600;
export const LAB_HISTORY_S = 24 * 3600;
/** numeric history resolution (low-quality samples are always kept) */
export const NUMERIC_STEP_S = 5.0;
/** points per chart in one snapshot */
export const MAX_POINTS = 360;
const LOG_MAX = 200;
const LOG_SENT = 60;
/** Display order, in the HMI's groups: circuit, sweep gas, air vent, EBOO, heater unit, alarm flags, labs, alarm limits, vitals. */
export const SIGNAL_ORDER = [
  'ECMO_BLOOD_FLOW',
  'ECMO_PUMP_SPEED',
  'ECMO_PUMP_TARGET',
  'ECMO_P_VENOUS',
  'ECMO_P_PRE_OXY',
  'ECMO_P_POST_OXY',
  'ECMO_OXY_DELTA_P',
  'ECMO_BLOOD_TEMP',
  'ECMO_SVO2',
  'ECMO_SAO2',
  'ECMO_SWEEP_ON',
  'ECMO_SWEEP_FLOW',
  'ECMO_SWEEP_FLOW_ACTUAL',
  'ECMO_FIO2',
  'ECMO_FIO2_MEASURED',
  'ECMO_GAS_SOURCE',
  'ECMO_GAS_INLET_P',
  'ECMO_GAS_SUPPLY_P',
  'ECMO_AV_MODE',
  'ECMO_AV_VALVE',
  'ECMO_AV_DURATION',
  'ECMO_AV_IN_FLOW',
  'ECMO_AV_EX_FLOW',
  'EBOO_OZONE_CONC',
  'EBOO_OZONE_ON',
  'EBOO_UV_ON',
  'EBOO_O2_ON',
  'HU_WATER_TEMP',
  'HU_SET_TEMP',
  'HU_MODE',
  'HU_WATER_FLOW',
  'HU_WATER_PRESSURE',
  'HU_WATER_LEVEL',
  'HU_GT38_ON',
  'ECMO_BUBBLE_ALARM',
  'ECMO_LEVEL_ALARM',
  'HU_LOW_WATER',
  'BG_POST_OXY_PO2',
  'LAB_HB',
  'LAB_HCT',
  'LAB_PH',
  'LAB_PCO2',
  'LAB_PO2',
  'LAB_LACTATE',
  'LAB_ALBUMIN',
  'LAB_ACT',
  'LIMIT_FLOW_LO',
  'LIMIT_FLOW_HI',
  'LIMIT_PUMP_HI',
  'LIMIT_PV_LO',
  'LIMIT_PA_HI',
  'LIMIT_PIN_HI',
  'LIMIT_DP_HI',
  'LIMIT_TEMP_LO',
  'LIMIT_TEMP_HI',
  'LIMIT_SVO2_LO',
  'LIMIT_FIO2_LO',
  'LIMIT_GASP_LO',
  'VITAL_SPO2',
  'VITAL_PULSE_RATE',
  'VITAL_HEART_RATE',
  'VITAL_NIBP_SYS',
  'VITAL_NIBP_DIA',
  'VITAL_NIBP_MEAN',
  'VITAL_RESP_RATE',
  'VITAL_TEMP',
  'VITAL_PERFUSION_INDEX',
];

interface SignalTrack {
  hist: VigilPoint[];
  head: number;
  last: { t: number; value: number; sqi: number; flags: string[] } | null;
  changedAt: number;
}

interface MachineTrack {
  driver: string;
  lastSeen: number | null;
  signals: Map<string, SignalTrack>;
  unmapped: number;
}

/** Fleet/patient details the API knows and the engine does not (LIVE mode). */
export interface MonitorDirectory {
  machineIdFor?(deviceId: string): string | null;
  /** The kind it is registered as, shown until its first data says what it is. */
  machineKindFor?(deviceId: string): string | null;
  patientLabelFor?(encounterId: string): string | null;
}

export interface MonitorOptions {
  runId: number;
  scenario?: Scenario | null;
  directory?: MonitorDirectory;
}

export class MonitorHub {
  readonly runId: number;
  readonly scenario: Scenario | null;
  finished = false;
  stopped = false;
  private readonly machines = new Map<string, MachineTrack>();
  private readonly log: VigilLogEntry[] = [];
  private readonly directory: MonitorDirectory;

  constructor(
    readonly engine: VigilEngine,
    opts: MonitorOptions,
  ) {
    this.runId = opts.runId;
    this.scenario = opts.scenario ?? null;
    this.directory = opts.directory ?? {};
    engine.observationListeners.push((env) => this.onObservation(env));
    engine.transitionListeners.push((tr) => this.onTransition(tr));
  }

  private onObservation(env: Envelope): void {
    const obs = env.payload;
    let m = this.machines.get(env.deviceId);
    if (!m) {
      m = { driver: env.provenance.driverId, lastSeen: null, signals: new Map(), unmapped: 0 };
      this.machines.set(env.deviceId, m);
    }
    const t = env.validTime;
    m.lastSeen = m.lastSeen === null ? t : Math.max(m.lastSeen, t);
    if (obs.codeSystem !== CODE_SYSTEM) {
      m.unmapped += 1;
      return;
    }
    const sig = SIGNALS[obs.code];
    let s = m.signals.get(obs.code);
    if (!s) {
      s = { hist: [], head: 0, last: null, changedAt: t };
      m.signals.set(obs.code, s);
    }
    if (s.last !== null && s.last.value !== obs.value) s.changedAt = t;
    s.last = { t, value: obs.value, sqi: obs.sqi, flags: [...obs.flags] };
    const lastPoint = s.hist.length > s.head ? s.hist[s.hist.length - 1] : null;
    // Measurements and status flags are kept at NUMERIC_STEP_S resolution (a
    // flag also on every change); settings and labs on every sample.
    const sampled = sig.kind === SignalKind.NUMERIC || sig.kind === SignalKind.STATUS;
    const changed = sig.kind === SignalKind.STATUS && lastPoint !== null && lastPoint[1] !== obs.value;
    if (!sampled || !lastPoint || changed || t - lastPoint[0] >= NUMERIC_STEP_S || obs.sqi < VIGIL_GOOD_SQI) {
      s.hist.push([t, Math.round(obs.value * 1000) / 1000, Math.round(obs.sqi * 100) / 100]);
    }
    const keep = sig.kind === SignalKind.LAB ? LAB_HISTORY_S : HISTORY_S;
    while (s.head < s.hist.length && s.hist[s.head][0] < t - keep) s.head += 1;
    if (s.head > 2048 && s.head * 2 > s.hist.length) {
      s.hist.splice(0, s.head);
      s.head = 0;
    }
  }

  private onTransition(tr: Transition): void {
    const a = tr.alert;
    this.log.unshift({
      kind: tr.kind,
      at: tr.at,
      id: shortId(a),
      priority: a.priority,
      rule: a.problemKey,
      encounter: a.encounterId,
      explanation: tr.kind === 'resolved' && tr.reason ? tr.reason : a.explanation,
      by: a.acknowledgedBy,
    });
    if (this.log.length > LOG_MAX) this.log.length = LOG_MAX;
  }

  /** The signal codes a device has sent so far (for the superuser's show/hide list). */
  machineSignals(deviceId: string): string[] {
    return [...(this.machines.get(deviceId)?.signals.keys() ?? [])];
  }

  snapshot(window: number, windows: number[], controller: VigilControllerState | null, mode: 'test' | 'live'): VigilState {
    const engine = this.engine;
    const now = engine.clock.now();
    const assocs = new Map(
      engine.associations
        .all()
        .filter((a) => a.end === null)
        .map((a) => [a.deviceId, a]),
    );
    const active = [...engine.alerts.active.values()].sort(
      (a, b) => PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority] || b.raisedTime - a.raisedTime,
    );
    const alerting = new Map<string, VigilPriority>();
    for (const a of active) if (!alerting.has(a.encounterId)) alerting.set(a.encounterId, a.priority);
    const label = (enc: string) => this.directory.patientLabelFor?.(enc) ?? null;

    const machines: VigilMachineState[] = [];
    for (const device of [...new Set([...this.machines.keys(), ...assocs.keys()])].sort()) {
      const m = this.machines.get(device) ?? { driver: '', lastSeen: null, signals: new Map(), unmapped: 0 };
      const assoc = assocs.get(device);
      const episode = assoc ? engine.associations.episode(assoc.therapyEpisodeId) : undefined;
      const streaming = [...m.signals.keys()].some((c) => SIGNALS[c].kind === SignalKind.NUMERIC);
      const age = m.lastSeen === null ? null : Math.max(0.0, now - m.lastSeen);
      let status: VigilMachineStatus;
      if (!assoc) status = 'unassociated';
      else if (!assoc.confirmed) status = 'unconfirmed';
      else if (m.lastSeen === null) status = 'waiting';
      else if (streaming && age! > VIGIL_STALE_S) status = 'no_data';
      else status = 'ok';
      machines.push({
        deviceId: device,
        machineId: this.directory.machineIdFor?.(device) ?? null,
        driver: DRIVER_LABELS[m.driver] ?? (m.driver || 'no data yet'),
        kind: m.signals.size ? machineKind(m.signals) : (this.directory.machineKindFor?.(device) ?? machineKind(m.signals)),
        status,
        age,
        unmapped: m.unmapped,
        encounterId: assoc ? assoc.encounterId : null,
        patientLabel: assoc ? label(assoc.encounterId) : null,
        associationId: assoc ? assoc.associationId : null,
        therapy: episode ? episode.therapy : null,
        therapyDetail: episode ? Object.values(episode.attributes).join(' ') : '',
        confirmedBy: assoc ? assoc.confirmedBy : '',
        alertPriority: assoc ? (alerting.get(assoc.encounterId) ?? null) : null,
        signals: [...m.signals.entries()]
          .sort(([a], [b]) => signalRank(a) - signalRank(b) || (a < b ? -1 : 1))
          .map(([code, s]) => signalView(code, s, now, window)),
      });
    }
    // Group by patient; within a patient, the therapy device first.
    machines.sort(
      (a, b) =>
        Number(a.encounterId === null) - Number(b.encounterId === null) ||
        (a.encounterId ?? '').localeCompare(b.encounterId ?? '') ||
        Number(a.kind !== 'ECMO console') - Number(b.kind !== 'ECMO console') ||
        a.deviceId.localeCompare(b.deviceId),
    );

    const [level, reasons] = operatingLevel(machines, engine);
    const sc = this.scenario;
    const alerts: VigilAlertView[] = active.map((a) => ({
      id: shortId(a),
      alertId: a.alertId,
      priority: a.priority,
      state: a.state,
      rule: a.problemKey,
      version: a.findings[0].rule.ruleVersion,
      placement: a.origin === Origin.EDGE_SAFETY_FLOOR ? 'safety_floor' : 'core',
      encounter: a.encounterId,
      patientLabel: label(a.encounterId),
      explanation: a.explanation,
      raised: a.raisedTime,
      acknowledgedBy: a.acknowledgedBy,
      testMode: a.testMode,
    }));
    return {
      ready: true,
      runId: this.runId,
      mode,
      tenantId: engine.tenantId,
      unitId: engine.unitId,
      nodeId: engine.nodeId,
      now,
      simulatedClock: engine.clock.simulated,
      window,
      windows,
      scenario: sc
        ? {
            name: sc.name,
            description: sc.description,
            duration: sc.duration,
            annotations: sc.annotations.map(([at, text]) => ({ at, label: text })),
          }
        : null,
      finished: this.finished,
      stopped: this.stopped,
      operatingLevel: level,
      operatingReasons: reasons,
      rules: engine.rules.map((r) => ({
        key: r.key,
        priority: r.priority,
        placement: r.safetyFloor ? 'safety_floor' : 'core',
        owner: r.owner,
        tests: r.tests.length,
      })),
      alerts,
      log: this.log.slice(0, LOG_SENT),
      machines,
      stats: {
        observations: engine.stat('observations'),
        flush: engine.stat('flag:FLUSH'),
        driverFaults: engine.stat('driver_faults'),
      },
      controller,
    };
  }
}

/**
 * Server-side part of the operating level. Level 3 (central station cut off
 * from the server) can only be detected by the browser, which sets it itself.
 *
 *   0  full operation
 *   1  degraded: some machines without live data, unconfirmed, or driver faults
 *   2  safety floor only: core rules not running
 */
export function operatingLevel(machines: VigilMachineState[], engine: VigilEngine): [0 | 1 | 2, string[]] {
  let level: 0 | 1 | 2 = 0;
  const reasons: string[] = [];
  const silent = machines.filter((m) => m.encounterId && m.status === 'no_data').map((m) => m.deviceId);
  if (silent.length) {
    level = 1;
    reasons.push(`no live data from ${silent.join(', ')}`);
  }
  const unconfirmed = machines.filter((m) => m.status === 'unconfirmed').map((m) => m.deviceId);
  if (unconfirmed.length) {
    level = 1;
    reasons.push(`association not confirmed for ${unconfirmed.join(', ')}`);
  }
  const faults = engine.stat('driver_faults');
  if (faults) {
    level = 1;
    reasons.push(`${faults} driver faults since start`);
  }
  if (!engine.cds.rules.length) {
    level = 2;
    reasons.push('core rules not running; safety floor only');
  }
  return [level, reasons];
}

function machineKind(signals: Map<string, unknown>): string {
  const codes = [...signals.keys()];
  if (codes.some((c) => c.startsWith('EBOO_'))) return 'EBOO';
  if (codes.some((c) => c.startsWith('ECMO_'))) return 'ECMO console';
  if (codes.some((c) => c.startsWith('BG_'))) return 'Blood gas analyzer';
  const vitals = codes.filter((c) => c.startsWith('VITAL_'));
  if (vitals.length) {
    if (vitals.every((c) => c === 'VITAL_TEMP')) return 'Temperature monitor';
    if (vitals.every((c) => ['VITAL_SPO2', 'VITAL_PULSE_RATE', 'VITAL_PERFUSION_INDEX'].includes(c))) return 'SpO₂ monitor';
    return 'Patient monitor';
  }
  return 'Device';
}

function signalRank(code: string): number {
  const i = SIGNAL_ORDER.indexOf(code);
  return i < 0 ? SIGNAL_ORDER.length : i;
}

function signalView(code: string, s: SignalTrack, now: number, window: number): VigilSignalState {
  const sig = SIGNALS[code];
  const last = s.last!;
  const hist = s.hist.slice(s.head);
  let points: VigilPoint[];
  if (sig.kind === SignalKind.LAB) {
    points = hist.slice(-12);
  } else {
    points = hist.filter((p) => p[0] >= now - window);
    if (points.length > MAX_POINTS) {
      const step = points.length / MAX_POINTS;
      const keep = new Set<number>([points.length - 1]);
      for (let i = 0; i < MAX_POINTS; i++) keep.add(Math.floor(i * step));
      points = points.filter((p, i) => keep.has(i) || p[2] < VIGIL_GOOD_SQI);
    }
  }
  return {
    code,
    label: sig.description,
    unit: sig.unit,
    kind: sig.kind,
    value: last.value,
    t: last.t,
    age: Math.max(0.0, now - last.t),
    sqi: last.sqi,
    flags: last.flags,
    changedAt: s.changedAt,
    points,
    ...(sig.states ? { states: sig.states } : {}),
    ...(sig.decimals !== undefined ? { decimals: sig.decimals } : {}),
  };
}
