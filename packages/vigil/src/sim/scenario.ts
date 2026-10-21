/**
 * Patient scenario format (JSON timeline of physiology and device events).
 *
 * Signal values in a scenario are the true physiology in the signal's
 * canonical unit; device simulators convert them to their own vendor units on
 * the wire. Timelines are piecewise linear; repeat a time to make a step change.
 */
import { SIGNALS, THERAPIES } from '../codes.js';
import { parseDuration } from '../time.js';

export interface DeviceSpec {
  deviceId: string;
  driver: string;
  confirmed: boolean;
}

export interface SignalSpec {
  name: string;
  device: string;
  period: number;
  noise: number;
  timeline: [number, number][];
}

export interface LabSpec {
  name: string;
  device: string;
  samples: [number, number][];
}

export interface Artifact {
  signal: string;
  start: number;
  end: number;
  every: number;
  length: number;
  offset: number;
}

export interface Outage {
  device: string;
  start: number;
  length: number;
}

export interface Scenario {
  name: string;
  description: string;
  duration: number;
  seed: number;
  encounterId: string;
  therapy: string;
  episodeId: string;
  attributes: Record<string, string>;
  devices: DeviceSpec[];
  signals: SignalSpec[];
  labs: LabSpec[];
  artifacts: Artifact[];
  outages: Outage[];
  annotations: [number, string][];
}

export function outageCovers(o: Outage, t: number): boolean {
  return o.start <= t && t < o.start + o.length;
}

/** Python `bisect.bisect_right` on the timeline's times. */
function bisectRight(times: number[], t: number): number {
  let lo = 0;
  let hi = times.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (t < times[mid]) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

export function interpolate(timeline: [number, number][], t: number): number {
  const i = bisectRight(
    timeline.map((p) => p[0]),
    t,
  ) - 1;
  if (i < 0) return timeline[0][1];
  if (i >= timeline.length - 1) return timeline[timeline.length - 1][1];
  const [t0, v0] = timeline[i];
  const [t1, v1] = timeline[i + 1];
  return v0 + ((v1 - v0) * (t - t0)) / (t1 - t0);
}

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

function points(raw: unknown, where: string): [number, number][] {
  if (!Array.isArray(raw)) throw new Error(`${where}: timeline must be a list of [time, value] pairs`);
  const pts = raw.map((p): [number, number] => {
    if (!Array.isArray(p) || p.length !== 2) throw new Error(`${where}: each point is [time, value]`);
    const v = Number(p[1]);
    if (!Number.isFinite(v)) throw new Error(`${where}: value must be a number`);
    return [parseDuration(p[0]), v];
  });
  if (!pts.length || pts.some((b, k) => k > 0 && b[0] < pts[k - 1][0])) {
    throw new Error(`${where}: timeline must be non-empty and in time order`);
  }
  return pts;
}

/** Validates and parses one scenario document. */
export function parseScenario(name: string, d: Json): Scenario {
  const devices: DeviceSpec[] = (d.devices ?? []).map((x: Json) => ({
    deviceId: String(x.device_id),
    driver: String(x.driver),
    confirmed: x.confirmed === undefined ? true : Boolean(x.confirmed),
  }));
  const known = new Set(devices.map((x) => x.deviceId));
  if (!d.therapy || !THERAPIES.has(d.therapy.type)) throw new Error(`${name}: unknown therapy '${d.therapy?.type}'`);

  const check = (sig: string, dev: string, where: string) => {
    if (!(sig in SIGNALS)) throw new Error(`${name}: ${where} uses unknown signal '${sig}'`);
    if (!known.has(dev)) throw new Error(`${name}: ${where} uses unknown device '${dev}'`);
  };

  const signals: SignalSpec[] = Object.entries((d.signals ?? {}) as Json).map(([sig, s]) => {
    check(sig, s.device, `signal ${sig}`);
    return {
      name: sig,
      device: s.device,
      period: parseDuration(s.period),
      noise: Number(s.noise ?? 0),
      timeline: points(s.timeline, `${name}/${sig}`),
    };
  });
  const labs: LabSpec[] = Object.entries((d.labs ?? {}) as Json).map(([sig, s]) => {
    check(sig, s.device, `lab ${sig}`);
    return { name: sig, device: s.device, samples: points(s.samples, `${name}/${sig}`) };
  });
  const duration = parseDuration(d.duration);
  const artifacts: Artifact[] = (d.artifacts ?? []).map((a: Json) => ({
    signal: a.signal,
    start: parseDuration(a.start),
    end: parseDuration(a.end ?? d.duration),
    every: parseDuration(a.every),
    length: parseDuration(a.length),
    offset: Number(a.offset),
  }));
  const outages: Outage[] = (d.outages ?? []).map((o: Json) => ({
    device: o.device,
    start: parseDuration(o.start),
    length: parseDuration(o.length),
  }));
  const annotations: [number, string][] = (d.annotations ?? []).map((a: Json) => [parseDuration(a.at), String(a.label)]);
  const attributes: Record<string, string> = {};
  for (const [k, v] of Object.entries(d.therapy as Json)) if (k !== 'type' && k !== 'episode_id') attributes[k] = String(v);

  return {
    name,
    description: d.description ?? '',
    duration,
    seed: Number.parseInt(String(d.seed ?? 0), 10),
    encounterId: d.encounter_id,
    therapy: d.therapy.type,
    episodeId: d.therapy.episode_id,
    attributes,
    devices,
    signals,
    labs,
    artifacts,
    outages,
    annotations,
  };
}
