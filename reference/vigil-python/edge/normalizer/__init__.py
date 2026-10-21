"""Maps device codes and units to Vigil signals in canonical UCUM units.

The raw value and unit are always kept. Anything that cannot be mapped or
converted is forwarded as a VENDOR observation with a flag, never dropped,
and never reaches the rules.
"""
from __future__ import annotations

import json
from pathlib import Path

from edge.driver_sdk import RawSample
from shared.vigil_codes import CODE_SYSTEM, SIGNALS, SignalKind, UnitConversionError, convert
from shared.vigil_contracts import Observation

MAPS_DIR = Path(__file__).parent / "maps"


class Normalizer:
    def __init__(self, maps: dict[str, dict[str, str]]):
        for driver_id, table in maps.items():
            for code, signal in table.items():
                if signal not in SIGNALS:
                    raise ValueError(f"map {driver_id}: {code!r} -> unknown signal {signal!r}")
        self.maps = maps

    @classmethod
    def from_files(cls, extra: dict[str, dict[str, str]] | None = None) -> "Normalizer":
        maps = {p.stem: json.loads(p.read_text(encoding="utf-8")) for p in sorted(MAPS_DIR.glob("*.json"))}
        for driver_id, table in (extra or {}).items():
            maps.setdefault(driver_id, {}).update(table)
        return cls(maps)

    def normalize(self, driver_id: str, raw: RawSample, association_id: str) -> Observation:
        flags = list(raw.flags)
        name = self.maps.get(driver_id, {}).get(raw.vendor_code)
        if name is None:
            return Observation(association_id, "VENDOR", raw.vendor_code, raw.value, raw.unit,
                               raw.value, raw.unit, 1.0, flags + ["UNMAPPED"])
        sig = SIGNALS[name]
        try:
            value = convert(raw.value, raw.unit, sig.ucum)
        except UnitConversionError:
            return Observation(association_id, "VENDOR", raw.vendor_code, raw.value, raw.unit,
                               raw.value, raw.unit, 1.0, flags + ["UNIT_UNCONVERTIBLE"])
        if sig.kind is SignalKind.SETTING:
            flags.append("SETTING")
        return Observation(association_id, CODE_SYSTEM, sig.name, value, sig.ucum,
                           raw.value, raw.unit, 1.0, flags)
