/**
 * Device simulators (true physiology -> vendor wire frames) and the scenario
 * player, which produces the time-ordered frame stream for a scenario.
 */
import { SIGNALS, SignalKind, convert } from '../codes.js';
import { formatTs } from '../drivers.js';
import { pyFixed } from '../time.js';
import { PyRandom } from './pyrandom.js';
import { interpolate, outageCovers, type Scenario } from './scenario.js';

interface DeviceSimulator {
  encode(deviceId: string, signal: string, unitUcum: string, t: number, value: number): string;
}

/** Simulated ECMO console. Reports pressures in kPa, like some real consoles. */
export class SimCircConsole implements DeviceSimulator {
  static readonly VENDOR: Record<string, [string, string]> = {
    ECMO_BLOOD_FLOW: ['QB', 'L/min'],
    ECMO_OXY_DELTA_P: ['DPOXY', 'kPa'],
    ECMO_SWEEP_FLOW: ['SWEEP', 'L/min'],
  };

  encode(deviceId: string, signal: string, unitUcum: string, t: number, value: number): string {
    const [code, unit] = SimCircConsole.VENDOR[signal];
    return `SC1|${deviceId}|${pyFixed(t, 3)}|${code}|${pyFixed(convert(value, unitUcum, unit), 4)}|${unit}`;
  }
}

/** Simulated blood gas analyzer sending HL7 v2 ORU^R01 results. */
export class SimBloodGasAnalyzer implements DeviceSimulator {
  static readonly VENDOR: Record<string, [string, string, string]> = {
    BG_POST_OXY_PO2: ['POST_OXY_PO2', 'Post-oxygenator pO2', 'L'],
  };
  private n = 0;

  encode(deviceId: string, signal: string, unitUcum: string, t: number, value: number): string {
    this.n += 1;
    const [code, text, system] = SimBloodGasAnalyzer.VENDOR[signal];
    const ts = formatTs(t);
    const obx = ['OBX', '1', 'NM', `${code}^${text}^${system}`, '', pyFixed(value, 1), `${unitUcum}^${unitUcum}^UCUM`,
      '', '', '', '', 'F', '', '', ts, '', '', '', deviceId];
    return (
      [
        `MSH|^~\\&|SIM_BGA|SIMLAB|VIGIL|EDGE|${ts}||ORU^R01^ORU_R01|SIM${String(this.n).padStart(6, '0')}|P|2.6`,
        `OBR|1|||BG^Blood gas^L|||${ts}`,
        obx.join('|'),
      ].join('\r') + '\r'
    );
  }
}

const SIMULATORS: Record<string, () => DeviceSimulator> = {
  sim_ecmo: () => new SimCircConsole(),
  hl7_pcd01: () => new SimBloodGasAnalyzer(),
};

export interface SimFrame {
  t: number;
  seq: number;
  driverId: string;
  frame: string;
}

/** Python floor division for the non-negative floats used here. */
function floorDiv(a: number, b: number): number {
  return Math.floor(a / b);
}

export function frames(scenario: Scenario): SimFrame[] {
  const rng = new PyRandom(scenario.seed);
  const drivers = new Map(scenario.devices.map((d) => [d.deviceId, d.driver]));
  const sims = new Map(Object.entries(SIMULATORS).map(([name, make]) => [name, make()]));
  const out: SimFrame[] = [];

  const offline = (device: string, t: number) => scenario.outages.some((o) => o.device === device && outageCovers(o, t));
  const emit = (device: string, signal: string, t: number, value: number) => {
    const drv = drivers.get(device)!;
    const frame = sims.get(drv)!.encode(device, signal, SIGNALS[signal].ucum, t, value);
    out.push({ t, seq: out.length, driverId: drv, frame });
  };

  for (const spec of scenario.signals) {
    const artifacts = scenario.artifacts.filter((a) => a.signal === spec.name);
    const isSetting = SIGNALS[spec.name].kind === SignalKind.SETTING;
    const steps = floorDiv(scenario.duration, spec.period);
    for (let k = 0; k <= steps; k++) {
      const t = k * spec.period;
      if (offline(spec.device, t)) continue;
      let value = interpolate(spec.timeline, t);
      if (spec.noise && !isSetting) value += rng.gauss(0.0, spec.noise);
      for (const a of artifacts) {
        if (a.start <= t && t < a.end && pyMod(t - a.start, a.every) < a.length) value += a.offset;
      }
      emit(spec.device, spec.name, t, value);
    }
  }

  for (const lab of scenario.labs) {
    for (const [t, value] of lab.samples) {
      if (t <= scenario.duration && !offline(lab.device, t)) emit(lab.device, lab.name, t, value);
    }
  }

  out.sort((a, b) => a.t - b.t || a.seq - b.seq);
  return out;
}

/** Python `%` for floats (result takes the sign of the divisor). */
function pyMod(a: number, b: number): number {
  const r = a % b;
  return r !== 0 && r < 0 !== b < 0 ? r + b : r;
}
