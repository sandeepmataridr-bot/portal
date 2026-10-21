"""Type checker and compiler: RuleDecl -> CompiledRule.

Checks enforced here (plan §5.5):
  * units are type-checked; a limit in kPa against a signal in mmHg is a
    compile error, never a runtime conversion
  * every rule declares at least one firing and one non-firing test
  * `safety_floor true` rules may only use Class C functions
"""
from __future__ import annotations

import operator
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable

from shared.vigil_codes import SIGNALS, THERAPIES, TIME_UNITS, Signal
from shared.vigil_time import format_duration

from . import nodes as n
from .errors import RuleError
from .functions import LIBRARY, FunctionSpec
from .parser import parse

PRIORITIES = ("HIGH", "MEDIUM", "LOW", "ADVISORY")
_CMP = {">": operator.gt, "<": operator.lt, ">=": operator.ge, "<=": operator.le,
        "==": operator.eq, "!=": operator.ne}
_PLACEHOLDER = re.compile(r"\{([A-Za-z_][A-Za-z0-9_]*)(?:\.([A-Za-z_][A-Za-z0-9_]*))?\}")
_GET = {None: lambda v: v, "slope": lambda v: v.slope, "value": lambda v: v.value}
TIME = "time"

# Three-valued condition: True, False, or None (unknown).
Cond = Callable[[dict, float], "bool | None"]


def _fields(result: str, sig: Signal) -> dict:
    """Readable parts of a function result and their units (None = the bare value)."""
    return {
        "trend": {"slope": f"{sig.unit}/h"},
        "quantity": {None: sig.unit},
        "setting": {"value": sig.unit},
        "duration": {None: TIME},
    }[result]


def format_value(x: float, unit: str, with_unit: bool = True) -> str:
    if unit == TIME:
        return format_duration(x)
    num = f"{x:.0f}" if abs(x) >= 100 else f"{x:.1f}"
    if not with_unit:
        return num
    return f"{num}%" if unit == "%" else f"{num} {unit}"


@dataclass
class LetBinding:
    name: str
    spec: FunctionSpec
    signal: Signal
    args: dict[str, float]

    @property
    def fields(self) -> dict:
        return _fields(self.spec.result, self.signal)


@dataclass
class RuleTestSpec:
    name: str
    scenario: str
    expect: str
    within: float | None


@dataclass
class CompiledRule:
    rule_id: str
    version: int
    owner: str
    therapy: str
    priority: str
    safety_floor: bool
    source: str
    lets: list[LetBinding]
    when: Cond
    when_hold: float
    clear: Cond | None
    clear_hold: float
    explain: str
    tests: list[RuleTestSpec] = field(default_factory=list)

    @property
    def key(self) -> str:
        return f"{self.rule_id} v{self.version}"

    @property
    def signals(self) -> set[str]:
        return {b.signal.name for b in self.lets}

    def new_operators(self, start: float) -> dict[str, object]:
        return {b.name: b.spec.factory(b.args, start) for b in self.lets}

    def explain_text(self, values: dict) -> str:
        bindings = {b.name: b for b in self.lets}

        def sub(m: re.Match) -> str:
            name, fld = m.group(1), m.group(2)
            v = values.get(name)
            if v is None:
                return "unknown"
            unit = bindings[name].fields[fld]
            # "{dp.slope} mmHg/h" already spells the unit; "{post_o2}" does not.
            written = re.match(rf"\s*{re.escape(unit)}(?![\w/])", self.explain[m.end():])
            return format_value(_GET[fld](v), unit, with_unit=not written)

        return _PLACEHOLDER.sub(sub, self.explain)


class _Compiler:
    def __init__(self, decl: n.RuleDecl):
        self.d = decl
        self.lets: dict[str, LetBinding] = {}

    def err(self, msg: str, line: int = 0, col: int = 0):
        raise RuleError(f"{self.d.rule_id}: {msg}", self.d.source, line or self.d.line, col)

    def compile(self) -> CompiledRule:
        d = self.d
        if d.priority not in PRIORITIES:
            self.err(f"priority must be one of {', '.join(PRIORITIES)}")
        if d.therapy not in THERAPIES:
            self.err(f"unknown therapy {d.therapy!r}; known: {', '.join(sorted(THERAPIES))}")
        for let in d.lets:
            self._bind(let)
        when = self._expr(d.when.expr)
        when_hold = self._hold(d.when.hold)
        clear, clear_hold = None, 0.0
        if d.clear_when:
            clear = self._expr(d.clear_when.expr)
            clear_hold = self._hold(d.clear_when.hold)
        self._check_explain()
        return CompiledRule(d.rule_id, d.version, d.owner, d.therapy, d.priority, d.safety_floor,
                            d.source, list(self.lets.values()), when, when_hold, clear, clear_hold,
                            d.explain, self._tests())

    def _bind(self, let: n.Let):
        call = let.call
        spec = LIBRARY.get(call.func)
        if spec is None:
            self.err(f"unknown function {call.func!r}; known: {', '.join(LIBRARY)}", call.line, call.col)
        if let.name in self.lets:
            self.err(f"{let.name!r} is defined twice", let.line, let.col)
        sig = SIGNALS.get(call.signal)
        if sig is None:
            self.err(f"unknown signal {call.signal!r}", call.line, call.col)
        if sig.kind not in spec.signal_kinds:
            self.err(f"{call.func}() does not accept {sig.kind.value} signal {sig.name}", call.line, call.col)
        if self.d.safety_floor and not spec.class_c:
            allowed = ", ".join(s.name for s in LIBRARY.values() if s.class_c)
            self.err(f"safety_floor rules may only use Class C functions ({allowed}); "
                     f"{call.func}() is not Class C", call.line, call.col)
        args = {}
        for key, q in call.kwargs.items():
            kind = spec.kwargs.get(key)
            if kind is None:
                self.err(f"{call.func}() has no argument {key!r}", q.line, q.col)
            args[key] = self._literal(q, kind)
        missing = spec.required - args.keys()
        if missing:
            self.err(f"{call.func}() needs {', '.join(sorted(missing))}", call.line, call.col)
        self.lets[let.name] = LetBinding(let.name, spec, sig, args)

    def _literal(self, q: n.Quantity, kind: str) -> float:
        if kind == "duration":
            if q.unit not in TIME_UNITS:
                self.err("expected a duration such as 30 s, 15 min or 6h", q.line, q.col)
            return q.value * TIME_UNITS[q.unit]
        if kind == "fraction":
            if q.unit is not None or not 0.0 <= q.value <= 1.0:
                self.err("expected a plain number between 0 and 1", q.line, q.col)
            return q.value
        raise AssertionError(kind)

    def _hold(self, q: n.Quantity | None) -> float:
        return 0.0 if q is None else self._literal(q, "duration")

    def _binding(self, name: str, line: int, col: int) -> LetBinding:
        b = self.lets.get(name)
        if b is None:
            self.err(f"unknown name {name!r}; define it with let", line, col)
        return b

    def _expr(self, e) -> Cond:
        if isinstance(e, n.Compare):
            return self._compare(e)
        if isinstance(e, n.Predicate):
            return self._predicate(e)
        if isinstance(e, n.And):
            parts = [self._expr(x) for x in e.items]

            def and_(vals, now):
                results = [p(vals, now) for p in parts]
                if any(r is False for r in results):
                    return False
                return None if any(r is None for r in results) else True
            return and_
        if isinstance(e, n.Or):
            parts = [self._expr(x) for x in e.items]

            def or_(vals, now):
                results = [p(vals, now) for p in parts]
                if any(r is True for r in results):
                    return True
                return None if any(r is None for r in results) else False
            return or_
        if isinstance(e, n.Not):
            inner = self._expr(e.item)

            def not_(vals, now):
                r = inner(vals, now)
                return None if r is None else not r
            return not_
        raise AssertionError(type(e))

    def _compare(self, c: n.Compare) -> Cond:
        ref, q = c.left, c.right
        b = self._binding(ref.name, ref.line, ref.col)
        fields = b.fields
        label = ref.name + (f".{ref.field}" if ref.field else "")
        if ref.field not in fields:
            options = ", ".join(f"{ref.name}.{f}" if f else ref.name for f in fields)
            self.err(f"cannot compare {label}; use {options}", ref.line, ref.col)
        unit = fields[ref.field]
        if unit == TIME:
            threshold = self._literal(q, "duration")
        else:
            if q.unit is None:
                self.err(f"missing unit: {label} is in {unit}", q.line, q.col)
            if q.unit != unit:
                self.err(f"unit mismatch: {label} is in {unit} but the limit is in {q.unit}; "
                         f"rules never convert units, write the limit in {unit}", q.line, q.col)
            threshold = q.value
        name, get, cmp = ref.name, _GET[ref.field], _CMP[c.op]

        def compare(vals, now):
            v = vals[name]
            return None if v is None else cmp(get(v), threshold)
        return compare

    def _predicate(self, p: n.Predicate) -> Cond:
        b = self._binding(p.target, p.line, p.col)
        if b.spec.result != "setting" or p.method != "unchanged_for":
            self.err(f"{p.target}.{p.method}() is not available; only setting().unchanged_for(<duration>)",
                     p.line, p.col)
        duration, name = self._literal(p.arg, "duration"), p.target

        def unchanged_for(vals, now):
            v = vals[name]
            return None if v is None else now - v.changed_at >= duration
        return unchanged_for

    def _check_explain(self):
        for m in _PLACEHOLDER.finditer(self.d.explain):
            name, fld = m.group(1), m.group(2)
            b = self.lets.get(name)
            if b is None or fld not in b.fields:
                self.err(f"explain refers to unknown value {m.group(0)}")

    def _tests(self) -> list[RuleTestSpec]:
        tests, names = [], set()
        for t in self.d.tests:
            if t.name in names:
                self.err(f"test {t.name!r} is defined twice", t.line)
            names.add(t.name)
            within = self._literal(t.within, "duration") if t.within else None
            tests.append(RuleTestSpec(t.name, t.scenario, t.expect, within))
        if not any(t.expect == "fire" for t in tests) or not any(t.expect == "no_fire" for t in tests):
            self.err("every rule needs at least one 'expect fire' and one 'expect no_fire' test")
        return tests


def compile_source(text: str, source: str = "<rule>") -> list[CompiledRule]:
    return [_Compiler(decl).compile() for decl in parse(text, source)]


def load_rule_files(paths) -> list[CompiledRule]:
    rules: list[CompiledRule] = []
    seen: dict[str, str] = {}
    for path in paths:
        path = Path(path)
        for rule in compile_source(path.read_text(encoding="utf-8"), str(path)):
            if rule.rule_id in seen:
                raise RuleError(f"duplicate rule id {rule.rule_id} (also in {seen[rule.rule_id]})", str(path))
            seen[rule.rule_id] = str(path)
            rules.append(rule)
    return rules
