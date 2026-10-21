import io
import json
import tempfile
import unittest
import urllib.error
import urllib.request
from pathlib import Path

from apps.central_station.hub import MonitorHub
from apps.central_station.server import serve
from shared.vigil_config import load_config
from tools.modes import run_test_mode

CONFIG = """
live_mode = false
[test]
tenant_id = "sim-h"
unit_id = "sim-u"
audit_path = "audit.jsonl"
"""


class CentralStationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.dir = tempfile.TemporaryDirectory()
        path = Path(cls.dir.name) / "vigil.toml"
        path.write_text(CONFIG, encoding="utf-8")
        cls.cfg = load_config(path, env={})
        cls.hub = MonitorHub()
        run_test_mode(cls.cfg, "ecmo/flow_loss_01", 0, out=io.StringIO(), hub=cls.hub)
        cls.httpd = serve(cls.hub, None, "127.0.0.1", 0)
        cls.base = f"http://127.0.0.1:{cls.httpd.server_address[1]}"

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        cls.httpd.server_close()
        cls.dir.cleanup()

    def request(self, path, body=None, ctype="application/json"):
        data = None if body is None else (body if isinstance(body, bytes) else json.dumps(body).encode())
        req = urllib.request.Request(self.base + path, data=data, headers={"Content-Type": ctype} if data else {})
        try:
            with urllib.request.urlopen(req, timeout=5) as r:
                return r.status, r.headers, r.read()
        except urllib.error.HTTPError as e:
            with e:
                return e.code, e.headers, e.read()

    def test_snapshot(self):
        s = self.hub.snapshot(1800)
        self.assertTrue(s["ready"])
        self.assertEqual(s["mode"], "test")
        [m] = s["machines"]
        self.assertEqual((m["device_id"], m["kind"], m["status"]), ("sim-ecmo-04", "ECMO console", "ok"))
        self.assertEqual([x["code"] for x in m["signals"]], ["ECMO_BLOOD_FLOW", "ECMO_OXY_DELTA_P", "ECMO_SWEEP_FLOW"])
        self.assertLessEqual(len(m["signals"][0]["points"]), 400)
        self.assertEqual(s["operating_level"], 0)
        self.assertEqual([e["kind"] for e in s["log"]], ["resolved", "raised"])

    def test_pages_and_security_headers(self):
        status, headers, body = self.request("/")
        self.assertEqual(status, 200)
        self.assertIn(b"Vigil Central Station", body)
        self.assertIn("default-src 'self'", headers["Content-Security-Policy"])
        self.assertEqual(self.request("/static/app.js")[0], 200)
        self.assertEqual(self.request("/../vigil.toml")[0], 404)

    def test_state_api(self):
        status, _, body = self.request("/api/state?window=900")
        s = json.loads(body)
        self.assertEqual((status, s["window"]), (200, 900))
        self.assertEqual(json.loads(self.request("/api/state?window=7")[2])["window"], 1800)

    def test_post_rules(self):
        self.assertEqual(self.request("/api/ack", b"id=x", "application/x-www-form-urlencoded")[0], 415)
        self.assertEqual(self.request("/api/ack", {"id": "x", "by": ""})[0], 400)
        self.assertEqual(self.request("/api/ack", {"id": "nope", "by": "rn"})[0], 409)
        self.assertEqual(self.request("/api/run", {"scenario": "ecmo/stable_va_01"})[0], 403)  # no controller


if __name__ == "__main__":
    unittest.main()
