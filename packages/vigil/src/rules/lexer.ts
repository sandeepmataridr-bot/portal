/** Tokenizer for the Vigil rule language (.vrl). */

/** A rule failed to lex, parse, type-check or compile. */
export class RuleError extends Error {
  constructor(
    readonly detail: string,
    readonly source = '<rule>',
    readonly line = 0,
    readonly col = 0,
  ) {
    super(line ? `${source}:${line}:${col}: ${detail}` : `${source}: ${detail}`);
    this.name = 'RuleError';
  }
}

export type TokenKind = 'IDENT' | 'NUMBER' | 'STRING' | 'OP' | 'PUNCT' | 'EOF';

export interface Token {
  kind: TokenKind;
  text: string;
  line: number;
  col: number;
}

const TOKEN =
  /(?<ws>[ \t\r]+)|(?<nl>\n)|(?<comment>\/\/[^\n]*)|(?<STRING>"(?:[^"\\\n]|\\.)*")|(?<NUMBER>\d+(?:\.\d+)?)|(?<IDENT>[A-Za-z_][A-Za-z0-9_]*)|(?<OP>>=|<=|==|!=|>|<)|(?<PUNCT>[(),.=/%])/y;

export function tokenize(text: string, source = '<rule>'): Token[] {
  const tokens: Token[] = [];
  let pos = 0;
  let line = 1;
  let lineStart = 0;
  while (pos < text.length) {
    TOKEN.lastIndex = pos;
    const m = TOKEN.exec(text);
    if (!m || !m.groups) {
      throw new RuleError(`unexpected character ${JSON.stringify(text[pos])}`, source, line, pos - lineStart + 1);
    }
    const kind = Object.keys(m.groups).find((k) => m.groups![k] !== undefined)!;
    const end = pos + m[0].length;
    if (kind === 'nl') {
      line += 1;
      lineStart = end;
    } else if (kind !== 'ws' && kind !== 'comment') {
      tokens.push({ kind: kind as TokenKind, text: m[0], line, col: pos - lineStart + 1 });
    }
    pos = end;
  }
  tokens.push({ kind: 'EOF', text: '', line, col: pos - lineStart + 1 });
  return tokens;
}
