/**
 * Built-in rule functions.
 *
 * Each function is a stateful operator per (rule, encounter): it receives the
 * encounter's observations for one signal and yields a value at evaluation
 * time, or null when the value is unknown (no data, stale data, too little
 * coverage). Unknown never fires and never clears a rule.
 *
 * Functions marked classC are simple enough for safety-floor rules (IEC 62304
 * Class C); the compiler rejects anything else in a `safety_floor true` rule.
 *
 * Arithmetic order matches reference/vigil-python exactly so both engines
 * produce identical rule hits on the same scenario (ADR-004).
 */
import { SignalKind } from '../codes.js';

export interface TrendValue {
  /** signal unit per hour */
  slope: number;
  n: number;
}

export interface SettingValue {
  value: number;
  changedAt: number;
}

export type OpValue = number | TrendValue | SettingValue | null;

export interface Operator {
  observe(t: number, value: number, sqi: number, flags: readonly string[]): void;
  value(now: number): OpValue;
}

/** Least-squares slope over a sliding window, using only samples with sqi >= minSqi. */
export class TrendOp implements Operator {
  static readonly MIN_POINTS = 6;
  private readonly ts: number[] = [];
  private readonly xs: number[] = [];
  private readonly ys: number[] = [];
  private head = 0;
  private n = 0;
  private sx = 0;
  private sy = 0;
  private sxx = 0;
  private sxy = 0;

  constructor(
    private readonly window: number,
    private readonly minSqi: number,
    private readonly t0: number,
  ) {}

  observe(t: number, value: number, sqi: number): void {
    if (sqi < this.minSqi) return;
    const x = (t - this.t0) / 3600.0;
    this.ts.push(t);
    this.xs.push(x);
    this.ys.push(value);
    this.n += 1;
    this.sx += x;
    this.sy += value;
    this.sxx += x * x;
    this.sxy += x * value;
  }

  value(now: number): TrendValue | null {
    while (this.head < this.ts.length && this.ts[this.head] < now - this.window) {
      const x = this.xs[this.head];
      const y = this.ys[this.head];
      this.head += 1;
      this.n -= 1;
      this.sx -= x;
      this.sy -= y;
      this.sxx -= x * x;
      this.sxy -= x * y;
    }
    if (this.head > 4096 && this.head * 2 > this.ts.length) this.compact();
    if (this.n < TrendOp.MIN_POINTS) return null;
    // not enough coverage of the window to trust a slope
    if (this.ts[this.ts.length - 1] - this.ts[this.head] < this.window / 2) return null;
    const denom = this.n * this.sxx - this.sx * this.sx;
    if (denom <= 1e-12) return null;
    return { slope: (this.n * this.sxy - this.sx * this.sy) / denom, n: this.n };
  }

  private compact(): void {
    this.ts.splice(0, this.head);
    this.xs.splice(0, this.head);
    this.ys.splice(0, this.head);
    this.head = 0;
  }
}

export class LatestOp implements Operator {
  private last: [number, number] | null = null;

  constructor(
    private readonly maxAge: number,
    private readonly minSqi: number,
  ) {}

  observe(t: number, value: number, sqi: number): void {
    if (sqi >= this.minSqi && (this.last === null || t >= this.last[0])) this.last = [t, value];
  }

  value(now: number): number | null {
    if (this.last === null || now - this.last[0] > this.maxAge) return null;
    return this.last[1];
  }
}

export class SettingOp implements Operator {
  private current: SettingValue | null = null;

  observe(t: number, value: number): void {
    if (this.current === null || value !== this.current.value) this.current = { value, changedAt: t };
  }

  value(): SettingValue | null {
    return this.current;
  }
}

/** Seconds since the last sample of the signal (or since the encounter opened). */
export class DataAgeOp implements Operator {
  private last: number;

  constructor(start: number) {
    this.last = start;
  }

  observe(t: number): void {
    this.last = Math.max(this.last, t);
  }

  value(now: number): number {
    return Math.max(0.0, now - this.last);
  }
}

export type ArgKind = 'duration' | 'fraction';
export type ResultKind = 'trend' | 'quantity' | 'setting' | 'duration';

export interface FunctionSpec {
  name: string;
  classC: boolean;
  signalKinds: ReadonlySet<SignalKind>;
  kwargs: Record<string, ArgKind>;
  required: readonly string[];
  result: ResultKind;
  factory: (args: Record<string, number>, start: number) => Operator;
}

const NUMERIC = new Set([SignalKind.NUMERIC, SignalKind.LAB]);

const SPECS: FunctionSpec[] = [
  {
    name: 'trend',
    classC: false,
    signalKinds: new Set([SignalKind.NUMERIC]),
    kwargs: { window: 'duration', min_sqi: 'fraction' },
    required: ['window'],
    result: 'trend',
    factory: (a, start) => new TrendOp(a.window, a.min_sqi ?? 0.0, start),
  },
  {
    name: 'latest',
    classC: true,
    signalKinds: NUMERIC,
    kwargs: { max_age: 'duration', min_sqi: 'fraction' },
    required: ['max_age'],
    result: 'quantity',
    factory: (a) => new LatestOp(a.max_age, a.min_sqi ?? 0.0),
  },
  {
    name: 'setting',
    classC: true,
    signalKinds: new Set([SignalKind.SETTING]),
    kwargs: {},
    required: [],
    result: 'setting',
    factory: () => new SettingOp(),
  },
  {
    name: 'data_age',
    classC: true,
    signalKinds: new Set(Object.values(SignalKind)),
    kwargs: {},
    required: [],
    result: 'duration',
    factory: (_a, start) => new DataAgeOp(start),
  },
];

export const LIBRARY: Record<string, FunctionSpec> = Object.fromEntries(SPECS.map((s) => [s.name, s]));
