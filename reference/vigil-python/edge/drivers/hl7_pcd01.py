"""IHE PCD-01 (HL7 v2 ORU^R01) driver with an MLLP listener. Usable in both modes.

Each numeric OBX becomes one RawSample:
  vendor_code = "<OBX-3 coding system>:<OBX-3 identifier>"
  unit        = OBX-6 (UCUM, or an MDC_DIM_* code mapped to UCUM)
  device_time = OBX-14, falling back to MSH-7
  device_id   = OBX-18 component 1, falling back to MSH-3
"""
from __future__ import annotations

import re
import socketserver
from datetime import datetime, timedelta, timezone
from typing import Callable

from edge.driver_sdk import Driver, RawSample
from shared.vigil_codes import MDC_DIM_TO_UCUM
from shared.vigil_time import new_event_id

MLLP_START = b"\x0b"
MLLP_END = b"\x1c\x0d"
MAX_BUFFER = 1 << 20
_ACCEPTED_STATUS = {"F", "R", "C"}  # final, unverified, corrected
_TS = re.compile(r"^(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\.\d+)?([+-]\d{4})?$")
_EPOCH = datetime(1970, 1, 1, tzinfo=timezone.utc)


class Hl7Error(ValueError):
    pass


def parse_ts(ts: str) -> float:
    m = _TS.match(ts.strip())
    if not m:
        raise Hl7Error(f"bad HL7 timestamp {ts!r}")
    y, mo, d, h, mi, s, frac, tz = m.groups()
    dt = datetime(int(y), int(mo or 1), int(d or 1), int(h or 0), int(mi or 0), int(s or 0),
                  tzinfo=timezone.utc)
    if tz:
        sign = 1 if tz[0] == "+" else -1
        dt -= sign * timedelta(hours=int(tz[1:3]), minutes=int(tz[3:5]))
    return (dt - _EPOCH).total_seconds() + (float(frac) if frac else 0.0)


def format_ts(t: float) -> str:
    return (_EPOCH + timedelta(seconds=t)).strftime("%Y%m%d%H%M%S")


def _segments(text: str) -> list[str]:
    return [s for s in re.split(r"\r\n|\r|\n", text) if s.strip()]


def _msh(text: str) -> list[str]:
    segs = _segments(text)
    if not segs or not segs[0].startswith("MSH"):
        raise Hl7Error("message does not start with MSH")
    return segs[0].split(segs[0][3])


def _field(fields: list[str], i: int) -> str:
    return fields[i] if i < len(fields) else ""


def _unit(obx6: str) -> str:
    comps = obx6.split("^")
    if len(comps) >= 3 and comps[2] == "MDC":
        return MDC_DIM_TO_UCUM.get(comps[1], comps[1])
    return comps[0]


def parse_oru(text: str) -> list[RawSample]:
    msh = _msh(text)
    sep = text.lstrip()[3]
    # After split on the field separator, MSH-n is index n-1.
    msg_type = _field(msh, 8).split("^")
    if msg_type[:2] != ["ORU", "R01"]:
        raise Hl7Error(f"expected ORU^R01, got {_field(msh, 8)!r}")
    default_device = _field(msh, 2).split("^")[0]
    default_time = parse_ts(_field(msh, 6)) if _field(msh, 6) else None

    samples = []
    for seg in _segments(text)[1:]:
        f = seg.split(sep)
        if f[0] != "OBX" or _field(f, 2) != "NM":
            continue
        if _field(f, 11) and _field(f, 11) not in _ACCEPTED_STATUS:
            continue
        ident = _field(f, 3).split("^")
        code = ident[0]
        system = ident[2] if len(ident) > 2 else ""
        if not code:
            raise Hl7Error("OBX-3 identifier is empty")
        try:
            value = float(_field(f, 5))
        except ValueError:
            raise Hl7Error(f"OBX-5 is not numeric: {_field(f, 5)!r}") from None
        ts = _field(f, 14)
        t = parse_ts(ts) if ts else default_time
        if t is None:
            raise Hl7Error("no observation time (OBX-14 or MSH-7)")
        device = _field(f, 18).split("^")[0] or default_device
        samples.append(RawSample(device, f"{system}:{code}" if system else code, value, _unit(_field(f, 6)), t))
    return samples


def build_ack(text: str, code: str, error: str = "") -> str:
    try:
        msh = _msh(text)
        control_id, app, fac = _field(msh, 9), _field(msh, 2), _field(msh, 3)
    except Hl7Error:
        control_id, app, fac = "", "", ""
    now = format_ts(datetime.now(timezone.utc).timestamp())
    msa = f"MSA|{code}|{control_id}"
    if error:
        msa += "|" + re.sub(r"[|^~\\&\r\n]", " ", error)[:80]
    return f"MSH|^~\\&|VIGIL|EDGE|{app}|{fac}|{now}||ACK^R01^ACK|{new_event_id()}|P|2.6\r{msa}\r"


def wrap_mllp(text: str) -> bytes:
    return MLLP_START + text.encode("utf-8") + MLLP_END


def unwrap_mllp(buf: bytes) -> tuple[list[str], bytes]:
    """Split complete MLLP frames off the front of buf; return (messages, rest)."""
    messages = []
    while True:
        start = buf.find(MLLP_START)
        if start < 0:
            return messages, b""
        end = buf.find(MLLP_END, start + 1)
        if end < 0:
            return messages, buf[start:]
        messages.append(buf[start + 1:end].decode("utf-8", errors="replace"))
        buf = buf[end + len(MLLP_END):]


class Hl7Pcd01Driver(Driver):
    driver_id = "hl7_pcd01"
    version = "0.1.0"
    simulated = False

    def decode(self, frame: str) -> list[RawSample]:
        return parse_oru(frame)


class _MllpHandler(socketserver.BaseRequestHandler):
    def handle(self):
        buf = b""
        while True:
            chunk = self.request.recv(65536)
            if not chunk:
                return
            buf += chunk
            messages, buf = unwrap_mllp(buf)
            for text in messages:
                try:
                    self.server.on_message(text)
                    ack = build_ack(text, "AA")
                except Exception as e:
                    ack = build_ack(text, "AE", str(e))
                self.request.sendall(wrap_mllp(ack))
            if len(buf) > MAX_BUFFER:
                return


class MllpServer(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True

    def __init__(self, address: tuple[str, int], on_message: Callable[[str], None]):
        self.on_message = on_message
        super().__init__(address, _MllpHandler)
