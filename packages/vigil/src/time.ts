/**
 * Time helpers: durations, clocks, number formatting and time-ordered ids.
 *
 * Times are float seconds. In LIVE mode they are Unix epoch seconds; in TEST
 * mode they are seconds since the start of the scenario (epoch 0).
 */
import { randomBytes } from 'node:crypto';
import { TIME_UNITS } from './codes.js';

const DURATION = /^\s*(\d+(?:\.\d+)?)\s*(ms|s|min|h)\s*$/;

/** '15min' -> 900. Bare numbers are seconds. */
export function parseDuration(text: string | number): number {
  if (typeof text === 'number') return text;
  const m = DURATION.exec(text);
  if (!m) throw new Error(`bad duration '${text}'; use e.g. 5s, 15min, 6h`);
  return parseFloat(m[1]) * TIME_UNITS[m[2]];
}

/**
 * Python's `f"{x:.{digits}f}"`: the exact binary value rounded half-to-even.
 * JS `toFixed` rounds exact ties away from zero, so ties are re-done here;
 * this keeps rule explanations and simulator frames byte-identical with the
 * reference prototype.
 */
export function pyFixed(x: number, digits: number): string {
  const scaled2 = x * 10 ** digits * 2;
  if (Number.isFinite(scaled2) && Number.isInteger(scaled2)) {
    const exact = Math.abs(x).toFixed(100);
    const point = exact.indexOf('.');
    const tail = exact.slice(point + 1 + digits);
    if (/^50*$/.test(tail)) {
      const kept = exact.slice(0, point + 1 + digits).replace('.', '');
      let n = BigInt(kept);
      if (n % 2n === 1n) n += 1n;
      let s = n.toString().padStart(digits + 1, '0');
      if (digits > 0) s = `${s.slice(0, -digits)}.${s.slice(-digits)}`;
      return (x < 0 && /[1-9]/.test(s) ? '-' : '') + s;
    }
  }
  return x.toFixed(digits);
}

/** Python `repr(float)`. Used only to hash frame streams the same way as the reference. */
export function pyFloatRepr(x: number): string {
  return Number.isInteger(x) && Math.abs(x) < 1e16 ? `${x}.0` : String(x);
}

export function formatDuration(seconds: number): string {
  if (seconds < 120) return `${pyFixed(seconds, 0)} s`;
  if (seconds < 7200) return `${pyFixed(seconds / 60, 1)} min`;
  return `${pyFixed(seconds / 3600, 1)} h`;
}

/** UUIDv7: time-ordered, so ids sort by recording time. */
export function newEventId(): string {
  const bytes = randomBytes(16);
  const ms = BigInt(Date.now());
  for (let i = 0; i < 6; i++) bytes[i] = Number((ms >> BigInt(8 * (5 - i))) & 0xffn);
  bytes[6] = (bytes[6] & 0x0f) | 0x70;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export interface Clock {
  readonly simulated: boolean;
  now(): number;
  format(t: number): string;
}

export class WallClock implements Clock {
  readonly simulated = false;

  now(): number {
    return Date.now() / 1000;
  }

  format(t: number): string {
    return `${new Date(t * 1000).toISOString().slice(0, 19)}Z`;
  }
}

export class SimClock implements Clock {
  readonly simulated = true;
  private current: number;

  constructor(start = 0.0) {
    this.current = start;
  }

  now(): number {
    return this.current;
  }

  advanceTo(t: number): void {
    if (t < this.current) throw new Error('simulated clock cannot run backwards');
    this.current = t;
  }

  format(t: number): string {
    const s = Math.round(t);
    const pad = (n: number) => String(n).padStart(2, '0');
    return `T+${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
  }
}
