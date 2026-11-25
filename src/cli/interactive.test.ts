import { describe, expect, it } from 'vitest';
import type { ChoiceQuestion, ParameterQuestion } from '../engine/types.js';
import { parseAnswer, parseSelection } from './interactive.js';

const parameter = (type: ParameterQuestion['type'], extra: Partial<ParameterQuestion> = {}): ParameterQuestion => ({
  kind: 'parameter',
  key: 'q',
  label: 'Q',
  type,
  required: true,
  ...extra,
});

const choice = (extra: Partial<ChoiceQuestion> = {}): ChoiceQuestion => ({
  kind: 'choice',
  key: 'extras',
  label: 'Extras?',
  mode: 'single',
  minSelections: 0,
  options: [
    { key: 'linen', label: 'Linen service' },
    { key: 'towels', label: 'Towels' },
  ],
  ...extra,
});

describe('parseAnswer', () => {
  it('parses strings, dates, times as-is (trimmed)', () => {
    expect(parseAnswer(parameter('string'), ' hello ')).toEqual({ ok: true, value: 'hello' });
    expect(parseAnswer(parameter('date'), '2026-07-04')).toEqual({ ok: true, value: '2026-07-04' });
    expect(parseAnswer(parameter('time'), ' 09:30 ')).toEqual({ ok: true, value: '09:30' });
  });

  it('parses numbers strictly', () => {
    expect(parseAnswer(parameter('number'), '10')).toEqual({ ok: true, value: 10 });
    expect(parseAnswer(parameter('number'), '-2.5')).toEqual({ ok: true, value: -2.5 });
    expect(parseAnswer(parameter('number'), 'ten').ok).toBe(false);
    expect(parseAnswer(parameter('integer'), '3')).toEqual({ ok: true, value: 3 });
    expect(parseAnswer(parameter('integer'), '3.5').ok).toBe(false);
  });

  it('parses booleans with the usual spellings', () => {
    const truthy = ['y', 'yes', 'true', 't', '1', 'YES'];
    const falsy = ['n', 'no', 'false', 'f', '0'];
    expect(truthy.map((input) => parseAnswer(parameter('boolean'), input))).toEqual(
      truthy.map(() => ({ ok: true, value: true })),
    );
    expect(falsy.map((input) => parseAnswer(parameter('boolean'), input))).toEqual(
      falsy.map(() => ({ ok: true, value: false })),
    );
    expect(parseAnswer(parameter('boolean'), 'maybe').ok).toBe(false);
  });

  it('parses select by value or label', () => {
    const question = parameter('select', {
      options: [
        { value: 's', label: 'Small' },
        { value: 'l', label: 'Large' },
      ],
    });
    expect(parseAnswer(question, 's')).toEqual({ ok: true, value: 's' });
    expect(parseAnswer(question, 'Large')).toEqual({ ok: true, value: 'l' });
    const rejected = parseAnswer(question, 'medium');
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) expect(rejected.error).toContain('choose one of: s, l');
  });

  it('parses multiselect as a comma list, deduplicated', () => {
    const question = parameter('multiselect', {
      options: [
        { value: 'a', label: 'Alpha' },
        { value: 'b', label: 'Beta' },
      ],
    });
    expect(parseAnswer(question, 'a, Alpha, b')).toEqual({ ok: true, value: ['a', 'b'] });
    expect(parseAnswer(question, 'a, c').ok).toBe(false);
    expect(parseAnswer(question, '')).toEqual({ ok: true, value: [] });
  });
});

describe('parseSelection', () => {
  it('parses by key or label, single mode rejects multiple picks', () => {
    expect(parseSelection(choice(), 'linen')).toEqual({ ok: true, value: ['linen'] });
    expect(parseSelection(choice(), 'Towels')).toEqual({ ok: true, value: ['towels'] });
    const rejected = parseSelection(choice(), 'linen, towels');
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) expect(rejected.error).toContain('exactly one');
    expect(parseSelection(choice(), 'nope').ok).toBe(false);
  });

  it('multi mode allows up to maxSelections', () => {
    const multi = choice({ mode: 'multi', maxSelections: 2 });
    expect(parseSelection(multi, 'linen, towels')).toEqual({ ok: true, value: ['linen', 'towels'] });
    const rejected = parseSelection(choice({ mode: 'multi', maxSelections: 1 }), 'linen, towels');
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) expect(rejected.error).toContain('at most 1');
  });

  it('empty input selects nothing', () => {
    expect(parseSelection(choice({ mode: 'multi' }), '  ')).toEqual({ ok: true, value: [] });
  });
});
