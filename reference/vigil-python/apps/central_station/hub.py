"""Monitor hub: watches an edge node and serves JSON snapshots to the web app.

Subscribes to the node's observation bus and alert transitions, keeps the
latest value and a short history per machine and signal, and builds
snapshots on request. All access goes through `lock`, which the runners also
hold while they drive the node.
"""
from __future__ import annotations

import threading
from collections import deque

from shared.vigil_codes import CODE_SYSTEM, SIGNALS, SignalKind
from shared.vigil_contracts import Origin, Priority
from edge.local_alarm import Transition, short_id

HISTORY_S = 6 * 3600        # numeric history kept per signal
LAB_HISTORY_S = 24 * 3600
NUMERIC_STEP_S = 5.0         # numeric history resolution (artifact samples always kept)
MAX_POINTS = 360             # points per chart in one snapshot
STALE_S = 5.0                # plan §3.1: a stream gap over 5 s greys the tile ("no live data")
LOG_MAX = 200
GOOD_SQI = 0.8
PRIORITY_ORDER = {Priority.HIGH: 0, Priority.MEDIUM: 1, Priority.LOW: 2, Priority.ADVISORY: 3}
DRIVER_LABELS = {"sim_ecmo": "Simulated ECMO console", "hl7_pcd01": "HL7 PCD-01 device"}


class MonitorHub:
    def __init__(self):
        self.lock = threading.RLock()
        self._clear()

    def _clear(self):
        self.node = None
        self.clock = None
        self.cfg = None
        self.scenario = None
        self.rules = []
        self.machines: dict[str, dict] = {}
        self.log: deque = deque(maxlen=LOG_MAX)
        self.finished = False
        self.stopped = False
        self.run_id = 0

    # -- wiring (called by the runners) -------------------------------------
    def attach(self, node, clock, cfg, scenario=None, rules=()):
        with self.lock:
            run_id = self.run_id + 1
            self._clear()
            self.run_id = run_id
            self.node, self.clock, self.cfg, self.scenario = node, clock, cfg, scenario
            self.rules = list(rules)
            node.bus.subscribe("observation", self._on_observation)
            node.listeners.append(self._on_transition)

    def finish(self, node, stopped: bool):
        with self.lock:
            if node is self.node:
                self.finished, self.stopped = True, stopped

    def _on_observation(self, env):
        obs = env.payload
        device = env.source_id.rsplit("/", 1)[-1]
        m = self.machines.setdefault(device, {"driver": env.provenance.driver_id, "last_seen": None,
                                              "signals": {}, "unmapped": 0})
        t = env.valid_time
        m["last_seen"] = t if m["last_seen"] is None else max(m["last_seen"], t)
        if obs.code_system != CODE_SYSTEM:
            m["unmapped"] += 1
            return
        sig = SIGNALS[obs.code]
        s = m["signals"].setdefault(obs.code, {"hist": deque(), "last": None, "changed_at": t})
        if s["last"] is not None and s["last"][1] != obs.value:
            s["changed_at"] = t
        s["last"] = (t, obs.value, obs.sqi, list(obs.flags))
        hist = s["hist"]
        if sig.kind is not SignalKind.NUMERIC or not hist or t - hist[-1][0] >= NUMERIC_STEP_S or obs.sqi < GOOD_SQI:
            hist.append((t, round(obs.value, 3), round(obs.sqi, 2)))
        keep = LAB_HISTORY_S if sig.kind is SignalKind.LAB else HISTORY_S
        while hist and hist[0][0] < t - keep:
            hist.popleft()

    def _on_transition(self, tr: Transition):
        a = tr.alert
        self.log.appendleft({
            "kind": tr.kind, "at": tr.at, "id": short_id(a), "priority": a.priority.value,
            "rule": a.problem_key, "encounter": a.encounter_id, "explanation": a.explanation,
            "by": a.acknowledged_by,
        })

    # -- actions -------------------------------------------------------------
    def acknowledge(self, alert_ref: str, by: str):
        with self.lock:
            if self.node is None:
                raise KeyError("no node attached")
            self.node.acknowledge(alert_ref, by)

    # -- snapshot ------------------------------------------------------------
    def snapshot(self, window: float = 1800.0) -> dict:
        with self.lock:
            if self.node is None:
                return {"ready": False}
            node, cfg, now = self.node, self.cfg, self.clock.now()
            assocs = {a.device_id: a for a in node.associations.all() if a.end is None}
            active = sorted(node.alerts.active.values(),
                            key=lambda a: (PRIORITY_ORDER[a.priority], -a.raised_time))
            alerting = {}
            for a in active:
                alerting.setdefault(a.encounter_id, a.priority.value)

            machines = []
            for device in sorted(set(self.machines) | set(assocs)):
                m = self.machines.get(device, {"driver": "", "last_seen": None, "signals": {}, "unmapped": 0})
                assoc = assocs.get(device)
                episode = node.associations.episode(assoc.therapy_episode_id) if assoc else None
                streaming = any(SIGNALS[c].kind is SignalKind.NUMERIC for c in m["signals"])
                age = None if m["last_seen"] is None else max(0.0, now - m["last_seen"])
                if assoc is None:
                    status = "unassociated"
                elif not assoc.confirmed:
                    status = "unconfirmed"
                elif m["last_seen"] is None:
                    status = "waiting"
                elif streaming and age > STALE_S:
                    status = "no_data"
                else:
                    status = "ok"
                machines.append({
                    "device_id": device,
                    "driver": DRIVER_LABELS.get(m["driver"], m["driver"] or "unknown"),
                    "kind": _machine_kind(m["signals"]),
                    "status": status, "age": age, "unmapped": m["unmapped"],
                    "encounter_id": assoc.encounter_id if assoc else None,
                    "therapy": episode.therapy if episode else None,
                    "therapy_detail": " ".join(episode.attributes.values()) if episode else "",
                    "confirmed_by": assoc.confirmed_by if assoc else "",
                    "alert_priority": alerting.get(assoc.encounter_id) if assoc else None,
                    "signals": [_signal(code, s, now, window) for code, s in
                                sorted(m["signals"].items(), key=lambda kv: _signal_order(kv[0]))],
                })
            # Group by patient; within a patient, the therapy device first.
            machines.sort(key=lambda m: (m["encounter_id"] is None, m["encounter_id"] or "",
                                         m["kind"] != "ECMO console", m["device_id"]))

            sc = self.scenario
            level, reasons = _operating_level(machines, node, self.rules)
            return {
                "operating_level": level, "operating_reasons": reasons,
                "ready": True,
                "run_id": self.run_id,
                "mode": "live" if cfg.live_mode else "test",
                "tenant_id": cfg.tenant_id, "unit_id": cfg.unit_id, "edge_node_id": cfg.edge_node_id,
                "now": now, "simulated_clock": self.clock.simulated,
                "window": window,
                "scenario": None if sc is None else {
                    "name": sc.name, "description": sc.description, "duration": sc.duration,
                    "annotations": [{"at": t, "label": label} for t, label in sc.annotations],
                },
                "finished": self.finished, "stopped": self.stopped,
                "rules": [{"key": r.key, "priority": r.priority, "placement": "edge" if r.safety_floor else "core"}
                          for r in self.rules],
                "alerts": [{
                    "id": short_id(a), "priority": a.priority.value, "state": a.state.value,
                    "rule": a.problem_key, "version": a.findings[0].rule.rule_version,
                    "origin": "edge" if a.origin is Origin.EDGE_SAFETY_FLOOR else "core",
                    "encounter": a.encounter_id, "explanation": a.explanation,
                    "raised": a.raised_time, "acknowledged_by": a.acknowledged_by, "test_mode": a.test_mode,
                } for a in active],
                "log": list(self.log)[:60],
                "machines": machines,
                "stats": {"observations": node.stats["observations"], "flush": node.stats["flag:FLUSH"],
                          "driver_faults": node.stats["driver_faults"]},
            }


def _operating_level(machines: list, node, rules) -> tuple[int, list[str]]:
    """Server-side part of the operating level. Level 3 (central station cut off
    from the edge) can only be detected by the browser, which sets it itself.

      0  full operation
      1  degraded: some machines without live data, unconfirmed, or driver faults
      2  safety floor only: core rules not running
    """
    level, reasons = 0, []
    silent = [m["device_id"] for m in machines if m["encounter_id"] and m["status"] == "no_data"]
    if silent:
        level = 1
        reasons.append(f"no live data from {', '.join(silent)}")
    unconfirmed = [m["device_id"] for m in machines if m["status"] == "unconfirmed"]
    if unconfirmed:
        level = 1
        reasons.append(f"association not confirmed for {', '.join(unconfirmed)}")
    if node.stats["driver_faults"]:
        level = 1
        reasons.append(f"{node.stats['driver_faults']} driver faults since start")
    if not any(not r.safety_floor for r in rules):
        level = 2
        reasons.append("core rules not running; edge safety floor only")
    return level, reasons


def _machine_kind(signals: dict) -> str:
    if any(c.startswith("ECMO_") for c in signals):
        return "ECMO console"
    if any(c.startswith("BG_") for c in signals):
        return "Blood gas analyzer"
    return "Device"


_ORDER = ["ECMO_BLOOD_FLOW", "ECMO_OXY_DELTA_P", "ECMO_SWEEP_FLOW", "BG_POST_OXY_PO2"]


def _signal_order(code: str):
    return (_ORDER.index(code) if code in _ORDER else len(_ORDER), code)


def _signal(code: str, s: dict, now: float, window: float) -> dict:
    sig = SIGNALS[code]
    t, value, sqi, flags = s["last"]
    if sig.kind is SignalKind.LAB:
        points = [p for p in s["hist"]][-12:]
    else:
        points = [p for p in s["hist"] if p[0] >= now - window]
        if len(points) > MAX_POINTS:
            step = len(points) / MAX_POINTS
            keep = {int(i * step) for i in range(MAX_POINTS)} | {len(points) - 1}
            points = [p for i, p in enumerate(points) if i in keep or p[2] < GOOD_SQI]
    return {
        "code": code, "label": sig.description, "unit": sig.unit, "kind": sig.kind.value,
        "value": value, "t": t, "age": max(0.0, now - t), "sqi": sqi, "flags": flags,
        "changed_at": s["changed_at"],
        "points": points,
    }
