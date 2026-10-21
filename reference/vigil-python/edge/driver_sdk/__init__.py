"""Driver ABI and driver host.

A driver turns device frames into RawSample messages (proto/vigil/v1/driver.proto).
The host enforces the operating mode (simulated drivers are refused in LIVE
mode) and isolates faults: a driver that throws is replaced by a fresh
instance and the frame is dropped, without affecting other drivers.

In production each driver runs as a separate sandboxed process (plan epic 1.2);
here they run in-process behind the same interface.
"""
from __future__ import annotations

from abc import ABC, abstractmethod
from collections import Counter
from dataclasses import dataclass, field
from typing import Callable


@dataclass
class RawSample:
    device_id: str
    vendor_code: str
    value: float
    unit: str
    device_time: float
    flags: list[str] = field(default_factory=list)


class Driver(ABC):
    driver_id: str = ""
    version: str = ""
    simulated: bool = False

    @abstractmethod
    def decode(self, frame: str) -> list[RawSample]:
        """Decode one device frame. Raise on malformed input."""


class ModeViolation(Exception):
    """An action that the current operating mode forbids."""


class DriverHost:
    def __init__(self, live_mode: bool, on_fault: Callable[[str, Exception], None] | None = None):
        self.live_mode = live_mode
        self._factories: dict[str, type[Driver]] = {}
        self._drivers: dict[str, Driver] = {}
        self.faults: Counter = Counter()
        self._on_fault = on_fault

    def register(self, factory: type[Driver]) -> None:
        if self.live_mode and factory.simulated:
            raise ModeViolation(f"driver {factory.driver_id!r} is a simulator and cannot run in LIVE mode")
        self._factories[factory.driver_id] = factory
        self._drivers[factory.driver_id] = factory()

    def driver(self, driver_id: str) -> Driver:
        try:
            return self._drivers[driver_id]
        except KeyError:
            raise ModeViolation(f"driver {driver_id!r} is not registered in "
                                f"{'LIVE' if self.live_mode else 'TEST'} mode") from None

    def decode(self, driver_id: str, frame: str) -> list[RawSample]:
        drv = self.driver(driver_id)
        try:
            return drv.decode(frame)
        except Exception as e:
            self.faults[driver_id] += 1
            self._drivers[driver_id] = self._factories[driver_id]()  # restart
            if self._on_fault:
                self._on_fault(driver_id, e)
            return []
