"""Replay suite: every test declared in every rule must pass against its scenario."""
import unittest
from pathlib import Path

from core.cds_runtime import load_core_rules
from edge.safety_engine import load_safety_rules
from shared.vigil_rules import compile_source
from tools.rule_tests import run_rule_test, run_rule_tests


class RuleScenarioTests(unittest.TestCase):
    def test_all_declared_rule_tests_pass(self):
        results = run_rule_tests(load_safety_rules() + load_core_rules())
        failures = [f"{r.rule} / {r.test}: {r.detail}" for r in results if not r.passed]
        self.assertFalse(failures, "\n".join(failures))

    def test_flush_scenario_needs_sqi_gating(self):
        """Without min_sqi the flush artifacts look like a rising trend: proves the negative test bites."""
        [core] = load_core_rules()
        text = Path(core.source).read_text(encoding="utf-8").replace(", min_sqi 0.8", "")
        [ungated] = compile_source(text)
        test = next(t for t in ungated.tests if t.scenario == "ecmo/flush_artifact")
        self.assertFalse(run_rule_test(ungated, test).passed)


if __name__ == "__main__":
    unittest.main()
