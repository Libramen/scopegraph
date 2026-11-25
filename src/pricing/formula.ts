/**
 * Pricing formulas: bounded arithmetic over parameter names, evaluated
 * exactly with bigint fractions.
 *
 * Syntax:
 * - Numbers: plain decimals (`40`, `1.5`, `0.005`); no exponents.
 * - Names: snake_case parameter names — `[a-z_][a-z0-9_]*` — standing for
 *   that parameter's numeric value, e.g. `nights * 40 + guests * 5`.
 * - Operators: `+ - * /` with the usual precedence, unary `+`/`-` and
 *   parentheses. Whitespace is ignored. No functions, no comparison, no `%`.
 *
 * `parseFormula(expr)` returns the referenced parameter names (sorted, unique)
 * or a readable error; `evaluateFormula(expr, values)` evaluates exactly.
 * Every referenced name must have a value at evaluation time.
 */

import { FORMULA_LIMITS, type Fraction, add, divide, multiply, negated, parseDecimal } from './fraction.js';

export type FormulaResult =
  | { ok: true; dependencies: string[] }
  | { ok: false; message: string };

type BinaryOp = '+' | '-' | '*' | '/';

type Token =
  | { kind: 'number'; text: string }
  | { kind: 'name'; text: string }
  | { kind: 'op'; text: BinaryOp }
  | { kind: '(' }
  | { kind: ')' };

/** Parsed formula. */
type Expr =
  | { number: Fraction }
  | { name: string }
  | { minus: Expr }
  | { op: BinaryOp; left: Expr; right: Expr };

export class FormulaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FormulaError';
  }
}

const NAME = /^[a-z_][a-z0-9_]*/;
const NUMBER = /^\d+(?:\.\d+)?/;

function tokenize(expression: string): Token[] {
  if (expression.length === 0 || expression.length > FORMULA_LIMITS.maxLength) {
    throw new FormulaError(`Formula is empty or longer than ${FORMULA_LIMITS.maxLength} characters.`);
  }
  const tokens: Token[] = [];
  let index = 0;
  while (index < expression.length) {
    const char = expression[index]!;
    const rest = expression.slice(index);
    let length = 1;
    if (/\s/.test(char)) {
      index += 1;
      continue;
    } else if (/[a-z_]/.test(char)) {
      const text = NAME.exec(rest)![0];
      tokens.push({ kind: 'name', text });
      length = text.length;
    } else if (/\d/.test(char)) {
      const text = NUMBER.exec(rest)![0];
      tokens.push({ kind: 'number', text });
      length = text.length;
    } else if (char === '+' || char === '-' || char === '*' || char === '/') {
      tokens.push({ kind: 'op', text: char });
    } else if (char === '(' || char === ')') {
      tokens.push({ kind: char });
    } else {
      throw new FormulaError(
        `Formula: ${JSON.stringify(char)} is not allowed (use snake_case parameter names, numbers, + - * / and parentheses).`,
      );
    }
    index += length;
    if (tokens.length > FORMULA_LIMITS.maxTokens) {
      throw new FormulaError(`Formula has more than ${FORMULA_LIMITS.maxTokens} tokens.`);
    }
  }
  return tokens;
}

/**
 * Recursive-descent parse with the size limits enforced. Throws
 * `FormulaError` (or a `FractionError` for an unusable number literal).
 */
function parse(tokens: readonly Token[]): Expr {
  let position = 0;
  let operations = 0;
  let nesting = 0;

  const binary = (op: BinaryOp, left: Expr, right: Expr): Expr => {
    operations += 1;
    if (operations > FORMULA_LIMITS.maxSteps) {
      throw new FormulaError(`Formula has more than ${FORMULA_LIMITS.maxSteps} operators.`);
    }
    return { op, left, right };
  };

  const atom = (): Expr => {
    const token = tokens[position];
    if (!token) throw new FormulaError('Formula is incomplete.');
    position += 1;
    if (token.kind === 'number') return { number: parseDecimal(token.text) };
    if (token.kind === 'name') return { name: token.text };
    if (token.kind === 'op' && (token.text === '+' || token.text === '-')) {
      const operand = atom();
      return token.text === '-' ? { minus: operand } : operand;
    }
    if (token.kind === '(') {
      nesting += 1;
      if (nesting > FORMULA_LIMITS.maxDepth) {
        throw new FormulaError(`Formula nests parentheses more than ${FORMULA_LIMITS.maxDepth} deep.`);
      }
      const inner = sum();
      if (tokens[position]?.kind !== ')') throw new FormulaError('Formula has an unclosed "(".');
      position += 1;
      nesting -= 1;
      return inner;
    }
    throw new FormulaError('Formula has a misplaced operator or value.');
  };

  /** Left-associative chain of `ops` over `operand`. */
  const chain = (operand: () => Expr, ops: readonly BinaryOp[]): Expr => {
    let left = operand();
    for (;;) {
      const token = tokens[position];
      if (token?.kind !== 'op' || !ops.includes(token.text)) return left;
      position += 1;
      left = binary(token.text, left, operand());
    }
  };
  const product = (): Expr => chain(atom, ['*', '/']);
  const sum = (): Expr => chain(product, ['+', '-']);

  const expr = sum();
  if (position !== tokens.length) throw new FormulaError('Formula has extra input after the expression.');
  return expr;
}

/** Referenced parameter names, sorted and unique, within the dependency limit. */
function dependenciesOf(tokens: readonly Token[]): string[] {
  const names = [...new Set(tokens.flatMap((token) => (token.kind === 'name' ? [token.text] : [])))].sort();
  if (names.length > FORMULA_LIMITS.maxVariables) {
    throw new FormulaError(`Formula uses more than ${FORMULA_LIMITS.maxVariables} different parameters.`);
  }
  return names;
}

/**
 * Parse a formula expression: `{ ok: true, dependencies }` with the referenced
 * snake_case parameter names (sorted, unique), or `{ ok: false, message }`.
 */
export function parseFormula(expr: string): FormulaResult {
  try {
    const tokens = tokenize(expr);
    const dependencies = dependenciesOf(tokens);
    parse(tokens);
    return { ok: true, dependencies };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : 'Formula is invalid.',
    };
  }
}

/**
 * One dependency's value from `values` (answers keyed by parameter name).
 * Only finite, non-negative numbers and plain decimal strings are accepted;
 * anything else fails closed.
 */
function dependencyValue(name: string, values: Readonly<Record<string, unknown>>): Fraction {
  const raw = Object.hasOwn(values, name) ? values[name] : undefined;
  if (raw === null || raw === undefined) {
    throw new FormulaError(`Formula needs a value for ${name}.`);
  }
  if (typeof raw !== 'number' && typeof raw !== 'string') {
    throw new FormulaError(`Formula value for ${name} is not a number.`);
  }
  let value: Fraction;
  try {
    value = parseDecimal(raw);
  } catch {
    throw new FormulaError(`Formula value for ${name} is not a plain decimal.`);
  }
  if (value.numerator < 0n) {
    throw new FormulaError(`Formula value for ${name} is negative.`);
  }
  return value;
}

/**
 * Evaluate the expression exactly over `values` (parameter name → number or
 * decimal string). Throws `FormulaError` on any syntax, limit, or
 * missing-dependency problem (division by zero surfaces as a `FractionError`).
 */
export function evaluateFormula(
  expression: string,
  values: Readonly<Record<string, unknown>>,
): Fraction {
  const tokens = tokenize(expression);
  const dependencies = dependenciesOf(tokens);
  const expr = parse(tokens);
  const resolved = new Map(dependencies.map((name) => [name, dependencyValue(name, values)]));

  const evaluate = (node: Expr): Fraction => {
    if ('number' in node) return node.number;
    // Every name is a dependency, resolved above.
    if ('name' in node) return resolved.get(node.name)!;
    if ('minus' in node) return negated(evaluate(node.minus));
    const left = evaluate(node.left);
    const right = evaluate(node.right);
    switch (node.op) {
      case '+':
        return add(left, right);
      case '-':
        return add(left, negated(right));
      case '*':
        return multiply(left, right);
      case '/':
        return divide(left, right);
    }
  };
  return evaluate(expr);
}
