// Port of reference/vigil-python/test/unit/test_rules.py.
import { describe, expect, it } from 'vitest';
import { ruleSourceText } from './assets.js';
import { RuleError } from './rules/lexer.js';
import { compileSource } from './rules/compiler.js';
import { RuleInstance } from './rules/host.js';

const OXY = ruleSourceText('rules/ecmo_oxygenator.vrl');

const FLOW_RULE = `
rule t.flow v1
  owner "test"
  applies_to therapy ECMO
  priority HIGH
  safety_floor true
  let flow = latest(ECMO_BLOOD_FLOW, max_age 5 s)
  when flow < 1.5 L/min for 5 s
  clear_when flow > 2.0 L/min for 10 s
  explain "flow {flow}"
  test "a" scenario "x" expect fire within 30 s
  test "b" scenario "y" expect no_fire
`;

describe('compiler', () => {
  it('compiles the plan example', () => {
    const [rule] = compileSource(OXY);
    expect(rule.key).toBe('ecmo.oxygenator_failure_trend v3');
    expect(rule.priority).toBe('MEDIUM');
    expect(rule.safetyFloor).toBe(false);
    expect(rule.whenHold).toBe(900);
    expect(rule.clearHold).toBe(1800);
    expect(rule.signals).toEqual(new Set(['ECMO_OXY_DELTA_P', 'BG_POST_OXY_PO2', 'ECMO_SWEEP_FLOW']));
  });

  it('makes a unit mismatch a compile error', () => {
    expect(() => compileSource(OXY.replace('post_o2 < 200 mmHg', 'post_o2 < 26 kPa'))).toThrow(
      /unit mismatch: post_o2 is in mmHg but the limit is in kPa/,
    );
  });

  it('makes a missing unit a compile error', () => {
    expect(() => compileSource(OXY.replace('post_o2 < 200 mmHg', 'post_o2 < 200'))).toThrow(/missing unit/);
  });

  it('requires firing and non-firing tests', () => {
    const text = OXY.split('\n')
      .filter((l) => !l.includes('expect no_fire'))
      .join('\n');
    expect(() => compileSource(text)).toThrow(/at least one 'expect fire' and one 'expect no_fire'/);
  });

  it('allows only Class C functions on the safety floor', () => {
    expect(() => compileSource(OXY.replace('safety_floor false', 'safety_floor true'))).toThrow(/trend\(\) is not Class C/);
  });

  it('rejects unknown signals', () => {
    expect(() => compileSource(FLOW_RULE.replace('ECMO_BLOOD_FLOW', 'NOPE'))).toThrow(/unknown signal 'NOPE'/);
  });

  it('needs a setting signal for setting()', () => {
    expect(() => compileSource(OXY.replace('setting(ECMO_SWEEP_FLOW)', 'setting(ECMO_BLOOD_FLOW)'))).toThrow(
      /does not accept numeric signal/,
    );
  });

  it('reports syntax errors with their location', () => {
    let err: unknown;
    try {
      compileSource(FLOW_RULE.replace('flow < 1.5', 'flow 1.5'), 'f.vrl');
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(RuleError);
    expect(String((err as Error).message)).toMatch(/^f\.vrl:8:/);
  });

  it('renders the unit once in explanations', () => {
    const [rule] = compileSource(OXY);
    const text = rule.explainText({ dp: { slope: 4.12, n: 50 }, post_o2: 176.0, sweep: null });
    expect(text).toBe('Oxygenator pressure drop rising 4.1 mmHg/h with post-oxygenator PO2 176 mmHg.');
  });

  it('rejects duplicate clauses and reserved names', () => {
    expect(() => compileSource(FLOW_RULE.replace('priority HIGH', 'priority HIGH\n  priority LOW'))).toThrow(
      /duplicate 'priority' clause/,
    );
    expect(() => compileSource(FLOW_RULE.replace('let flow', 'let when'))).toThrow(/found keyword 'when'/);
  });
});

describe('runtime', () => {
  function runSeries(inst: RuleInstance, values: [number, number][]): [string, number][] {
    const series = new Map(values);
    const events: [string, number][] = [];
    const last = Math.max(...series.keys());
    for (let t = 0; t <= last; t++) {
      if (series.has(t)) inst.observe('ECMO_BLOOD_FLOW', t, series.get(t)!, 1.0, []);
      const ev = inst.evaluate(t);
      if (ev) events.push([ev.kind, t]);
    }
    return events;
  }
  const range = (a: number, b: number, v: number) => Array.from({ length: b - a }, (_, i): [number, number] => [a + i, v]);
  const fresh = (text = FLOW_RULE) => new RuleInstance(compileSource(text)[0], 'enc-1', 0.0);

  it('applies persistence and hysteresis', () => {
    const series = [...range(0, 10, 4.0), ...range(10, 30, 1.0), ...range(30, 50, 1.8), ...range(50, 70, 3.0)];
    expect(runSeries(fresh(), series)).toEqual([
      ['fire', 15],
      ['clear', 60],
    ]);
  });

  it('ignores a short dip', () => {
    const series = range(0, 60, 4.0);
    series.splice(20, 4, ...range(20, 24, 1.0));
    expect(runSeries(fresh(), series)).toEqual([]);
  });

  it('neither fires nor clears on stale data', () => {
    const inst = fresh();
    expect(runSeries(inst, [...range(0, 10, 1.0), [60, 1.0]])).toEqual([['fire', 5]]);
    expect(inst.active).toBe(true);
  });

  it('breaks persistence on unknown values', () => {
    const inst = fresh(FLOW_RULE.replace('max_age 5 s', 'max_age 2 s'));
    expect(
      runSeries(inst, [
        [0, 1.0],
        [1, 1.0],
        [2, 1.0],
        [10, 1.0],
        [11, 1.0],
        [12, 1.0],
        [13, 4.0],
      ]),
    ).toEqual([]);
  });
});
