"""Edge safety floor: hosts `safety_floor true` rules only, so the unit keeps
alarming when the core is down."""
from __future__ import annotations

from pathlib import Path

from shared.vigil_rules import CompiledRule, RuleHost, load_rule_files

RULES_DIR = Path(__file__).parent / "rules"


class SafetyEngine(RuleHost):
    def __init__(self, rules: list[CompiledRule]):
        bad = [r.key for r in rules if not r.safety_floor]
        if bad:
            raise ValueError(f"the edge safety engine only hosts safety_floor rules; not: {', '.join(bad)}")
        super().__init__(rules)


def load_safety_rules(directory: Path = RULES_DIR) -> list[CompiledRule]:
    return load_rule_files(sorted(directory.glob("*.vrl")))
