import { describe, expect, it } from 'vitest';
import type { Condition } from '../graph/types.js';
import type { ConditionContext } from '../engine/types.js';
import { evaluateCondition, patternError, patternTest, unknownRefs } from './index.js';

function ctx(values: Record<string, unknown> = {}, selected: string[] = []): ConditionContext {
  const groups = new Map<string, Set<string>>();
  for (const id of selected) {
    const group = id.slice(0, id.indexOf('.'));
    const set = groups.get(group) ?? new Set<string>();
    set.add(id);
    groups.set(group, set);
  }
  return {
    values: values as ConditionContext['values'],
    chosenOptions: new Set(selected),
    selectedByGroup: groups,
  };
}

const leaf = (name: string, op: Condition['op'], value?: Condition['value']): Condition => ({
  ref: 'parameter',
  name,
  op,
  ...(value === undefined ? {} : { value }),
});

const ev = (c: Condition, values: Record<string, unknown> = {}, selected: string[] = []) =>
  evaluateCondition(c, ctx(values, selected));

describe('comparison operators', () => {
  it('eq: equal, unequal, numeric-string and boolean-string coercion', () => {
    expect(ev(leaf('weight', 'eq', 72), { weight: 72 })).toBe('TRUE');
    expect(ev(leaf('weight', 'eq', 72), { weight: 80 })).toBe('FALSE');
    expect(ev(leaf('weight', 'eq', 72), { weight: '72' })).toBe('TRUE');
    expect(ev(leaf('party', 'eq', '9'), { party: 9 })).toBe('TRUE');
    expect(ev(leaf('party', 'eq', 10), { party: '9' })).toBe('FALSE');
    expect(ev(leaf('waiver_signed', 'eq', 'true'), { waiver_signed: true })).toBe('TRUE');
    expect(ev(leaf('waiver_signed', 'eq', false), { waiver_signed: 'false' })).toBe('TRUE');
  });

  it('neq', () => {
    expect(ev(leaf('plan', 'neq', 'free'), { plan: 'pro' })).toBe('TRUE');
    expect(ev(leaf('plan', 'neq', 'pro'), { plan: 'pro' })).toBe('FALSE');
  });

  it('gt / gte / lt / lte, including numeric strings (numeric, not lexical)', () => {
    expect(ev(leaf('height', 'gt', 150), { height: 170 })).toBe('TRUE');
    expect(ev(leaf('height', 'gt', 150), { height: 150 })).toBe('FALSE');
    expect(ev(leaf('height', 'gt', 150), { height: 140 })).toBe('FALSE');
    expect(ev(leaf('height', 'gt', 150), { height: '170' })).toBe('TRUE');
    expect(ev(leaf('height', 'gte', 150), { height: 150 })).toBe('TRUE');
    expect(ev(leaf('height', 'gte', 150), { height: 140 })).toBe('FALSE');
    expect(ev(leaf('boards', 'lt', 8), { boards: 3 })).toBe('TRUE');
    expect(ev(leaf('boards', 'lt', 8), { boards: 8 })).toBe('FALSE');
    expect(ev(leaf('boards', 'lte', 8), { boards: 8 })).toBe('TRUE');
    expect(ev(leaf('boards', 'lte', 8), { boards: 12 })).toBe('FALSE');
    expect(ev(leaf('boards', 'gt', 4), { boards: '12' })).toBe('TRUE');
    expect(ev(leaf('boards', 'gte', 8), { boards: '8' })).toBe('TRUE');
    expect(ev(leaf('boards', 'lt', 4), { boards: '2' })).toBe('TRUE');
    expect(ev(leaf('boards', 'lte', 4), { boards: '4' })).toBe('TRUE');
    expect(ev(leaf('boards', 'gt', 4), { boards: '2' })).toBe('FALSE');
  });
});

describe('set operators', () => {
  it('in / not_in', () => {
    expect(ev(leaf('level', 'in', ['novice', 'improver']), { level: 'novice' })).toBe('TRUE');
    expect(ev(leaf('level', 'in', ['novice', 'improver']), { level: 'pro' })).toBe('FALSE');
    expect(ev(leaf('size', 'in', [2, 4, 6]), { size: 4 })).toBe('TRUE');
    expect(ev(leaf('plan', 'not_in', ['suspended']), { plan: 'pro' })).toBe('TRUE');
    expect(ev(leaf('plan', 'not_in', ['suspended']), { plan: 'suspended' })).toBe('FALSE');
    expect(ev(leaf('plan', 'not_in', 'suspended'), { plan: 'pro' })).toBe('TRUE');
  });

  it('contains on strings and arrays', () => {
    expect(ev(leaf('email', 'contains', '@example.org'), { email: 'rosa@example.org' })).toBe('TRUE');
    expect(ev(leaf('email', 'contains', '@example.org'), { email: 'rosa@example.net' })).toBe('FALSE');
    expect(ev(leaf('tags', 'contains', 'kayak'), { tags: ['kayak', 'tour'] })).toBe('TRUE');
    expect(ev(leaf('tags', 'contains', 'novice'), { tags: ['kayak', 'tour'] })).toBe('FALSE');
  });
});

describe('existence operators', () => {
  it('exists: present (incl. 0, "", false) → TRUE; undefined/null → FALSE', () => {
    expect(ev(leaf('name', 'exists'), { name: 'Rosa' })).toBe('TRUE');
    expect(ev(leaf('boards', 'exists'), { boards: 0 })).toBe('TRUE');
    expect(ev(leaf('note', 'exists'), { note: '' })).toBe('TRUE');
    expect(ev(leaf('waiver_signed', 'exists'), { waiver_signed: false })).toBe('TRUE');
    expect(ev(leaf('name', 'exists'), {})).toBe('FALSE');
    expect(ev(leaf('name', 'exists'), { name: null })).toBe('FALSE');
  });

  it('exists: false', () => {
    expect(ev(leaf('name', 'exists', false), {})).toBe('TRUE');
    expect(ev(leaf('name', 'exists', false), { name: null })).toBe('TRUE');
    expect(ev(leaf('name', 'exists', false), { name: 'Rosa' })).toBe('FALSE');
  });

  it('selected on a value leaf behaves like exists', () => {
    expect(ev(leaf('option', 'selected'), { option: 'x' })).toBe('TRUE');
    expect(ev(leaf('option', 'selected'), {})).toBe('FALSE');
  });

});

describe('matches', () => {
  it('matches, fails, stringifies non-strings', () => {
    expect(ev(leaf('email', 'matches', '^[^@]+@[^@]+\\.[a-z]+$'), { email: 'rosa@example.org' })).toBe('TRUE');
    expect(ev(leaf('email', 'matches', '^[^@]+@[^@]+\\.[a-z]+$'), { email: 'not an address' })).toBe('FALSE');
    expect(ev(leaf('code', 'matches', '^\\d{4}$'), { code: 4321 })).toBe('TRUE');
  });

  it('invalid regex fails closed', () => {
    expect(ev(leaf('text', 'matches', '(unclosed'), { text: 'sample' })).toBe('FALSE');
  });

  it('natural patterns with groups / alternation work', () => {
    expect(ev(leaf('notes', 'matches', 'gun|rifle'), { notes: 'bringing a rifle' })).toBe('TRUE');
    expect(ev(leaf('answer', 'matches', '^(yes|no)$'), { answer: 'no' })).toBe('TRUE');
    expect(ev(leaf('zip', 'matches', '^(\\d{5})$'), { zip: '90210' })).toBe('TRUE');
  });

  it('unusable patterns are never run → FALSE', () => {
    expect(ev(leaf('text', 'matches', '(a)\\1'), { text: 'aa' })).toBe('FALSE');
    expect(ev(leaf('text', 'matches', 'a'.repeat(300)), { text: 'a'.repeat(300) })).toBe('FALSE');
  });

  it('values over 512 characters are never run → UNKNOWN (so not cannot fire)', () => {
    const long = 'firearm' + ' '.repeat(506);
    expect(ev(leaf('notes', 'matches', 'firearm'), { notes: long })).toBe('UNKNOWN');
    expect(ev({ op: 'not', conditions: [leaf('notes', 'matches', 'firearm')] }, { notes: long })).toBe('UNKNOWN');
    expect(ev(leaf('notes', 'matches', 'firearm'), { notes: long.slice(0, 512) })).toBe('TRUE');
  });

  it('array values match per element (any element), never joined', () => {
    const extras = Array.from({ length: 60 }, (_, k) => `extra_option_${k}`).concat('premium');
    expect(String(extras).length).toBeGreaterThan(512); // joining would have been cut off
    expect(ev(leaf('extras', 'matches', '^premium$'), { extras })).toBe('TRUE');
    expect(ev({ op: 'not', conditions: [leaf('extras', 'matches', '^premium$')] }, { extras })).toBe('FALSE');
    expect(ev(leaf('extras', 'matches', '^gold$'), { extras })).toBe('FALSE');
    expect(ev(leaf('extras', 'matches', 'a,b'), { extras: ['a', 'b'] })).toBe('FALSE'); // no match across elements
    expect(ev(leaf('extras', 'matches', 'x'), { extras: [] })).toBe('FALSE');
  });

  it('an over-long element is UNKNOWN unless another element matches', () => {
    const long = 'y'.repeat(513);
    expect(ev(leaf('tags', 'matches', '^x$'), { tags: [long, 'x'] })).toBe('TRUE');
    expect(ev(leaf('tags', 'matches', '^x$'), { tags: [long, 'z'] })).toBe('UNKNOWN');
  });
});

describe('catalog regexes run on RE2 (linear time)', () => {
  // Wall-clock bound loose enough for slow CI runners, yet far below the 8–65 s
  // the same patterns took on a backtracking engine — exponential blow-up still fails.
  const FAST_MS = 500;
  // Shapes that blow up on a backtracking engine: overlapping alternation under
  // a quantifier, and chained unbounded quantifiers. On V8 these take 8–65 s on
  // ~30–60 characters; RE2 is linear in the input.
  const hostile: Array<[string, string]> = [
    ['^(a|a)*$', `${'a'.repeat(60)}!`],
    ['^(\\w|\\d)+$', `${'1'.repeat(60)}!`],
    [`^${'\\d*'.repeat(20)}x$`, `${'1'.repeat(60)}!`],
    ['(a+)+$', `${'a'.repeat(511)}!`],
    ['^([a-z]|[a-z0-9])*$', `${'a'.repeat(511)}!`],
  ];

  it.each(hostile)('%s compiles and rejects hostile input fast', (pattern, input) => {
    expect(patternError(pattern)).toBeUndefined();
    const start = performance.now();
    expect(patternTest(pattern, input)).toBe(false);
    expect(ev(leaf('text', 'matches', pattern), { text: input })).toBe('FALSE');
    expect(performance.now() - start).toBeLessThan(FAST_MS);
  });

  it.each([
    ['^[a-z]+\\d*$', 'abc123'],
    ['gun|rifle', 'a rifle'],
    ['^(yes|no)$', 'yes'],
    ['^(\\d{5})$', '90210'],
    ['(ab)+', 'xabab'],
    ['(?:a|b)*c', 'abc'],
    ['((a)b)+', 'ab'],
    ['(?<zip>\\d{5})', 'zip 12345'],
    ['[(+)]+', '(+)'],
    ['[\\d-z]+', '-'],
    ['^\\x41\\.\\-\\/\\t$', 'A.-/\t'],
    ['\\bcat\\B', 'cats'],
    ['\\(a+\\)+', '(aa)'],
    ['a{2,3}b?', 'aa'],
    ['^[\\w.+-]+@[\\w-]+\\.[a-z]{2,}$', 'kai@example.com'],
    ['x'.repeat(256), 'x'.repeat(256)],
  ])('accepts and matches %s', (pattern, input) => {
    expect(patternError(pattern)).toBeUndefined();
    expect(patternTest(pattern, input)).toBe(true);
  });

  it.each([
    ['(a)\\1', '\\1'],
    ['(?<x>a)\\k<x>', '\\k'],
    ['(?=a)a+', '(?='],
    ['(?!a)b', '(?!'],
    ['(?<=a)b', '(?<=a)b'],
    ['(?<!a)b', '(?<!a)b'],
    ['[abc', 'missing closing ]'],
    ['a)', 'unexpected )'],
    ['(?i)abc', 'JavaScript'],
    ['\\a', '`\\a`'],
    ['\\Qa.b\\E', '`\\Q`'],
    ['\\x{41}', '`\\x{41}`'],
    ['\\Aabc', '`\\A`'],
    ['abc\\z', '`\\z`'],
    ['\\pL', '`\\pL`'],
    ['\\p{Greek}', '`\\p{Greek}`'],
    ['\\PL', '`\\PL`'],
    ['[[:alpha:]]', '`[:alpha:]`'],
    ['[^[:digit:]x]', '`[:digit:]`'],
    ['\\C', '`\\C`'],
    ['\\0', '`\\0`'],
    ['[]a]', '`[]`'],
    ['[^]a]', '`[^]`'],
    ['a{600}b{600}', 'add up to 1200'],
    ['(?:x{2}y{3}){250}', 'add up to 1250'],
    ['(?:a|ab|b){300}!', 'too complex'],
    ['x'.repeat(257), 'longer than 256'],
  ])('rejects %s, naming the construct', (pattern, construct) => {
    expect(patternError(pattern)).toContain(construct);
    expect(patternTest(pattern, 'a')).toBe(false);
  });

  // The largest programs the caps still accept (repeat sum ≤ 1000, RE2
  // program ≤ 1200 instructions), including the slowest shapes found per size.
  it.each([
    '\\w{0,23}'.repeat(25) + '!$',
    '^\\w{0,298}\\d{0,299}!$',
    '^.{0,598}$',
    '(?:\\w|\\s|\\d|[a-z]|[^x]){1000}$',
    '^(?:[a-z0-9_]?\\d?){299}$',
    '(?:a|ab|b){199}!',
    '^\\w{0,199}\\d{0,199}\\w{0,199}$',
  ])('worst accepted shape %s stays fast on 512-character hostile input', (pattern) => {
    expect(patternError(pattern)).toBeUndefined();
    for (const input of ['a'.repeat(511) + '#', '1'.repeat(511) + '#', 'a1 '.repeat(170) + '##', 'ab'.repeat(256), 'é'.repeat(512)]) {
      const start = performance.now();
      patternTest(pattern, input);
      expect(performance.now() - start, input.slice(0, 6)).toBeLessThan(FAST_MS);
    }
  });
});

describe('multiselect values', () => {
  const diet = { dietary: ['vegan', 'nut_free'] };
  it('eq = contains, neq = does not contain', () => {
    expect(ev(leaf('dietary', 'eq', 'vegan'), diet)).toBe('TRUE');
    expect(ev(leaf('dietary', 'eq', 'halal'), diet)).toBe('FALSE');
    expect(ev(leaf('dietary', 'neq', 'vegan'), diet)).toBe('FALSE');
    expect(ev(leaf('dietary', 'neq', 'halal'), diet)).toBe('TRUE');
  });

  it('in = intersects, not_in = no intersection', () => {
    expect(ev(leaf('dietary', 'in', ['halal', 'vegan']), diet)).toBe('TRUE');
    expect(ev(leaf('dietary', 'in', ['halal']), diet)).toBe('FALSE');
    expect(ev(leaf('dietary', 'not_in', ['halal']), diet)).toBe('TRUE');
    expect(ev(leaf('dietary', 'not_in', ['halal', 'vegan']), diet)).toBe('FALSE');
  });

  it('empty selection: nothing contained / intersected', () => {
    expect(ev(leaf('dietary', 'eq', 'vegan'), { dietary: [] })).toBe('FALSE');
    expect(ev(leaf('dietary', 'in', ['vegan']), { dietary: [] })).toBe('FALSE');
    expect(ev(leaf('dietary', 'not_in', ['vegan']), { dietary: [] })).toBe('TRUE');
  });
});

describe('ordering on ISO date / time strings', () => {
  it('same-shape dates and times compare lexically (chronologically)', () => {
    expect(ev(leaf('event_time', 'gte', '18:00'), { event_time: '09:00' })).toBe('FALSE');
    expect(ev(leaf('event_time', 'gte', '18:00'), { event_time: '19:30' })).toBe('TRUE');
    expect(ev(leaf('event_time', 'lt', '18:00'), { event_time: '17:59:59' })).toBe('TRUE');
    expect(ev(leaf('pickup_date', 'lt', '2026-12-24'), { pickup_date: '2026-12-20' })).toBe('TRUE');
    expect(ev(leaf('pickup_date', 'lt', '2026-12-24'), { pickup_date: '2027-01-02' })).toBe('FALSE');
    expect(ev(leaf('pickup_date', 'lte', '2026-12-24'), { pickup_date: '2026-12-24' })).toBe('TRUE');
  });

  it('mixed shapes fall back to numeric comparison', () => {
    expect(ev(leaf('x', 'gt', '2026-12-24'), { x: '18:00' })).toBe('FALSE');
    expect(ev(leaf('n', 'gt', 5), { n: '10' })).toBe('TRUE');
  });
});

describe('compound operators (Kleene)', () => {
  const tall = leaf('height', 'gte', 150);
  const goofy = leaf('stance', 'eq', 'goofy');

  it('all / any basics and vacuous truth', () => {
    expect(ev({ op: 'all', conditions: [tall, goofy] }, { height: 170, stance: 'goofy' })).toBe('TRUE');
    expect(ev({ op: 'all', conditions: [tall, goofy] }, { height: 140, stance: 'goofy' })).toBe('FALSE');
    expect(ev({ op: 'all', conditions: [] })).toBe('TRUE');
    expect(ev({ op: 'any', conditions: [tall, leaf('guardian', 'eq', true)] }, { height: 140, guardian: true })).toBe('TRUE');
    expect(ev({ op: 'any', conditions: [tall, leaf('guardian', 'eq', true)] }, { height: 140, guardian: false })).toBe('FALSE');
    expect(ev({ op: 'any', conditions: [] })).toBe('TRUE');
  });

  it('nested compounds', () => {
    const c: Condition = {
      op: 'any',
      conditions: [
        { op: 'all', conditions: [leaf('w', 'eq', 2), leaf('x', 'eq', 7)] },
        { op: 'all', conditions: [leaf('y', 'eq', 5), { op: 'any', conditions: [leaf('z', 'eq', 9)] }] },
      ],
    };
    expect(ev(c, { w: 2, x: 6, y: 5, z: 9 })).toBe('TRUE');
  });

  it('missing referent: comparisons UNKNOWN', () => {
    expect(ev(tall, {})).toBe('UNKNOWN');
    expect(ev(leaf('height', 'in', [1]), {})).toBe('UNKNOWN');
    expect(ev(leaf('height', 'matches', 'x'), { height: null })).toBe('UNKNOWN');
    expect(ev(leaf('constructor', 'eq', 'x'), {})).toBe('UNKNOWN');
    expect(ev(leaf('toString', 'exists'), {})).toBe('FALSE');
  });

  it('not: TRUE↔FALSE, not(UNKNOWN)=UNKNOWN, not() = FALSE', () => {
    expect(ev({ op: 'not', conditions: [tall] }, { height: 140 })).toBe('TRUE');
    expect(ev({ op: 'not', conditions: [tall] }, { height: 170 })).toBe('FALSE');
    expect(ev({ op: 'not', conditions: [tall] }, {})).toBe('UNKNOWN');
    expect(ev({ op: 'not', conditions: [] })).toBe('FALSE');
  });

  it('all is FALSE-dominant then UNKNOWN; any is TRUE-dominant then UNKNOWN', () => {
    expect(ev({ op: 'all', conditions: [tall, goofy] }, { stance: 'regular' })).toBe('FALSE');
    expect(ev({ op: 'all', conditions: [tall, goofy] }, { stance: 'goofy' })).toBe('UNKNOWN');
    expect(ev({ op: 'any', conditions: [tall, goofy] }, { stance: 'goofy' })).toBe('TRUE');
    expect(ev({ op: 'any', conditions: [tall, goofy] }, { stance: 'regular' })).toBe('UNKNOWN');
  });

});

describe('malformed nodes are UNKNOWN, never TRUE/FALSE', () => {
  // An object where the operator string belongs.
  const objectOperator = { ref: 'parameter', name: 'age', op: { gt: 'gt', gte: 'gte' }, value: 12 } as unknown as Condition;

  it.each<[string, Condition]>([
    ['unrecognised operator', { ref: 'parameter', name: 'age', op: 'BOGUS' as never, value: 'x' }],
    ['object operator', objectOperator],
    ['prototype-named operator', { ref: 'parameter', name: 'age', op: 'constructor' as never }],
    ['leaf without name', { op: 'exists' }],
    ['option leaf without name', { ref: 'option', op: 'selected' }],
    ['option leaf with unrecognised operator', { ref: 'option', name: 'g.o', op: 'BOGUS' as never }],
    ['compound with non-list conditions', { op: 'all', conditions: 'nope' as never }],
    ['null node', null as unknown as Condition],
  ])('%s', (_name, c) => {
    expect(ev(c, { age: 14 }, ['g.o'])).toBe('UNKNOWN');
    expect(ev({ op: 'not', conditions: [c] }, { age: 14 }, ['g.o'])).toBe('UNKNOWN');
    expect(unknownRefs({ op: 'not', conditions: [c] }, ctx({ age: 14 }, ['g.o']))).toEqual([]);
  });

  it('Kleene dominance still decides around a malformed child', () => {
    expect(ev({ op: 'all', conditions: [leaf('age', 'lt', 10), objectOperator] }, { age: 14 })).toBe('FALSE');
    expect(ev({ op: 'any', conditions: [leaf('age', 'gt', 10), objectOperator] }, { age: 14 })).toBe('TRUE');
  });

  it('a malformed leaf with a missing value reports no unknown refs (answering cannot decide it)', () => {
    expect(unknownRefs(objectOperator, ctx({}))).toEqual([]);
  });
});

describe('option references (set membership)', () => {
  const opt = (name: string, op: Condition['op'], value?: Condition['value']): Condition => ({
    ref: 'option',
    name,
    op,
    ...(value === undefined ? {} : { value }),
  });

  it('option id: selected / exists: true / exists: false', () => {
    expect(ev(opt('extras.helmet', 'selected'), {}, ['extras.helmet'])).toBe('TRUE');
    expect(ev(opt('extras.helmet', 'selected'), {}, ['extras.gloves'])).toBe('FALSE');
    expect(ev(opt('extras.helmet', 'exists'), {}, ['extras.helmet'])).toBe('TRUE');
    expect(ev(opt('extras.helmet', 'exists', false), {}, [])).toBe('TRUE');
    expect(ev(opt('extras.helmet', 'exists', false), {}, ['extras.helmet'])).toBe('FALSE');
  });

  it('group key (no dot) = anything selected in the group', () => {
    expect(ev(opt('extras', 'selected'), {}, ['extras.gloves'])).toBe('TRUE');
    expect(ev(opt('extras', 'selected'), {}, ['lodging.cabin'])).toBe('FALSE');
    expect(ev(opt('extras', 'exists', false), {}, [])).toBe('TRUE');
  });

  it('in / not_in over option ids', () => {
    expect(ev(opt('extras', 'in', ['extras.m', 'extras.n']), {}, ['extras.n'])).toBe('TRUE');
    expect(ev(opt('extras', 'in', ['extras.m']), {}, ['extras.n'])).toBe('FALSE');
    expect(ev(opt('extras', 'not_in', ['extras.m']), {}, ['extras.n'])).toBe('TRUE');
    expect(ev(opt('extras', 'not_in', ['extras.n']), {}, ['extras.n'])).toBe('FALSE');
  });

  it('other operators compare membership as a boolean; never UNKNOWN', () => {
    expect(ev(opt('extras.a', 'eq', true), {}, ['extras.a'])).toBe('TRUE');
    expect(ev(opt('extras.a', 'eq', true), {}, [])).toBe('FALSE');
  });

  it('a value named like an option does not leak into option resolution', () => {
    expect(ev(opt('extras.a', 'selected'), { 'extras.a': 'yes' }, [])).toBe('FALSE');
  });
});

describe('unknownRefs', () => {
  const a = leaf('p', 'eq', 1);
  const b = leaf('q', 'gt', 2);
  const c = leaf('r', 'eq', 'x');

  it('decided conditions have no unknown refs', () => {
    expect(unknownRefs({ op: 'any', conditions: [a, b] }, ctx({ p: 1 }))).toEqual([]);
    expect(unknownRefs({ op: 'all', conditions: [a, b] }, ctx({ p: 2 }))).toEqual([]);
  });

  it('collects missing leaves in tree order, deduped', () => {
    expect(unknownRefs({ op: 'all', conditions: [a, b, a] }, ctx({}))).toEqual(['p', 'q']);
  });

  it('prunes decided sub-trees', () => {
    // any(p TRUE, q ?) is decided TRUE, so only r can change the all.
    const cond: Condition = { op: 'all', conditions: [{ op: 'any', conditions: [a, b] }, c] };
    expect(unknownRefs(cond, ctx({ p: 1 }))).toEqual(['r']);
  });

  it('existence leaves and option leaves are never unknown; derived leaves are', () => {
    const cond: Condition = {
      op: 'all',
      conditions: [
        leaf('x', 'exists'),
        { ref: 'option', name: 'g.o', op: 'exists', value: false },
        { ref: 'derived', name: 'isWeekend', op: 'eq', value: true },
      ],
    };
    expect(evaluateCondition(cond, ctx({ x: 1 }))).toBe('UNKNOWN');
    expect(unknownRefs(cond, ctx({ x: 1 }))).toEqual(['isWeekend']);
  });

  it('not passes through', () => {
    expect(unknownRefs({ op: 'not', conditions: [b] }, ctx({}))).toEqual(['q']);
  });
});
