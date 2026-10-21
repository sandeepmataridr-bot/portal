/**
 * Scenario playback (reference: tools/modes.py and tools/rule_tests.py).
 *
 *   setupScenario   associations + therapy episode for a scenario's devices
 *   play            synchronous, as-fast-as-possible playback (replay suite)
 *   runRuleTests    the `test` clauses declared inside the rules
 */
import type { Transition } from './alerts.js';
import { loadScenario } from './assets.js';
import { AssociationMethod } from './contracts.js';
import { VigilEngine } from './engine.js';
import type { CompiledRule, RuleTestSpec } from './rules/compiler.js';
import { frames, type SimFrame } from './sim/player.js';
import type { Scenario } from './sim/scenario.js';
import { SimClock, formatDuration } from './time.js';

export function setupScenario(engine: VigilEngine, scenario: Scenario): void {
  const episode = {
    episodeId: scenario.episodeId,
    encounterId: scenario.encounterId,
    therapy: scenario.therapy,
    start: 0.0,
    end: null,
    attributes: scenario.attributes,
  };
  for (const dev of scenario.devices) {
    engine.addAssociation(
      {
        associationId: `as-${dev.deviceId}`,
        deviceId: dev.deviceId,
        encounterId: scenario.encounterId,
        therapyEpisodeId: scenario.episodeId,
        start: 0.0,
        end: null,
        method: AssociationMethod.BARCODE,
        confirmed: dev.confirmed,
        confirmedBy: dev.confirmed ? 'scenario' : '',
      },
      episode,
    );
  }
}

/**
 * Steps a scenario forward. Feeds every frame with time <= t, then ticks at
 * t, for t = 0, tick, 2*tick, ... duration. Used both by `play` (all at once)
 * and by the API's real-time TEST controller (a few steps per timer callback).
 */
export class ScenarioCursor {
  private i = 0;
  private k = 0;
  readonly steps: number;

  constructor(
    readonly engine: VigilEngine,
    readonly scenario: Scenario,
    readonly clock: SimClock,
    readonly stream: SimFrame[] = frames(scenario),
    readonly tickSeconds = 1.0,
  ) {
    this.steps = Math.floor(scenario.duration / tickSeconds);
  }

  get done(): boolean {
    return this.k > this.steps;
  }

  /** Simulated time of the next step. */
  get nextT(): number {
    return this.k * this.tickSeconds;
  }

  step(): Transition[] {
    if (this.done) return [];
    const t = this.k * this.tickSeconds;
    this.k += 1;
    this.clock.advanceTo(t);
    while (this.i < this.stream.length && this.stream[this.i].t <= t) {
      this.engine.receive(this.stream[this.i].driverId, this.stream[this.i].frame);
      this.i += 1;
    }
    return this.engine.tick(t);
  }

  /** Runs every step whose time is <= t. */
  advanceTo(t: number): Transition[] {
    const out: Transition[] = [];
    while (!this.done && this.nextT <= t) out.push(...this.step());
    return out;
  }
}

export function play(engine: VigilEngine, scenario: Scenario, clock: SimClock, stream?: SimFrame[]): Transition[] {
  const cursor = new ScenarioCursor(engine, scenario, clock, stream);
  const out: Transition[] = [];
  while (!cursor.done) out.push(...cursor.step());
  return out;
}

export interface RuleTestResult {
  rule: string;
  test: string;
  scenario: string;
  passed: boolean;
  detail: string;
  /** first firing time, if any */
  firedAt: number | null;
}

/**
 * Runs one declared rule test: plays its scenario through the full pipeline
 * (simulated driver, normalizer, SQI, rule host) with only the rule under
 * test loaded. Always simulated and in memory; writes no audit records.
 *
 *   expect fire within W : first firing is at or after the scenario's annotated
 *                          onset and no later than onset + W
 *   expect no_fire       : the rule never fires
 */
export function runRuleTest(
  rule: CompiledRule,
  test: RuleTestSpec,
  cache: Map<string, [Scenario, SimFrame[]]> = new Map(),
): RuleTestResult {
  let entry = cache.get(test.scenario);
  if (!entry) {
    const sc = loadScenario(test.scenario);
    entry = [sc, frames(sc)];
    cache.set(test.scenario, entry);
  }
  const [scenario, stream] = entry;
  const clock = new SimClock(0.0);
  const engine = new VigilEngine({
    liveMode: false,
    tenantId: 'sim-ruletest',
    unitId: 'sim-ruletest',
    nodeId: 'sim-ruletest',
    clock,
    safetyRules: rule.safetyFloor ? [rule] : [],
    coreRules: rule.safetyFloor ? [] : [rule],
  });
  setupScenario(engine, scenario);
  const fires = play(engine, scenario, clock, stream)
    .filter((tr) => tr.kind === 'raised')
    .map((tr) => tr.at);
  const fmt = (t: number) => clock.format(t);
  const result = (passed: boolean, detail: string): RuleTestResult => ({
    rule: rule.key,
    test: test.name,
    scenario: test.scenario,
    passed,
    detail,
    firedAt: fires[0] ?? null,
  });

  if (test.expect === 'no_fire') {
    return fires.length ? result(false, `fired at ${fires.map(fmt).join(', ')}`) : result(true, 'no firing');
  }
  if (!scenario.annotations.length) return result(false, "scenario has no annotated onset to measure 'within' from");
  const onset = scenario.annotations[0][0];
  const deadline = onset + test.within!;
  if (!fires.length) return result(false, `never fired (onset ${fmt(onset)})`);
  if (fires[0] < onset) return result(false, `fired early at ${fmt(fires[0])}, before onset ${fmt(onset)}`);
  if (fires[0] > deadline) return result(false, `fired late at ${fmt(fires[0])}, deadline ${fmt(deadline)}`);
  return result(true, `fired at ${fmt(fires[0])}, ${formatDuration(fires[0] - onset)} after onset`);
}

export function runRuleTests(rules: CompiledRule[]): RuleTestResult[] {
  const cache = new Map<string, [Scenario, SimFrame[]]>();
  return rules.flatMap((rule) => rule.tests.map((test) => runRuleTest(rule, test, cache)));
}
