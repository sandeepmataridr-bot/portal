"""Scenario player: produces the time-ordered stream of device frames for a scenario."""
from __future__ import annotations

import random
from dataclasses import dataclass, field

from shared.vigil_codes import SIGNALS, SignalKind

from .devices import SIMULATORS
from .scenario import Scenario, interpolate


@dataclass(order=True, frozen=True)
class SimFrame:
    t: float
    seq: int
    driver_id: str = field(compare=False)
    frame: str = field(compare=False)


def frames(scenario: Scenario) -> list[SimFrame]:
    rng = random.Random(scenario.seed)
    drivers = {d.device_id: d.driver for d in scenario.devices}
    sims = {name: cls() for name, cls in SIMULATORS.items()}
    out: list[SimFrame] = []

    def offline(device: str, t: float) -> bool:
        return any(o.device == device and o.covers(t) for o in scenario.outages)

    def emit(device: str, signal: str, t: float, value: float):
        drv = drivers[device]
        frame = sims[drv].encode(device, signal, SIGNALS[signal].ucum, t, value)
        out.append(SimFrame(t, len(out), drv, frame))

    for spec in scenario.signals:
        artifacts = [a for a in scenario.artifacts if a.signal == spec.name]
        is_setting = SIGNALS[spec.name].kind is SignalKind.SETTING
        steps = int(scenario.duration // spec.period)
        for k in range(steps + 1):
            t = k * spec.period
            if offline(spec.device, t):
                continue
            value = interpolate(spec.timeline, t)
            if spec.noise and not is_setting:
                value += rng.gauss(0.0, spec.noise)
            for a in artifacts:
                if a.start <= t < a.end and (t - a.start) % a.every < a.length:
                    value += a.offset
            emit(spec.device, spec.name, t, value)

    for lab in scenario.labs:
        for t, value in lab.samples:
            if t <= scenario.duration and not offline(lab.device, t):
                emit(lab.device, lab.name, t, value)

    out.sort()
    return out
