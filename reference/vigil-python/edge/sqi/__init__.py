"""Per-channel signal quality index (0..1) with artifact flags.

Checks, in order:
  * out of plausible range        -> 0.0, OUT_OF_RANGE
  * step artifact (e.g. flush)    -> 0.1, FLUSH   while the value stays away from baseline
  * flatline (numeric channels)   -> 0.3, FLATLINE after an identical value for FLATLINE_S
Settings and lab results only get the range check.
"""
from __future__ import annotations

from dataclasses import dataclass

from shared.vigil_codes import Signal, SignalKind

FLATLINE_S = 60.0
MAX_ARTIFACT_S = 300.0  # a "flush" lasting longer than this is accepted as a real level change


@dataclass
class _Channel:
    baseline: float | None = None
    artifact_since: float | None = None
    last_value: float | None = None
    same_since: float | None = None


class SignalQuality:
    def __init__(self):
        self._channels: dict[tuple, _Channel] = {}

    def assess(self, key: tuple, sig: Signal, t: float, value: float) -> tuple[float, list[str]]:
        lo, hi = sig.plausible
        if not lo <= value <= hi:
            return 0.0, ["OUT_OF_RANGE"]
        if sig.kind is not SignalKind.NUMERIC:
            return 1.0, []

        ch = self._channels.setdefault(key, _Channel())
        sqi, flags = 1.0, []

        if sig.step_artifact is not None:
            if ch.artifact_since is not None:
                if abs(value - ch.baseline) <= sig.step_artifact / 3:
                    ch.artifact_since = None
                elif t - ch.artifact_since > MAX_ARTIFACT_S:
                    ch.artifact_since = None
                    sqi, flags = 0.5, ["LEVEL_SHIFT"]
                else:
                    sqi, flags = 0.1, ["FLUSH"]
            elif ch.baseline is not None and abs(value - ch.baseline) > sig.step_artifact:
                ch.artifact_since = t
                sqi, flags = 0.1, ["FLUSH"]
            if ch.artifact_since is None:
                ch.baseline = value

        if value == ch.last_value:
            if ch.same_since is not None and t - ch.same_since >= FLATLINE_S and sqi > 0.3:
                sqi, flags = 0.3, ["FLATLINE"]
        else:
            ch.same_since = t
        ch.last_value = value
        return sqi, flags
