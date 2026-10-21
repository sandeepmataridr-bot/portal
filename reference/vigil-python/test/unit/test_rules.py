import unittest
from pathlib import Path

from shared.vigil_rules import RuleError, RuleInstance, compile_source

ROOT = Path(__file__).resolve().parents[2]
OXY = (ROOT / "core/cds_runtime/rules/ecmo_oxygenator.vrl").read_text(encoding="utf-8")

FLOW_RULE = """
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
"""


class CompileTests(unittest.TestCase):
    def test_plan_example_compiles(self):
        [rule] = compile_source(OXY)
        self.assertEqual(rule.key, "ecmo.oxygenator_failure_trend v3")
        self.assertEqual(rule.priority, "MEDIUM")
        self.assertFalse(rule.safety_floor)
        self.assertEqual(rule.when_hold, 900)
        self.assertEqual(rule.clear_hold, 1800)
        self.assertEqual(rule.signals, {"ECMO_OXY_DELTA_P", "BG_POST_OXY_PO2", "ECMO_SWEEP_FLOW"})

    def test_unit_mismatch_is_compile_error(self):
        with self.assertRaisesRegex(RuleError, "unit mismatch: post_o2 is in mmHg but the limit is in kPa"):
            compile_source(OXY.replace("post_o2 < 200 mmHg", "post_o2 < 26 kPa"))

    def test_missing_unit_is_compile_error(self):
        with self.assertRaisesRegex(RuleError, "missing unit"):
            compile_source(OXY.replace("post_o2 < 200 mmHg", "post_o2 < 200"))

    def test_rule_needs_firing_and_non_firing_tests(self):
        text = "\n".join(l for l in OXY.splitlines() if "expect no_fire" not in l)
        with self.assertRaisesRegex(RuleError, "at least one 'expect fire' and one 'expect no_fire'"):
            compile_source(text)

    def test_safety_floor_only_class_c(self):
        with self.assertRaisesRegex(RuleError, r"trend\(\) is not Class C"):
            compile_source(OXY.replace("safety_floor false", "safety_floor true"))

    def test_unknown_signal(self):
        with self.assertRaisesRegex(RuleError, "unknown signal 'NOPE'"):
            compile_source(FLOW_RULE.replace("ECMO_BLOOD_FLOW", "NOPE"))

    def test_setting_function_needs_setting_signal(self):
        with self.assertRaisesRegex(RuleError, "does not accept numeric signal"):
            compile_source(OXY.replace("setting(ECMO_SWEEP_FLOW)", "setting(ECMO_BLOOD_FLOW)"))

    def test_syntax_error_has_location(self):
        with self.assertRaises(RuleError) as cm:
            compile_source(FLOW_RULE.replace("flow < 1.5", "flow 1.5"), "f.vrl")
        self.assertTrue(str(cm.exception).startswith("f.vrl:8:"))

    def test_explain_renders_unit_once(self):
        [rule] = compile_source(OXY)
        from shared.vigil_rules.functions import TrendValue
        text = rule.explain_text({"dp": TrendValue(4.12, 50), "post_o2": 176.0, "sweep": None})
        self.assertEqual(text, "Oxygenator pressure drop rising 4.1 mmHg/h with post-oxygenator PO2 176 mmHg.")


class RuntimeTests(unittest.TestCase):
    def setUp(self):
        [self.rule] = compile_source(FLOW_RULE)
        self.inst = RuleInstance(self.rule, "enc-1", 0.0)

    def run_series(self, values):
        """values: list of (t, flow); one tick per second from 0 to the last t."""
        events = []
        series = dict(values)
        for t in range(int(max(series)) + 1):
            if t in series:
                self.inst.observe("ECMO_BLOOD_FLOW", float(t), series[t], 1.0, [])
            ev = self.inst.evaluate(float(t))
            if ev:
                events.append((ev.kind, t))
        return events

    def test_persistence_and_hysteresis(self):
        series = [(t, 4.0) for t in range(0, 10)]
        series += [(t, 1.0) for t in range(10, 30)]       # low from t=10
        series += [(t, 1.8) for t in range(30, 50)]       # between thresholds: stays active
        series += [(t, 3.0) for t in range(50, 70)]       # above clear threshold from t=50
        events = self.run_series(series)
        self.assertEqual(events, [("fire", 15), ("clear", 60)])

    def test_short_dip_does_not_fire(self):
        series = [(t, 4.0) for t in range(0, 60)]
        series[20:24] = [(t, 1.0) for t in range(20, 24)]
        self.assertEqual(self.run_series(series), [])

    def test_stale_data_neither_fires_nor_clears(self):
        # Fires on low flow; then data stops. After max_age the value is unknown,
        # which must not clear the alert. Then one isolated low sample after the
        # gap is too short to fire again (the rule is still active anyway).
        events = self.run_series([(t, 1.0) for t in range(0, 10)] + [(60, 1.0)])
        self.assertEqual(events, [("fire", 5)])
        self.assertTrue(self.inst.active)

    def test_unknown_breaks_persistence(self):
        # max_age 2 s: low 0-2 (known until 4), gap, low 10-12: never 5 s of continuous known-low
        [rule] = compile_source(FLOW_RULE.replace("max_age 5 s", "max_age 2 s"))
        self.inst = RuleInstance(rule, "enc-1", 0.0)
        events = self.run_series([(0, 1.0), (1, 1.0), (2, 1.0), (10, 1.0), (11, 1.0), (12, 1.0), (13, 4.0)])
        self.assertEqual(events, [])


if __name__ == "__main__":
    unittest.main()
