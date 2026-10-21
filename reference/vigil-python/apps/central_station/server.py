"""Central station web server (stdlib only, no external assets).

    GET  /                  dashboard
    GET  /static/<file>     app.js, app.css
    GET  /api/state?window= snapshot JSON (window in seconds)
    POST /api/ack           {"id": "<short or full alert id>", "by": "<name>"}
    GET  /api/scenarios     TEST mode: scenario list and current run
    POST /api/run           TEST mode: {"scenario": "...", "speed": 60}  start or restart
    POST /api/speed         TEST mode: {"speed": 60}

Binds to 127.0.0.1 by default. There is no login yet (Keycloak / FIDO2 is plan
epic 2.10), so do not expose it beyond the edge host in LIVE mode.
"""
from __future__ import annotations

import json
import sys
import threading
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from apps.central_station.hub import MonitorHub
from shared.vigil_config import Config
from simulators.scenario import list_scenarios
from tools.modes import run_test_mode

STATIC = Path(__file__).parent / "static"
FILES = {"/": ("index.html", "text/html; charset=utf-8"),
         "/static/app.js": ("app.js", "text/javascript; charset=utf-8"),
         "/static/app.css": ("app.css", "text/css; charset=utf-8")}
SPEEDS = (1, 10, 60, 300, 600)
WINDOWS = (900, 1800, 3600, 6 * 3600)
MAX_BODY = 4096


class TestController:
    """Runs scenarios in a background thread so the dashboard can restart them."""

    def __init__(self, cfg: Config, hub: MonitorHub, out=sys.stdout):
        self.cfg, self.hub, self.out = cfg, hub, out
        self.scenario = cfg.scenario
        self.speed = float(cfg.speed) if cfg.speed else 60.0
        self._thread: threading.Thread | None = None
        self._stop: threading.Event | None = None
        self._guard = threading.Lock()
        self.error = ""

    def start(self, scenario: str | None = None, speed: float | None = None) -> None:
        if scenario is not None and scenario not in list_scenarios():
            raise ValueError(f"unknown scenario {scenario!r}")
        with self._guard:
            self.stop()
            if scenario is not None:
                self.scenario = scenario
            if speed is not None:
                self.set_speed(speed)
            self._stop = threading.Event()
            self.error = ""
            self._thread = threading.Thread(target=self._run, args=(self.scenario, self._stop),
                                            name="scenario", daemon=True)
            self._thread.start()

    def _run(self, scenario: str, stop: threading.Event) -> None:
        try:
            run_test_mode(self.cfg, scenario, lambda: self.speed, out=self.out, hub=self.hub, stop=stop)
        except Exception as e:  # surfaced on the dashboard
            self.error = str(e)

    def set_speed(self, speed: float) -> None:
        if speed not in SPEEDS:
            raise ValueError(f"speed must be one of {SPEEDS}")
        self.speed = float(speed)

    def stop(self) -> None:
        if self._stop is not None:
            self._stop.set()
        if self._thread is not None:
            self._thread.join(timeout=10)

    def status(self) -> dict:
        return {"scenario": self.scenario, "speed": self.speed, "speeds": list(SPEEDS),
                "scenarios": list_scenarios(), "error": self.error,
                "running": bool(self._thread and self._thread.is_alive())}


def make_handler(hub: MonitorHub, controller: TestController | None):
    class Handler(BaseHTTPRequestHandler):
        server_version = "VigilCentralStation/0.1"

        def log_message(self, fmt, *args):  # keep the console for alarms
            pass

        def _send(self, status: int, body: bytes, ctype: str):
            self.send_response(status)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("X-Frame-Options", "DENY")
            self.send_header("Referrer-Policy", "no-referrer")
            self.send_header("Content-Security-Policy",
                             "default-src 'self'; style-src 'self'; script-src 'self'; img-src 'self' data:; "
                             "frame-ancestors 'none'; base-uri 'none'; form-action 'none'")
            self.end_headers()
            self.wfile.write(body)

        def _json(self, status: int, data):
            self._send(status, json.dumps(data).encode(), "application/json")

        def do_GET(self):
            url = urlparse(self.path)
            if url.path in FILES:
                name, ctype = FILES[url.path]
                return self._send(200, (STATIC / name).read_bytes(), ctype)
            if url.path == "/api/state":
                q = parse_qs(url.query)
                try:
                    window = float(q.get("window", ["1800"])[0])
                except ValueError:
                    window = 1800.0
                if window not in WINDOWS:
                    window = 1800.0
                state = hub.snapshot(window)
                state["controller"] = controller.status() if controller else None
                state["windows"] = list(WINDOWS)
                return self._json(200, state)
            if url.path == "/api/scenarios":
                if controller is None:
                    return self._json(403, {"error": "scenario control is TEST-mode only"})
                return self._json(200, controller.status())
            self._json(404, {"error": "not found"})

        def do_POST(self):
            # Read the body before any rejection: replying with unread request data
            # makes Windows reset the connection and the client loses the reply.
            try:
                length = int(self.headers.get("Content-Length") or 0)
            except ValueError:
                length = -1
            if not 0 <= length <= MAX_BODY:
                self.close_connection = True
                return self._json(413, {"error": "body too large or bad Content-Length"})
            raw = self.rfile.read(length)
            # Same-origin JSON only: blocks cross-site form posts.
            if self.headers.get("Content-Type", "").split(";")[0].strip() != "application/json":
                return self._json(415, {"error": "expected application/json"})
            origin = self.headers.get("Origin")
            if origin and urlparse(origin).netloc != self.headers.get("Host"):
                return self._json(403, {"error": "cross-origin request refused"})
            try:
                body = json.loads(raw or b"{}")
            except json.JSONDecodeError:
                return self._json(400, {"error": "invalid JSON"})
            if not isinstance(body, dict):
                return self._json(400, {"error": "expected a JSON object"})

            path = urlparse(self.path).path
            try:
                if path == "/api/ack":
                    who = str(body.get("by", "")).strip()[:80]
                    if not who:
                        return self._json(400, {"error": "enter your name to acknowledge"})
                    hub.acknowledge(str(body.get("id", "")), who)
                    return self._json(200, {"ok": True})
                if path in ("/api/run", "/api/speed"):
                    if controller is None:
                        return self._json(403, {"error": "scenario control is only available in TEST mode"})
                    speed = body.get("speed")
                    speed = float(speed) if speed is not None else None
                    if path == "/api/run":
                        controller.start(body.get("scenario"), speed)
                    else:
                        controller.set_speed(speed)
                    return self._json(200, controller.status())
            except KeyError as e:
                return self._json(409, {"error": str(e.args[0]) if e.args else "not found"})
            except (ValueError, TypeError) as e:
                return self._json(400, {"error": str(e)})
            self._json(404, {"error": "not found"})

    return Handler


def serve(hub: MonitorHub, controller: TestController | None, host: str, port: int) -> ThreadingHTTPServer:
    httpd = ThreadingHTTPServer((host, port), make_handler(hub, controller))
    httpd.daemon_threads = True
    threading.Thread(target=httpd.serve_forever, name="http", daemon=True).start()
    return httpd
