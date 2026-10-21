"""Built-in rule functions.

Each function is a stateful operator per (rule, encounter): it receives the
encounter's observations for one signal and yields a value at evaluation time,
or None when the value is unknown (no data, stale data, too little coverage).
Unknown never fires and never clears a rule.

Functions marked class_c are simple enough for safety-floor rules (IEC 62304
Class C); the compiler rejects anything else in a `safety_floor true` rule.
"""
from __future__ import annotations

from collections import deque
from dataclasses import dataclass
from typing import Callable

from shared.vigil_codes import SignalKind


@dataclass(frozen=True)
class TrendValue:
    slope: float  # signal unit per hour
    n: int


@dataclass(frozen=True)
class SettingValue:
    value: float
    changed_at: float


class TrendOp:
    """Least-squares slope over a sliding window, using only samples with sqi >= min_sqi."""

    MIN_POINTS = 6

    def __init__(self, window: float, min_sqi: float, start: float):
        self.window = window
        self.min_sqi = min_sqi
        self.t0 = start
        self.points: deque[tuple[float, float, float]] = deque()
        self.n = 0
        self.sx = self.sy = self.sxx = self.sxy = 0.0

    def observe(self, t, value, sqi, flags):
        if sqi < self.min_sqi:
            return
        x = (t - self.t0) / 3600.0
        self.points.append((t, x, value))
        self.n += 1
        self.sx += x
        self.sy += value
        self.sxx += x * x
        self.sxy += x * value

    def value(self, now):
        while self.points and self.points[0][0] < now - self.window:
            _, x, y = self.points.popleft()
            self.n -= 1
            self.sx -= x
            self.sy -= y
            self.sxx -= x * x
            self.sxy -= x * y
        if self.n < self.MIN_POINTS:
            return None
        if self.points[-1][0] - self.points[0][0] < self.window / 2:
            return None  # not enough coverage of the window to trust a slope
        denom = self.n * self.sxx - self.sx * self.sx
        if denom <= 1e-12:
            return None
        return TrendValue((self.n * self.sxy - self.sx * self.sy) / denom, self.n)


class LatestOp:
    def __init__(self, max_age: float, min_sqi: float):
        self.max_age = max_age
        self.min_sqi = min_sqi
        self.last: tuple[float, float] | None = None

    def observe(self, t, value, sqi, flags):
        if sqi >= self.min_sqi and (self.last is None or t >= self.last[0]):
            self.last = (t, value)

    def value(self, now):
        if self.last is None or now - self.last[0] > self.max_age:
            return None
        return self.last[1]


class SettingOp:
    def __init__(self):
        self.current: SettingValue | None = None

    def observe(self, t, value, sqi, flags):
        if self.current is None or value != self.current.value:
            self.current = SettingValue(value, t)

    def value(self, now):
        return self.current


class DataAgeOp:
    """Seconds since the last sample of the signal (or since the encounter opened)."""

    def __init__(self, start: float):
        self.last = start

    def observe(self, t, value, sqi, flags):
        self.last = max(self.last, t)

    def value(self, now):
        return max(0.0, now - self.last)


@dataclass(frozen=True)
class FunctionSpec:
    name: str
    class_c: bool
    signal_kinds: frozenset
    kwargs: dict            # name -> "duration" | "fraction"
    required: frozenset
    result: str             # "trend" | "quantity" | "setting" | "duration"
    factory: Callable[[dict, float], object]


_NUMERIC = frozenset({SignalKind.NUMERIC, SignalKind.LAB})

LIBRARY = {spec.name: spec for spec in [
    FunctionSpec("trend", False, frozenset({SignalKind.NUMERIC}),
                 {"window": "duration", "min_sqi": "fraction"}, frozenset({"window"}), "trend",
                 lambda a, start: TrendOp(a["window"], a.get("min_sqi", 0.0), start)),
    FunctionSpec("latest", True, _NUMERIC,
                 {"max_age": "duration", "min_sqi": "fraction"}, frozenset({"max_age"}), "quantity",
                 lambda a, start: LatestOp(a["max_age"], a.get("min_sqi", 0.0))),
    FunctionSpec("setting", True, frozenset({SignalKind.SETTING}), {}, frozenset(), "setting",
                 lambda a, start: SettingOp()),
    FunctionSpec("data_age", True, frozenset(SignalKind), {}, frozenset(), "duration",
                 lambda a, start: DataAgeOp(start)),
]}
