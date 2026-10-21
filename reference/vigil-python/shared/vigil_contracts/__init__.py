"""In-process mirror of proto/vigil/v1. Field names and numbering follow the
.proto files, which stay the source of truth. Timestamps are float seconds.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import Any


class Priority(Enum):
    HIGH = "HIGH"
    MEDIUM = "MEDIUM"
    LOW = "LOW"
    ADVISORY = "ADVISORY"


class AlertState(Enum):
    ACTIVE = "ACTIVE"
    ACKNOWLEDGED = "ACKNOWLEDGED"
    ESCALATED = "ESCALATED"
    RESOLVED = "RESOLVED"
    DISMISSED = "DISMISSED"


class Origin(Enum):
    EDGE_SAFETY_FLOOR = "EDGE_SAFETY_FLOOR"
    CORE = "CORE"


class AssociationMethod(Enum):
    ADT_ONLY = "ADT_ONLY"
    BARCODE = "BARCODE"
    NFC = "NFC"
    SDC_CONTEXT = "SDC_CONTEXT"


@dataclass
class Provenance:
    driver_id: str = ""
    driver_version: str = ""
    edge_node_id: str = ""
    late_arrival: bool = False


@dataclass
class Envelope:
    event_id: str
    tenant_id: str
    unit_id: str
    source_id: str
    valid_time: float
    recorded_time: float
    clock_offset_us: int
    schema: str
    payload: Any          # decoded message; bytes on the wire
    provenance: Provenance
    test_mode: bool


@dataclass
class Observation:
    association_id: str
    code_system: str
    code: str
    value: float
    unit_ucum: str
    raw_value: float
    raw_unit: str
    sqi: float = 1.0
    flags: list[str] = field(default_factory=list)


@dataclass
class DeviceAssociation:
    association_id: str
    device_id: str
    encounter_id: str
    therapy_episode_id: str
    start: float
    end: float | None = None
    method: AssociationMethod = AssociationMethod.ADT_ONLY
    confirmed: bool = False
    confirmed_by: str = ""


@dataclass
class TherapyEpisode:
    episode_id: str
    encounter_id: str
    therapy: str
    start: float
    end: float | None = None
    attributes: dict[str, str] = field(default_factory=dict)


@dataclass(frozen=True)
class RuleHit:
    rule_id: str
    rule_version: str


@dataclass(frozen=True)
class Finding:
    rule: RuleHit | None = None


@dataclass
class Alert:
    alert_id: str
    encounter_id: str
    priority: Priority
    problem_key: str
    findings: list[Finding]
    state: AlertState
    explanation: str
    evidence_event_ids: list[str]
    origin: Origin
    raised_time: float
    test_mode: bool
    resolved_time: float | None = None
    acknowledged_by: str = ""
