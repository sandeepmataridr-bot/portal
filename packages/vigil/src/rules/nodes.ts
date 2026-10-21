/** Syntax tree for the Vigil rule language. */

export interface Quantity {
  value: number;
  unit: string | null;
  line: number;
  col: number;
}

export interface Call {
  func: string;
  signal: string;
  kwargs: Map<string, Quantity>;
  line: number;
  col: number;
}

export interface Let {
  name: string;
  call: Call;
  line: number;
  col: number;
}

export interface Ref {
  name: string;
  field: string | null;
  line: number;
  col: number;
}

export interface Compare {
  type: 'compare';
  left: Ref;
  op: string;
  right: Quantity;
}

export interface Predicate {
  type: 'predicate';
  target: string;
  method: string;
  arg: Quantity;
  line: number;
  col: number;
}

export interface And {
  type: 'and';
  items: Expr[];
}

export interface Or {
  type: 'or';
  items: Expr[];
}

export interface Not {
  type: 'not';
  item: Expr;
}

export type Expr = Compare | Predicate | And | Or | Not;

export interface Condition {
  expr: Expr;
  hold: Quantity | null;
}

export interface RuleTest {
  name: string;
  scenario: string;
  expect: 'fire' | 'no_fire';
  within: Quantity | null;
  line: number;
}

export interface RuleDecl {
  ruleId: string;
  version: number;
  source: string;
  line: number;
  owner: string;
  therapy: string;
  priority: string;
  safetyFloor: boolean;
  lets: Let[];
  when: Condition | null;
  clearWhen: Condition | null;
  explain: string;
  tests: RuleTest[];
}
