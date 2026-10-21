/**
 * Replay suite (plan §7, ADR-004 "identical rule hits").
 *
 * 1. Every bundled scenario, played through the TS engine with every rule
 *    loaded, must reproduce the Python reference prototype's golden output
 *    exactly: the same device frames (byte for byte), the same stats and the
 *    same alert transitions at the same times with the same text. Regenerate
 *    the golden files with `py packages/vigil/scripts/export_golden.py`.
 * 2. Every `test` clause declared inside a rule must pass.
 */
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { listScenarios, loadBundledRules, loadScenario, ruleSourceText } from './assets.js';
import { VigilEngine } from './engine.js';
import { MonitorHub } from './monitor.js';
import { play, runRuleTest, runRuleTests, setupScenario } from './modes.js';
import { compileSource, type CompiledRule } from './rules/compiler.js';
import { frames } from './sim/player.js';
import { SimClock, pyFloatRepr } from './time.js';

const GOLDEN = new URL('../test/golden/', import.meta.url);

interface Golden {
  scenario: string;
  frames: { count: number; sha256: string; first: [number, string, string][] };
  stats: Record<string, number>;
  transitions: { kind: string; rule: string; priority: string; origin: string; at: number; explanation: string }[];
}

function golden(file: string): Golden {
  return JSON.parse(readFileSync(new URL(file, GOLDEN), 'utf-8'));
}

function run(name: string, safety: CompiledRule[], core: CompiledRule[]) {
  const sc = loadScenario(name);
  const stream = frames(sc);
  const hash = createHash('sha256');
  for (const f of stream) hash.update(`${pyFloatRepr(f.t)}|${f.driverId}|${f.frame}\n`);
  const clock = new SimClock(0.0);
  const engine = new VigilEngine({
    liveMode: false,
    tenantId: 'sim-golden',
    unitId: 'sim-golden',
    nodeId: 'sim-golden',
    clock,
    safetyRules: safety,
    coreRules: core,
  });
  setupScenario(engine, sc);
  const transitions = play(engine, sc, clock, stream);
  return {
    frames: { count: stream.length, sha256: hash.digest('hex'), first: stream.slice(0, 4).map((f) => [f.t, f.driverId, f.frame]) },
    stats: Object.fromEntries([...engine.stats.entries()].sort(([a], [b]) => (a < b ? -1 : 1))),
    transitions: transitions.map((tr) => ({
      kind: tr.kind,
      rule: tr.alert.problemKey,
      priority: tr.alert.priority,
      origin: tr.alert.origin,
      at: tr.at,
      explanation: tr.alert.explanation,
    })),
  };
}

describe('golden parity with the Python reference', () => {
  const { safety, core } = loadBundledRules();

  it('has a golden file for every bundled scenario', () => {
    const files = readdirSync(GOLDEN).filter((f) => !f.startsWith('ungated__'));
    expect(files.sort()).toEqual(listScenarios().map((s) => `${s.replace('/', '__')}.json`));
  });

  for (const name of listScenarios()) {
    it(`reproduces ${name}`, () => {
      const want = golden(`${name.replace('/', '__')}.json`);
      const got = run(name, safety, core);
      expect(got.frames.first).toEqual(want.frames.first);
      expect(got.frames.count).toBe(want.frames.count);
      expect(got.frames.sha256).toBe(want.frames.sha256);
      expect(got.stats).toEqual(want.stats);
      expect(got.transitions).toEqual(want.transitions);
    });
  }

  it('reproduces the ungated flush run (the negative test bites without SQI gating)', () => {
    const [rule] = compileSource(ruleSourceText('rules/ecmo_oxygenator.vrl').replace(', min_sqi 0.8', ''));
    const want = golden('ungated__flush_artifact.json');
    const got = run('ecmo/flush_artifact', [], [rule]);
    expect(want.transitions.length).toBeGreaterThan(0);
    expect(got.transitions).toEqual(want.transitions);
  });
});

describe('declared rule tests', () => {
  const { safety, core } = loadBundledRules();

  it('pass for every bundled rule', () => {
    const results = runRuleTests([...safety, ...core]);
    expect(results).toHaveLength(8);
    expect(results.filter((r) => !r.passed).map((r) => `${r.rule} / ${r.test}: ${r.detail}`)).toEqual([]);
  });

  it('fail for the flush scenario without SQI gating', () => {
    const [ungated] = compileSource(ruleSourceText('rules/ecmo_oxygenator.vrl').replace(', min_sqi 0.8', ''));
    const test = ungated.tests.find((t) => t.scenario === 'ecmo/flush_artifact')!;
    expect(runRuleTest(ungated, test).passed).toBe(false);
  });
});

describe('monitor snapshot', () => {
  it('summarises a flow-loss run', () => {
    const { safety, core } = loadBundledRules();
    const sc = loadScenario('ecmo/flow_loss_01');
    const clock = new SimClock(0.0);
    const engine = new VigilEngine({
      liveMode: false,
      tenantId: 'sim-t',
      unitId: 'sim-u',
      nodeId: 'sim-n',
      clock,
      safetyRules: safety,
      coreRules: core,
    });
    const hub = new MonitorHub(engine, { runId: 1, scenario: sc });
    setupScenario(engine, sc);
    play(engine, sc, clock);
    const s = hub.snapshot(1800, [900, 1800], null, 'test');
    if (!s.ready) throw new Error('not ready');
    expect(s.mode).toBe('test');
    const [m] = s.machines;
    expect([m.deviceId, m.kind, m.status]).toEqual(['sim-ecmo-04', 'ECMO console', 'ok']);
    expect(m.signals.map((x) => x.code)).toEqual(['ECMO_BLOOD_FLOW', 'ECMO_OXY_DELTA_P', 'ECMO_SWEEP_FLOW']);
    expect(m.signals[0].points.length).toBeLessThanOrEqual(400);
    expect(s.operatingLevel).toBe(0);
    expect(s.log.map((e) => e.kind)).toEqual(['resolved', 'raised']);
    expect(s.alerts).toEqual([]);
  });
});
