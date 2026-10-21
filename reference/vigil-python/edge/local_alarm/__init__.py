"""Local alarm path: alert lifecycle, console display and nurse-call adapters.

Priority markers follow IEC 60601-1-8 (!!! high, !! medium, ! low).
TEST-mode alerts are always labelled TEST and are never sent to nurse call.
"""
from __future__ import annotations

import os
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import TextIO

from shared.vigil_contracts import Alert, AlertState, Finding, Origin, Priority, RuleHit
from shared.vigil_rules import RuleEvent
from shared.vigil_time import new_event_id

MARKERS = {Priority.HIGH: "!!!", Priority.MEDIUM: "!! ", Priority.LOW: "!  ", Priority.ADVISORY: "   "}
COLORS = {Priority.HIGH: "\x1b[1;37;41m", Priority.MEDIUM: "\x1b[1;30;43m",
          Priority.LOW: "\x1b[36m", Priority.ADVISORY: "\x1b[37m"}
RESET = "\x1b[0m"


def short_id(alert: Alert) -> str:
    """Last 8 hex digits: the random part of the UUIDv7 (the front is a timestamp)."""
    return alert.alert_id.replace("-", "")[-8:]


@dataclass
class Transition:
    kind: str  # "raised" | "resolved" | "acknowledged"
    alert: Alert
    at: float


class AlertBook:
    """Active alerts, keyed by (rule id, encounter)."""

    def __init__(self, test_mode: bool):
        self.test_mode = test_mode
        self.active: dict[tuple[str, str], Alert] = {}

    def apply(self, ev: RuleEvent, origin: Origin) -> Transition | None:
        key = (ev.rule.rule_id, ev.encounter_id)
        if ev.kind == "fire":
            alert = Alert(
                alert_id=new_event_id(), encounter_id=ev.encounter_id, priority=Priority(ev.rule.priority),
                problem_key=ev.rule.rule_id,
                findings=[Finding(rule=RuleHit(ev.rule.rule_id, f"v{ev.rule.version}"))],
                state=AlertState.ACTIVE, explanation=ev.explanation, evidence_event_ids=[],
                origin=origin, raised_time=ev.at, test_mode=self.test_mode)
            self.active[key] = alert
            return Transition("raised", alert, ev.at)
        alert = self.active.pop(key, None)
        if alert is None:
            return None
        alert.state, alert.resolved_time = AlertState.RESOLVED, ev.at
        return Transition("resolved", alert, ev.at)

    def acknowledge(self, ref: str, by: str, at: float) -> Transition:
        """ref is the short id shown on screen, or the full alert id."""
        if not by.strip():
            raise KeyError("acknowledgement needs the acknowledging user")
        matches = [a for a in self.active.values() if ref in (a.alert_id, short_id(a))]
        if len(matches) != 1:
            raise KeyError(f"{len(matches)} active alerts match {ref!r}")
        alert = matches[0]
        alert.state, alert.acknowledged_by = AlertState.ACKNOWLEDGED, by
        return Transition("acknowledged", alert, at)


class ConsolePresenter:
    def __init__(self, clock, live_mode: bool, out: TextIO = sys.stdout, color: bool | None = None):
        self.clock = clock
        self.live_mode = live_mode
        self.out = out
        if color is None:
            color = hasattr(out, "isatty") and out.isatty() and "NO_COLOR" not in os.environ
        self.color = color

    def show(self, tr: Transition) -> None:
        a = tr.alert
        tag = "" if self.live_mode else "[TEST] "
        rule = a.findings[0].rule
        where = "edge" if a.origin is Origin.EDGE_SAFETY_FLOOR else "core"
        if tr.kind == "raised":
            head = f"{MARKERS[a.priority]} {a.priority.value:<8}"
            if self.color:
                head = f"{COLORS[a.priority]}{head}{RESET}"
            line = (f"{tag}{self.clock.format(tr.at)}  {head} {rule.rule_id} {rule.rule_version} [{where}]"
                    f"  {a.encounter_id}  {a.explanation}  (id {short_id(a)})")
        elif tr.kind == "resolved":
            line = (f"{tag}{self.clock.format(tr.at)}  resolved     {rule.rule_id} {rule.rule_version} [{where}]"
                    f"  {a.encounter_id}  after {(tr.at - a.raised_time) / 60:.1f} min  (id {short_id(a)})")
        else:
            line = f"{tag}{self.clock.format(tr.at)}  acknowledged {rule.rule_id} by {a.acknowledged_by}  (id {short_id(a)})"
        print(line, file=self.out, flush=True)


class NurseCall:
    """Adapter interface for nurse-call / alarm-distribution systems."""

    def send(self, tr: Transition) -> None:
        raise NotImplementedError


class LogNurseCall(NurseCall):
    """Writes nurse-call messages to a file. Placeholder until a vendor
    adapter (Ascom, Vocera/Stryker, Rauland) is integrated and certified."""

    def __init__(self, path: Path | str):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)

    def send(self, tr: Transition) -> None:
        a = tr.alert
        if a.test_mode:
            raise ValueError("refusing to send a TEST-mode alert to nurse call")
        with open(self.path, "a", encoding="utf-8") as fh:
            fh.write(f"{tr.at:.3f}\t{tr.kind}\t{a.priority.value}\t{a.encounter_id}\t{a.alert_id}\t{a.explanation}\n")
