import io
import json
import tempfile
import unittest
from pathlib import Path

from core.audit_ledger import AuditLedger, verify
from edge.driver_sdk import DriverHost, ModeViolation
from edge.drivers import SimEcmoDriver
from edge.local_alarm import LogNurseCall
from edge.node import EdgeNode
from shared.vigil_config import ConfigError, Mode, load_config
from shared.vigil_time import SimClock, WallClock
from tools.modes import run_live_mode, run_test_mode

TEST_ONLY = """
live_mode = {live}
[test]
tenant_id = "sim-h"
unit_id = "sim-u"
audit_path = "audit-test.jsonl"
scenario = "ecmo/flow_loss_01"
[live]
tenant_id = ""
unit_id = ""
"""

LIVE_OK = """
live_mode = true
[test]
tenant_id = "sim-h"
unit_id = "sim-u"
[live]
tenant_id = "general-hospital"
unit_id = "cvicu-3"
audit_path = "audit-live.jsonl"
nurse_call = "log"
nurse_call_log = "nc.log"
hl7_port = 2575
[live.hl7_codes]
"MDC:999" = "ECMO_BLOOD_FLOW"
[[live.associations]]
device_id = "ecmo-7"
encounter_id = "ENC-1"
therapy = "ECMO"
episode_id = "EP-1"
confirmed = true
confirmed_by = "rn.doe"
"""


class ConfigTests(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.dir.cleanup)

    def write(self, text):
        p = Path(self.dir.name) / "vigil.toml"
        p.write_text(text, encoding="utf-8")
        return p

    def test_false_means_test_mode(self):
        cfg = load_config(self.write(TEST_ONLY.format(live="false")), env={})
        self.assertEqual(cfg.mode, Mode.TEST)
        self.assertFalse(cfg.live_mode)
        self.assertEqual(cfg.tenant_id, "sim-h")

    def test_true_means_live_mode(self):
        cfg = load_config(self.write(LIVE_OK), env={})
        self.assertEqual(cfg.mode, Mode.LIVE)
        self.assertEqual(cfg.hl7_codes, {"MDC:999": "ECMO_BLOOD_FLOW"})
        self.assertEqual(cfg.associations[0].confirmed_by, "rn.doe")
        self.assertEqual(cfg.edge_node_id, "cvicu-3-edge-a")

    def test_env_overrides_file(self):
        cfg = load_config(self.write(LIVE_OK), env={"VIGIL_LIVE_MODE": "false"})
        self.assertEqual(cfg.mode, Mode.TEST)
        self.assertIn("VIGIL_LIVE_MODE", cfg.mode_source)

    def test_bad_env_value_rejected(self):
        with self.assertRaisesRegex(ConfigError, "VIGIL_LIVE_MODE"):
            load_config(self.write(LIVE_OK), env={"VIGIL_LIVE_MODE": "maybe"})

    def test_live_requires_complete_section(self):
        with self.assertRaisesRegex(ConfigError, "tenant_id is required"):
            load_config(self.write(TEST_ONLY.format(live="true")), env={})

    def test_live_rejects_sim_identities(self):
        with self.assertRaisesRegex(ConfigError, "must not start with 'sim'"):
            load_config(self.write(LIVE_OK.replace("general-hospital", "sim-hospital")), env={})

    def test_test_requires_sim_identities(self):
        with self.assertRaisesRegex(ConfigError, "must start with 'sim'"):
            load_config(self.write(TEST_ONLY.format(live="false").replace("sim-h", "general")), env={})

    def test_confirmed_needs_confirmer(self):
        with self.assertRaisesRegex(ConfigError, "confirmed_by"):
            load_config(self.write(LIVE_OK.replace('confirmed_by = "rn.doe"', "")), env={})

    def test_live_mode_must_be_set(self):
        with self.assertRaisesRegex(ConfigError, "live_mode"):
            load_config(self.write(TEST_ONLY.replace("live_mode = {live}", "")), env={})

    def test_shipped_config_is_test_mode(self):
        self.assertEqual(load_config(env={}).mode, Mode.TEST)


class ModeGuardTests(unittest.TestCase):
    def test_live_refuses_simulated_drivers(self):
        with self.assertRaises(ModeViolation):
            DriverHost(live_mode=True).register(SimEcmoDriver)

    def test_live_node_has_no_simulated_driver(self):
        node = EdgeNode(live_mode=True, tenant_id="h", unit_id="u", edge_node_id="e", clock=WallClock(),
                        safety_rules=[], core_rules=[])
        with self.assertRaises(ModeViolation):
            node.receive("sim_ecmo", "SC1|d|0|QB|4|L/min")

    def test_live_refuses_simulated_clock(self):
        with self.assertRaises(ValueError):
            EdgeNode(live_mode=True, tenant_id="h", unit_id="u", edge_node_id="e", clock=SimClock(),
                     safety_rules=[], core_rules=[])

    def test_test_mode_never_gets_nurse_call(self):
        with tempfile.TemporaryDirectory() as d:
            with self.assertRaises(ValueError):
                EdgeNode(live_mode=False, tenant_id="sim", unit_id="sim", edge_node_id="sim", clock=SimClock(),
                         safety_rules=[], core_rules=[], nurse_call=LogNurseCall(Path(d) / "nc.log"))

    def test_runners_refuse_the_other_mode(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "vigil.toml"
            p.write_text(LIVE_OK, encoding="utf-8")
            live = load_config(p, env={})
            test = load_config(p, env={"VIGIL_LIVE_MODE": "false"})
            with self.assertRaises(ModeViolation):
                run_test_mode(live, out=io.StringIO())
            with self.assertRaises(ModeViolation):
                run_live_mode(test, out=io.StringIO())

    def test_test_run_tags_alerts_and_audits(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "vigil.toml"
            p.write_text(TEST_ONLY.format(live="false"), encoding="utf-8")
            cfg = load_config(p, env={})
            out = io.StringIO()
            summary = run_test_mode(cfg, out=out)
            raised = [tr for tr in summary.transitions if tr.kind == "raised"]
            self.assertEqual(len(raised), 1)
            self.assertTrue(raised[0].alert.test_mode)
            self.assertIn("[TEST]", out.getvalue())
            ok, count, _ = verify(cfg.audit_path)
            self.assertTrue(ok)
            records = [json.loads(l) for l in cfg.audit_path.read_text(encoding="utf-8").splitlines()]
            self.assertTrue(all(r["data"]["mode"] == "test" for r in records))


class AuditTests(unittest.TestCase):
    def test_chain_detects_tampering(self):
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / "a.jsonl"
            ledger = AuditLedger(path)
            for i in range(3):
                ledger.append("x", {"i": i})
            self.assertEqual(verify(path), (True, 3, ""))
            AuditLedger(path).append("x", {"i": 3})  # reopen continues the chain
            self.assertEqual(verify(path)[:2], (True, 4))
            lines = path.read_text(encoding="utf-8").splitlines()
            lines[1] = lines[1].replace('"i": 1', '"i": 9')
            path.write_text("\n".join(lines) + "\n", encoding="utf-8")
            ok, _, error = verify(path)
            self.assertFalse(ok)
            self.assertIn("line 2", error)
            with self.assertRaises(RuntimeError):
                AuditLedger(path)


if __name__ == "__main__":
    unittest.main()
