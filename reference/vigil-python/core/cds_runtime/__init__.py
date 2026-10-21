"""Core CDS runtime: the same vigil-rules host as the edge, running the rules
that do not belong to the safety floor. In this slice it is fed in-process by
the edge node; the forwarder and Kafka path come in plan epics 1.12 / 2.2.
"""
from __future__ import annotations

from pathlib import Path

from shared.vigil_rules import CompiledRule, RuleHost, load_rule_files

RULES_DIR = Path(__file__).parent / "rules"


class CdsRuntime(RuleHost):
    def __init__(self, rules: list[CompiledRule]):
        bad = [r.key for r in rules if r.safety_floor]
        if bad:
            raise ValueError(f"safety_floor rules run on the edge, not the core: {', '.join(bad)}")
        super().__init__(rules)


def load_core_rules(directory: Path = RULES_DIR) -> list[CompiledRule]:
    return load_rule_files(sorted(directory.glob("*.vrl")))
