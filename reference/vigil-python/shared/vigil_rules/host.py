"""Deterministic rule runtime. The same host runs on the edge (safety floor)
and in the core (full rule sets); only the rule set and alert origin differ.
"""
from __future__ import annotations

from dataclasses import dataclass

from .compiler import CompiledRule


@dataclass
class RuleEvent:
    kind: str  # "fire" | "clear"
    rule: CompiledRule
    encounter_id: str
    at: float
    explanation: str = ""


class RuleInstance:
    """One rule for one encounter: operators plus the persistence/hysteresis state machine."""

    def __init__(self, rule: CompiledRule, encounter_id: str, start: float):
        self.rule = rule
        self.encounter_id = encounter_id
        self.ops = rule.new_operators(start)
        self._by_signal: dict[str, list] = {}
        for b in rule.lets:
            self._by_signal.setdefault(b.signal.name, []).append(self.ops[b.name])
        self.active = False
        self._since: float | None = None

    def observe(self, signal: str, t: float, value: float, sqi: float, flags) -> None:
        for op in self._by_signal.get(signal, ()):
            op.observe(t, value, sqi, flags)

    def evaluate(self, now: float) -> RuleEvent | None:
        r = self.rule
        values = {name: op.value(now) for name, op in self.ops.items()}
        if not self.active:
            cond, hold, kind = r.when(values, now), r.when_hold, "fire"
        elif r.clear is not None:
            cond, hold, kind = r.clear(values, now), r.clear_hold, "clear"
        else:
            w = r.when(values, now)
            cond, hold, kind = (None if w is None else not w), 0.0, "clear"

        if cond is not True:
            self._since = None
            return None
        if self._since is None:
            self._since = now
        if now - self._since < hold:
            return None
        self._since = None
        self.active = kind == "fire"
        return RuleEvent(kind, r, self.encounter_id, now, r.explain_text(values) if self.active else "")


class RuleHost:
    def __init__(self, rules):
        self.rules: list[CompiledRule] = list(rules)
        self._instances: dict[str, list[RuleInstance]] = {}

    def open_encounter(self, encounter_id: str, therapies: set[str], start: float) -> None:
        insts = self._instances.setdefault(encounter_id, [])
        have = {i.rule.rule_id for i in insts}
        for rule in self.rules:
            if rule.therapy in therapies and rule.rule_id not in have:
                insts.append(RuleInstance(rule, encounter_id, start))

    def close_encounter(self, encounter_id: str) -> None:
        self._instances.pop(encounter_id, None)

    def observe(self, encounter_id: str, signal: str, t: float, value: float, sqi: float, flags) -> None:
        for inst in self._instances.get(encounter_id, ()):
            inst.observe(signal, t, value, sqi, flags)

    def tick(self, now: float) -> list[RuleEvent]:
        events = []
        for insts in self._instances.values():
            for inst in insts:
                ev = inst.evaluate(now)
                if ev:
                    events.append(ev)
        return events
