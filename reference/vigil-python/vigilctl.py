"""Vigil command line.

    python vigilctl.py mode                      show the resolved operating mode
    python vigilctl.py run [--scenario NAME] [--speed N]
                                                 TEST: play a scenario; LIVE: start the device listener
    python vigilctl.py scenarios                 list scenarios
    python vigilctl.py check-rules               compile every rule file
    python vigilctl.py test-rules                run the tests declared in the rules
    python vigilctl.py audit-verify              verify the current mode's audit ledger
    python vigilctl.py web [--port 8080]         run with the central-station website

The mode comes from `live_mode` in vigil.toml, or VIGIL_LIVE_MODE=true|false.
"""
from __future__ import annotations

import argparse
import os
import sys
import threading
from pathlib import Path

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))

from core.audit_ledger import verify  # noqa: E402
from core.cds_runtime import load_core_rules  # noqa: E402
from edge.driver_sdk import ModeViolation  # noqa: E402
from edge.safety_engine import load_safety_rules  # noqa: E402
from shared.vigil_config import ConfigError, load_config  # noqa: E402
from shared.vigil_rules import RuleError  # noqa: E402
from simulators.scenario import list_scenarios  # noqa: E402
from tools.modes import describe_mode, run_live_mode, run_test_mode  # noqa: E402
from tools.rule_tests import run_rule_tests  # noqa: E402


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(prog="vigilctl", description="Vigil edge node")
    p.add_argument("--config", help="path to vigil.toml")
    sub = p.add_subparsers(dest="cmd", required=True)
    sub.add_parser("mode")
    run = sub.add_parser("run")
    run.add_argument("--scenario")
    run.add_argument("--speed", type=float)
    sub.add_parser("scenarios")
    sub.add_parser("check-rules")
    sub.add_parser("test-rules")
    sub.add_parser("audit-verify")
    web = sub.add_parser("web", help="run the node with the central-station website")
    web.add_argument("--host", default="127.0.0.1")
    web.add_argument("--port", type=int, default=8080)
    web.add_argument("--scenario")
    web.add_argument("--speed", type=float)
    args = p.parse_args(argv)

    if sys.platform == "win32":
        os.system("")  # enable ANSI colours in the Windows console

    try:
        if args.cmd == "scenarios":
            print("\n".join(list_scenarios()))
            return 0
        if args.cmd == "check-rules":
            rules = load_safety_rules() + load_core_rules()
            for r in rules:
                where = "edge safety floor" if r.safety_floor else "core"
                print(f"ok  {r.key:<40} {r.priority:<8} {where:<17} {len(r.tests)} tests")
            return 0
        if args.cmd == "test-rules":
            results = run_rule_tests(load_safety_rules() + load_core_rules())
            for res in results:
                print(f"{'PASS' if res.passed else 'FAIL'}  {res.rule:<36} {res.test:<32} {res.detail}")
            failed = sum(not r.passed for r in results)
            print(f"\n{len(results) - failed} passed, {failed} failed")
            return 1 if failed else 0

        cfg = load_config(args.config)
        if args.cmd == "mode":
            print("\n".join(describe_mode(cfg)))
            return 0
        if args.cmd == "audit-verify":
            ok, count, error = verify(cfg.audit_path)
            print(f"{cfg.audit_path}: {count} records, " + ("chain intact" if ok else f"BROKEN: {error}"))
            return 0 if ok else 1
        if args.cmd == "run":
            if cfg.live_mode:
                if args.scenario or args.speed is not None:
                    raise ModeViolation("--scenario and --speed are TEST-mode options; live_mode is true")
                run_live_mode(cfg)
            else:
                run_test_mode(cfg, args.scenario, args.speed)
            return 0
        if args.cmd == "web":
            return run_web(cfg, args)
    except (ConfigError, ModeViolation, RuleError, FileNotFoundError, ValueError) as e:
        print(f"error: {e}", file=sys.stderr)
        return 2
    return 1


def run_web(cfg, args) -> int:
    from apps.central_station.hub import MonitorHub
    from apps.central_station.server import SPEEDS, TestController, serve

    hub = MonitorHub()
    controller = None
    if cfg.live_mode:
        if args.scenario or args.speed is not None:
            raise ModeViolation("--scenario and --speed are TEST-mode options; live_mode is true")
        if args.host not in ("127.0.0.1", "localhost", "::1"):
            print("warning: the central station has no login yet; exposing it beyond this host "
                  "shows patient data to anyone on the network", file=sys.stderr)
    else:
        controller = TestController(cfg, hub)
        if args.speed is not None and args.speed not in SPEEDS:
            raise ValueError(f"--speed must be one of {SPEEDS} for the website")
    httpd = serve(hub, controller, args.host, args.port)
    print(f"Central station: http://{args.host}:{args.port}/  (Ctrl+C to stop)\n", flush=True)
    try:
        if cfg.live_mode:
            run_live_mode(cfg, hub=hub, stdin=None)
        else:
            controller.start(args.scenario or cfg.scenario, args.speed)
            threading.Event().wait()
    except KeyboardInterrupt:
        pass
    finally:
        if controller:
            controller.stop()
        httpd.shutdown()
    return 0


if __name__ == "__main__":
    sys.exit(main())
