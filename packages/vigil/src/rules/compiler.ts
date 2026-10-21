/**
 * Type checker and compiler: RuleDecl -> CompiledRule.
 *
 * Checks enforced here (plan §5.5):
 *   - units are type-checked; a limit in kPa against a signal in mmHg is a
 *     compile error, never a runtime conversion
 *   - every rule declares at least one firing and one non-firing test
 *   - `safety_floor true` rules may only use Class C functions
 */
import { SIGNALS, THERAPIES, TIME_UNITS, type Signal } from '../codes.js';
import { formatDuration, pyFixed } from '../time.js';
import { RuleError } from './lexer.js';
import { LIBRARY, type FunctionSpec, type OpValue, type Operator, type SettingValue, type TrendValue } from './functions.js';
import type * as n from './nodes.js';
import { parse } from './parser.js';

export const PRIORITIES = ['HIGH', 'MEDIUM', 'LOW', 'ADVISORY'] as const;
const TIME = 'time';
const BARE = '';
const PLACEHOLDER = /\{([A-Za-z_][A-Za-z0-9_]*)(?:\.([A-Za-z_][A-Za-z0-9_]*))?\}/g;
const q = (s: string) => `'${s}'`;

const CMP: Record<string, (a: number, b: number) => boolean> = {
  '>': (a, b) => a > b,
  '<': (a, b) => a < b,
  '>=': (a, b) => a >= b,
  '<=': (a, b) => a <= b,
  '==': (a, b) => a === b,
  '!=': (a, b) => a !== b,
};

const GET: Record<string, (v: OpValue) => number> = {
  [BARE]: (v) => v as number,
  slope: (v) => (v as TrendValue).slope,
  value: (v) => (v as SettingValue).value,
};

export type Values = Record<string, OpValue>;
/** Three-valued condition: true, false, or null (unknown). */
export type Cond = (vals: Values, now: number) => boolean | null;

/** Readable parts of a function result and their units ('' = the bare value). */
function fieldsOf(result: FunctionSpec['result'], sig: Signal): Record<string, string> {
  switch (result) {
    case 'trend':
      return { slope: `${sig.unit}/h` };
    case 'quantity':
      return { [BARE]: sig.unit };
    case 'setting':
      return { value: sig.unit };
    case 'duration':
      return { [BARE]: TIME };
  }
}

export function formatValue(x: number, unit: string, withUnit = true): string {
  if (unit === TIME) return formatDuration(x);
  const num = Math.abs(x) >= 100 ? pyFixed(x, 0) : pyFixed(x, 1);
  if (!withUnit) return num;
  return unit === '%' ? `${num}%` : `${num} ${unit}`;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
}

export interface LetBinding {
  name: string;
  spec: FunctionSpec;
  signal: Signal;
  args: Record<string, number>;
  fields: Record<string, string>;
}

export interface RuleTestSpec {
  name: string;
  scenario: string;
  expect: 'fire' | 'no_fire';
  within: number | null;
}

export class CompiledRule {
  constructor(
    readonly ruleId: string,
    readonly version: number,
    readonly owner: string,
    readonly therapy: string,
    readonly priority: (typeof PRIORITIES)[number],
    readonly safetyFloor: boolean,
    readonly source: string,
    readonly lets: LetBinding[],
    readonly when: Cond,
    readonly whenHold: number,
    readonly clear: Cond | null,
    readonly clearHold: number,
    readonly explain: string,
    readonly tests: RuleTestSpec[],
  ) {}

  get key(): string {
    return `${this.ruleId} v${this.version}`;
  }

  get signals(): Set<string> {
    return new Set(this.lets.map((b) => b.signal.name));
  }

  newOperators(start: number): Map<string, Operator> {
    return new Map(this.lets.map((b) => [b.name, b.spec.factory(b.args, start)]));
  }

  explainText(values: Values): string {
    const bindings = new Map(this.lets.map((b) => [b.name, b]));
    return this.explain.replace(PLACEHOLDER, (match: string, name: string, fld: string | undefined, offset: number) => {
      const v = values[name];
      if (v === null || v === undefined) return 'unknown';
      const key = fld ?? BARE;
      const unit = bindings.get(name)!.fields[key];
      // "{dp.slope} mmHg/h" already spells the unit; "{post_o2}" does not.
      const rest = this.explain.slice(offset + match.length);
      const written = new RegExp(`^\\s*${escapeRegExp(unit)}(?![A-Za-z0-9_/])`).test(rest);
      return formatValue(GET[key](v), unit, !written);
    });
  }
}

class Compiler {
  private readonly lets = new Map<string, LetBinding>();

  constructor(private readonly d: n.RuleDecl) {}

  private err(msg: string, line = 0, col = 0): never {
    throw new RuleError(`${this.d.ruleId}: ${msg}`, this.d.source, line || this.d.line, col);
  }

  compile(): CompiledRule {
    const d = this.d;
    if (!(PRIORITIES as readonly string[]).includes(d.priority)) {
      this.err(`priority must be one of ${PRIORITIES.join(', ')}`);
    }
    if (!THERAPIES.has(d.therapy)) {
      this.err(`unknown therapy ${q(d.therapy)}; known: ${[...THERAPIES].sort().join(', ')}`);
    }
    for (const let_ of d.lets) this.bind(let_);
    const when = this.expr(d.when!.expr);
    const whenHold = this.hold(d.when!.hold);
    let clear: Cond | null = null;
    let clearHold = 0.0;
    if (d.clearWhen) {
      clear = this.expr(d.clearWhen.expr);
      clearHold = this.hold(d.clearWhen.hold);
    }
    this.checkExplain();
    return new CompiledRule(
      d.ruleId,
      d.version,
      d.owner,
      d.therapy,
      d.priority as (typeof PRIORITIES)[number],
      d.safetyFloor,
      d.source,
      [...this.lets.values()],
      when,
      whenHold,
      clear,
      clearHold,
      d.explain,
      this.tests(),
    );
  }

  private bind(let_: n.Let): void {
    const call = let_.call;
    const spec = LIBRARY[call.func];
    if (!spec) this.err(`unknown function ${q(call.func)}; known: ${Object.keys(LIBRARY).join(', ')}`, call.line, call.col);
    if (this.lets.has(let_.name)) this.err(`${q(let_.name)} is defined twice`, let_.line, let_.col);
    const sig = SIGNALS[call.signal];
    if (!sig) this.err(`unknown signal ${q(call.signal)}`, call.line, call.col);
    if (!spec.signalKinds.has(sig.kind)) {
      this.err(`${call.func}() does not accept ${sig.kind} signal ${sig.name}`, call.line, call.col);
    }
    if (this.d.safetyFloor && !spec.classC) {
      const allowed = Object.values(LIBRARY)
        .filter((s) => s.classC)
        .map((s) => s.name)
        .join(', ');
      this.err(
        `safety_floor rules may only use Class C functions (${allowed}); ${call.func}() is not Class C`,
        call.line,
        call.col,
      );
    }
    const args: Record<string, number> = {};
    for (const [key, qty] of call.kwargs) {
      const kind = spec.kwargs[key];
      if (!kind) this.err(`${call.func}() has no argument ${q(key)}`, qty.line, qty.col);
      args[key] = this.literal(qty, kind);
    }
    const missing = spec.required.filter((k) => !(k in args));
    if (missing.length) this.err(`${call.func}() needs ${[...missing].sort().join(', ')}`, call.line, call.col);
    this.lets.set(let_.name, { name: let_.name, spec, signal: sig, args, fields: fieldsOf(spec.result, sig) });
  }

  private literal(qty: n.Quantity, kind: 'duration' | 'fraction'): number {
    if (kind === 'duration') {
      if (qty.unit === null || !(qty.unit in TIME_UNITS)) {
        this.err('expected a duration such as 30 s, 15 min or 6h', qty.line, qty.col);
      }
      return qty.value * TIME_UNITS[qty.unit];
    }
    if (qty.unit !== null || !(qty.value >= 0.0 && qty.value <= 1.0)) {
      this.err('expected a plain number between 0 and 1', qty.line, qty.col);
    }
    return qty.value;
  }

  private hold(qty: n.Quantity | null): number {
    return qty === null ? 0.0 : this.literal(qty, 'duration');
  }

  private binding(name: string, line: number, col: number): LetBinding {
    const b = this.lets.get(name);
    if (!b) this.err(`unknown name ${q(name)}; define it with let`, line, col);
    return b;
  }

  private expr(e: n.Expr): Cond {
    switch (e.type) {
      case 'compare':
        return this.compare(e);
      case 'predicate':
        return this.predicate(e);
      case 'and': {
        const parts = e.items.map((x) => this.expr(x));
        return (vals, now) => {
          const results = parts.map((p) => p(vals, now));
          if (results.some((r) => r === false)) return false;
          return results.some((r) => r === null) ? null : true;
        };
      }
      case 'or': {
        const parts = e.items.map((x) => this.expr(x));
        return (vals, now) => {
          const results = parts.map((p) => p(vals, now));
          if (results.some((r) => r === true)) return true;
          return results.some((r) => r === null) ? null : false;
        };
      }
      case 'not': {
        const inner = this.expr(e.item);
        return (vals, now) => {
          const r = inner(vals, now);
          return r === null ? null : !r;
        };
      }
    }
  }

  private compare(c: n.Compare): Cond {
    const ref = c.left;
    const qty = c.right;
    const b = this.binding(ref.name, ref.line, ref.col);
    const fields = b.fields;
    const label = ref.name + (ref.field ? `.${ref.field}` : '');
    const key = ref.field ?? BARE;
    if (!(key in fields)) {
      const options = Object.keys(fields)
        .map((f) => (f ? `${ref.name}.${f}` : ref.name))
        .join(', ');
      this.err(`cannot compare ${label}; use ${options}`, ref.line, ref.col);
    }
    const unit = fields[key];
    let threshold: number;
    if (unit === TIME) {
      threshold = this.literal(qty, 'duration');
    } else {
      if (qty.unit === null) this.err(`missing unit: ${label} is in ${unit}`, qty.line, qty.col);
      if (qty.unit !== unit) {
        this.err(
          `unit mismatch: ${label} is in ${unit} but the limit is in ${qty.unit}; ` +
            `rules never convert units, write the limit in ${unit}`,
          qty.line,
          qty.col,
        );
      }
      threshold = qty.value;
    }
    const name = ref.name;
    const get = GET[key];
    const cmp = CMP[c.op];
    return (vals) => {
      const v = vals[name];
      return v === null || v === undefined ? null : cmp(get(v), threshold);
    };
  }

  private predicate(p: n.Predicate): Cond {
    const b = this.binding(p.target, p.line, p.col);
    if (b.spec.result !== 'setting' || p.method !== 'unchanged_for') {
      this.err(`${p.target}.${p.method}() is not available; only setting().unchanged_for(<duration>)`, p.line, p.col);
    }
    const duration = this.literal(p.arg, 'duration');
    const name = p.target;
    return (vals, now) => {
      const v = vals[name] as SettingValue | null;
      return v === null || v === undefined ? null : now - v.changedAt >= duration;
    };
  }

  private checkExplain(): void {
    for (const m of this.d.explain.matchAll(PLACEHOLDER)) {
      const b = this.lets.get(m[1]);
      if (!b || !((m[2] ?? BARE) in b.fields)) this.err(`explain refers to unknown value ${m[0]}`);
    }
  }

  private tests(): RuleTestSpec[] {
    const tests: RuleTestSpec[] = [];
    const names = new Set<string>();
    for (const t of this.d.tests) {
      if (names.has(t.name)) this.err(`test ${q(t.name)} is defined twice`, t.line);
      names.add(t.name);
      const within = t.within ? this.literal(t.within, 'duration') : null;
      tests.push({ name: t.name, scenario: t.scenario, expect: t.expect, within });
    }
    if (!tests.some((t) => t.expect === 'fire') || !tests.some((t) => t.expect === 'no_fire')) {
      this.err("every rule needs at least one 'expect fire' and one 'expect no_fire' test");
    }
    return tests;
  }
}

export function compileSource(text: string, source = '<rule>'): CompiledRule[] {
  return parse(text, source).map((decl) => new Compiler(decl).compile());
}

/** Compiles several rule files; rule ids must be unique across all of them. */
export function compileFiles(files: { source: string; text: string }[]): CompiledRule[] {
  const rules: CompiledRule[] = [];
  const seen = new Map<string, string>();
  for (const file of files) {
    for (const rule of compileSource(file.text, file.source)) {
      const other = seen.get(rule.ruleId);
      if (other !== undefined) throw new RuleError(`duplicate rule id ${rule.ruleId} (also in ${other})`, file.source);
      seen.set(rule.ruleId, file.source);
      rules.push(rule);
    }
  }
  return rules;
}
