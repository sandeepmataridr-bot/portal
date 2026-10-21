"""Driver for the simulated "SimCirc" ECMO console (TEST mode only).

Frame format, one sample per line:  SC1|<device_id>|<device_time>|<code>|<value>|<unit>
"""
from __future__ import annotations

from edge.driver_sdk import Driver, RawSample


class SimEcmoDriver(Driver):
    driver_id = "sim_ecmo"
    version = "0.1.0"
    simulated = True

    def decode(self, frame: str) -> list[RawSample]:
        parts = frame.strip().split("|")
        if len(parts) != 6 or parts[0] != "SC1":
            raise ValueError(f"not a SimCirc frame: {frame!r}")
        _, device_id, t, code, value, unit = parts
        return [RawSample(device_id, code, float(value), unit, float(t))]
