"""Device simulators: turn true physiology into vendor wire frames."""
from __future__ import annotations

from edge.drivers.hl7_pcd01 import format_ts
from shared.vigil_codes import convert


class SimCircConsole:
    """Simulated ECMO console. Reports pressures in kPa, like some real consoles."""

    driver_id = "sim_ecmo"
    VENDOR = {
        "ECMO_BLOOD_FLOW": ("QB", "L/min"),
        "ECMO_OXY_DELTA_P": ("DPOXY", "kPa"),
        "ECMO_SWEEP_FLOW": ("SWEEP", "L/min"),
    }

    def encode(self, device_id: str, signal: str, unit_ucum: str, t: float, value: float) -> str:
        code, unit = self.VENDOR[signal]
        return f"SC1|{device_id}|{t:.3f}|{code}|{convert(value, unit_ucum, unit):.4f}|{unit}"


class SimBloodGasAnalyzer:
    """Simulated blood gas analyzer sending HL7 v2 ORU^R01 results."""

    driver_id = "hl7_pcd01"
    VENDOR = {"BG_POST_OXY_PO2": ("POST_OXY_PO2", "Post-oxygenator pO2", "L")}

    def __init__(self):
        self._n = 0

    def encode(self, device_id: str, signal: str, unit_ucum: str, t: float, value: float) -> str:
        self._n += 1
        code, text, system = self.VENDOR[signal]
        ts = format_ts(t)
        obx = ["OBX", "1", "NM", f"{code}^{text}^{system}", "", f"{value:.1f}", f"{unit_ucum}^{unit_ucum}^UCUM",
               "", "", "", "", "F", "", "", ts, "", "", "", device_id]
        return "\r".join([
            f"MSH|^~\\&|SIM_BGA|SIMLAB|VIGIL|EDGE|{ts}||ORU^R01^ORU_R01|SIM{self._n:06d}|P|2.6",
            "OBR|1|||BG^Blood gas^L|||" + ts,
            "|".join(obx),
        ]) + "\r"


SIMULATORS = {"sim_ecmo": SimCircConsole, "hl7_pcd01": SimBloodGasAnalyzer}
