"""Runs the `test` clauses declared inside rules against their scenarios.

Each test plays its scenario through the full edge pipeline (simulated driver,
normalizer, SQI, rule host) with only the rule under test loaded. Always runs
with simulators and an in-memory node, whatever the configured mode; it writes
no audit records and never contacts nurse call.

  expect fire within W : first firing is at or after the scenario's annotated
                         onset and no later than onset + W
  expect no_fire       : the rule never fires
"""
from __future__ import annotations

from dataclasses import dataclass

from edge.node import EdgeNode
from shared.vigil_rules import CompiledRule, RuleTestSpec
from shared.vigil_time import SimClock, format_duration
from simulators.player import frames
from simulators.scenario import load_scenario

from .modes import play, setup_scenario


@dataclass
class RuleTestResult:
    rule: str
    test: str
    scenario: str
    passed: bool
    detail: str


def run_rule_test(rule: CompiledRule, test: RuleTestSpec, _cache: dict | None = None) -> RuleTestResult:
    cache = {} if _cache is None else _cache
    if test.scenario not in cache:
        sc = load_scenario(test.scenario)
        cache[test.scenario] = (sc, frames(sc))
    scenario, stream = cache[test.scenario]

    clock = SimClock(0.0)
    node = EdgeNode(live_mode=False, tenant_id="sim-ruletest", unit_id="sim-ruletest", edge_node_id="sim-ruletest",
                    clock=clock, safety_rules=[rule] if rule.safety_floor else [],
                    core_rules=[] if rule.safety_floor else [rule])
    setup_scenario(node, scenario)
    fires = [tr.at for tr in play(node, scenario, clock, stream=stream) if tr.kind == "raised"]
    fmt = clock.format

    if test.expect == "no_fire":
        ok = not fires
        detail = "no firing" if ok else f"fired at {', '.join(fmt(t) for t in fires)}"
    elif not scenario.annotations:
        ok, detail = False, "scenario has no annotated onset to measure 'within' from"
    else:
        onset = scenario.annotations[0][0]
        deadline = onset + test.within
        if not fires:
            ok, detail = False, f"never fired (onset {fmt(onset)})"
        elif fires[0] < onset:
            ok, detail = False, f"fired early at {fmt(fires[0])}, before onset {fmt(onset)}"
        elif fires[0] > deadline:
            ok, detail = False, f"fired late at {fmt(fires[0])}, deadline {fmt(deadline)}"
        else:
            ok, detail = True, f"fired at {fmt(fires[0])}, {format_duration(fires[0] - onset)} after onset"
    return RuleTestResult(rule.key, test.name, test.scenario, ok, detail)


def run_rule_tests(rules: list[CompiledRule]) -> list[RuleTestResult]:
    cache: dict = {}
    return [run_rule_test(rule, test, cache) for rule in rules for test in rule.tests]
