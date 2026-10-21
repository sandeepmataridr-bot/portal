"""Time helpers: durations, clocks and time-ordered event ids.

Times are float seconds. In LIVE mode they are Unix epoch seconds; in TEST mode
they are seconds since the start of the scenario (epoch 0).
"""
from __future__ import annotations

import os
import re
import time
import uuid
from datetime import datetime, timezone

DURATION_UNITS = {"ms": 0.001, "s": 1.0, "min": 60.0, "h": 3600.0}
_DURATION = re.compile(r"^\s*(\d+(?:\.\d+)?)\s*(ms|s|min|h)\s*$")


def parse_duration(text: str | int | float) -> float:
    """'15min' -> 900.0. Bare numbers are seconds."""
    if isinstance(text, (int, float)):
        return float(text)
    m = _DURATION.match(text)
    if not m:
        raise ValueError(f"bad duration {text!r}; use e.g. 5s, 15min, 6h")
    return float(m.group(1)) * DURATION_UNITS[m.group(2)]


def format_duration(seconds: float) -> str:
    if seconds < 120:
        return f"{seconds:.0f} s"
    if seconds < 7200:
        return f"{seconds / 60:.1f} min"
    return f"{seconds / 3600:.1f} h"


def new_event_id() -> str:
    """UUIDv7: time-ordered, so ids sort by recording time."""
    if hasattr(uuid, "uuid7"):
        return str(uuid.uuid7())
    ms = time.time_ns() // 1_000_000
    value = (ms & ((1 << 48) - 1)) << 80 | 0x7 << 76 | int.from_bytes(os.urandom(10), "big") >> 4
    value = (value & ~(0b11 << 62)) | (0b10 << 62)
    return str(uuid.UUID(int=value))


class WallClock:
    simulated = False

    def now(self) -> float:
        return time.time()

    def format(self, t: float) -> str:
        return datetime.fromtimestamp(t, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


class SimClock:
    simulated = True

    def __init__(self, start: float = 0.0):
        self._now = start

    def now(self) -> float:
        return self._now

    def advance_to(self, t: float) -> None:
        if t < self._now:
            raise ValueError("simulated clock cannot run backwards")
        self._now = t

    def format(self, t: float) -> str:
        s = int(round(t))
        return f"T+{s // 3600:02d}:{s % 3600 // 60:02d}:{s % 60:02d}"
