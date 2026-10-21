"""Recursive-descent parser for .vrl files.

    rule      := 'rule' qualid VERSION clause*
    clause    := 'owner' STRING | 'applies_to' 'therapy' IDENT | 'priority' IDENT
               | 'safety_floor' ('true'|'false') | 'let' IDENT '=' call
               | 'when' cond ['for' quantity] | 'clear_when' cond ['for' quantity]
               | 'explain' STRING
               | 'test' STRING 'scenario' STRING 'expect' ('fire' 'within' quantity | 'no_fire')
    call      := IDENT '(' IDENT (',' IDENT quantity)* ')'
    cond      := and ('or' and)*
    and       := unary ('and' unary)*
    unary     := 'not' unary | '(' cond ')' | IDENT ['.' IDENT] CMP quantity
               | IDENT '.' IDENT '(' quantity ')'
    quantity  := NUMBER [unit]
    unit      := '%' | UNITWORD ('/' UNITWORD)*
"""
from __future__ import annotations

import re

from . import nodes as n
from .errors import RuleError
from .lexer import Token, tokenize

UNIT_WORDS = {"mmHg", "kPa", "L", "mL", "ms", "s", "min", "h"}
CLAUSES = ("owner", "applies_to", "priority", "safety_floor", "let", "when", "clear_when", "explain", "test")
RESERVED = set(CLAUSES) | {"rule", "for", "and", "or", "not", "scenario", "expect", "within",
                           "fire", "no_fire", "therapy", "true", "false"}
REQUIRED = ("owner", "applies_to", "priority", "safety_floor", "when", "explain")


class _Parser:
    def __init__(self, tokens: list[Token], source: str):
        self.toks = tokens
        self.i = 0
        self.source = source

    # -- token helpers -----------------------------------------------------
    def peek(self) -> Token:
        return self.toks[self.i]

    def next(self) -> Token:
        tok = self.toks[self.i]
        if tok.kind != "EOF":
            self.i += 1
        return tok

    def error(self, msg: str, tok: Token | None = None):
        tok = tok or self.peek()
        raise RuleError(msg, self.source, tok.line, tok.col)

    def at(self, kind: str, text: str | None = None) -> bool:
        tok = self.peek()
        return tok.kind == kind and (text is None or tok.text == text)

    def accept(self, kind: str, text: str | None = None) -> Token | None:
        return self.next() if self.at(kind, text) else None

    def expect(self, kind: str, text: str | None = None, what: str | None = None) -> Token:
        if self.at(kind, text):
            return self.next()
        want = what or (repr(text) if text else kind.lower())
        tok = self.peek()
        found = "end of file" if tok.kind == "EOF" else repr(tok.text)
        self.error(f"expected {want}, found {found}")

    def string(self) -> str:
        tok = self.expect("STRING", what="a quoted string")
        return tok.text[1:-1].replace('\\"', '"').replace("\\\\", "\\")

    def name(self, what: str) -> Token:
        tok = self.expect("IDENT", what=what)
        if tok.text in RESERVED:
            self.error(f"expected {what}, found keyword {tok.text!r}", tok)
        return tok

    # -- grammar -----------------------------------------------------------
    def parse_file(self) -> list[n.RuleDecl]:
        rules = []
        while not self.at("EOF"):
            rules.append(self.parse_rule())
        if not rules:
            raise RuleError("no rules in file", self.source)
        return rules

    def parse_rule(self) -> n.RuleDecl:
        start = self.expect("IDENT", "rule")
        parts = [self.name("rule id").text]
        while self.accept("PUNCT", "."):
            parts.append(self.name("rule id part").text)
        rule_id = ".".join(parts)
        vtok = self.expect("IDENT", what="a version like v3")
        m = re.fullmatch(r"v(\d+)", vtok.text)
        if not m:
            self.error("expected a version like v3", vtok)
        rule = n.RuleDecl(rule_id=rule_id, version=int(m.group(1)), source=self.source, line=start.line)

        seen = set()
        while self.at("IDENT") and self.peek().text in CLAUSES:
            tok = self.next()
            if tok.text not in ("let", "test"):
                if tok.text in seen:
                    self.error(f"duplicate '{tok.text}' clause", tok)
                seen.add(tok.text)
            getattr(self, f"_clause_{tok.text}")(rule)
        if not (self.at("EOF") or self.at("IDENT", "rule")):
            self.error(f"unexpected {self.peek().text!r} in rule {rule_id}")
        for req in REQUIRED:
            if req not in seen:
                raise RuleError(f"rule {rule_id} is missing '{req}'", self.source, start.line, start.col)
        return rule

    def _clause_owner(self, r: n.RuleDecl):
        r.owner = self.string()

    def _clause_applies_to(self, r: n.RuleDecl):
        self.expect("IDENT", "therapy")
        r.therapy = self.expect("IDENT", what="a therapy name").text

    def _clause_priority(self, r: n.RuleDecl):
        r.priority = self.expect("IDENT", what="a priority").text

    def _clause_safety_floor(self, r: n.RuleDecl):
        tok = self.expect("IDENT", what="true or false")
        if tok.text not in ("true", "false"):
            self.error("expected true or false", tok)
        r.safety_floor = tok.text == "true"

    def _clause_let(self, r: n.RuleDecl):
        name = self.name("a variable name")
        self.expect("PUNCT", "=")
        r.lets.append(n.Let(name.text, self.parse_call(), name.line, name.col))

    def _clause_when(self, r: n.RuleDecl):
        r.when = self.parse_condition()

    def _clause_clear_when(self, r: n.RuleDecl):
        r.clear_when = self.parse_condition()

    def _clause_explain(self, r: n.RuleDecl):
        r.explain = self.string()

    def _clause_test(self, r: n.RuleDecl):
        line = self.peek().line
        name = self.string()
        self.expect("IDENT", "scenario")
        scenario = self.string()
        self.expect("IDENT", "expect")
        if self.accept("IDENT", "fire"):
            self.expect("IDENT", "within")
            r.tests.append(n.RuleTest(name, scenario, "fire", self.parse_quantity(), line))
        elif self.accept("IDENT", "no_fire"):
            r.tests.append(n.RuleTest(name, scenario, "no_fire", None, line))
        else:
            self.error("expected 'fire within <duration>' or 'no_fire'")

    def parse_call(self) -> n.Call:
        func = self.name("a function name")
        self.expect("PUNCT", "(")
        signal = self.expect("IDENT", what="a signal name").text
        kwargs: dict[str, n.Quantity] = {}
        while self.accept("PUNCT", ","):
            key = self.expect("IDENT", what="an argument name")
            if key.text in kwargs:
                self.error(f"argument {key.text!r} given twice", key)
            kwargs[key.text] = self.parse_quantity()
        self.expect("PUNCT", ")")
        return n.Call(func.text, signal, kwargs, func.line, func.col)

    def parse_condition(self) -> n.Condition:
        expr = self.parse_or()
        hold = self.parse_quantity() if self.accept("IDENT", "for") else None
        return n.Condition(expr, hold)

    def parse_or(self):
        items = [self.parse_and()]
        while self.accept("IDENT", "or"):
            items.append(self.parse_and())
        return items[0] if len(items) == 1 else n.Or(items)

    def parse_and(self):
        items = [self.parse_unary()]
        while self.accept("IDENT", "and"):
            items.append(self.parse_unary())
        return items[0] if len(items) == 1 else n.And(items)

    def parse_unary(self):
        if self.accept("IDENT", "not"):
            return n.Not(self.parse_unary())
        if self.accept("PUNCT", "("):
            expr = self.parse_or()
            self.expect("PUNCT", ")")
            return expr
        name = self.name("a condition")
        field = None
        if self.accept("PUNCT", "."):
            ftok = self.expect("IDENT", what="a field or method name")
            field = ftok.text
            if self.accept("PUNCT", "("):
                arg = self.parse_quantity()
                self.expect("PUNCT", ")")
                return n.Predicate(name.text, field, arg, ftok.line, ftok.col)
        op = self.expect("OP", what="a comparison (> < >= <= == !=)")
        return n.Compare(n.Ref(name.text, field, name.line, name.col), op.text, self.parse_quantity())

    def parse_quantity(self) -> n.Quantity:
        num = self.expect("NUMBER", what="a number")
        unit = None
        if self.accept("PUNCT", "%"):
            unit = "%"
        elif self.at("IDENT") and self.peek().text in UNIT_WORDS:
            parts = [self.next().text]
            while self.accept("PUNCT", "/"):
                tok = self.expect("IDENT", what="a unit")
                if tok.text not in UNIT_WORDS:
                    self.error(f"unknown unit {tok.text!r}", tok)
                parts.append(tok.text)
            unit = "/".join(parts)
        return n.Quantity(float(num.text), unit, num.line, num.col)


def parse(text: str, source: str = "<rule>") -> list[n.RuleDecl]:
    return _Parser(tokenize(text, source), source).parse_file()
