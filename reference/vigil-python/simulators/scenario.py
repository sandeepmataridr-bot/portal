"""Patient scenario format (JSON timeline of physiology and device events).

Signal values in a scenario are the true physiology in the signal's canonical
unit; device simulators convert them to their own vendor units on the wire.
Timelines are piecewise linear; repeat a time to make a step change.
"""
from __future__ import annotations

import bisect
import json
from dataclasses import dataclass, field
from pathlib import Path

from shared.vigil_codes import SIGNALS, THERAPIES
from shared.vigil_time import parse_duration

SCENARIO_DIR = Path(__file__).parent / "scenarios"


@dataclass
class DeviceSpec:
    device_id: str
    driver: str
    confirmed: bool


@dataclass
class SignalSpec:
    name: str
    device: str
    period: float
    noise: float
    timeline: list[tuple[float, float]]


@dataclass
class LabSpec:
    name: str
    device: str
    samples: list[tuple[float, float]]


@dataclass
class Artifact:
    signal: str
    start: float
    end: float
    every: float
    length: float
    offset: float


@dataclass
class Outage:
    device: str
    start: float
    length: float

    def covers(self, t: float) -> bool:
        return self.start <= t < self.start + self.length


@dataclass
class Scenario:
    name: str
    description: str
    duration: float
    seed: int
    encounter_id: str
    therapy: str
    episode_id: str
    attributes: dict
    devices: list[DeviceSpec]
    signals: list[SignalSpec]
    labs: list[LabSpec]
    artifacts: list[Artifact] = field(default_factory=list)
    outages: list[Outage] = field(default_factory=list)
    annotations: list[tuple[float, str]] = field(default_factory=list)


def interpolate(timeline: list[tuple[float, float]], t: float) -> float:
    times = [p[0] for p in timeline]
    i = bisect.bisect_right(times, t) - 1
    if i < 0:
        return timeline[0][1]
    if i >= len(timeline) - 1:
        return timeline[-1][1]
    (t0, v0), (t1, v1) = timeline[i], timeline[i + 1]
    return v0 + (v1 - v0) * (t - t0) / (t1 - t0)


def _points(raw, where: str) -> list[tuple[float, float]]:
    pts = [(parse_duration(t), float(v)) for t, v in raw]
    if not pts or any(b[0] < a[0] for a, b in zip(pts, pts[1:])):
        raise ValueError(f"{where}: timeline must be non-empty and in time order")
    return pts


def list_scenarios() -> list[str]:
    return sorted(p.relative_to(SCENARIO_DIR).with_suffix("").as_posix() for p in SCENARIO_DIR.rglob("*.json"))


def load_scenario(name: str) -> Scenario:
    path = (SCENARIO_DIR / f"{name}.json").resolve()
    if SCENARIO_DIR.resolve() not in path.parents or not path.exists():
        raise FileNotFoundError(f"unknown scenario {name!r}; available: {', '.join(list_scenarios())}")
    d = json.loads(path.read_text(encoding="utf-8"))
    devices = [DeviceSpec(x["device_id"], x["driver"], bool(x.get("confirmed", True))) for x in d["devices"]]
    known = {x.device_id for x in devices}
    if d["therapy"]["type"] not in THERAPIES:
        raise ValueError(f"{name}: unknown therapy {d['therapy']['type']!r}")

    def check(sig: str, dev: str, where: str):
        if sig not in SIGNALS:
            raise ValueError(f"{name}: {where} uses unknown signal {sig!r}")
        if dev not in known:
            raise ValueError(f"{name}: {where} uses unknown device {dev!r}")

    signals = []
    for sig, s in d.get("signals", {}).items():
        check(sig, s["device"], f"signal {sig}")
        signals.append(SignalSpec(sig, s["device"], parse_duration(s["period"]), float(s.get("noise", 0)),
                                  _points(s["timeline"], f"{name}/{sig}")))
    labs = []
    for sig, s in d.get("labs", {}).items():
        check(sig, s["device"], f"lab {sig}")
        labs.append(LabSpec(sig, s["device"], _points(s["samples"], f"{name}/{sig}")))
    duration = parse_duration(d["duration"])
    artifacts = [Artifact(a["signal"], parse_duration(a["start"]), parse_duration(a.get("end", d["duration"])),
                          parse_duration(a["every"]), parse_duration(a["length"]), float(a["offset"]))
                 for a in d.get("artifacts", [])]
    outages = [Outage(o["device"], parse_duration(o["start"]), parse_duration(o["length"]))
               for o in d.get("outages", [])]
    annotations = [(parse_duration(a["at"]), a["label"]) for a in d.get("annotations", [])]
    return Scenario(name=name, description=d.get("description", ""), duration=duration,
                    seed=int(d.get("seed", 0)), encounter_id=d["encounter_id"],
                    therapy=d["therapy"]["type"], episode_id=d["therapy"]["episode_id"],
                    attributes={k: str(v) for k, v in d["therapy"].items() if k not in ("type", "episode_id")},
                    devices=devices, signals=signals, labs=labs, artifacts=artifacts,
                    outages=outages, annotations=annotations)
