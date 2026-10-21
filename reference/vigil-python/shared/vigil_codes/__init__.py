"""Terminology tables: units, Vigil signal definitions, therapies.

Signals use the VIGIL code system until a standard code (MDC / LOINC) exists
for the concept; ECMO circuit parameters mostly have none today.
"""
from __future__ import annotations

from dataclasses import dataclass
from enum import Enum

CODE_SYSTEM = "VIGIL"

# Rule-language unit symbol -> UCUM code.
UNITS = {
    "mmHg": "mm[Hg]",
    "kPa": "kPa",
    "L/min": "L/min",
    "%": "%",
}
TIME_UNITS = {"ms": 0.001, "s": 1.0, "min": 60.0, "h": 3600.0}

_MMHG_PER_KPA = 7.500615758
_CONVERSIONS = {
    ("kPa", "mm[Hg]"): lambda v: v * _MMHG_PER_KPA,
    ("mm[Hg]", "kPa"): lambda v: v / _MMHG_PER_KPA,
    ("mL/min", "L/min"): lambda v: v / 1000.0,
}

# MDC dimension codes seen in HL7 PCD-01 OBX-6.
MDC_DIM_TO_UCUM = {
    "MDC_DIM_MMHG": "mm[Hg]",
    "MDC_DIM_KILO_PASCAL": "kPa",
    "MDC_DIM_L_PER_MIN": "L/min",
    "MDC_DIM_PERCENT": "%",
}


class UnitConversionError(ValueError):
    pass


def convert(value: float, from_ucum: str, to_ucum: str) -> float:
    if from_ucum == to_ucum:
        return value
    try:
        return _CONVERSIONS[(from_ucum, to_ucum)](value)
    except KeyError:
        raise UnitConversionError(f"no conversion from {from_ucum!r} to {to_ucum!r}") from None


class SignalKind(Enum):
    NUMERIC = "numeric"   # periodic device measurement
    SETTING = "setting"   # device setting chosen by a clinician
    LAB = "lab"           # sporadic result, e.g. blood gas


@dataclass(frozen=True)
class Signal:
    name: str
    unit: str                         # rule-language unit symbol, key of UNITS
    kind: SignalKind
    plausible: tuple[float, float]    # outside this range the sample is an artifact
    description: str
    step_artifact: float | None = None  # jump size treated as flush/step artifact

    @property
    def ucum(self) -> str:
        return UNITS[self.unit]


SIGNALS = {s.name: s for s in [
    Signal("ECMO_BLOOD_FLOW", "L/min", SignalKind.NUMERIC, (0.0, 10.0),
           "ECMO circuit blood flow"),
    Signal("ECMO_OXY_DELTA_P", "mmHg", SignalKind.NUMERIC, (-20.0, 300.0),
           "Pressure drop across the oxygenator (pre minus post)", step_artifact=30.0),
    Signal("ECMO_SWEEP_FLOW", "L/min", SignalKind.SETTING, (0.0, 15.0),
           "Sweep gas flow setting"),
    Signal("BG_POST_OXY_PO2", "mmHg", SignalKind.LAB, (0.0, 800.0),
           "Post-oxygenator blood gas PO2"),
]}

THERAPIES = {"ECMO", "IABP"}
