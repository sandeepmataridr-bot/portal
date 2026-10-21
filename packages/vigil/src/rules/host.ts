/**
 * Deterministic rule runtime. The same host runs the safety floor and the
 * core rule set; only the rule set and alert origin differ.
 */
import type { CompiledRule, Values } from './compiler.js';
import type { Operator } from './functions.js';

export interface RuleEvent {
  kind: 'fire' | 'clear';
  rule: CompiledRule;
  encounterId: string;
  at: number;
  explanation: string;
}

/** One rule for one encounter: operators plus the persistence/hysteresis state machine. */
export class RuleInstance {
  readonly ops: Map<string, Operator>;
  private readonly bySignal = new Map<string, Operator[]>();
  active = false;
  private since: number | null = null;

  constructor(
    readonly rule: CompiledRule,
    readonly encounterId: string,
    start: number,
  ) {
    this.ops = rule.newOperators(start);
    for (const b of rule.lets) {
      const list = this.bySignal.get(b.signal.name) ?? [];
      list.push(this.ops.get(b.name)!);
      this.bySignal.set(b.signal.name, list);
    }
  }

  observe(signal: string, t: number, value: number, sqi: number, flags: readonly string[]): void {
    for (const op of this.bySignal.get(signal) ?? []) op.observe(t, value, sqi, flags);
  }

  evaluate(now: number): RuleEvent | null {
    const r = this.rule;
    const values: Values = {};
    for (const [name, op] of this.ops) values[name] = op.value(now);
    let cond: boolean | null;
    let hold: number;
    let kind: RuleEvent['kind'];
    if (!this.active) {
      [cond, hold, kind] = [r.when(values, now), r.whenHold, 'fire'];
    } else if (r.clear !== null) {
      [cond, hold, kind] = [r.clear(values, now), r.clearHold, 'clear'];
    } else {
      const w = r.when(values, now);
      [cond, hold, kind] = [w === null ? null : !w, 0.0, 'clear'];
    }

    if (cond !== true) {
      this.since = null;
      return null;
    }
    if (this.since === null) this.since = now;
    if (now - this.since < hold) return null;
    this.since = null;
    this.active = kind === 'fire';
    return { kind, rule: r, encounterId: this.encounterId, at: now, explanation: this.active ? r.explainText(values) : '' };
  }
}

export class RuleHost {
  readonly rules: CompiledRule[];
  private readonly instances = new Map<string, RuleInstance[]>();

  constructor(rules: Iterable<CompiledRule>) {
    this.rules = [...rules];
  }

  openEncounter(encounterId: string, therapies: Set<string>, start: number): void {
    const insts = this.instances.get(encounterId) ?? [];
    this.instances.set(encounterId, insts);
    const have = new Set(insts.map((i) => i.rule.ruleId));
    for (const rule of this.rules) {
      if (therapies.has(rule.therapy) && !have.has(rule.ruleId)) insts.push(new RuleInstance(rule, encounterId, start));
    }
  }

  closeEncounter(encounterId: string): void {
    this.instances.delete(encounterId);
  }

  hasEncounter(encounterId: string): boolean {
    return this.instances.has(encounterId);
  }

  observe(encounterId: string, signal: string, t: number, value: number, sqi: number, flags: readonly string[]): void {
    for (const inst of this.instances.get(encounterId) ?? []) inst.observe(signal, t, value, sqi, flags);
  }

  tick(now: number): RuleEvent[] {
    const events: RuleEvent[] = [];
    for (const insts of this.instances.values()) {
      for (const inst of insts) {
        const ev = inst.evaluate(now);
        if (ev) events.push(ev);
      }
    }
    return events;
  }
}

/** Core CDS runtime: everything that is not part of the safety floor. */
export class CdsRuntime extends RuleHost {
  constructor(rules: CompiledRule[]) {
    const bad = rules.filter((r) => r.safetyFloor).map((r) => r.key);
    if (bad.length) throw new Error(`safety_floor rules belong to the safety engine, not the core: ${bad.join(', ')}`);
    super(rules);
  }
}

/** Safety floor: hosts `safety_floor true` rules only (Class C functions). */
export class SafetyEngine extends RuleHost {
  constructor(rules: CompiledRule[]) {
    const bad = rules.filter((r) => !r.safetyFloor).map((r) => r.key);
    if (bad.length) throw new Error(`the safety engine only hosts safety_floor rules; not: ${bad.join(', ')}`);
    super(rules);
  }
}
