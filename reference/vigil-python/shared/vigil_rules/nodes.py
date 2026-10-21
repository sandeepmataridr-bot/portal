"""Syntax tree for the Vigil rule language."""
from __future__ import annotations

from dataclasses import dataclass, field


@dataclass
class Quantity:
    value: float
    unit: str | None
    line: int
    col: int


@dataclass
class Call:
    func: str
    signal: str
    kwargs: dict[str, Quantity]
    line: int
    col: int


@dataclass
class Let:
    name: str
    call: Call
    line: int
    col: int


@dataclass
class Ref:
    name: str
    field: str | None
    line: int
    col: int


@dataclass
class Compare:
    left: Ref
    op: str
    right: Quantity


@dataclass
class Predicate:
    target: str
    method: str
    arg: Quantity
    line: int
    col: int


@dataclass
class And:
    items: list


@dataclass
class Or:
    items: list


@dataclass
class Not:
    item: object


@dataclass
class Condition:
    expr: object
    hold: Quantity | None


@dataclass
class RuleTest:
    name: str
    scenario: str
    expect: str  # "fire" | "no_fire"
    within: Quantity | None
    line: int


@dataclass
class RuleDecl:
    rule_id: str
    version: int
    source: str
    line: int
    owner: str = ""
    therapy: str = ""
    priority: str = ""
    safety_floor: bool = False
    lets: list[Let] = field(default_factory=list)
    when: Condition | None = None
    clear_when: Condition | None = None
    explain: str = ""
    tests: list[RuleTest] = field(default_factory=list)
