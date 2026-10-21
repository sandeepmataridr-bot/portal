/**
 * Driver ABI and driver host, plus the two drivers:
 *
 *   hl7_pcd01  IHE PCD-01 (HL7 v2 ORU^R01). Usable in both modes; it is the
 *              LIVE-mode path for real ECMO machines (POST /vigil/ingest).
 *   sim_ecmo   the simulated "SimCirc" ECMO console. TEST mode only.
 *
 * A driver turns device frames into RawSample messages (proto driver.proto).
 * The host enforces the operating mode (simulated drivers are refused in LIVE
 * mode) and isolates faults: a driver that throws is replaced by a fresh
 * instance and the frame is dropped, without affecting other drivers.
 */
import { MDC_DIM_TO_UCUM } from './codes.js';
import { newEventId } from './time.js';

export interface RawSample {
  deviceId: string;
  vendorCode: string;
  value: number;
  unit: string;
  deviceTime: number;
  flags: string[];
}

export interface Driver {
  readonly driverId: string;
  readonly version: string;
  readonly simulated: boolean;
  /** Decode one device frame. Throws on malformed input. */
  decode(frame: string): RawSample[];
}

/** An action that the current operating mode forbids. */
export class ModeViolation extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ModeViolation';
  }
}

export class DriverHost {
  private readonly factories = new Map<string, () => Driver>();
  private readonly drivers = new Map<string, Driver>();
  readonly faults = new Map<string, number>();

  constructor(
    readonly liveMode: boolean,
    private readonly onFault?: (driverId: string, error: unknown) => void,
  ) {}

  register(create: () => Driver): void {
    const drv = create();
    if (this.liveMode && drv.simulated) {
      throw new ModeViolation(`driver '${drv.driverId}' is a simulator and cannot run in LIVE mode`);
    }
    this.factories.set(drv.driverId, create);
    this.drivers.set(drv.driverId, drv);
  }

  driver(driverId: string): Driver {
    const drv = this.drivers.get(driverId);
    if (!drv) {
      throw new ModeViolation(`driver '${driverId}' is not registered in ${this.liveMode ? 'LIVE' : 'TEST'} mode`);
    }
    return drv;
  }

  decode(driverId: string, frame: string): RawSample[] {
    const drv = this.driver(driverId);
    try {
      return drv.decode(frame);
    } catch (e) {
      this.faults.set(driverId, (this.faults.get(driverId) ?? 0) + 1);
      this.drivers.set(driverId, this.factories.get(driverId)!()); // restart
      this.onFault?.(driverId, e);
      return [];
    }
  }
}

// ── simulated ECMO console ─────────────────────────────────────────────────

/** Frame format, one sample per line:  SC1|<device_id>|<device_time>|<code>|<value>|<unit> */
export class SimEcmoDriver implements Driver {
  readonly driverId = 'sim_ecmo';
  readonly version = '0.1.0';
  readonly simulated = true;

  decode(frame: string): RawSample[] {
    const parts = frame.trim().split('|');
    if (parts.length !== 6 || parts[0] !== 'SC1') throw new Error(`not a SimCirc frame: ${JSON.stringify(frame)}`);
    const [, deviceId, t, code, value, unit] = parts;
    return [{ deviceId, vendorCode: code, value: parseNumber(value), unit, deviceTime: parseNumber(t), flags: [] }];
  }
}

// ── HL7 PCD-01 ─────────────────────────────────────────────────────────────

export class Hl7Error extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'Hl7Error';
  }
}

/** final, unverified, corrected */
const ACCEPTED_STATUS = new Set(['F', 'R', 'C']);
const TS = /^(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\.\d+)?([+-]\d{4})?$/;
const NUMBER = /^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/;

/** Finite decimal numbers only: NaN/Infinity/empty are malformed device data, never values. */
function parseNumber(text: string): number {
  const s = text.trim();
  if (!NUMBER.test(s)) throw new Error(`not a number: ${JSON.stringify(text)}`);
  return Number(s);
}

export function parseTs(ts: string): number {
  const m = TS.exec(ts.trim());
  if (!m) throw new Hl7Error(`bad HL7 timestamp '${ts}'`);
  const [, y, mo, d, h, mi, s, frac, tz] = m;
  const parts = [+y, +(mo ?? 1), +(d ?? 1), +(h ?? 0), +(mi ?? 0), +(s ?? 0)];
  const ms = Date.UTC(parts[0], parts[1] - 1, parts[2], parts[3], parts[4], parts[5]);
  const back = new Date(ms);
  if (
    parts[0] < 1 ||
    back.getUTCMonth() !== parts[1] - 1 ||
    back.getUTCDate() !== parts[2] ||
    back.getUTCHours() !== parts[3] ||
    back.getUTCMinutes() !== parts[4] ||
    back.getUTCSeconds() !== parts[5]
  ) {
    throw new Hl7Error(`bad HL7 timestamp '${ts}'`);
  }
  let t = ms / 1000;
  if (tz) {
    const sign = tz[0] === '+' ? 1 : -1;
    t -= sign * (parseInt(tz.slice(1, 3), 10) * 3600 + parseInt(tz.slice(3, 5), 10) * 60);
  }
  return t + (frac ? parseFloat(frac) : 0.0);
}

export function formatTs(t: number): string {
  const d = new Date(Math.floor(t * 1000));
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${p(d.getUTCFullYear(), 4)}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`;
}

function segments(text: string): string[] {
  return text.split(/\r\n|\r|\n/).filter((s) => s.trim());
}

function msh(text: string): string[] {
  const segs = segments(text);
  if (!segs.length || !segs[0].startsWith('MSH') || segs[0].length < 4) throw new Hl7Error('message does not start with MSH');
  return segs[0].split(segs[0][3]);
}

const field = (fields: string[], i: number) => (i < fields.length ? fields[i] : '');

function unitOf(obx6: string): string {
  const comps = obx6.split('^');
  if (comps.length >= 3 && comps[2] === 'MDC') return MDC_DIM_TO_UCUM[comps[1]] ?? comps[1];
  return comps[0];
}

/**
 * Each numeric OBX becomes one RawSample:
 *   vendorCode = "<OBX-3 coding system>:<OBX-3 identifier>"
 *   unit       = OBX-6 (UCUM, or an MDC_DIM_* code mapped to UCUM)
 *   deviceTime = OBX-14, falling back to MSH-7
 *   deviceId   = OBX-18 component 1, falling back to MSH-3
 */
export function parseOru(text: string): RawSample[] {
  const header = msh(text);
  const sep = text.trimStart()[3];
  // After split on the field separator, MSH-n is index n-1.
  const msgType = field(header, 8).split('^');
  if (msgType[0] !== 'ORU' || msgType[1] !== 'R01') throw new Hl7Error(`expected ORU^R01, got '${field(header, 8)}'`);
  const defaultDevice = field(header, 2).split('^')[0];
  const defaultTime = field(header, 6) ? parseTs(field(header, 6)) : null;

  const samples: RawSample[] = [];
  for (const seg of segments(text).slice(1)) {
    const f = seg.split(sep);
    if (f[0] !== 'OBX' || field(f, 2) !== 'NM') continue;
    if (field(f, 11) && !ACCEPTED_STATUS.has(field(f, 11))) continue;
    const ident = field(f, 3).split('^');
    const code = ident[0];
    const system = ident.length > 2 ? ident[2] : '';
    if (!code) throw new Hl7Error('OBX-3 identifier is empty');
    let value: number;
    try {
      value = parseNumber(field(f, 5));
    } catch {
      throw new Hl7Error(`OBX-5 is not numeric: '${field(f, 5)}'`);
    }
    const ts = field(f, 14);
    const t = ts ? parseTs(ts) : defaultTime;
    if (t === null) throw new Hl7Error('no observation time (OBX-14 or MSH-7)');
    const device = field(f, 18).split('^')[0] || defaultDevice;
    samples.push({
      deviceId: device,
      vendorCode: system ? `${system}:${code}` : code,
      value,
      unit: unitOf(field(f, 6)),
      deviceTime: t,
      flags: [],
    });
  }
  return samples;
}

/** HL7 ACK for one message: code AA (accepted) or AE (error). */
export function buildAck(text: string, code: 'AA' | 'AE', error = '', now = Date.now() / 1000): string {
  let controlId = '';
  let app = '';
  let fac = '';
  try {
    const header = msh(text);
    [controlId, app, fac] = [field(header, 9), field(header, 2), field(header, 3)];
  } catch {
    // unparseable message: ACK without echo fields
  }
  const clean = (s: string) => s.replace(/[|^~\\&\r\n]/g, ' ');
  let msa = `MSA|${code}|${clean(controlId)}`;
  if (error) msa += `|${clean(error).slice(0, 80)}`;
  return `MSH|^~\\&|VIGIL|EDGE|${clean(app)}|${clean(fac)}|${formatTs(now)}||ACK^R01^ACK|${newEventId()}|P|2.6\r${msa}\r`;
}

export class Hl7Pcd01Driver implements Driver {
  readonly driverId = 'hl7_pcd01';
  readonly version = '0.1.0';
  readonly simulated = false;

  decode(frame: string): RawSample[] {
    return parseOru(frame);
  }
}

export const DRIVER_LABELS: Record<string, string> = {
  sim_ecmo: 'Simulated ECMO console',
  hl7_pcd01: 'HL7 PCD-01 device',
};
