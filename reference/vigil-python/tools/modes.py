"""Runners for the two operating modes.

    run_test_mode  scenario -> simulators -> edge node, simulated clock
    run_live_mode  HL7 PCD-01 over MLLP -> edge node, wall clock, nurse call

Both accept an optional `hub` (apps/central_station) that observes the node
for the web dashboard. The node is only ever touched while holding hub.lock.
"""
from __future__ import annotations

import contextlib
import queue
import sys
import threading
import time
from dataclasses import dataclass
from typing import Callable, TextIO

from core.audit_ledger import AuditLedger
from core.cds_runtime import load_core_rules
from edge.driver_sdk import ModeViolation
from edge.drivers.hl7_pcd01 import MllpServer, parse_oru
from edge.local_alarm import ConsolePresenter, LogNurseCall, Transition, short_id
from edge.node import EdgeNode
from edge.safety_engine import load_safety_rules
from shared.vigil_config import Config
from shared.vigil_contracts import AssociationMethod, DeviceAssociation, TherapyEpisode
from shared.vigil_time import SimClock, WallClock
from simulators.player import SimFrame, frames
from simulators.scenario import Scenario, load_scenario


def describe_mode(cfg: Config) -> list[str]:
    if cfg.live_mode:
        return [
            f"Vigil mode: LIVE  (live_mode = true, from {cfg.mode_source})",
            f"  tenant {cfg.tenant_id}, unit {cfg.unit_id}, edge node {cfg.edge_node_id}",
            f"  data: HL7 PCD-01 over MLLP on {cfg.hl7_host}:{cfg.hl7_port}; simulators refused",
            f"  alarms: console + nurse call ({cfg.nurse_call} -> {cfg.nurse_call_log})",
            f"  audit: {cfg.audit_path}",
        ]
    return [
        f"Vigil mode: TEST  (live_mode = false, from {cfg.mode_source})",
        f"  tenant {cfg.tenant_id}, unit {cfg.unit_id}, edge node {cfg.edge_node_id}",
        "  data: device simulators driven by a patient scenario, simulated clock",
        "  alarms: console only, tagged [TEST]; nurse call disabled",
        f"  audit: {cfg.audit_path}",
    ]


def setup_scenario(node: EdgeNode, scenario: Scenario) -> None:
    episode = TherapyEpisode(scenario.episode_id, scenario.encounter_id, scenario.therapy, 0.0,
                             attributes=scenario.attributes)
    for dev in scenario.devices:
        node.add_association(DeviceAssociation(
            association_id=f"as-{dev.device_id}", device_id=dev.device_id, encounter_id=scenario.encounter_id,
            therapy_episode_id=scenario.episode_id, start=0.0, method=AssociationMethod.BARCODE,
            confirmed=dev.confirmed, confirmed_by="scenario" if dev.confirmed else ""), episode)


def play(node: EdgeNode, scenario: Scenario, clock: SimClock, *, tick: float = 1.0,
         speed: float | Callable[[], float] = 0.0, stream: list[SimFrame] | None = None,
         lock=None, stop: threading.Event | None = None) -> list[Transition]:
    """Feed every frame with time <= t, then tick at t, for t = 0, tick, 2*tick, ... duration.

    speed: simulated seconds per wall second (0 = as fast as possible); may be a
    callable so it can change while playing.
    """
    stream = frames(scenario) if stream is None else stream
    speed_of = speed if callable(speed) else (lambda: speed)
    lock = lock or contextlib.nullcontext()
    transitions: list[Transition] = []
    i, steps = 0, int(scenario.duration // tick)
    anchor_wall, anchor_t, anchor_speed = time.monotonic(), 0.0, None
    for k in range(steps + 1):
        t = k * tick
        s = speed_of()
        if s != anchor_speed:
            anchor_wall, anchor_t, anchor_speed = time.monotonic(), t, s
        if s > 0:
            delay = anchor_wall + (t - anchor_t) / s - time.monotonic()
            if delay > 0:
                if stop is not None:
                    stop.wait(delay)
                else:
                    time.sleep(delay)
        if stop is not None and stop.is_set():
            break
        with lock:
            clock.advance_to(t)
            while i < len(stream) and stream[i].t <= t:
                node.receive(stream[i].driver_id, stream[i].frame)
                i += 1
            transitions += node.tick(t)
    return transitions


@dataclass
class RunSummary:
    scenario: str
    transitions: list[Transition]
    stats: dict


def run_test_mode(cfg: Config, scenario_name: str | None = None, speed: float | Callable[[], float] | None = None,
                  out: TextIO = sys.stdout, hub=None, stop: threading.Event | None = None) -> RunSummary:
    if cfg.live_mode:
        raise ModeViolation("scenario playback is only available in TEST mode (live_mode = false)")
    name = scenario_name or cfg.scenario
    if not name:
        raise ValueError("no scenario given and [test] scenario is not set")
    scenario = load_scenario(name)
    clock = SimClock(0.0)
    audit = AuditLedger(cfg.audit_path)
    safety, core = load_safety_rules(), load_core_rules()
    node = EdgeNode(live_mode=False, tenant_id=cfg.tenant_id, unit_id=cfg.unit_id, edge_node_id=cfg.edge_node_id,
                    clock=clock, safety_rules=safety, core_rules=core,
                    presenter=ConsolePresenter(clock, live_mode=False, out=out), audit=audit)
    for line in describe_mode(cfg):
        print(line, file=out)
    print(f"  scenario: {scenario.name} ({scenario.duration / 3600:.1f} h) - {scenario.description}", file=out)
    print(f"  rules: {', '.join(r.key for r in safety + core)}", file=out)
    print("", file=out, flush=True)
    audit.append("run_start", {"mode": "test", "scenario": scenario.name,
                               "rules": [r.key for r in safety + core]})
    if hub is not None:
        hub.attach(node, clock, cfg, scenario=scenario, rules=safety + core)
    setup_scenario(node, scenario)
    transitions = play(node, scenario, clock, tick=cfg.tick_seconds, speed=cfg.speed if speed is None else speed,
                       lock=hub.lock if hub is not None else None, stop=stop)
    stopped = stop is not None and stop.is_set()
    if hub is not None:
        hub.finish(node, stopped)
    audit.append("run_end", {"mode": "test", "scenario": scenario.name, "stopped": stopped,
                             "stats": dict(node.stats)})
    print("", file=out)
    print(f"{'Stopped' if stopped else 'Done'}: {node.stats['observations']} observations, "
          f"{node.stats['alerts_raised']} alerts raised, {node.stats['alerts_resolved']} resolved, "
          f"{node.stats['flag:FLUSH']} samples flagged FLUSH, {node.stats['driver_faults']} driver faults.", file=out)
    for t, label in scenario.annotations:
        print(f"Annotated event at {clock.format(t)}: {label}", file=out)
    return RunSummary(scenario.name, transitions, dict(node.stats))


def run_live_mode(cfg: Config, out: TextIO = sys.stdout, stdin: TextIO | None = sys.stdin, hub=None,
                  stop: threading.Event | None = None) -> None:
    if not cfg.live_mode:
        raise ModeViolation("the device listener only runs in LIVE mode (live_mode = true)")
    clock = WallClock()
    audit = AuditLedger(cfg.audit_path)
    safety, core = load_safety_rules(), load_core_rules()
    node = EdgeNode(live_mode=True, tenant_id=cfg.tenant_id, unit_id=cfg.unit_id, edge_node_id=cfg.edge_node_id,
                    clock=clock, safety_rules=safety, core_rules=core,
                    presenter=ConsolePresenter(clock, live_mode=True, out=out), audit=audit,
                    nurse_call=LogNurseCall(cfg.nurse_call_log), hl7_codes=cfg.hl7_codes)
    lock = hub.lock if hub is not None else contextlib.nullcontext()
    stop = stop or threading.Event()
    for line in describe_mode(cfg):
        print(line, file=out)
    audit.append("run_start", {"mode": "live", "rules": [r.key for r in safety + core]})
    if hub is not None:
        hub.attach(node, clock, cfg, rules=safety + core)

    start = clock.now()
    with lock:
        for a in cfg.associations:
            episode = TherapyEpisode(a.episode_id, a.encounter_id, a.therapy, start)
            node.add_association(DeviceAssociation(
                association_id=f"as-{a.device_id}", device_id=a.device_id, encounter_id=a.encounter_id,
                therapy_episode_id=a.episode_id, start=start, method=AssociationMethod.BARCODE,
                confirmed=a.confirmed, confirmed_by=a.confirmed_by), episode)
            state = f"confirmed by {a.confirmed_by}" if a.confirmed else "NOT confirmed - therapy rules will not run"
            print(f"  device {a.device_id} -> {a.encounter_id} ({a.therapy}), {state}", file=out)

    inbox: queue.Queue = queue.Queue()

    def on_hl7(text: str) -> None:
        parse_oru(text)  # reject malformed messages with an AE before queueing
        inbox.put(("hl7_pcd01", text))

    server = MllpServer((cfg.hl7_host, cfg.hl7_port), on_hl7)
    threading.Thread(target=server.serve_forever, name="mllp", daemon=True).start()

    if stdin is not None:
        def read_commands():
            for line in stdin:
                inbox.put(("__cmd__", line.strip()))
            inbox.put(("__cmd__", "quit"))
        threading.Thread(target=read_commands, name="stdin", daemon=True).start()
        print("Listening. Commands: list | ack <alert-id> <your-name> | quit", file=out, flush=True)

    next_tick = clock.now()
    try:
        while not stop.is_set():
            now = clock.now()
            if now >= next_tick:
                with lock:
                    node.tick(now)
                next_tick += cfg.tick_seconds
                if next_tick < now:
                    next_tick = now + cfg.tick_seconds
                continue
            try:
                kind, payload = inbox.get(timeout=next_tick - now)
            except queue.Empty:
                continue
            with lock:
                if kind == "__cmd__":
                    if not _command(node, payload, out):
                        stop.set()
                else:
                    node.receive(kind, payload)
    except KeyboardInterrupt:
        pass
    finally:
        server.shutdown()
        server.server_close()
        audit.append("run_end", {"mode": "live", "stats": dict(node.stats)})
        print("Stopped.", file=out)


def _command(node: EdgeNode, line: str, out: TextIO) -> bool:
    parts = line.split()
    if not parts:
        return True
    if parts[0] == "quit":
        return False
    if parts[0] == "list":
        if not node.alerts.active:
            print("no active alerts", file=out)
        for a in node.alerts.active.values():
            print(f"  {short_id(a)}  {a.priority.value:<8} {a.state.value:<12} {a.problem_key}  "
                  f"{a.encounter_id}  {a.explanation}", file=out)
    elif parts[0] == "ack" and len(parts) >= 3:
        try:
            node.acknowledge(parts[1], " ".join(parts[2:]))
        except KeyError as e:
            print(f"ack failed: {e}", file=out)
    else:
        print("commands: list | ack <alert-id> <your-name> | quit", file=out)
    return True
