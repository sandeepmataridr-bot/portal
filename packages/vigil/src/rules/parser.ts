/**
 * Recursive-descent parser for .vrl files.
 *
 *     rule      := 'rule' qualid VERSION clause*
 *     clause    := 'owner' STRING | 'applies_to' 'therapy' IDENT | 'priority' IDENT
 *                | 'safety_floor' ('true'|'false') | 'let' IDENT '=' call
 *                | 'when' cond ['for' quantity] | 'clear_when' cond ['for' quantity]
 *                | 'explain' STRING
 *                | 'test' STRING 'scenario' STRING 'expect' ('fire' 'within' quantity | 'no_fire')
 *     call      := IDENT '(' IDENT (',' IDENT quantity)* ')'
 *     cond      := and ('or' and)*
 *     and       := unary ('and' unary)*
 *     unary     := 'not' unary | '(' cond ')' | IDENT ['.' IDENT] CMP quantity
 *                | IDENT '.' IDENT '(' quantity ')'
 *     quantity  := NUMBER [unit]
 *     unit      := '%' | UNITWORD ('/' UNITWORD)*
 */
import { RuleError, tokenize, type Token, type TokenKind } from './lexer.js';
import type * as n from './nodes.js';

const UNIT_WORDS = new Set(['mmHg', 'kPa', 'L', 'mL', 'ms', 's', 'min', 'h']);
const CLAUSES = ['owner', 'applies_to', 'priority', 'safety_floor', 'let', 'when', 'clear_when', 'explain', 'test'];
const RESERVED = new Set([
  ...CLAUSES,
  'rule', 'for', 'and', 'or', 'not', 'scenario', 'expect', 'within', 'fire', 'no_fire', 'therapy', 'true', 'false',
]);
const REQUIRED = ['owner', 'applies_to', 'priority', 'safety_floor', 'when', 'explain'];

/** Python-style repr for error messages, matching the reference's wording. */
const q = (s: string) => `'${s}'`;

class Parser {
  private i = 0;

  constructor(
    private readonly toks: Token[],
    private readonly source: string,
  ) {}

  // -- token helpers -----------------------------------------------------
  private peek(): Token {
    return this.toks[this.i];
  }

  private next(): Token {
    const tok = this.toks[this.i];
    if (tok.kind !== 'EOF') this.i += 1;
    return tok;
  }

  private error(msg: string, tok?: Token): never {
    const t = tok ?? this.peek();
    throw new RuleError(msg, this.source, t.line, t.col);
  }

  private at(kind: TokenKind, text?: string): boolean {
    const tok = this.peek();
    return tok.kind === kind && (text === undefined || tok.text === text);
  }

  private accept(kind: TokenKind, text?: string): Token | null {
    return this.at(kind, text) ? this.next() : null;
  }

  private expect(kind: TokenKind, text?: string, what?: string): Token {
    if (this.at(kind, text)) return this.next();
    const want = what ?? (text ? q(text) : kind.toLowerCase());
    const tok = this.peek();
    const found = tok.kind === 'EOF' ? 'end of file' : q(tok.text);
    return this.error(`expected ${want}, found ${found}`);
  }

  private string(): string {
    const tok = this.expect('STRING', undefined, 'a quoted string');
    return tok.text.slice(1, -1).replaceAll('\\"', '"').replaceAll('\\\\', '\\');
  }

  private name(what: string): Token {
    const tok = this.expect('IDENT', undefined, what);
    if (RESERVED.has(tok.text)) this.error(`expected ${what}, found keyword ${q(tok.text)}`, tok);
    return tok;
  }

  // -- grammar -----------------------------------------------------------
  parseFile(): n.RuleDecl[] {
    const rules: n.RuleDecl[] = [];
    while (!this.at('EOF')) rules.push(this.parseRule());
    if (!rules.length) throw new RuleError('no rules in file', this.source);
    return rules;
  }

  private parseRule(): n.RuleDecl {
    const start = this.expect('IDENT', 'rule');
    const parts = [this.name('rule id').text];
    while (this.accept('PUNCT', '.')) parts.push(this.name('rule id part').text);
    const ruleId = parts.join('.');
    const vtok = this.expect('IDENT', undefined, 'a version like v3');
    const m = /^v(\d+)$/.exec(vtok.text);
    if (!m) this.error('expected a version like v3', vtok);
    const rule: n.RuleDecl = {
      ruleId,
      version: parseInt(m![1], 10),
      source: this.source,
      line: start.line,
      owner: '',
      therapy: '',
      priority: '',
      safetyFloor: false,
      lets: [],
      when: null,
      clearWhen: null,
      explain: '',
      tests: [],
    };

    const seen = new Set<string>();
    while (this.at('IDENT') && CLAUSES.includes(this.peek().text)) {
      const tok = this.next();
      if (tok.text !== 'let' && tok.text !== 'test') {
        if (seen.has(tok.text)) this.error(`duplicate '${tok.text}' clause`, tok);
        seen.add(tok.text);
      }
      this.clause(tok.text, rule);
    }
    if (!(this.at('EOF') || this.at('IDENT', 'rule'))) {
      this.error(`unexpected ${q(this.peek().text)} in rule ${ruleId}`);
    }
    for (const req of REQUIRED) {
      if (!seen.has(req)) throw new RuleError(`rule ${ruleId} is missing '${req}'`, this.source, start.line, start.col);
    }
    return rule;
  }

  private clause(kind: string, r: n.RuleDecl): void {
    switch (kind) {
      case 'owner':
        r.owner = this.string();
        return;
      case 'applies_to':
        this.expect('IDENT', 'therapy');
        r.therapy = this.expect('IDENT', undefined, 'a therapy name').text;
        return;
      case 'priority':
        r.priority = this.expect('IDENT', undefined, 'a priority').text;
        return;
      case 'safety_floor': {
        const tok = this.expect('IDENT', undefined, 'true or false');
        if (tok.text !== 'true' && tok.text !== 'false') this.error('expected true or false', tok);
        r.safetyFloor = tok.text === 'true';
        return;
      }
      case 'let': {
        const name = this.name('a variable name');
        this.expect('PUNCT', '=');
        r.lets.push({ name: name.text, call: this.parseCall(), line: name.line, col: name.col });
        return;
      }
      case 'when':
        r.when = this.parseCondition();
        return;
      case 'clear_when':
        r.clearWhen = this.parseCondition();
        return;
      case 'explain':
        r.explain = this.string();
        return;
      case 'test': {
        const line = this.peek().line;
        const name = this.string();
        this.expect('IDENT', 'scenario');
        const scenario = this.string();
        this.expect('IDENT', 'expect');
        if (this.accept('IDENT', 'fire')) {
          this.expect('IDENT', 'within');
          r.tests.push({ name, scenario, expect: 'fire', within: this.parseQuantity(), line });
        } else if (this.accept('IDENT', 'no_fire')) {
          r.tests.push({ name, scenario, expect: 'no_fire', within: null, line });
        } else {
          this.error("expected 'fire within <duration>' or 'no_fire'");
        }
        return;
      }
    }
  }

  private parseCall(): n.Call {
    const func = this.name('a function name');
    this.expect('PUNCT', '(');
    const signal = this.expect('IDENT', undefined, 'a signal name').text;
    const kwargs = new Map<string, n.Quantity>();
    while (this.accept('PUNCT', ',')) {
      const key = this.expect('IDENT', undefined, 'an argument name');
      if (kwargs.has(key.text)) this.error(`argument ${q(key.text)} given twice`, key);
      kwargs.set(key.text, this.parseQuantity());
    }
    this.expect('PUNCT', ')');
    return { func: func.text, signal, kwargs, line: func.line, col: func.col };
  }

  private parseCondition(): n.Condition {
    const expr = this.parseOr();
    const hold = this.accept('IDENT', 'for') ? this.parseQuantity() : null;
    return { expr, hold };
  }

  private parseOr(): n.Expr {
    const items = [this.parseAnd()];
    while (this.accept('IDENT', 'or')) items.push(this.parseAnd());
    return items.length === 1 ? items[0] : { type: 'or', items };
  }

  private parseAnd(): n.Expr {
    const items = [this.parseUnary()];
    while (this.accept('IDENT', 'and')) items.push(this.parseUnary());
    return items.length === 1 ? items[0] : { type: 'and', items };
  }

  private parseUnary(): n.Expr {
    if (this.accept('IDENT', 'not')) return { type: 'not', item: this.parseUnary() };
    if (this.accept('PUNCT', '(')) {
      const expr = this.parseOr();
      this.expect('PUNCT', ')');
      return expr;
    }
    const name = this.name('a condition');
    let field: string | null = null;
    if (this.accept('PUNCT', '.')) {
      const ftok = this.expect('IDENT', undefined, 'a field or method name');
      field = ftok.text;
      if (this.accept('PUNCT', '(')) {
        const arg = this.parseQuantity();
        this.expect('PUNCT', ')');
        return { type: 'predicate', target: name.text, method: field, arg, line: ftok.line, col: ftok.col };
      }
    }
    const op = this.expect('OP', undefined, 'a comparison (> < >= <= == !=)');
    return {
      type: 'compare',
      left: { name: name.text, field, line: name.line, col: name.col },
      op: op.text,
      right: this.parseQuantity(),
    };
  }

  private parseQuantity(): n.Quantity {
    const num = this.expect('NUMBER', undefined, 'a number');
    let unit: string | null = null;
    if (this.accept('PUNCT', '%')) {
      unit = '%';
    } else if (this.at('IDENT') && UNIT_WORDS.has(this.peek().text)) {
      const parts = [this.next().text];
      while (this.accept('PUNCT', '/')) {
        const tok = this.expect('IDENT', undefined, 'a unit');
        if (!UNIT_WORDS.has(tok.text)) this.error(`unknown unit ${q(tok.text)}`, tok);
        parts.push(tok.text);
      }
      unit = parts.join('/');
    }
    return { value: parseFloat(num.text), unit, line: num.line, col: num.col };
  }
}

export function parse(text: string, source = '<rule>'): n.RuleDecl[] {
  return new Parser(tokenize(text, source), source).parseFile();
}
