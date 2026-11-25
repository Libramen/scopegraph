import { describe, expect, it } from 'vitest';
import type { Condition } from '../graph/types.js';
import type { Diagnostic } from './diagnostics.js';
import { compileCatalog } from './index.js';

/**
 * Condition shorthand → canonical form. These call compileCatalog directly
 * with plain data (no files), so diagnostics carry no positions — the shape
 * of the emitted Condition tree is what matters here.
 */

interface OfferingSpec {
  ask?: Record<string, unknown>;
  choose?: Record<string, unknown>;
  rules?: unknown[];
  facts?: Record<string, unknown>;
}

function compileWhen(
  spec: OfferingSpec,
  when: unknown,
): { when?: Condition; diagnostics: Diagnostic[] } {
  const result = compileCatalog({
    business: {
      file: 'business.yaml',
      data: { name: 'B', ...(spec.facts ? { facts: spec.facts } : {}) },
    },
    offerings: [
      {
        id: 'p',
        file: 'offerings/p.yaml',
        data: {
          name: 'P',
          price: 10,
          ...(spec.ask ? { ask: spec.ask } : {}),
          ...(spec.choose ? { choose: spec.choose } : {}),
          rules: [{ when, block: 'no' }],
        },
      },
    ],
  });
  return {
    when: result.graph?.offerings['p']?.scope.rules[0]?.when,
    diagnostics: result.diagnostics,
  };
}

const NUMERIC_ASK = {
  age: { type: 'integer', min: 0, max: 120 },
  hours: { type: 'number', min: 0 },
  when_date: { type: 'date' },
  start_time: { type: 'time' },
};
const SELECT_ASK = {
  stance: { type: 'select', options: ['regular', 'goofy'] },
};
const MULTI_ASK = {
  tags: { type: 'multiselect', options: ['vip', 'family', 'kayak'] },
};
const STRING_ASK = {
  promo_code: { type: 'string' },
};
const GROUPS = {
  extras: { options: ['photos', 'pickup'] },
};

describe('condition shorthand → canonical Condition', () => {
  it('compiles a scalar to eq', () => {
    const { when, diagnostics } = compileWhen(
      { ask: SELECT_ASK },
      { stance: 'regular' },
    );
    expect(diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    expect(when).toEqual({
      ref: 'parameter',
      name: 'stance',
      op: 'eq',
      value: 'regular',
    });
  });

  it('compiles an array to in', () => {
    const { when } = compileWhen({ ask: SELECT_ASK }, { stance: ['regular', 'goofy'] });
    expect(when).toEqual({
      ref: 'parameter',
      name: 'stance',
      op: 'in',
      value: ['regular', 'goofy'],
    });
  });

  it('compiles an operator object with several keys to all', () => {
    const { when } = compileWhen({ ask: NUMERIC_ASK }, { age: { gte: 1, lte: 5 } });
    expect(when).toEqual({
      op: 'all',
      conditions: [
        { ref: 'parameter', name: 'age', op: 'gte', value: 1 },
        { ref: 'parameter', name: 'age', op: 'lte', value: 5 },
      ],
    });
  });

  it('compiles several top-level keys to all (single key stays bare)', () => {
    const both = compileWhen({ ask: { ...NUMERIC_ASK, ...SELECT_ASK } }, { age: 3, stance: 'regular' }).when;
    expect(both).toEqual({
      op: 'all',
      conditions: [
        { ref: 'parameter', name: 'age', op: 'eq', value: 3 },
        { ref: 'parameter', name: 'stance', op: 'eq', value: 'regular' },
      ],
    });
    const single = compileWhen({ ask: NUMERIC_ASK }, { age: 3 }).when;
    expect(single).toEqual({
      ref: 'parameter',
      name: 'age',
      op: 'eq',
      value: 3,
    });
  });

  it('compiles all/any/not to compound nodes', () => {
    expect(compileWhen({ ask: NUMERIC_ASK }, { all: [{ age: 1 }, { hours: 2 }] }).when).toEqual({
      op: 'all',
      conditions: [
        { ref: 'parameter', name: 'age', op: 'eq', value: 1 },
        { ref: 'parameter', name: 'hours', op: 'eq', value: 2 },
      ],
    });
    expect(compileWhen({ ask: NUMERIC_ASK }, { any: [{ age: 1 }, { hours: 2 }] }).when).toEqual({
      op: 'any',
      conditions: [
        { ref: 'parameter', name: 'age', op: 'eq', value: 1 },
        { ref: 'parameter', name: 'hours', op: 'eq', value: 2 },
      ],
    });
    expect(compileWhen({ ask: NUMERIC_ASK }, { not: { age: 1 } }).when).toEqual({
      op: 'not',
      conditions: [
        { ref: 'parameter', name: 'age', op: 'eq', value: 1 },
      ],
    });
  });

  it('compiles exists true/false to an exists leaf carrying the boolean', () => {
    expect(compileWhen({ ask: NUMERIC_ASK }, { age: { exists: true } }).when).toEqual({
      ref: 'parameter',
      name: 'age',
      op: 'exists',
      value: true,
    });
    expect(compileWhen({ ask: NUMERIC_ASK }, { age: { exists: false } }).when).toEqual({
      ref: 'parameter',
      name: 'age',
      op: 'exists',
      value: false,
    });
  });

  it('compiles selected to an option leaf (option and group)', () => {
    expect(compileWhen({ choose: GROUPS }, { selected: 'extras.photos' }).when).toEqual({
      ref: 'option',
      name: 'extras.photos',
      op: 'selected',
    });
    expect(compileWhen({ choose: GROUPS }, { selected: 'extras' }).when).toEqual({
      ref: 'option',
      name: 'extras',
      op: 'selected',
    });
  });

  it('resolves facts to fact leaves and derived values to derived leaves', () => {
    expect(
      compileWhen({ facts: { is_public_holiday: { type: 'boolean' } } }, { is_public_holiday: true }).when,
    ).toEqual({
      ref: 'fact',
      name: 'is_public_holiday',
      op: 'eq',
      value: true,
    });
    expect(compileWhen({}, { isWeekend: true }).when).toEqual({
      ref: 'derived',
      name: 'isWeekend',
      op: 'eq',
      value: true,
    });
    expect(compileWhen({}, { leadTimeHours: { gte: 48 } }).when).toEqual({
      ref: 'derived',
      name: 'leadTimeHours',
      op: 'gte',
      value: 48,
    });
  });

  it('compiles multiselect scalars to contains (engine intersects arrays)', () => {
    expect(compileWhen({ ask: MULTI_ASK }, { tags: 'vip' }).when).toEqual({
      ref: 'parameter',
      name: 'tags',
      op: 'contains',
      value: 'vip',
    });
    // explicit eq stays eq — the engine reads eq on an array as "contains"
    expect(compileWhen({ ask: MULTI_ASK }, { tags: { eq: 'vip' } }).when).toEqual({
      ref: 'parameter',
      name: 'tags',
      op: 'eq',
      value: 'vip',
    });
  });

  it('compiles every operator key to a single operator string', () => {
    // Each `op` must be the operator itself, never a lookup table or other object.
    const cases: Array<[when: unknown, expected: Condition]> = [
      [{ age: { eq: 5 } }, { ref: 'parameter', name: 'age', op: 'eq', value: 5 }],
      [{ age: { neq: 5 } }, { ref: 'parameter', name: 'age', op: 'neq', value: 5 }],
      [{ age: { gt: 5 } }, { ref: 'parameter', name: 'age', op: 'gt', value: 5 }],
      [{ age: { gte: 5 } }, { ref: 'parameter', name: 'age', op: 'gte', value: 5 }],
      [{ age: { lt: 5 } }, { ref: 'parameter', name: 'age', op: 'lt', value: 5 }],
      [{ age: { lte: 5 } }, { ref: 'parameter', name: 'age', op: 'lte', value: 5 }],
      [
        { stance: { in: ['regular'] } },
        { ref: 'parameter', name: 'stance', op: 'in', value: ['regular'] },
      ],
      [
        { stance: { not_in: ['regular'] } },
        { ref: 'parameter', name: 'stance', op: 'not_in', value: ['regular'] },
      ],
      [
        { tags: { contains: 'vip' } },
        { ref: 'parameter', name: 'tags', op: 'contains', value: 'vip' },
      ],
      [
        { promo_code: { matches: '^SUMMER' } },
        { ref: 'parameter', name: 'promo_code', op: 'matches', value: '^SUMMER' },
      ],
      [{ age: { exists: true } }, { ref: 'parameter', name: 'age', op: 'exists', value: true }],
      [{ age: { exists: false } }, { ref: 'parameter', name: 'age', op: 'exists', value: false }],
    ];
    const ask = { ...NUMERIC_ASK, ...SELECT_ASK, ...MULTI_ASK, ...STRING_ASK };
    for (const [when, expected] of cases) {
      const compiled = compileWhen({ ask }, when);
      expect(compiled.diagnostics.filter((d) => d.severity === 'error'), `when: ${JSON.stringify(when)}`).toEqual([]);
      expect(typeof compiled.when?.op, `when: ${JSON.stringify(when)}`).toBe('string');
      expect(compiled.when, `when: ${JSON.stringify(when)}`).toEqual(expected);
    }
  });

  it('emits single operator strings inside not/all/any', () => {
    const notGte = compileWhen({ ask: NUMERIC_ASK }, { not: { age: { gte: 12 } } }).when;
    expect(notGte).toEqual({
      op: 'not',
      conditions: [{ ref: 'parameter', name: 'age', op: 'gte', value: 12 }],
    });

    const both = compileWhen({ ask: NUMERIC_ASK }, { age: { gte: 26, lte: 50 } }).when;
    expect(both).toEqual({
      op: 'all',
      conditions: [
        { ref: 'parameter', name: 'age', op: 'gte', value: 26 },
        { ref: 'parameter', name: 'age', op: 'lte', value: 50 },
      ],
    });

    const anyLt = compileWhen({ ask: NUMERIC_ASK }, { any: [{ age: { lt: 3 } }, { hours: { gte: 2 } }] }).when;
    expect(anyLt).toEqual({
      op: 'any',
      conditions: [
        { ref: 'parameter', name: 'age', op: 'lt', value: 3 },
        { ref: 'parameter', name: 'hours', op: 'gte', value: 2 },
      ],
    });
  });

  it('allows ordering ops on date and time parameters', () => {
    const { when, diagnostics } = compileWhen({ ask: NUMERIC_ASK }, { when_date: { gte: '2026-01-01' } });
    expect(diagnostics.filter((d) => d.code === 'INVALID_CONDITION')).toEqual([]);
    expect(when).toEqual({
      ref: 'parameter',
      name: 'when_date',
      op: 'gte',
      value: '2026-01-01',
    });
  });

  it('rejects ordering ops on non-orderable parameters (INVALID_CONDITION)', () => {
    const { diagnostics } = compileWhen({ ask: SELECT_ASK }, { stance: { gte: 3 } });
    expect(diagnostics).toContainEqual(
      expect.objectContaining({
        code: 'INVALID_CONDITION',
        severity: 'error',
        path: ['rules', 0, 'when', 'stance', 'gte'],
      }),
    );
    const weekday = compileWhen({}, { weekday: { gte: 3 } });
    expect(weekday.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'INVALID_CONDITION' }),
    );
  });

  it('rejects select values outside the options with INVALID_CONDITION', () => {
    const { diagnostics } = compileWhen({ ask: SELECT_ASK }, { stance: 'switch' });
    expect(diagnostics).toContainEqual(
      expect.objectContaining({
        code: 'INVALID_CONDITION',
        severity: 'error',
        path: ['rules', 0, 'when', 'stance'],
      }),
    );
  });

  it('rejects weekday values that are not sun..sat', () => {
    const { diagnostics } = compileWhen({}, { weekday: 'saturday' });
    expect(diagnostics).toContainEqual(
      expect.objectContaining({
        code: 'INVALID_CONDITION',
        message: expect.stringContaining('saturday'),
      }),
    );
  });

  it('suggests the right operator for typos', () => {
    const { diagnostics } = compileWhen({ ask: NUMERIC_ASK }, { age: { gtee: 3 } });
    expect(diagnostics).toContainEqual(
      expect.objectContaining({
        code: 'INVALID_CONDITION',
        hint: expect.stringContaining("Did you mean 'gte'?"),
      }),
    );
  });

  it('suggests the right name for unknown references', () => {
    const { diagnostics } = compileWhen(
      { ask: { participants: { type: 'integer', min: 0 } } },
      { participents: 2 },
    );
    expect(diagnostics).toContainEqual(
      expect.objectContaining({
        code: 'UNKNOWN_REFERENCE',
        path: ['rules', 0, 'when', 'participents'],
        hint: expect.stringContaining("Did you mean 'participants'?"),
      }),
    );
  });

  it('matches patterns compile on RE2 — backtracking shapes are fine, lookaround is named and refused', () => {
    for (const pattern of ['(a+)+b', '^(\\w|\\d)+$', `^${'\\d*'.repeat(20)}x$`]) {
      const { diagnostics } = compileWhen({ ask: STRING_ASK }, { promo_code: { matches: pattern } });
      expect(diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    }
    const { diagnostics } = compileWhen({ ask: STRING_ASK }, { promo_code: { matches: '^(?=SUMMER)S' } });
    expect(diagnostics).toContainEqual(
      expect.objectContaining({ code: 'INVALID_CONDITION', message: expect.stringContaining('`(?=`') }),
    );
  });
});
