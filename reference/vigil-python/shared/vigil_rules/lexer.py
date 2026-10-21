"""Tokenizer for the Vigil rule language (.vrl)."""
from __future__ import annotations

import re
from dataclasses import dataclass

from .errors import RuleError


@dataclass(frozen=True)
class Token:
    kind: str  # IDENT, NUMBER, STRING, OP, PUNCT, EOF
    text: str
    line: int
    col: int


_TOKEN = re.compile(r"""
    (?P<ws>[ \t\r]+)
  | (?P<nl>\n)
  | (?P<comment>//[^\n]*)
  | (?P<STRING>"(?:[^"\\\n]|\\.)*")
  | (?P<NUMBER>\d+(?:\.\d+)?)
  | (?P<IDENT>[A-Za-z_][A-Za-z0-9_]*)
  | (?P<OP>>=|<=|==|!=|>|<)
  | (?P<PUNCT>[(),.=/%])
""", re.VERBOSE)


def tokenize(text: str, source: str = "<rule>") -> list[Token]:
    tokens: list[Token] = []
    pos, line, line_start = 0, 1, 0
    while pos < len(text):
        m = _TOKEN.match(text, pos)
        if not m:
            raise RuleError(f"unexpected character {text[pos]!r}", source, line, pos - line_start + 1)
        kind = m.lastgroup
        if kind == "nl":
            line += 1
            line_start = m.end()
        elif kind not in ("ws", "comment"):
            tokens.append(Token(kind, m.group(), line, m.start() - line_start + 1))
        pos = m.end()
    tokens.append(Token("EOF", "", line, pos - line_start + 1))
    return tokens
