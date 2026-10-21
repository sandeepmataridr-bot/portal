import socket
import threading
import unittest

from edge.driver_sdk import Driver, DriverHost, RawSample
from edge.drivers.hl7_pcd01 import MllpServer, build_ack, parse_oru, unwrap_mllp, wrap_mllp
from edge.node import EdgeNode
from edge.normalizer import Normalizer
from edge.safety_engine import load_safety_rules
from edge.sqi import SignalQuality
from shared.vigil_codes import SIGNALS
from shared.vigil_contracts import AssociationMethod, DeviceAssociation, TherapyEpisode
from shared.vigil_time import SimClock
from simulators.devices import SimBloodGasAnalyzer, SimCircConsole


class NormalizerTests(unittest.TestCase):
    def setUp(self):
        self.n = Normalizer.from_files()

    def test_kpa_converted_to_mmhg_and_raw_kept(self):
        obs = self.n.normalize("sim_ecmo", RawSample("d", "DPOXY", 4.0, "kPa", 0.0), "as-1")
        self.assertEqual((obs.code_system, obs.code, obs.unit_ucum), ("VIGIL", "ECMO_OXY_DELTA_P", "mm[Hg]"))
        self.assertAlmostEqual(obs.value, 30.0, places=2)
        self.assertEqual((obs.raw_value, obs.raw_unit), (4.0, "kPa"))

    def test_unmapped_is_flagged_not_dropped(self):
        obs = self.n.normalize("sim_ecmo", RawSample("d", "RPM", 3200, "/min", 0.0), "as-1")
        self.assertEqual((obs.code_system, obs.code, obs.value), ("VENDOR", "RPM", 3200))
        self.assertIn("UNMAPPED", obs.flags)

    def test_unconvertible_unit_is_flagged(self):
        obs = self.n.normalize("sim_ecmo", RawSample("d", "DPOXY", 4.0, "cm[H2O]", 0.0), "as-1")
        self.assertIn("UNIT_UNCONVERTIBLE", obs.flags)

    def test_setting_flag(self):
        obs = self.n.normalize("sim_ecmo", RawSample("d", "SWEEP", 3.0, "L/min", 0.0), "as-1")
        self.assertIn("SETTING", obs.flags)


class SqiTests(unittest.TestCase):
    def test_flush_detected_and_recovers(self):
        q, sig = SignalQuality(), SIGNALS["ECMO_OXY_DELTA_P"]
        values = [25, 25.5, 24.8, 105, 106, 104, 25.2, 25.1]
        out = [q.assess(("d", sig.name), sig, float(i * 5), v) for i, v in enumerate(values)]
        self.assertEqual([s for s, _ in out], [1.0, 1.0, 1.0, 0.1, 0.1, 0.1, 1.0, 1.0])
        self.assertEqual(out[3][1], ["FLUSH"])

    def test_out_of_range(self):
        q, sig = SignalQuality(), SIGNALS["ECMO_BLOOD_FLOW"]
        self.assertEqual(q.assess(("d", sig.name), sig, 0.0, 42.0), (0.0, ["OUT_OF_RANGE"]))

    def test_flatline(self):
        q, sig = SignalQuality(), SIGNALS["ECMO_BLOOD_FLOW"]
        out = [q.assess(("d", sig.name), sig, float(t), 4.0) for t in range(0, 61)]
        self.assertEqual(out[59], (1.0, []))
        self.assertEqual(out[60], (0.3, ["FLATLINE"]))


class Hl7Tests(unittest.TestCase):
    def setUp(self):
        self.msg = SimBloodGasAnalyzer().encode("bga-1", "BG_POST_OXY_PO2", "mm[Hg]", 18000.0, 176.0)

    def test_parse_oru(self):
        [s] = parse_oru(self.msg)
        self.assertEqual((s.device_id, s.vendor_code, s.value, s.unit, s.device_time),
                         ("bga-1", "L:POST_OXY_PO2", 176.0, "mm[Hg]", 18000.0))

    def test_mdc_units_and_tz_offset(self):
        msg = ("MSH|^~\\&|GW|ICU|VIGIL|EDGE|20261021120000+0200||ORU^R01|1|P|2.6\r"
               "OBX|1|NM|150456^MDC_X^MDC||7.5|266016^MDC_DIM_KILO_PASCAL^MDC|||||F\r")
        [s] = parse_oru(msg)
        self.assertEqual((s.vendor_code, s.unit, s.device_id), ("MDC:150456", "kPa", "GW"))
        self.assertEqual(s.device_time, 1792576800.0)  # 2026-10-21T10:00:00Z

    def test_rejects_non_oru(self):
        with self.assertRaises(ValueError):
            parse_oru("MSH|^~\\&|A|B|C|D|20260101||ADT^A01|1|P|2.6\r")

    def test_ack_echoes_control_id(self):
        self.assertIn("MSA|AA|SIM000001", build_ack(self.msg, "AA"))

    def test_mllp_framing(self):
        buf = wrap_mllp("one") + wrap_mllp("two") + b"\x0bpartial"
        msgs, rest = unwrap_mllp(buf)
        self.assertEqual((msgs, rest), (["one", "two"], b"\x0bpartial"))

    def test_mllp_server_acks(self):
        got = []

        def on_message(text):
            parse_oru(text)
            got.append(text)
        server = MllpServer(("127.0.0.1", 0), on_message)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        try:
            with socket.create_connection(server.server_address, timeout=5) as c:
                c.sendall(wrap_mllp(self.msg))
                reply = c.recv(4096)
                c.sendall(wrap_mllp("garbage"))
                bad = c.recv(4096)
        finally:
            server.shutdown()
            server.server_close()
        self.assertIn(b"MSA|AA|SIM000001", reply)
        self.assertIn(b"MSA|AE", bad)
        self.assertEqual(len(got), 1)


class _Crashy(Driver):
    driver_id, version, simulated = "crashy", "0", False

    def decode(self, frame):
        raise RuntimeError("boom")


class DriverHostTests(unittest.TestCase):
    def test_fault_is_isolated_and_driver_restarted(self):
        faults = []
        host = DriverHost(live_mode=False, on_fault=lambda d, e: faults.append(d))
        host.register(_Crashy)
        from edge.drivers import SimEcmoDriver
        host.register(SimEcmoDriver)
        first = host.driver("crashy")
        self.assertEqual(host.decode("crashy", "x"), [])
        self.assertIsNot(host.driver("crashy"), first)
        self.assertEqual(faults, ["crashy"])
        frame = SimCircConsole().encode("d", "ECMO_BLOOD_FLOW", "L/min", 1.0, 4.0)
        self.assertEqual(len(host.decode("sim_ecmo", frame)), 1)


class AssociationGatingTests(unittest.TestCase):
    def _node(self, confirmed):
        clock = SimClock()
        node = EdgeNode(live_mode=False, tenant_id="sim-t", unit_id="sim-u", edge_node_id="sim-e", clock=clock,
                        safety_rules=load_safety_rules(), core_rules=[])
        node.add_association(
            DeviceAssociation("as-1", "ecmo-1", "enc-1", "ep-1", 0.0, method=AssociationMethod.BARCODE,
                              confirmed=confirmed, confirmed_by="rn" if confirmed else ""),
            TherapyEpisode("ep-1", "enc-1", "ECMO", 0.0))
        return node, clock

    def _feed_low_flow(self, node, clock, start, seconds):
        console, raised = SimCircConsole(), []
        for t in range(start, start + seconds):
            clock.advance_to(float(t))
            node.receive("sim_ecmo", console.encode("ecmo-1", "ECMO_BLOOD_FLOW", "L/min", float(t), 0.5))
            raised += [tr for tr in node.tick(float(t)) if tr.kind == "raised"]
        return raised

    def test_unconfirmed_association_runs_no_therapy_rules(self):
        node, clock = self._node(confirmed=False)
        self.assertEqual(self._feed_low_flow(node, clock, 0, 30), [])
        self.assertGreater(node.stats["flag:UNCONFIRMED"], 0)

    def test_confirmation_enables_rules(self):
        node, clock = self._node(confirmed=False)
        self._feed_low_flow(node, clock, 0, 10)
        node.confirm_association("as-1", "rn.smith (barcode)")
        raised = self._feed_low_flow(node, clock, 10, 30)
        self.assertEqual([tr.alert.problem_key for tr in raised], ["ecmo.blood_flow_loss"])
        self.assertTrue(raised[0].alert.test_mode)

    def test_unknown_device_is_flagged(self):
        node, clock = self._node(confirmed=True)
        frame = SimCircConsole().encode("stranger", "ECMO_BLOOD_FLOW", "L/min", 0.0, 4.0)
        [env] = node.receive("sim_ecmo", frame)
        self.assertIn("UNASSOCIATED", env.payload.flags)


if __name__ == "__main__":
    unittest.main()
