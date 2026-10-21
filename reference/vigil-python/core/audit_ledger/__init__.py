"""Append-only, hash-chained audit ledger (JSON lines).

Each record carries the SHA-256 of the previous one, so any edit, deletion or
reordering breaks verification from that point on.
"""
from __future__ import annotations

import hashlib
import json
import threading
import time
from pathlib import Path

GENESIS = "0" * 64


def _digest(record: dict) -> str:
    body = {k: record[k] for k in ("seq", "at", "kind", "data", "prev")}
    return hashlib.sha256(json.dumps(body, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


class AuditLedger:
    def __init__(self, path: Path | str):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()
        self._seq, self._prev = 0, GENESIS
        ok, count, error = verify(self.path)
        if not ok:
            raise RuntimeError(f"audit ledger {self.path} failed verification: {error}")
        if count:
            last = json.loads(self.path.read_text(encoding="utf-8").splitlines()[-1])
            self._seq, self._prev = last["seq"], last["hash"]

    def append(self, kind: str, data: dict) -> dict:
        with self._lock:
            record = {"seq": self._seq + 1, "at": time.time(), "kind": kind, "data": data, "prev": self._prev}
            record["hash"] = _digest(record)
            with open(self.path, "a", encoding="utf-8") as fh:
                fh.write(json.dumps(record, sort_keys=True) + "\n")
            self._seq, self._prev = record["seq"], record["hash"]
            return record


def verify(path: Path | str) -> tuple[bool, int, str]:
    """Returns (ok, record count, error message)."""
    path = Path(path)
    if not path.exists():
        return True, 0, ""
    prev, count = GENESIS, 0
    for lineno, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        try:
            rec = json.loads(line)
        except json.JSONDecodeError:
            return False, count, f"line {lineno}: not JSON"
        if rec.get("prev") != prev or rec.get("seq") != count + 1:
            return False, count, f"line {lineno}: chain broken"
        if _digest(rec) != rec.get("hash"):
            return False, count, f"line {lineno}: hash mismatch"
        prev, count = rec["hash"], count + 1
    return True, count, ""
