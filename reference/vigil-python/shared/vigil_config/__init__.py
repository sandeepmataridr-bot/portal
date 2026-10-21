"""Loads vigil.toml and resolves the operating mode.

`live_mode` is the single switch between the two modes:

    False -> TEST: simulators, simulated clock, console-only alarms tagged TEST
    True  -> LIVE: real drivers only, wall clock, nurse call, separate audit ledger

The VIGIL_LIVE_MODE environment variable overrides the file.
"""
from __future__ import annotations

import os
import tomllib
from dataclasses import dataclass, field
from enum import Enum
from pathlib import Path
from typing import Mapping

from shared.vigil_codes import SIGNALS, THERAPIES

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_PATH = ROOT / "vigil.toml"
ENV_VAR = "VIGIL_LIVE_MODE"
NURSE_CALL_ADAPTERS = {"log"}

_TRUE = {"1", "true", "yes", "on"}
_FALSE = {"0", "false", "no", "off"}


class Mode(Enum):
    TEST = "test"
    LIVE = "live"


class ConfigError(Exception):
    pass


@dataclass
class LiveAssociation:
    device_id: str
    encounter_id: str
    therapy: str
    episode_id: str
    confirmed: bool
    confirmed_by: str


@dataclass
class Config:
    live_mode: bool
    mode_source: str
    tenant_id: str
    unit_id: str
    edge_node_id: str
    audit_path: Path
    tick_seconds: float = 1.0
    # TEST only
    scenario: str = ""
    speed: float = 0.0
    # LIVE only
    hl7_host: str = "127.0.0.1"
    hl7_port: int = 2575
    nurse_call: str = ""
    nurse_call_log: Path | None = None
    hl7_codes: dict[str, str] = field(default_factory=dict)
    associations: list[LiveAssociation] = field(default_factory=list)

    @property
    def mode(self) -> Mode:
        return Mode.LIVE if self.live_mode else Mode.TEST


def _parse_bool(value: object, where: str) -> bool:
    if isinstance(value, bool):
        return value
    text = str(value).strip().lower()
    if text in _TRUE:
        return True
    if text in _FALSE:
        return False
    raise ConfigError(f"{where} must be true or false, got {value!r}")


def load_config(path: Path | str | None = None, env: Mapping[str, str] | None = None) -> Config:
    path = Path(path) if path else DEFAULT_PATH
    env = os.environ if env is None else env
    try:
        with open(path, "rb") as fh:
            data = tomllib.load(fh)
    except FileNotFoundError:
        raise ConfigError(f"config file not found: {path}") from None
    except tomllib.TOMLDecodeError as e:
        raise ConfigError(f"{path}: {e}") from None

    if ENV_VAR in env and env[ENV_VAR].strip():
        live = _parse_bool(env[ENV_VAR], ENV_VAR)
        source = f"environment {ENV_VAR}"
    else:
        if "live_mode" not in data:
            raise ConfigError(f"{path}: 'live_mode' must be set to true or false")
        live = _parse_bool(data["live_mode"], "live_mode")
        source = path.name

    base = path.parent
    cfg = _live(data.get("live", {}), base, source) if live else _test(data.get("test", {}), base, source)
    return cfg


def _common(section: Mapping, base: Path, live: bool, source: str) -> Config:
    tenant = str(section.get("tenant_id", "")).strip()
    unit = str(section.get("unit_id", "")).strip()
    node = str(section.get("edge_node_id", "")).strip() or (f"{unit}-edge-a" if unit else "")
    audit = section.get("audit_path") or ("var/live/audit.jsonl" if live else "var/test/audit.jsonl")
    tick = float(section.get("tick_seconds", 1))
    if tick <= 0:
        raise ConfigError("tick_seconds must be positive")
    return Config(live_mode=live, mode_source=source, tenant_id=tenant, unit_id=unit,
                  edge_node_id=node, audit_path=base / audit, tick_seconds=tick)


def _test(section: Mapping, base: Path, source: str) -> Config:
    cfg = _common(section, base, False, source)
    # Test identities must be recognisably synthetic so test data can never
    # be filed under a real hospital or unit.
    for key, value in (("tenant_id", cfg.tenant_id), ("unit_id", cfg.unit_id)):
        if not value.startswith("sim"):
            raise ConfigError(f"[test] {key} must start with 'sim' (got {value!r})")
    cfg.scenario = str(section.get("scenario", ""))
    cfg.speed = float(section.get("speed", 0))
    if cfg.speed < 0:
        raise ConfigError("[test] speed must be >= 0")
    return cfg


def _live(section: Mapping, base: Path, source: str) -> Config:
    cfg = _common(section, base, True, source)
    problems = []
    for key, value in (("tenant_id", cfg.tenant_id), ("unit_id", cfg.unit_id)):
        if not value:
            problems.append(f"[live] {key} is required")
        elif value.startswith("sim"):
            problems.append(f"[live] {key} must not start with 'sim' (reserved for TEST mode)")
    cfg.hl7_host = str(section.get("hl7_host", "127.0.0.1"))
    cfg.hl7_port = int(section.get("hl7_port", 2575))
    if not 1 <= cfg.hl7_port <= 65535:
        problems.append("[live] hl7_port must be 1-65535")
    cfg.nurse_call = str(section.get("nurse_call", ""))
    if cfg.nurse_call not in NURSE_CALL_ADAPTERS:
        problems.append(f"[live] nurse_call must be one of {sorted(NURSE_CALL_ADAPTERS)}")
    cfg.nurse_call_log = base / section.get("nurse_call_log", "var/live/nurse_call.log")

    codes = dict(section.get("hl7_codes", {}))
    for code, signal in codes.items():
        if signal not in SIGNALS:
            problems.append(f"[live.hl7_codes] {code!r} maps to unknown signal {signal!r}")
    cfg.hl7_codes = codes

    seen = set()
    for i, a in enumerate(section.get("associations", [])):
        where = f"[[live.associations]] #{i + 1}"
        missing = [k for k in ("device_id", "encounter_id", "therapy", "episode_id") if not a.get(k)]
        if missing:
            problems.append(f"{where} missing {', '.join(missing)}")
            continue
        if a["therapy"] not in THERAPIES:
            problems.append(f"{where} therapy must be one of {sorted(THERAPIES)}")
        if a["device_id"] in seen:
            problems.append(f"{where} device {a['device_id']!r} is associated twice")
        seen.add(a["device_id"])
        confirmed = _parse_bool(a.get("confirmed", False), f"{where} confirmed")
        by = str(a.get("confirmed_by", "")).strip()
        if confirmed and not by:
            problems.append(f"{where} confirmed associations need confirmed_by")
        cfg.associations.append(LiveAssociation(a["device_id"], a["encounter_id"], a["therapy"],
                                                a["episode_id"], confirmed, by))
    if not cfg.associations and not problems:
        problems.append("[live] at least one [[live.associations]] block is required")

    if problems:
        raise ConfigError("LIVE mode configuration is incomplete:\n  - " + "\n  - ".join(problems))
    return cfg
