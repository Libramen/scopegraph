/**
 * Condition evaluation — Kleene three-valued logic over compiled `Condition`s.
 *
 * Semantics:
 * - not(UNKNOWN) = UNKNOWN; `all` is FALSE-dominant then UNKNOWN; `any` is
 *   TRUE-dominant then UNKNOWN. Empty `all`/`any` is vacuously TRUE; `not`
 *   combines its children with `all` (zero children = not(TRUE) = FALSE).
 * - Missing referent (undefined/null): `exists: true` / `selected` → FALSE,
 *   `exists: false` → TRUE, every comparison/membership operator → UNKNOWN.
 * - `option` leaves are set membership: a name containing '.' is an option
 *   id; otherwise it is a group key meaning "anything selected in that group".
 * - Malformed nodes are UNKNOWN, never TRUE/FALSE: an unrecognised operator
 *   (failing closed with FALSE would let `not` turn it into TRUE), a leaf
 *   without a string `name`, or a compound whose `conditions` is not a list.
 * - Coercion: eq/neq coerce numeric strings ↔ numbers and 'true'/'false' ↔
 *   booleans; gt/gte/lt/lte compare same-shape ISO dates (YYYY-MM-DD) or
 *   times (HH:MM[:SS]) lexically, everything else numerically (numeric strings
 *   coerced, non-numeric → 0); in/not_in test strict membership in an array
 *   (not_in with a non-array is TRUE); contains is substring on strings and
 *   element membership on arrays.
 * - Multiselect (array) values: eq = contains, neq = does not contain,
 *   in = intersects, not_in = no intersection.
 * - `matches` tests the stringified value with the catalog pattern on RE2
 *   (linear time, see `patternTest`); an array value (multiselect) is tested
 *   per element, TRUE when any element matches (Kleene OR). An unusable
 *   pattern is FALSE; a value (element) over 512 characters is never run and
 *   is UNKNOWN, so `not: matches` cannot fire on it. The engine rejects
 *   string answers over 512 characters.
 */
import { RE2JS, RE2JSException } from 're2js';
import type { Condition, Truth } from '../graph/types.js';
import type { ConditionContext } from '../engine/types.js';

/** Longest pattern (`pattern` / `matches`) the catalog may use. */
const PATTERN_MAX_LENGTH = 256;
/** Longest text a `matches` leaf runs a pattern against (the string-answer cap). */
const PATTERN_MAX_INPUT = 512;
/**
 * Most total explicit repetition (`{n}`/`{n,m}` maxima summed, nested ones
 * multiplied) a pattern may use: RE2 unrolls them into its program.
 */
const PATTERN_MAX_REPEAT = 1000;
/**
 * Largest RE2 program (instructions) a pattern may compile to — the backstop
 * for what the repeat count misses (repeated alternations, wide classes).
 * Matching cost per character grows with it; at this size the worst shapes
 * found take ~15 ms on 512 characters.
 */
const PATTERN_MAX_PROGRAM = 1200;

/** Diagnostic hint for an unusable catalog pattern. */
export const PATTERN_HINT =
  'patterns must mean the same in RE2 and JavaScript: literals, classes, anchors, quantifiers, groups, alternation; escapes \\d \\D \\w \\W \\s \\S \\b \\B \\t \\n \\r \\f \\v \\xHH and escaped punctuation; no backreferences, lookaround or POSIX classes; repeat counts summing to at most 1000; at most 256 characters';

type CompiledPattern = { program: RE2JS } | { error: string };

/** Catalog patterns only (compile + engine), so the cache is bounded by the catalog. */
const compiled = new Map<string, CompiledPattern>();

function compile(src: string): CompiledPattern {
  if (src.length > PATTERN_MAX_LENGTH) return { error: `longer than ${PATTERN_MAX_LENGTH} characters` };
  let program: RE2JS;
  try {
    program = RE2JS.compile(src);
  } catch (error) {
    if (!(error instanceof RE2JSException)) throw error;
    // e.g. "invalid or unsupported Perl syntax: `(?=`", "invalid escape sequence: `\1`".
    return { error: error.message.replace(/^error parsing regexp: /, '') };
  }
  // Agents read `pattern` from the published questions, so it must parse as
  // a JavaScript RegExp too (RE2-only syntax like `(?i)` is refused)…
  try {
    new RegExp(src);
  } catch {
    return { error: 'not valid JavaScript regular-expression syntax' };
  }
  // …and mean the same there; and its RE2 program must stay small.
  const problem = sharedSyntaxProblem(src);
  if (problem !== undefined) return { error: problem };
  const size = program.programSize();
  if (size > PATTERN_MAX_PROGRAM) {
    return { error: `too complex to match quickly (RE2 program of ${size} instructions; at most ${PATTERN_MAX_PROGRAM}) — use smaller repeat counts or fewer alternatives` };
  }
  return { program };
}

/** Single-letter escapes with the same meaning in RE2 and JavaScript (`\b`/`\B` outside classes only). */
const SHARED_LETTER_ESCAPES: Record<string, true> = {
  d: true, D: true, w: true, W: true, s: true, S: true, t: true, n: true, r: true, f: true, v: true,
};

/** Length of the escape at `src[i] === '\\'` when RE2 and JavaScript agree on it, else undefined. */
function sharedEscapeLength(src: string, i: number, inClass: boolean): number | undefined {
  const next = src[i + 1] ?? '';
  if (/^[!-/:-@[-`{-~]$/.test(next)) return 2; // escaped ASCII punctuation is a literal in both
  if (Object.hasOwn(SHARED_LETTER_ESCAPES, next) || (!inClass && (next === 'b' || next === 'B'))) return 2;
  if (next === 'x' && /^[0-9a-fA-F]{2}$/.test(src.slice(i + 2, i + 4))) return 4;
  return undefined;
}

/**
 * Rejects syntax both engines accept but read differently — escapes outside
 * the shared set (`\a`, `\Q…\E`, `\x{…}`, `\A`, `\z`, `\pL`, `\p{…}`, `\C`, `\0`, …),
 * POSIX classes (`[[:alpha:]]`) and classes opening with `]` (`[]a]`, `[^]`)
 * — and total explicit repetition over PATTERN_MAX_REPEAT. Runs only on
 * patterns both engines already parsed, so the structure is well formed.
 */
function sharedSyntaxProblem(src: string): string | undefined {
  // Repetition cost per open group; the bottom entry is the whole pattern.
  const costs: number[] = [0];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    let atomCost = 0;
    if (c === '(') {
      costs.push(0);
      // Skip `(?:`, `(?<name>`, `(?i:` prefixes (lookaround never gets here).
      const end = src[i + 1] === '?' ? src.indexOf(src[i + 2] === '<' ? '>' : ':', i) : -1;
      i = end > i ? end + 1 : i + 1;
      continue;
    }
    if (c === '\\') {
      const length = sharedEscapeLength(src, i, false);
      if (length === undefined) return escapeProblem(src, i);
      i += length;
    } else if (c === '[') {
      const start = i;
      i += src[i + 1] === '^' ? 2 : 1;
      if (src[i] === ']') {
        return `the character class \`${src.slice(start, i + 1)}\` means different things in RE2 and JavaScript`;
      }
      while (i < src.length && src[i] !== ']') {
        const posix = /^\[:\^?[a-z]+:\]/.exec(src.slice(i));
        if (posix) return `POSIX class \`${posix[0]}\` is not supported (JavaScript reads it as single characters)`;
        if (src[i] === '\\') {
          const length = sharedEscapeLength(src, i, true);
          if (length === undefined) return escapeProblem(src, i);
          i += length;
        } else {
          i += 1;
        }
      }
      i += 1;
    } else if (c === ')') {
      atomCost = costs.pop() ?? 0;
      i += 1;
    } else {
      i += 1;
    }
    const repeat = /^\{(\d+)(?:,(\d*))?\}/.exec(src.slice(i));
    if (repeat) {
      // `{n}` and `{n,}` unroll n copies, `{n,m}` m copies, of the atom's own program.
      atomCost = Number(repeat[2] || repeat[1]) * Math.max(atomCost, 1);
      i += repeat[0].length;
    }
    costs[costs.length - 1] = (costs.at(-1) ?? 0) + atomCost;
  }
  const total = costs[0] ?? 0;
  return total > PATTERN_MAX_REPEAT
    ? `repeat counts add up to ${total} (nested repeats multiply); at most ${PATTERN_MAX_REPEAT}`
    : undefined;
}

function escapeProblem(src: string, i: number): string {
  const escape = /^\\(?:x\{[^}]*\}|[pP]\{[^}]*\}|[pP].|[\s\S])/.exec(src.slice(i))?.[0] ?? '\\';
  return `escape \`${escape}\` means different things in RE2 and JavaScript (or is not supported)`;
}

/** The cached compile result for `src` (RE2 program or why it is unusable). */
function compiledPattern(src: string): CompiledPattern {
  let entry = compiled.get(src);
  if (entry === undefined) {
    entry = compile(src);
    compiled.set(src, entry);
  }
  return entry;
}

/**
 * Why `src` cannot be a catalog pattern, or undefined when it can (the
 * compiler calls this, which also caches the RE2 program for the engine).
 * Patterns run on RE2 — linear time in the input, so no pattern can
 * backtrack catastrophically — and must mean the same in JavaScript.
 */
export function patternError(src: string): string | undefined {
  const entry = compiledPattern(src);
  return 'error' in entry ? entry.error : undefined;
}

/**
 * Unanchored RE2 test of a catalog pattern (`RegExp.test` semantics); FALSE
 * when the pattern is unusable. Callers cap `input` (512 characters).
 */
export function patternTest(pattern: string, input: string): boolean {
  const entry = compiledPattern(pattern);
  return 'program' in entry && entry.program.test(input);
}

/** `matches`: per element for arrays (any match); text over 512 characters is UNKNOWN. */
function matches(provided: unknown, pattern: string): Truth {
  const one = (value: unknown): Truth => {
    const text = String(value);
    return text.length > PATTERN_MAX_INPUT ? 'UNKNOWN' : fromBool(patternTest(pattern, text));
  };
  return Array.isArray(provided) ? or(provided.map(one)) : one(provided);
}

function and(results: Truth[]): Truth {
  if (results.includes('FALSE')) return 'FALSE';
  if (results.includes('UNKNOWN')) return 'UNKNOWN';
  return 'TRUE';
}

function or(results: Truth[]): Truth {
  if (results.includes('TRUE')) return 'TRUE';
  if (results.includes('UNKNOWN')) return 'UNKNOWN';
  return 'FALSE';
}

function fromBool(b: boolean): Truth {
  return b ? 'TRUE' : 'FALSE';
}

const LEAF_OPS: Record<string, true> = {
  eq: true,
  neq: true,
  gt: true,
  gte: true,
  lt: true,
  lte: true,
  in: true,
  not_in: true,
  contains: true,
  matches: true,
  exists: true,
  selected: true,
};

/** A recognised leaf operator (own key only, so `constructor` etc. never match). */
function isLeafOp(op: unknown): op is string {
  return typeof op === 'string' && Object.hasOwn(LEAF_OPS, op);
}

function isCompound(op: unknown): boolean {
  return op === 'all' || op === 'any' || op === 'not';
}

function readValue(ctx: ConditionContext, name: string): unknown {
  // Own properties only: a name like `constructor` must never resolve to Object.prototype.
  return Object.hasOwn(ctx.values, name) ? ctx.values[name] : undefined;
}

/**
 * Evaluate a condition to TRUE / FALSE / UNKNOWN. A malformed node — not an
 * object, an unrecognised operator, a compound whose `conditions` is not a
 * list, or a leaf without a string `name` — is UNKNOWN, never a definite
 * answer (so `not` of it cannot fire a rule).
 */
export function evaluateCondition(condition: Condition, ctx: ConditionContext): Truth {
  if (typeof condition !== 'object' || condition === null) return 'UNKNOWN';
  const { op } = condition;
  if (isCompound(op)) {
    const children = condition.conditions ?? [];
    if (!Array.isArray(children)) return 'UNKNOWN';
    if (op === 'any') return children.length === 0 ? 'TRUE' : or(children.map((c) => evaluateCondition(c, ctx)));
    const inner = children.length === 0 ? 'TRUE' : and(children.map((c) => evaluateCondition(c, ctx)));
    if (op === 'all') return inner;
    // Negation flips TRUE and FALSE; UNKNOWN stays UNKNOWN.
    return inner === 'UNKNOWN' ? 'UNKNOWN' : fromBool(inner === 'FALSE');
  }
  if (!isLeafOp(op) || typeof condition.name !== 'string') {
    return 'UNKNOWN';
  }
  if (condition.ref === 'option') return evaluateOptionLeaf(op, condition.name, condition.value, ctx);
  return evaluateOp(op, readValue(ctx, condition.name), condition.value);
}

/**
 * Names of value leaves (parameter, fact, derived, or untyped) whose missing
 * value makes the condition UNKNOWN — only within sub-trees that could still
 * change the result. Empty when the condition is decided. Deduped, tree order.
 */
export function unknownRefs(condition: Condition, ctx: ConditionContext): string[] {
  const out: string[] = [];
  const walk = (c: Condition): void => {
    if (evaluateCondition(c, ctx) !== 'UNKNOWN' || typeof c !== 'object' || c === null) return;
    if (isCompound(c.op)) {
      if (Array.isArray(c.conditions)) for (const child of c.conditions) walk(child);
      return;
    }
    // Only well-formed value leaves whose value is actually missing (malformed
    // leaves are UNKNOWN too, but answering cannot decide them).
    if (c.ref === 'option' || typeof c.name !== 'string' || !isLeafOp(c.op)) return;
    const value = readValue(ctx, c.name);
    if (value !== undefined && value !== null) return;
    if (!out.includes(c.name)) out.push(c.name);
  };
  walk(condition);
  return out;
}

function isOptionSelected(name: string, ctx: ConditionContext): boolean {
  if (name.includes('.')) return ctx.chosenOptions.has(name);
  return (ctx.selectedByGroup.get(name)?.size ?? 0) > 0;
}

function evaluateOptionLeaf(op: string, name: string, value: Condition['value'], ctx: ConditionContext): Truth {
  const present = isOptionSelected(name, ctx);
  // Presence tests: `selected`, `exists: true` and `exists: false`.
  if (op === 'selected' || op === 'exists') return fromBool(value === false ? !present : present);
  const ids = Array.isArray(value) ? value.map(String) : [];
  if (op === 'in') return fromBool(ids.some((id) => ctx.chosenOptions.has(id)));
  if (op === 'not_in') return fromBool(!ids.some((id) => ctx.chosenOptions.has(id)));
  // Any other operator compares membership as a boolean (e.g. eq true).
  return evaluateOp(op, present, value);
}

function evaluateOp(op: string, provided: unknown, required: unknown): Truth {
  const missing = provided === undefined || provided === null;
  // Presence tests never return UNKNOWN; `exists: false` (and only that) tests for absence.
  if (op === 'selected' || op === 'exists') return fromBool(op === 'exists' && required === false ? missing : !missing);
  if (missing) return 'UNKNOWN';

  switch (op) {
    // Multiselect (array value): eq = contains, neq = does not contain.
    case 'eq':
      return fromBool(Array.isArray(provided) ? provided.some((x) => isEqual(x, required)) : isEqual(provided, required));
    case 'neq':
      return fromBool(Array.isArray(provided) ? !provided.some((x) => isEqual(x, required)) : !isEqual(provided, required));
    case 'gt':
      return fromBool(compareOrdered(provided, required) > 0);
    case 'gte':
      return fromBool(compareOrdered(provided, required) >= 0);
    case 'lt':
      return fromBool(compareOrdered(provided, required) < 0);
    case 'lte':
      return fromBool(compareOrdered(provided, required) <= 0);
    // Multiselect (array value): in = intersects, not_in = no intersection.
    case 'in':
      return fromBool(Array.isArray(required) && intersects(provided, required));
    case 'not_in':
      return fromBool(!Array.isArray(required) || !intersects(provided, required));
    case 'contains':
      return fromBool(contains(provided, required));
    case 'matches':
      return matches(provided, String(required));
    default:
      // Unreachable (operators are checked up front); never a definite answer.
      return 'UNKNOWN';
  }
}

function isEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a === 'string' && typeof b === 'string') return ISO_TIME.test(a) && ISO_TIME.test(b) && withSeconds(a) === withSeconds(b);
  if (typeof a === 'string' && typeof b === 'number') return Number(a) === b;
  if (typeof a === 'number' && typeof b === 'string') return a === Number(b);
  if (typeof a === 'boolean' && typeof b === 'string') return a === (b === 'true');
  if (typeof a === 'string' && typeof b === 'boolean') return (a === 'true') === b;
  return false;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const ISO_TIME = /^\d{2}:\d{2}(?::\d{2})?$/;

/** `HH:MM` → `HH:MM:00`, so `17:00` and `17:00:00` are the same time. */
function withSeconds(time: string): string {
  return time.length === 5 ? `${time}:00` : time;
}

/**
 * Sign of provided − required. Same-shape ISO strings (both `YYYY-MM-DD`, or
 * both `HH:MM[:SS]`, seconds defaulting to 00) compare lexically, which is
 * chronological; everything else compares numerically (numeric strings
 * coerced, non-numeric → 0).
 */
function compareOrdered(provided: unknown, required: unknown): number {
  if (typeof provided === 'string' && typeof required === 'string') {
    if (ISO_DATE.test(provided) && ISO_DATE.test(required)) return provided < required ? -1 : provided > required ? 1 : 0;
    if (ISO_TIME.test(provided) && ISO_TIME.test(required)) {
      const [a, b] = [withSeconds(provided), withSeconds(required)];
      return a < b ? -1 : a > b ? 1 : 0;
    }
  }
  return toNumber(provided) - toNumber(required);
}

function intersects(provided: unknown, required: unknown[]): boolean {
  return Array.isArray(provided) ? provided.some((x) => required.includes(x)) : required.includes(provided);
}

function toNumber(value: unknown): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'string') {
    const n = Number(value);
    return Number.isNaN(n) ? 0 : n;
  }
  return 0;
}

function contains(provided: unknown, required: unknown): boolean {
  if (typeof provided === 'string' && typeof required === 'string') return provided.includes(required);
  if (Array.isArray(provided)) return provided.includes(required);
  return false;
}
