import { describe, expect, it } from 'vitest';
import type { Condition, Graph, Offering, OfferingScope, Rule } from '../graph/types.js';
import { evaluate } from './evaluate.js';
import { MINIMAL_BUSINESS_YAML, fixtureGraph } from '../compile/testkit.js';
import {
  adjustment,
  all,
  any,
  baseLine,
  d,
  f,
  group,
  graph,
  not,
  offering,
  p,
  param,
  rule,
  selected,
} from './testing.js';
import type { ScopeRequest, ScopeResult } from './types.js';

const NOW = new Date('2026-07-01T12:00:00Z');

function product(scope: Partial<OfferingScope>, extra: Partial<Omit<Offering, 'scope'>> = {}): Graph {
  return graph([offering('item', { name: 'Item', ...extra, scope: { baseLines: [baseLine(10000)], ...scope } })]);
}

function run(g: Graph, request: Omit<ScopeRequest, 'offering'> = {}, offeringId = 'item'): ScopeResult {
  return evaluate(g, { offering: offeringId, ...request }, { now: NOW });
}

function expectStatus<S extends ScopeResult['status']>(r: ScopeResult, status: S): Extract<ScopeResult, { status: S }> {
  expect(r.status, JSON.stringify(r, null, 2)).toBe(status);
  return r as Extract<ScopeResult, { status: S }>;
}

function askedKey(r: ScopeResult): string {
  return expectStatus(r, 'needs_input').question.key;
}

// ─── Lookup ──────────────────────────────────────────────────────────────────

describe('lookup', () => {
  it('NOT_FOUND / NOT_ACTIVE / NOT_BOOKABLE / CONTENTS_UNAVAILABLE', () => {
    const g = graph([
      offering('paused', { status: 'paused' }),
      offering('component', { bookable: false }),
      offering('bundle', { kind: 'package', scope: { inactiveContents: ['paused'] } }),
    ]);
    expect(expectStatus(run(g, {}, 'nope'), 'unavailable').code).toBe('NOT_FOUND');
    expect(expectStatus(run(g, {}, 'toString'), 'unavailable').code).toBe('NOT_FOUND');
    expect(expectStatus(run(g, {}, 'paused'), 'unavailable').code).toBe('NOT_ACTIVE');
    expect(expectStatus(run(g, {}, 'component'), 'unavailable').code).toBe('NOT_BOOKABLE');
    expect(expectStatus(run(g, {}, 'bundle'), 'unavailable').code).toBe('CONTENTS_UNAVAILABLE');
  });

  it('buyers get NOT_FOUND with one message for every unlisted offering, and no inactive ids', () => {
    const g = graph([
      offering('paused', { name: 'Secret Paused', status: 'paused' }),
      offering('archived', { name: 'Old Thing', status: 'archived' }),
      offering('component', { name: 'Hidden Part', bookable: false }),
      offering('bundle', { name: 'Bundle', kind: 'package', scope: { inactiveContents: ['unreleased-widget'] } }),
    ]);
    const buyer = (id: string) => evaluate(g, { offering: id }, { now: NOW, audience: 'buyer', trace: false });
    for (const id of ['nope', 'paused', 'archived', 'component']) {
      expect(buyer(id)).toEqual({ status: 'unavailable', offering: id, code: 'NOT_FOUND', message: `No offering "${id}".` });
    }
    const bundle = expectStatus(buyer('bundle'), 'unavailable');
    expect(bundle).toMatchObject({ code: 'CONTENTS_UNAVAILABLE', message: 'Bundle is not available right now.' });
    expect(bundle.message).not.toContain('unreleased-widget');
    // Owners (CLI, scenarios) keep the precise codes and ids.
    expect(expectStatus(run(g, {}, 'bundle'), 'unavailable').message).toContain('unreleased-widget');
  });
});

// ─── Input validation ────────────────────────────────────────────────────────

describe('input validation', () => {
  const g = product(
    {
      parameters: [
        param('participants', { type: 'integer', min: 1, max: 10 }),
        param('code', { type: 'string', required: false, pattern: '^[A-Z]{3}$', min: 3, max: 3 }),
        param('level', { type: 'select', required: false, options: [{ value: 'a', label: 'A' }] }),
        param('secret', { internal: true, required: false, default: 'x' }),
        param('when', { type: 'date', required: false }),
        param('ok', { type: 'boolean', required: false }),
      ],
      optionGroups: [
        group('board', ['soft', 'hard']),
        group('extras', ['wax', 'leash', 'fins'], { mode: 'multi', maxSelections: 2 }),
      ],
    },
    { date: 'none' },
  );

  it('collects every error together', () => {
    const r = run(g, {
      answers: {
        participants: 2.5,
        code: 'abcd',
        level: 'z',
        secret: 'y',
        bogus: 1,
        isWeekend: false,
        when: '2026-02-30',
        ok: 'yes',
      },
      selections: { board: ['soft', 'hard'], extras: ['wax', 'leash', 'fins'], ops: 'x', nope: 'a', ...{} },
      date: '2026-07-04',
    });
    const errors = expectStatus(r, 'invalid').errors;
    const by = (field: string) => errors.filter((e) => e.field === field).map((e) => e.code);
    expect(by('answers.participants')).toEqual(['INVALID_VALUE']);
    expect(by('answers.code')).toEqual(['INVALID_VALUE', 'INVALID_VALUE']); // too long + pattern
    expect(by('answers.level')).toEqual(['INVALID_VALUE']);
    expect(by('answers.secret')).toEqual(['UNKNOWN_FIELD']); // internal → not a question
    expect(by('answers.bogus')).toEqual(['UNKNOWN_FIELD']);
    expect(by('answers.isWeekend')).toEqual(['UNKNOWN_FIELD']); // derived names are reserved
    expect(by('answers.when')).toEqual(['INVALID_VALUE']);
    expect(by('answers.ok')).toEqual(['INVALID_VALUE']);
    expect(by('selections.board')).toEqual(['TOO_MANY_SELECTIONS']);
    expect(by('selections.extras')).toEqual(['TOO_MANY_SELECTIONS']);
    expect(by('selections.ops')).toEqual(['UNKNOWN_FIELD']);
    expect(by('selections.nope')).toEqual(['UNKNOWN_FIELD']);
    expect(by('date')).toEqual(['UNKNOWN_FIELD']); // offering takes no date
  });

  it('unknown options, malformed selections, min/max, unparsable dates', () => {
    const dated = product({ parameters: [param('participants', { type: 'number', min: 1, max: 10 })], optionGroups: [group('board', ['soft'])] }, { date: 'optional' });
    const errors = expectStatus(
      run(dated, { answers: { participants: 0 }, selections: { board: ['soft', 'carbon'] }, date: 'next tuesday' }),
      'invalid',
    ).errors;
    expect(errors.map((e) => [e.field, e.code])).toEqual([
      ['answers.participants', 'INVALID_VALUE'],
      ['selections.board', 'UNKNOWN_OPTION'],
      ['date', 'INVALID_DATE'],
    ]);
    expect(errors[0]?.message).toBe('participants must be at least 1');
    const malformed = expectStatus(run(dated, { selections: { board: 5 as never } }), 'invalid').errors;
    expect(malformed.map((e) => e.code)).toEqual(['INVALID_VALUE']);
  });

  it('owner messages (the default) report every field; buyers get only the next question\'s, with the same detail', () => {
    const request = {
      offering: 'item',
      answers: { participants: 0, code: 'AB', level: 'z' },
      selections: { board: ['carbon'], extras: ['wax', 'leash', 'fins'] },
    };
    expect(expectStatus(evaluate(g, request, { now: NOW }), 'invalid').errors).toEqual([
      { field: 'answers.participants', code: 'INVALID_VALUE', message: 'participants must be at least 1' },
      { field: 'answers.code', code: 'INVALID_VALUE', message: 'code must be at least 3 characters' },
      { field: 'answers.code', code: 'INVALID_VALUE', message: 'code does not match the required pattern' },
      { field: 'answers.level', code: 'INVALID_VALUE', message: 'level must be one of these values: a' },
      { field: 'selections.board', code: 'UNKNOWN_OPTION', message: '"carbon" is not an option of board. Options: soft, hard.' },
      { field: 'selections.extras', code: 'TOO_MANY_SELECTIONS', message: 'extras takes at most 2 choices.' },
    ]);
    // Buyer: every invalid value is dropped; only the next question's error comes back.
    expect(expectStatus(evaluate(g, request, { now: NOW, audience: 'buyer' }), 'invalid').errors).toEqual([
      { field: 'answers.participants', code: 'INVALID_VALUE', message: 'Invalid answer for "participants": must be at least 1.' },
    ]);
  });

  it('buyer: the next question\'s errors carry its type, bounds and options (existing codes)', () => {
    const asked = product({
      parameters: [param('code', { type: 'string', pattern: '^[A-Z]{3}$', min: 3, max: 3 })],
      optionGroups: [group('extras', ['wax', 'leash', 'fins'], { mode: 'multi', required: true, maxSelections: 2 })],
    });
    const buyer = (request: Omit<ScopeRequest, 'offering'>) => evaluate(asked, { offering: 'item', ...request }, { now: NOW, audience: 'buyer' });
    expect(expectStatus(buyer({ answers: { code: 'AB' } }), 'invalid').errors).toEqual([
      { field: 'answers.code', code: 'INVALID_VALUE', message: 'Invalid answer for "code": must be at least 3 characters.' },
      { field: 'answers.code', code: 'INVALID_VALUE', message: 'Invalid answer for "code": does not match the required pattern.' },
    ]);
    expect(expectStatus(buyer({ answers: { code: 'A'.repeat(600) } }), 'invalid').errors).toEqual([
      { field: 'answers.code', code: 'INVALID_VALUE', message: 'Invalid answer for "code": must be at most 512 characters.' },
    ]);
    expect(expectStatus(buyer({ answers: { code: 7 } }), 'invalid').errors).toEqual([
      { field: 'answers.code', code: 'INVALID_VALUE', message: 'Invalid answer for "code": must be a string.' },
    ]);
    expect(expectStatus(buyer({ answers: { code: 'ABC' }, selections: { extras: ['wax', 'leash', 'fins'] } }), 'invalid').errors).toEqual([
      { field: 'selections.extras', code: 'TOO_MANY_SELECTIONS', message: 'Too many options selected for "extras": pick at most 2.' },
    ]);
    expect(expectStatus(buyer({ answers: { code: 'ABC' }, selections: { extras: ['nope', 'zzz'] } }), 'invalid').errors).toEqual([
      { field: 'selections.extras', code: 'UNKNOWN_OPTION', message: 'Invalid choice for "extras": "nope" is not one of its options (wax, leash, fins).' },
      { field: 'selections.extras', code: 'UNKNOWN_OPTION', message: 'Invalid choice for "extras": "zzz" is not one of its options (wax, leash, fins).' },
    ]);
    // `code` is asked first: the bad `extras` stays hidden until it is the next question.
    expect(expectStatus(buyer({ answers: { code: 1 }, selections: { extras: ['nope'] } }), 'invalid').errors).toEqual([
      { field: 'answers.code', code: 'INVALID_VALUE', message: 'Invalid answer for "code": must be a string.' },
    ]);
  });

  it('buyer: an unknown option in an open group is invalid, never silently dropped; owners reject the group too', () => {
    const asked = product({
      parameters: [param('code', { type: 'string' })],
      optionGroups: [
        group('extras', ['wax', 'leash', 'fins'], { mode: 'multi', required: true }),
        group('board', ['soft', 'hard'], { mode: 'single' }),
      ],
    });
    const request = { offering: 'item', answers: { code: 'A' }, selections: { extras: ['wax', 'nope'], board: ['hard', 'carbon'] } };
    expect(expectStatus(evaluate(asked, request, { now: NOW, audience: 'buyer' }), 'invalid').errors).toEqual([
      { field: 'selections.extras', code: 'UNKNOWN_OPTION', message: 'Invalid choice for "extras": "nope" is not one of its options (wax, leash, fins).' },
      { field: 'selections.board', code: 'UNKNOWN_OPTION', message: 'Invalid choice for "board": "carbon" is not one of its options (soft, hard).' },
    ]);
    expect(expectStatus(evaluate(asked, request, { now: NOW }), 'invalid').errors.map((e) => [e.field, e.code])).toEqual([
      ['selections.extras', 'UNKNOWN_OPTION'],
      ['selections.board', 'UNKNOWN_OPTION'],
    ]);
  });

  it('buyer: an over-limit answer on a defaulted parameter is invalid, not quoted at the default', () => {
    const g = graph([offering('tour', { scope: {
      parameters: [param('guests', { type: 'integer', min: 1, max: 10, default: 2 })],
      baseLines: [baseLine(5000, { per: 'guests' })],
    } })]);
    const request = { offering: 'tour', answers: { guests: 25 } };
    expect(evaluate(g, request, { now: NOW, audience: 'buyer', trace: false })).toEqual({
      status: 'invalid',
      offering: 'tour',
      errors: [{ field: 'answers.guests', code: 'INVALID_VALUE', message: 'Invalid answer for "guests": must be at most 10.' }],
    });
    expectStatus(evaluate(g, request, { now: NOW }), 'invalid');
    expect(expectStatus(evaluate(g, { offering: 'tour', answers: { guests: 3 } }, { now: NOW, audience: 'buyer' }), 'qualified').quote.totalCents).toBe(15000);
  });

  it('buyer: a bad select value on a defaulted parameter is invalid, not swapped for the default', () => {
    const g = product({
      parameters: [param('level', { type: 'select', required: false, default: 'easy', options: [{ value: 'easy', label: 'Easy' }, { value: 'hard', label: 'Hard' }] })],
      adjustments: [adjustment('hard_fee', { type: 'fixed', amountCents: 500 }, { when: p('level', 'eq', 'hard') })],
    });
    expect(expectStatus(evaluate(g, { offering: 'item', answers: { level: 'expert' } }, { now: NOW, audience: 'buyer' }), 'invalid').errors).toEqual([
      { field: 'answers.level', code: 'INVALID_VALUE', message: 'Invalid answer for "level": must be one of these values: easy, hard.' },
    ]);
  });

  it('buyer: an unknown option in an optional group is invalid; closed groups and unknown names stay silent', () => {
    const g = product({
      parameters: [param('surfer', { type: 'boolean', required: false, default: false })],
      optionGroups: [
        group('extras', ['wax', 'leash'], { mode: 'multi' }),
        group('hire', ['board'], { mode: 'single' }),
      ],
      rules: [rule('ask_hire', { kind: 'ask', target: { type: 'group', id: 'hire' } }, { when: p('surfer', 'eq', true) })],
    });
    const buyer = (request: Omit<ScopeRequest, 'offering'>) => evaluate(g, { offering: 'item', ...request }, { now: NOW, audience: 'buyer', trace: false });
    expect(expectStatus(buyer({ selections: { extras: ['wax', 'fins'] } }), 'invalid').errors).toEqual([
      { field: 'selections.extras', code: 'UNKNOWN_OPTION', message: 'Invalid choice for "extras": "fins" is not one of its options (wax, leash).' },
    ]);
    // `hire` is behind a closed gate and `nada` does not exist: both ignored, exactly like an empty request.
    expect(buyer({ selections: { hire: ['jetski'], nada: ['x'] }, answers: { bogus: {} as never } })).toEqual(buyer({}));
    expectStatus(buyer({}), 'qualified');
    // Once the gate opens, the bad pick in `hire` is reported.
    expect(expectStatus(buyer({ answers: { surfer: true }, selections: { hire: ['jetski'] } }), 'invalid').errors.map((e) => e.field)).toEqual(['selections.hire']);
  });

  it('buyer summary leaves out groups answered with none; the full request keeps them', () => {
    const g = product({
      parameters: [param('surfer', { type: 'boolean', required: false, default: false })],
      optionGroups: [group('extras', ['wax']), group('hire', ['board'])],
      rules: [rule('ask_hire', { kind: 'ask', target: { type: 'group', id: 'hire' } }, { when: p('surfer', 'eq', true) })],
    });
    const request = { offering: 'item', answers: { surfer: true }, selections: { extras: [], hire: ['board'] } };
    const buyer = expectStatus(evaluate(g, request, { now: NOW, audience: 'buyer' }), 'qualified');
    expect(buyer.summary.selections).toEqual({ hire: ['board'] });
    expect(buyer.request?.selections).toEqual({ extras: [], hire: ['board'] });
    // A never-asked group sent as [] is no longer confirmed by the summary (an unknown one never was).
    const probe = expectStatus(evaluate(g, { offering: 'item', selections: { extras: [], zz: [] } }, { now: NOW, audience: 'buyer' }), 'qualified');
    expect(probe.summary.selections).toEqual({});
    expect(probe.request?.selections).toEqual({ extras: [] });
    const owner = expectStatus(evaluate(g, request, { now: NOW }), 'qualified');
    expect(owner.summary.selections).toEqual({ extras: [], hire: ['board'] });
  });

  it('buyer: invalid values for steps not asked next are dropped as if never sent (no wrong-type oracle)', () => {
    const dated = product(
      {
        parameters: [
          param('participants', { type: 'integer', min: 1, max: 10 }),
          param('size', { type: 'select', options: [{ value: 's', label: 'S' }] }),
          param('note', { required: false }),
        ],
        optionGroups: [group('board', ['soft', 'hard'])],
        rules: [rule('ask_size', { kind: 'ask', target: { type: 'parameter', id: 'size' } }, { when: selected('board.hard') })],
      },
      { date: 'required' },
    );
    const buyer = (request: Omit<ScopeRequest, 'offering'>) =>
      evaluate(dated, { offering: 'item', ...request }, { now: NOW, audience: 'buyer', trace: false });
    const junk = { participants: {}, size: {}, note: {}, bogus: {} } as unknown as Record<string, never>;
    // Date is asked first: the junk reveals nothing (same result as an empty request).
    expect(buyer({ answers: junk, selections: { board: ['nope'], nada: ['x'] } })).toEqual(buyer({}));
    // Participants is next: only its error comes back; the gated `size` and optional `note` stay silent.
    expect(expectStatus(buyer({ answers: junk, date: '2026-07-10' }), 'invalid').errors).toEqual([
      { field: 'answers.participants', code: 'INVALID_VALUE', message: 'Invalid answer for "participants": must be a number.' },
    ]);
    // Open steps' invalid values are reported before pricing, even when never asked.
    expect(expectStatus(buyer({ answers: { participants: 2, note: {} as never }, selections: { board: ['nope'] }, date: '2026-07-10' }), 'invalid').errors.map((e) => [e.field, e.code])).toEqual([
      ['answers.note', 'INVALID_VALUE'],
      ['selections.board', 'UNKNOWN_OPTION'],
    ]);
    // The gated `size` stays silent while its gate is closed, and the request qualifies without it.
    const qualified = expectStatus(buyer({ answers: { participants: 2, size: {} as never }, date: '2026-07-10' }), 'qualified');
    expect(qualified.summary).toEqual({ answers: { participants: 2 }, selections: {}, date: '2026-07-10' });
    // The gated `size` surfaces its error once its gate opens and it is next.
    expect(expectStatus(buyer({ answers: { participants: 2, size: 'xl' }, selections: { board: 'hard' }, date: '2026-07-10' }), 'invalid').errors).toEqual([
      { field: 'answers.size', code: 'INVALID_VALUE', message: 'Invalid answer for "size": must be one of these values: s.' },
    ]);
    // A malformed date is not catalog data: still reported straight away.
    expect(expectStatus(buyer({ answers: junk, date: 'tomorrow' }), 'invalid').errors.map((e) => e.field)).toEqual(['date']);
  });

  it('buyer audience ignores unknown and internal names with a trace warning instead of UNKNOWN_FIELD', () => {
    const r = evaluate(
      g,
      { offering: 'item', answers: { participants: 2, secret: 'y', bogus: 1 }, selections: { board: 'soft', nope: 'a' } },
      { now: NOW, audience: 'buyer' },
    );
    expect(r.status).not.toBe('invalid');
    expect(r.trace?.warnings).toEqual([
      'Ignored answer "secret": not a question for this offering.',
      'Ignored answer "bogus": not a question for this offering.',
      'Ignored selection "nope": not a choice for this offering.',
    ]);
  });

  it('owner summary echoes defaults and carries no request; buyer summary echoes only supplied answers', () => {
    const g = product({
      parameters: [
        param('guests', { type: 'integer' }),
        param('level', { required: false, default: 'easy' }),
        param('secret', { internal: true, required: false, default: 'x' }),
      ],
    });
    const owner = expectStatus(run(g, { answers: { guests: 2 } }), 'qualified');
    expect(owner.summary).toEqual({ answers: { guests: 2, level: 'easy' }, selections: {} });
    expect(owner).not.toHaveProperty('request');
    const buyer = expectStatus(evaluate(g, { offering: 'item', answers: { guests: 2 } }, { now: NOW, audience: 'buyer' }), 'qualified');
    expect(buyer.summary).toEqual({ answers: { guests: 2 }, selections: {} });
    expect(buyer.request).toEqual(owner.summary);
  });

  it('multi group at exactly maxSelections, duplicates collapse, single string accepted', () => {
    const r = run(g, { answers: { participants: 2 }, selections: { board: 'soft', extras: ['wax', 'leash', 'wax'] } });
    const q = expectStatus(r, 'qualified');
    expect(q.summary.selections).toEqual({ board: ['soft'], extras: ['wax', 'leash'] });
  });

  it('unusable patterns never run and reject the value', () => {
    const unusable = product({ parameters: [param('code', { pattern: '(a)\\1' })] });
    expect(expectStatus(run(unusable, { answers: { code: 'aa' } }), 'invalid').errors[0]?.message).toBe('code does not match the required pattern');
  });

  it('a backtracking-shaped pattern answers a hostile string in linear time', () => {
    const g = product({ parameters: [param('code', { pattern: '^(\\w|\\d)+$' })] });
    const start = performance.now();
    const r = expectStatus(run(g, { answers: { code: `${'1'.repeat(510)}!` } }), 'invalid');
    // Loose for slow CI runners; a backtracking engine took ~25 s on this input.
    expect(performance.now() - start).toBeLessThan(500);
    expect(r.errors[0]?.message).toBe('code does not match the required pattern');
    expectStatus(run(g, { answers: { code: 'abc123' } }), 'qualified');
  });

  it('text answers with control characters (other than tab/newline) are INVALID_VALUE', () => {
    const g = product({ parameters: [param('note')] });
    for (const note of ['hi\u001b]52;c;eA==\u0007', 'a\u0000b', 'x\ry', 'c1\u009b31m', 'del\u007f']) {
      const r = expectStatus(run(g, { answers: { note } }), 'invalid');
      expect(r.errors).toEqual([
        { field: 'answers.note', code: 'INVALID_VALUE', message: 'note must not contain control characters (only tab and newline)' },
      ]);
    }
    expectStatus(run(g, { answers: { note: 'line one\n\tline two' } }), 'qualified');
  });

  it('multiselect answers may not repeat an option (so never exceed the option count)', () => {
    const options = [{ value: 'vegan', label: 'Vegan' }, { value: 'halal', label: 'Halal' }];
    const g = product({ parameters: [param('diet', { type: 'multiselect', options })] });
    for (const diet of [['vegan', 'vegan'], ['vegan', 'halal', 'vegan'], Array.from({ length: 500 }, () => 'halal')]) {
      const r = expectStatus(run(g, { answers: { diet } }), 'invalid');
      expect(r.errors).toEqual([{ field: 'answers.diet', code: 'INVALID_VALUE', message: 'diet must not list an option twice' }]);
    }
    expectStatus(run(g, { answers: { diet: ['halal', 'vegan'] } }), 'qualified');
  });

  it('null / empty-string answers count as unanswered', () => {
    const r = run(product({ parameters: [param('name')] }), { answers: { name: '' } });
    expect(askedKey(r)).toBe('name');
  });

  it('a parameter named like an Object.prototype member is still unanswered until answered', () => {
    const g = product({ parameters: [param('constructor')] });
    expect(askedKey(run(g))).toBe('constructor');
    expectStatus(run(g, { answers: { constructor: 'x' } }), 'qualified');
  });
});

// ─── Values and facts ────────────────────────────────────────────────────────

describe('values and facts', () => {
  it('defaults (incl. internal) feed rules; answers override defaults', () => {
    const g = product({
      parameters: [param('zone', { internal: true, default: 'far' }), param('size', { required: false, default: 's' })],
      rules: [rule('far', { kind: 'block', message: 'Too far' }, { when: all(p('zone', 'eq', 'far'), p('size', 'eq', 'l')) })],
    });
    expectStatus(run(g), 'qualified');
    expectStatus(run(g, { answers: { size: 'l' } }), 'blocked');
  });

  it('declared facts feed conditions; undeclared facts are ignored with a warning', () => {
    const g = product(
      { rules: [rule('storm_hold', { kind: 'block', message: 'Storm hold' }, { when: f('storm', 'eq', true) })] },
    );
    g.business.facts = { storm: { name: 'storm', type: 'boolean', required: false } };
    const blocked = expectStatus(run(g, { facts: { storm: true } }), 'blocked');
    expect(blocked.reasons).toEqual([{ code: 'RULE', message: 'Storm hold', ruleId: 'storm_hold' }]);
    const ok = expectStatus(run(g, { facts: { storm: false, forged: 1 } }), 'qualified');
    expect(ok.trace?.warnings).toEqual(['Ignored undeclared fact "forged".']);
    expect(ok.trace?.values).toMatchObject({ storm: false });
    expect(ok.trace?.values).not.toHaveProperty('forged');
  });

  it('a missing required fact fails closed', () => {
    const g = product({});
    g.business.facts = {
      license_valid: { name: 'license_valid', type: 'boolean', required: true },
      wind_knots: { name: 'wind_knots', type: 'number', required: true },
    };
    const r = expectStatus(run(g, { facts: { wind_knots: 12 } }), 'blocked');
    expect(r.reasons.map((x) => x.code)).toEqual(['FACTS_UNAVAILABLE']);
    expect(r.trace?.warnings).toEqual(['Required fact "license_valid" was not supplied (server facts hook / scenario facts).']);
    expect(expectStatus(run(g), 'blocked').trace?.warnings).toEqual([
      'Required fact "license_valid" was not supplied (server facts hook / scenario facts).',
      'Required fact "wind_knots" was not supplied (server facts hook / scenario facts).',
    ]);
    expectStatus(run(g, { facts: { license_valid: true, wind_knots: 12 } }), 'qualified');
  });

  it('a missing optional fact leaves fact-based rules UNKNOWN (never asked)', () => {
    const g = product({ rules: [rule('storm_hold', { kind: 'block', message: 'Storm hold' }, { when: f('storm', 'eq', true) })] });
    g.business.facts = { storm: { name: 'storm', type: 'boolean', required: false } };
    const r = expectStatus(run(g), 'qualified');
    expect(r.trace?.rules).toEqual([
      { id: 'storm_hold', offering: 'item', effect: 'block', when: 'UNKNOWN', fired: false, unknownRefs: ['storm'] },
    ]);
  });
});

// ─── Block rules ─────────────────────────────────────────────────────────────

describe('block rules', () => {
  const age = param('age', { type: 'number', required: false });
  const minor = rule('too_young', { kind: 'block', message: 'Too young for this session' }, { when: p('age', 'lt', 10) });

  it('fires when `when` is TRUE; not when FALSE', () => {
    const g = product({ parameters: [age], rules: [minor] });
    expect(expectStatus(run(g, { answers: { age: 8 } }), 'blocked').reasons).toEqual([
      { code: 'RULE', message: 'Too young for this session', ruleId: 'too_young' },
    ]);
    expectStatus(run(g, { answers: { age: 30 } }), 'qualified');
  });

  it('an UNKNOWN `when` asks for the missing input instead of blocking', () => {
    const g = product({ parameters: [age], rules: [minor] });
    const r = expectStatus(run(g), 'needs_input');
    expect(r.reason).toBe('rule_dependency');
    expect(r.question).toMatchObject({ kind: 'parameter', key: 'age', type: 'number' });
    expect(r.trace?.rules[0]).toMatchObject({ when: 'UNKNOWN', fired: false, unknownRefs: ['age'] });
  });

  it('unconditional block always fires; inactive rules never do', () => {
    expectStatus(run(product({ rules: [rule('off_season', { kind: 'block', message: 'Shut for the season' })] })), 'blocked');
    expectStatus(run(product({ rules: [rule('off_season', { kind: 'block', message: 'Shut for the season' }, { active: false })] })), 'qualified');
  });

  it('reports every fired block by priority, then declaration order', () => {
    const g = product({
      rules: [
        rule('b', { kind: 'block', message: 'B' }, { priority: 5 }),
        rule('c', { kind: 'block', message: 'C' }, { priority: 1 }),
        rule('a', { kind: 'block', message: 'A' }, { priority: 5 }),
      ],
    });
    expect(expectStatus(run(g), 'blocked').reasons.map((r) => r.ruleId)).toEqual(['c', 'b', 'a']);
  });

  it('a fired block beats the date question and unanswered required params', () => {
    const g = product(
      { parameters: [param('name'), age], rules: [minor] },
      { date: 'required' },
    );
    expectStatus(run(g, { answers: { age: 5 } }), 'blocked');
  });

  it('block on a selected option', () => {
    const g = product({
      optionGroups: [group('board', ['soft', 'hard'])],
      rules: [rule('nohard', { kind: 'block', message: 'No hard boards' }, { when: selected('board.hard') })],
    });
    expectStatus(run(g, { selections: { board: 'hard' } }), 'blocked');
    expectStatus(run(g, { selections: { board: 'soft' } }), 'qualified');
  });
});

// ─── Date ────────────────────────────────────────────────────────────────────

describe('date handling', () => {
  it('required date missing → date question', () => {
    const r = expectStatus(run(product({}, { date: 'required', minNoticeHours: 24 })), 'needs_input');
    expect(r.reason).toBe('date');
    expect(r.question).toEqual({ kind: 'date', key: 'date', label: 'Date', required: true, minNoticeHours: 24 });
  });

  it('optional date missing → no question', () => {
    expectStatus(run(product({}, { date: 'optional' })), 'qualified');
  });

  it('past date → DATE_IN_PAST', () => {
    const g = product({}, { date: 'required' });
    expect(expectStatus(run(g, { date: '2026-06-30' }), 'blocked').reasons[0]?.code).toBe('DATE_IN_PAST');
    expect(expectStatus(run(g, { date: '2026-07-01T11:00:00Z' }), 'blocked').reasons[0]?.code).toBe('DATE_IN_PAST');
  });

  it('date-only today is not in the past; positive min notice refuses it as too soon', () => {
    expectStatus(run(product({}, { date: 'required' }), { date: '2026-07-01' }), 'qualified');
    const r = expectStatus(run(product({}, { date: 'required', minNoticeHours: 1 }), { date: '2026-07-01' }), 'blocked');
    expect(r.reasons[0]?.code).toBe('DATE_TOO_SOON');
  });

  it('min notice', () => {
    const g = product({}, { date: 'required', minNoticeHours: 48 });
    expect(expectStatus(run(g, { date: '2026-07-02T12:00:00Z' }), 'blocked').reasons).toEqual([
      { code: 'DATE_TOO_SOON', message: "Item needs at least 48 hours' notice." },
    ]);
    expectStatus(run(g, { date: '2026-07-03T12:00:00Z' }), 'qualified');
  });

  it('derived values feed rules, summary echoes the date', () => {
    const g = product(
      { rules: [rule('weekdays', { kind: 'block', message: 'Weekdays only' }, { when: d('isWeekend', 'eq', true) })] },
      { date: 'required' },
    );
    expectStatus(run(g, { date: '2026-07-04' }), 'blocked');
    const ok = expectStatus(run(g, { date: '2026-07-06' }), 'qualified');
    expect(ok.summary.date).toBe('2026-07-06');
    expect(ok.trace?.values).toMatchObject({ weekday: 'mon', isWeekend: false, isPeak: false });
  });

  it('a rule needing a date-derived value asks for an optional date (rule_dependency)', () => {
    const scope = { rules: [rule('weekend', { kind: 'block', message: 'No' }, { when: d('isWeekend', 'eq', true) })] };
    const r = expectStatus(run(product(scope, { date: 'optional' })), 'needs_input');
    expect(r.reason).toBe('rule_dependency');
    expect(r.question).toEqual({ kind: 'date', key: 'date', label: 'Date', required: false });
    // date: none → never asked; the rule stays UNKNOWN and does not fire.
    expectStatus(run(product(scope, { date: 'none' })), 'qualified');
  });
});

// ─── Require / exclude ───────────────────────────────────────────────────────

describe('require / exclude', () => {
  const groups = [group('kit', ['helmet', 'gloves'], { label: 'Kit' }), group('extras', [{ key: 'photos', label: 'Photos' }], { label: 'Extras' })];

  it('require(option) unselected → asks its group once with requiredOption + message', () => {
    const g = product({
      optionGroups: groups,
      rules: [rule('helmets', { kind: 'require', target: { type: 'option', id: 'kit.helmet' }, message: 'Helmets are mandatory' })],
    });
    const r = expectStatus(run(g), 'needs_input');
    expect(r.reason).toBe('rule_requirement');
    expect(r.question).toMatchObject({ kind: 'choice', key: 'kit', requiredOption: 'helmet', message: 'Helmets are mandatory' });
    // The group was answered, just not with the required option: block, don't ask again.
    const b = expectStatus(run(g, { selections: { kit: 'gloves' } }), 'blocked');
    expect(b.reasons).toEqual([{ code: 'RULE', message: 'Helmets are mandatory', ruleId: 'helmets' }]);
    expectStatus(run(g, { selections: { kit: 'helmet' } }), 'qualified');
  });

  it('require default message names the target; a group target is satisfied by any selection', () => {
    const g = product({ optionGroups: groups, rules: [rule('need', { kind: 'require', target: { type: 'group', id: 'extras' } })] });
    const r = expectStatus(run(g), 'needs_input');
    expect(r.question).toMatchObject({ key: 'extras', message: 'Requires Extras' });
    expect(r.question).not.toHaveProperty('requiredOption');
    expectStatus(run(g, { selections: { extras: 'photos' } }), 'qualified');
  });

  it('require whose target group is not in scope is never asked; it blocks with the raw id', () => {
    const g = product({ rules: [rule('crew', { kind: 'require', target: { type: 'option', id: 'ops.crew' } })] });
    expect(expectStatus(run(g), 'blocked').reasons[0]?.message).toBe('Requires ops.crew');
  });

  it('an explicit empty selection answers the group: no re-ask, the require blocks', () => {
    const g = product({
      optionGroups: groups,
      rules: [rule('need', { kind: 'require', target: { type: 'group', id: 'extras' } })],
    });
    expect(askedKey(run(g))).toBe('extras');
    const r = expectStatus(run(g, { selections: { extras: [] } }), 'blocked');
    expect(r.reasons).toEqual([{ code: 'RULE', message: 'Requires Extras', ruleId: 'need' }]);
  });

  it('require only applies when `when` is TRUE', () => {
    const g = product({
      parameters: [param('rapids', { type: 'boolean', required: false })],
      optionGroups: groups,
      rules: [rule('r', { kind: 'require', target: { type: 'option', id: 'kit.helmet' } }, { when: p('rapids', 'eq', true) })],
    });
    expectStatus(run(g, { answers: { rapids: false } }), 'qualified');
    expect(askedKey(run(g))).toBe('rapids');
  });

  it('exclude fires when the target is selected (option and group targets)', () => {
    const g = product({
      optionGroups: groups,
      rules: [
        rule('x1', { kind: 'exclude', target: { type: 'option', id: 'kit.gloves' } }, { when: selected('extras.photos') }),
        rule('x2', { kind: 'exclude', target: { type: 'group', id: 'extras' }, message: 'No extras with a helmet' }, { when: selected('kit.helmet') }),
      ],
    });
    expect(expectStatus(run(g, { selections: { kit: 'gloves', extras: 'photos' } }), 'blocked').reasons).toEqual([
      { code: 'RULE', message: 'Not available with gloves', ruleId: 'x1' },
    ]);
    expect(expectStatus(run(g, { selections: { kit: 'helmet', extras: 'photos' } }), 'blocked').reasons).toEqual([
      { code: 'RULE', message: 'No extras with a helmet', ruleId: 'x2' },
    ]);
    expectStatus(run(g, { selections: { kit: 'helmet' } }), 'qualified');
  });
});

// ─── Next question ───────────────────────────────────────────────────────────

describe('next question', () => {
  it('required parameters in scope order; pendingQuestions lists the rest', () => {
    const g = product({
      parameters: [param('first'), param('second'), param('opt', { required: false })],
      optionGroups: [group('board', ['soft'], { required: true })],
    });
    const r = expectStatus(run(g), 'needs_input');
    expect(r.question.key).toBe('first');
    expect(r.reason).toBe('required');
    expect(r.trace?.questionReason).toBe('required');
    expect(r.trace?.pendingQuestions).toEqual(['second', 'board']);
    expect(askedKey(run(g, { answers: { first: 'x' } }))).toBe('second');
    expect(askedKey(run(g, { answers: { first: 'x', second: 'y' } }))).toBe('board');
    expectStatus(run(g, { answers: { first: 'x', second: 'y' }, selections: { board: 'soft' } }), 'qualified');
  });

  it('parameter question payload', () => {
    const g = product({
      parameters: [
        param('level', {
          label: 'Ability',
          description: 'How experienced?',
          type: 'select',
          options: [{ value: 'novice', label: 'Novice' }],
          default: undefined,
        }),
      ],
    });
    expect(expectStatus(run(g), 'needs_input').question).toEqual({
      kind: 'parameter',
      key: 'level',
      label: 'Ability',
      description: 'How experienced?',
      type: 'select',
      required: true,
      options: [{ value: 'novice', label: 'Novice' }],
    });
  });

  it('order: required → rule dependency → pricing fact → required choice → rule requirement', () => {
    const g = product({
      parameters: [
        param('name'),
        param('age', { type: 'number', required: false }),
        param('parking', { type: 'boolean', required: false, role: 'fact' }),
      ],
      optionGroups: [group('board', ['soft'], { required: true }), group('kit', ['helmet'])],
      rules: [
        rule('too_young', { kind: 'block', message: 'No' }, { when: p('age', 'lt', 10) }),
        rule('helmets', { kind: 'require', target: { type: 'option', id: 'kit.helmet' } }),
      ],
      adjustments: [adjustment('noparking', { type: 'fixed', amountCents: 5000 }, { when: p('parking', 'eq', false) })],
    });
    const steps: Array<[Omit<ScopeRequest, 'offering'>, string, string]> = [
      [{}, 'name', 'required'],
      [{ answers: { name: 'A' } }, 'age', 'rule_dependency'],
      [{ answers: { name: 'A', age: 30 } }, 'parking', 'pricing_fact'],
      [{ answers: { name: 'A', age: 30, parking: true } }, 'board', 'required_choice'],
      [{ answers: { name: 'A', age: 30, parking: true }, selections: { board: 'soft' } }, 'kit', 'rule_requirement'],
    ];
    for (const [req, key, reason] of steps) {
      const r = expectStatus(run(g, req), 'needs_input');
      expect([r.question.key, r.reason]).toEqual([key, reason]);
    }
    expect(expectStatus(run(g), 'needs_input').trace?.pendingQuestions).toEqual(['age', 'parking', 'board', 'kit']);
    expectStatus(run(g, { answers: { name: 'A', age: 30, parking: true }, selections: { board: 'soft', kit: 'helmet' } }), 'qualified');
  });

  it('short-circuit: decided `when`s ask nothing; only refs that can change the result are asked', () => {
    const params = [param('a', { required: false }), param('b', { type: 'number', required: false }), param('c', { required: false })];
    const or = product({ parameters: params, rules: [rule('r', { kind: 'block', message: 'x' }, { when: any(p('a', 'eq', 'no'), p('b', 'gt', 1)) })] });
    expectStatus(run(or, { answers: { a: 'yes' } }), 'needs_input'); // any(FALSE, ?) still UNKNOWN → asks b
    expect(askedKey(run(or, { answers: { a: 'yes' } }))).toBe('b');
    expectStatus(run(or, { answers: { a: 'no' } }), 'blocked'); // any(TRUE, ?) decided
    const and = product({ parameters: params, rules: [rule('r', { kind: 'block', message: 'x' }, { when: all(p('a', 'eq', 'no'), p('b', 'gt', 1)) })] });
    expectStatus(run(and, { answers: { a: 'yes' } }), 'qualified'); // all(FALSE, ?) decided
    // all(any(a TRUE, b ?), c ?) → b cannot change the result; ask c.
    const nested = product({
      parameters: params,
      rules: [rule('r', { kind: 'block', message: 'x' }, { when: all(any(p('a', 'eq', 'no'), p('b', 'gt', 1)), p('c', 'eq', 'z')) })],
    });
    expect(askedKey(run(nested, { answers: { a: 'no' } }))).toBe('c');
  });

  it('exists, selected and fact leaves never trigger asking', () => {
    const g = product({
      parameters: [param('promo', { required: false })],
      optionGroups: [group('extras', ['x'])],
      rules: [
        rule('r1', { kind: 'block', message: 'x' }, { when: all(p('promo', 'exists'), f('storm', 'eq', true)) }),
        rule('r2', { kind: 'block', message: 'y' }, { when: all(selected('extras.x'), f('storm', 'eq', true)) }),
      ],
    });
    expectStatus(run(g, { answers: { promo: 'P' }, selections: { extras: 'x' } }), 'qualified');
  });
});

// ─── Ask rules ───────────────────────────────────────────────────────────────

describe('ask', () => {
  const scope = (rules: Rule[]): Partial<OfferingScope> => ({
    parameters: [param('kind', { type: 'select', options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }, { value: 'c', label: 'C' }] }), param('detail')],
    optionGroups: [group('addon', ['x'], { required: true })],
    rules,
  });

  it('never produces a violation; gated step only asked while open', () => {
    const g = product(scope([rule('g', { kind: 'ask', target: { type: 'parameter', id: 'detail' } }, { when: p('kind', 'eq', 'a') })]));
    expect(askedKey(run(g, { answers: { kind: 'a' } }))).toBe('detail');
    expect(askedKey(run(g, { answers: { kind: 'b' } }))).toBe('addon');
    const r = expectStatus(run(g, { answers: { kind: 'b' }, selections: { addon: 'x' } }), 'qualified');
    expect(r.trace?.rules[0]).toMatchObject({ effect: 'ask', when: 'FALSE', fired: false });
    expect(expectStatus(run(g, { answers: { kind: 'a', detail: 'd' }, selections: { addon: 'x' } }), 'qualified').trace?.rules[0]).toMatchObject({ fired: true });
  });

  it('any open ask rule opens the step', () => {
    const g = product(
      scope([
        rule('g1', { kind: 'ask', target: { type: 'parameter', id: 'detail' } }, { when: p('kind', 'eq', 'a') }),
        rule('g2', { kind: 'ask', target: { type: 'parameter', id: 'detail' } }, { when: p('kind', 'eq', 'b') }),
      ]),
    );
    expect(askedKey(run(g, { answers: { kind: 'a' } }))).toBe('detail');
    expect(askedKey(run(g, { answers: { kind: 'b' } }))).toBe('detail');
    expect(askedKey(run(g, { answers: { kind: 'c' } }))).toBe('addon');
  });

  it('an UNKNOWN `when` keeps the step closed; inactive ask rules do not gate', () => {
    const g = product({
      parameters: [param('kind', { required: false }), param('detail')],
      rules: [rule('g', { kind: 'ask', target: { type: 'parameter', id: 'detail' } }, { when: p('kind', 'eq', 'a') })],
    });
    // detail (required) is gated closed; the gate's own UNKNOWN `when` asks kind.
    const r = expectStatus(run(g), 'needs_input');
    expect([r.question.key, r.reason]).toEqual(['kind', 'rule_dependency']);
    const inactive = product({
      parameters: [param('kind', { required: false }), param('detail')],
      rules: [rule('g', { kind: 'ask', target: { type: 'parameter', id: 'detail' } }, { when: p('kind', 'eq', 'a'), active: false })],
    });
    expect(askedKey(run(inactive))).toBe('detail');
  });

  it('gates option groups too', () => {
    const g = product(scope([rule('g', { kind: 'ask', target: { type: 'group', id: 'addon' } }, { when: p('kind', 'eq', 'a') })]));
    expectStatus(run(g, { answers: { kind: 'b', detail: 'd' } }), 'qualified');
    expect(askedKey(run(g, { answers: { kind: 'a', detail: 'd' } }))).toBe('addon');
  });
});

// ─── internal skip ───────────────────────────────────────────────────────────

describe('internal constructs are never asked', () => {
  it('internal required parameter', () => {
    const g = product({ parameters: [param('zone', { internal: true, default: 'z' }), param('name')] });
    expect(askedKey(run(g))).toBe('name');
    expectStatus(run(g, { answers: { name: 'n' } }), 'qualified');
  });

  it('an internal parameter referenced by an UNKNOWN rule is not asked', () => {
    const g = product({
      parameters: [param('zone', { internal: true, required: false })],
      rules: [rule('r', { kind: 'block', message: 'x' }, { when: p('zone', 'eq', 'far') })],
    });
    expectStatus(run(g), 'qualified');
  });
});

// ─── Pricing facts ───────────────────────────────────────────────────────────

describe('lazy pricing-fact asking', () => {
  const surcharge = (when: Condition) =>
    adjustment('parking', { type: 'fixed', amountCents: 2500 }, { when });

  it('asks a role:fact param an UNKNOWN adjustment needs; not once answered', () => {
    const g = product({
      parameters: [param('parking', { type: 'boolean', required: false, role: 'fact' })],
      adjustments: [surcharge(p('parking', 'eq', false))],
    });
    const r = expectStatus(run(g), 'needs_input');
    expect([r.question.key, r.reason]).toEqual(['parking', 'pricing_fact']);
    expect(expectStatus(run(g, { answers: { parking: false } }), 'qualified').quote.subtotalCents).toBe(12500);
  });

  it('non-fact params (quantity / no role) are safe-absent; internal facts never asked', () => {
    for (const extra of [{ role: 'quantity' as const }, {}, { role: 'fact' as const, internal: true }]) {
      const g = product({
        parameters: [param('floors', { type: 'number', required: false, ...extra })],
        adjustments: [surcharge(p('floors', 'gt', 2))],
      });
      expectStatus(run(g), 'qualified');
    }
  });

  it('adjustments on derived values ask nothing without a date', () => {
    const g = product({ adjustments: [surcharge(d('isWeekend', 'eq', true))] });
    expectStatus(run(g), 'qualified');
  });

  it("only selected options' adjustments count", () => {
    const g = product({
      parameters: [param('stairs', { type: 'boolean', required: false, role: 'fact' })],
      optionGroups: [
        group('delivery', [{ key: 'carry', adjustments: [adjustment('carry', { type: 'fixed', amountCents: 1000 }, { when: p('stairs', 'eq', true) })] }]),
      ],
    });
    expectStatus(run(g), 'qualified');
    expect(askedKey(run(g, { selections: { delivery: 'carry' } }))).toBe('stairs');
  });
});

// ─── choice questions ────────────────────────────────────────────────────────

describe('choice questions', () => {
  it('payload incl. price hints and min/max', () => {
    const g = product({
      parameters: [param('participants', { type: 'integer', label: 'Participants' })],
      optionGroups: [
        group(
          'extras',
          [
            { key: 'photos', label: 'Photos', description: 'Pro shots', adjustments: [adjustment('p', { type: 'fixed', amountCents: 2000 }, { kind: 'addon' })] },
            { key: 'wax', label: 'Wax' },
          ],
          { label: 'Extras', mode: 'multi', required: true, minSelections: 1, maxSelections: undefined },
        ),
      ],
    });
    const r = expectStatus(run(g, { answers: { participants: 2 } }), 'needs_input');
    expect(r.question).toEqual({
      kind: 'choice',
      key: 'extras',
      label: 'Extras',
      mode: 'multi',
      minSelections: 1,
      options: [
        { key: 'photos', label: 'Photos', description: 'Pro shots', priceHint: '+$20.00' },
        { key: 'wax', label: 'Wax' },
      ],
    });
  });

  it('a non-required group with minSelections > 0 is treated as required', () => {
    const g = product({ optionGroups: [group('extras', ['a', 'b'], { mode: 'multi', minSelections: 2 })] });
    expect(askedKey(run(g))).toBe('extras');
    expect(askedKey(run(g, { selections: { extras: 'a' } }))).toBe('extras');
    expectStatus(run(g, { selections: { extras: ['a', 'b'] } }), 'qualified');
  });
});

// ─── Pricing and the qualified outcome ───────────────────────────────────────

describe('pricing and qualified outcome', () => {
  const lesson = () =>
    product({
      parameters: [
        param('participants', { type: 'integer', role: 'quantity', label: 'Participant', min: 1 }),
        param('level', { required: false, default: 'novice' }),
        param('zone', { internal: true, default: 'north' }),
      ],
      optionGroups: [group('board', [{ key: 'hard', adjustments: [adjustment('board.hard.price', { type: 'fixed', amountCents: 1500 }, { kind: 'addon' })] }, 'soft'])],
      baseLines: [baseLine(7300, { per: 'participants', label: 'Lesson' })],
    });

  it('qualified with quote and normalized summary', () => {
    const r = expectStatus(run(lesson(), { answers: { participants: 2 }, selections: { board: 'hard' } }), 'qualified');
    expect(r.quote).toMatchObject({ currency: 'USD', subtotalCents: 16100, taxCents: 0, totalCents: 16100 });
    expect(r.quote.lines.map((l) => l.amountCents)).toEqual([14600, 1500]);
    expect(r.summary).toEqual({ answers: { participants: 2, level: 'novice' }, selections: { board: ['hard'] } });
    expect(r.trace?.values).toMatchObject({ participants: 2, level: 'novice', zone: 'north' });
  });

  it('trace: false strips the trace', () => {
    const r = evaluate(lesson(), { offering: 'item', answers: { participants: 1 } }, { now: NOW, trace: false });
    expect(r.status).toBe('qualified');
    expect(r).not.toHaveProperty('trace');
  });

  it('pricing configuration errors block with a generic message', () => {
    // Per-unit base line over an internal parameter with no value (cannot be asked).
    const g = product({ parameters: [param('hours', { type: 'number', required: false, internal: true })], baseLines: [baseLine(1000, { per: 'hours' })] });
    const r = expectStatus(run(g), 'blocked');
    expect(r.reasons).toEqual([
      { code: 'PRICING_ERROR', message: "We can't price this request automatically right now. Please contact us for a quote." },
    ]);
    expect(r.trace?.warnings[0]).toMatch(/^PRICING_ERROR: /);
  });

  it('minimum spend: decline blocks with floor + shortfall; top_up qualifies', () => {
    const decline = product({}, { minimumSpend: { amountCents: 25000, mode: 'decline' } });
    expect(expectStatus(run(decline), 'blocked').reasons).toEqual([
      { code: 'MINIMUM_SPEND', message: 'Item has a minimum spend of $250.00; this request is $150.00 short.' },
    ]);
    const topUp = product({}, { minimumSpend: { amountCents: 25000, mode: 'top_up' } });
    expect(expectStatus(run(topUp), 'qualified').quote.subtotalCents).toBe(25000);
  });
});

// ─── packages ────────────────────────────────────────────────────────────────

describe('packages evaluate their pre-flattened scope', () => {
  it("contained product's parameters and rules apply; only the package's own groups are offered", () => {
    const g = graph([
      offering('lesson', { bookable: false, scope: { parameters: [param('age', { type: 'number' })], optionGroups: [group('board', ['soft'], { required: true })] } }),
      offering('camp', {
        kind: 'package',
        contains: [{ offeringId: 'lesson', quantity: 2 }],
        scope: {
          parameters: [param('nights', { type: 'integer' }), param('age', { type: 'number', ownerOfferingId: 'lesson' })],
          optionGroups: [group('room', ['dorm'], { required: true })],
          rules: [rule('lesson.minor', { kind: 'block', message: 'Adults only' }, { when: p('age', 'lt', 18), ownerOfferingId: 'lesson' })],
          baseLines: [baseLine(5000, { offeringId: 'lesson', quantity: 2, label: 'lesson' })],
        },
      }),
    ]);
    expect(askedKey(run(g, {}, 'camp'))).toBe('nights');
    expect(askedKey(run(g, { answers: { nights: 2 } }, 'camp'))).toBe('age');
    const blocked = expectStatus(run(g, { answers: { nights: 2, age: 10 } }, 'camp'), 'blocked');
    expect(blocked.reasons).toEqual([{ code: 'RULE', message: 'Adults only', ruleId: 'lesson.minor' }]);
    expect(blocked.trace?.rules[0]?.offering).toBe('lesson');
    expect(askedKey(run(g, { answers: { nights: 2, age: 30 } }, 'camp'))).toBe('room');
    const invalid = expectStatus(run(g, { answers: { nights: 2, age: 30 }, selections: { board: 'soft' } }, 'camp'), 'invalid');
    expect(invalid.errors[0]).toMatchObject({ field: 'selections.board', code: 'UNKNOWN_FIELD' });
    const ok = expectStatus(run(g, { answers: { nights: 2, age: 30 }, selections: { room: 'dorm' } }, 'camp'), 'qualified');
    expect(ok.quote.subtotalCents).toBe(10000);
  });

  it('the same policy inherited from two contained products is reported once (trace keeps both)', () => {
    const minor = (owner: string) =>
      rule(`${owner}.minor`, { kind: 'block', message: 'Adults only' }, { when: p('age', 'lt', 18), ownerOfferingId: owner });
    const g = product({
      parameters: [param('age', { type: 'number' })],
      rules: [minor('lesson'), minor('tour'), rule('item.night', { kind: 'block', message: 'No night sessions' })],
    });
    const blocked = expectStatus(run(g, { answers: { age: 10 } }), 'blocked');
    expect(blocked.reasons).toEqual([
      { code: 'RULE', message: 'Adults only', ruleId: 'lesson.minor' },
      { code: 'RULE', message: 'No night sessions', ruleId: 'item.night' },
    ]);
    expect(blocked.trace?.rules.filter((r) => r.fired)).toHaveLength(3);
  });
});

// ─── Edge cases ──────────────────────────────────────────────────────────────

describe('edge cases', () => {
  it('a malformed condition (object operator) never fires a not-wrapped block and is not re-asked', () => {
    const malformed = { ref: 'parameter', name: 'age', op: { gte: 'gte' }, value: 12 } as unknown as Condition;
    const g = product({
      parameters: [param('age', { type: 'integer' })],
      rules: [rule('too_young', { kind: 'block', message: 'Too young for this session' }, { when: not(malformed) })],
    });
    const r = expectStatus(run(g, { answers: { age: 14 } }), 'qualified');
    expect(r.trace?.rules[0]).toMatchObject({ when: 'UNKNOWN', fired: false, unknownRefs: [] });
  });

  it('string answers over 512 chars are INVALID_VALUE (padding cannot slip past matches)', () => {
    const g = product({
      parameters: [param('notes')],
      rules: [rule('weapons', { kind: 'block', message: 'No weapons' }, { when: p('notes', 'matches', 'firearm|rifle') })],
    });
    const r = expectStatus(run(g, { answers: { notes: 'firearm' + ' '.repeat(506) } }), 'invalid');
    expect(r.errors).toEqual([{ field: 'answers.notes', code: 'INVALID_VALUE', message: 'notes must be at most 512 characters' }]);
    expectStatus(run(g, { answers: { notes: 'firearm' + ' '.repeat(505) } }), 'blocked');
    expectStatus(run(g, { answers: { notes: 'a rifle' } }), 'blocked');
  });

  it('parameter patterns with groups / alternation are answerable', () => {
    const g = product({ parameters: [param('rsvp', { pattern: '^(yes|no)$' })] });
    expectStatus(run(g, { answers: { rsvp: 'yes' } }), 'qualified');
    expect(expectStatus(run(g, { answers: { rsvp: 'maybe' } }), 'invalid').errors[0]?.message).toBe('rsvp does not match the required pattern');
  });

  it("season is 'none' when no season matches, so 'only in summer' blocks", () => {
    const g = product(
      { rules: [rule('summer_only', { kind: 'block', message: 'Summer only' }, { when: not(d('season', 'eq', 'summer')) })] },
      { date: 'required' },
    );
    g.business.seasons = [{ name: 'summer', kind: 'peak', from: '06-01', to: '08-31' }];
    const r = expectStatus(run(g, { date: '2026-12-01' }), 'blocked');
    expect(r.reasons).toEqual([{ code: 'RULE', message: 'Summer only', ruleId: 'summer_only' }]);
    expectStatus(run(g, { date: '2027-07-01' }), 'qualified');
  });

  it('a buyer answer can never stand in for a declared fact', () => {
    const g = product({
      parameters: [param('verified_member', { type: 'boolean', required: false })],
      rules: [rule('members', { kind: 'block', message: 'Members only' }, { when: f('verified_member', 'neq', true) })],
    });
    g.business.facts = { verified_member: { name: 'verified_member', type: 'boolean', required: true } };
    expect(expectStatus(run(g, { answers: { verified_member: true } }), 'blocked').reasons[0]?.code).toBe('FACTS_UNAVAILABLE');
    const forged = expectStatus(run(g, { answers: { verified_member: true }, facts: { verified_member: false } }), 'blocked');
    expect(forged.reasons[0]).toMatchObject({ code: 'RULE', ruleId: 'members' });
    const ok = expectStatus(run(g, { answers: { verified_member: false }, facts: { verified_member: true } }), 'qualified');
    expect(ok.summary.answers).toEqual({});
  });

  it('selections for a group behind a closed ask rule are dropped (and not priced)', () => {
    const g = product({
      parameters: [param('is_student', { type: 'boolean' })],
      optionGroups: [
        group('student_discount', [
          { key: 'yes', adjustments: [adjustment('student', { type: 'percent', rateMicros: 200_000, basis: 'running' }, { kind: 'discount', order: 200 })] },
        ]),
      ],
      rules: [rule('g', { kind: 'ask', target: { type: 'group', id: 'student_discount' } }, { when: p('is_student', 'eq', true) })],
    });
    const dropped = expectStatus(run(g, { answers: { is_student: false }, selections: { student_discount: 'yes' } }), 'qualified');
    expect(dropped.quote.totalCents).toBe(10000);
    expect(dropped.summary.selections).toEqual({});
    expect(dropped.trace?.warnings).toEqual(['Ignored selection "student_discount": that choice does not apply (closed gate).']);
    const kept = expectStatus(run(g, { answers: { is_student: true }, selections: { student_discount: 'yes' } }), 'qualified');
    expect(kept.quote.totalCents).toBe(8000);
  });

  it('dropping answers to closed steps repeats until stable; dropped answers fall back to defaults', () => {
    const g = product({
      parameters: [
        param('has_group', { type: 'boolean' }),
        param('group_size', { type: 'integer', required: false, default: 1 }),
        param('bus_note', { required: false }),
      ],
      rules: [
        rule('g1', { kind: 'ask', target: { type: 'parameter', id: 'group_size' } }, { when: p('has_group', 'eq', true) }),
        rule('g2', { kind: 'ask', target: { type: 'parameter', id: 'bus_note' } }, { when: p('group_size', 'gt', 10) }),
      ],
    });
    const r = expectStatus(run(g, { answers: { has_group: false, group_size: 20, bus_note: 'big bus' } }), 'qualified');
    expect(r.summary.answers).toEqual({ has_group: false, group_size: 1 });
    expect(r.trace?.warnings).toEqual([
      'Ignored answer "group_size": that question does not apply (closed gate).',
      'Ignored answer "bus_note": that question does not apply (closed gate).',
    ]);
    const open = expectStatus(run(g, { answers: { has_group: true, group_size: 20, bus_note: 'big bus' } }), 'qualified');
    expect(open.trace?.warnings).toEqual([]);
  });

  it('a date-derived adjustment condition asks for an optional date (pricing_fact)', () => {
    const g = product(
      { adjustments: [adjustment('weekend', { type: 'fixed', amountCents: 5000 }, { when: d('isWeekend', 'eq', true) })] },
      { date: 'optional' },
    );
    const r = expectStatus(run(g), 'needs_input');
    expect([r.question.kind, r.reason]).toEqual(['date', 'pricing_fact']);
    expect(expectStatus(run(g, { date: '2026-07-04' }), 'qualified').quote.totalCents).toBe(15000);
    expect(expectStatus(run(g, { date: '2026-07-06' }), 'qualified').quote.totalCents).toBe(10000);
    expectStatus(run(product({ adjustments: [adjustment('weekend', { type: 'fixed', amountCents: 5000 }, { when: d('isWeekend', 'eq', true) })] })), 'qualified');
  });

  it('missing optional price-line inputs are asked (pricing_input)', () => {
    const g = product({
      parameters: [param('added_hours', { type: 'integer', required: false, min: 0 })],
      adjustments: [adjustment('hours', { type: 'per_unit', amountCents: 2000, per: 'added_hours' }, { kind: 'addon', order: 100 })],
    });
    const r = expectStatus(run(g), 'needs_input');
    expect([r.question.key, r.reason]).toEqual(['added_hours', 'pricing_input']);
    expect(expectStatus(run(g, { answers: { added_hours: 2 } }), 'qualified').quote.totalCents).toBe(14000);
  });

  it('a base-line quantity behind a closed ask rule is still asked and its answer kept', () => {
    const g = product({
      parameters: [param('mode'), param('guests', { type: 'integer', min: 1 })],
      rules: [rule('g', { kind: 'ask', target: { type: 'parameter', id: 'guests' } }, { when: p('mode', 'eq', 'group') })],
      baseLines: [baseLine(1000, { per: 'guests' })],
    });
    const r = expectStatus(run(g, { answers: { mode: 'solo' } }), 'needs_input');
    expect([r.question.key, r.reason]).toEqual(['guests', 'pricing_input']);
    const ok = expectStatus(run(g, { answers: { mode: 'solo', guests: 3 } }), 'qualified');
    expect(ok.quote.totalCents).toBe(3000);
    expect(ok.trace?.warnings).toEqual([]);
  });

  it('inputs of adjustments whose when is FALSE are not asked', () => {
    const g = product({
      parameters: [param('rush', { type: 'boolean' }), param('added_hours', { type: 'integer', required: false, min: 0 })],
      adjustments: [adjustment('hours', { type: 'per_unit', amountCents: 2000, per: 'added_hours' }, { when: p('rush', 'eq', true) })],
    });
    expectStatus(run(g, { answers: { rush: false } }), 'qualified');
    expect(askedKey(run(g, { answers: { rush: true } }))).toBe('added_hours');
  });

  it('multiselect eq means contains in pricing conditions', () => {
    const g = product({
      parameters: [
        param('dietary', { type: 'multiselect', required: false, options: [{ value: 'vegan', label: 'Vegan' }, { value: 'halal', label: 'Halal' }] }),
      ],
      adjustments: [adjustment('vegan', { type: 'fixed', amountCents: 500 }, { when: p('dietary', 'eq', 'vegan') })],
    });
    expect(expectStatus(run(g, { answers: { dietary: ['halal', 'vegan'] } }), 'qualified').quote.totalCents).toBe(10500);
    expect(expectStatus(run(g, { answers: { dietary: ['halal'] } }), 'qualified').quote.totalCents).toBe(10000);
  });

  it('dates before 1900 or after 9999 are INVALID_DATE', () => {
    const g = product({}, { date: 'optional' });
    expect(expectStatus(run(g, { date: '0099-01-01' }), 'invalid').errors[0]?.code).toBe('INVALID_DATE');
    expect(expectStatus(run(g, { date: '1899-12-31T10:00:00Z' }), 'invalid').errors[0]?.code).toBe('INVALID_DATE');
  });
});

describe('compiled-catalog behaviour', () => {
  it('per-unit base lines report the per value as quantity, so amount = unit × quantity', async () => {
    const g = await fixtureGraph({ lesson: 'name: Lesson\ndescription: A lesson.\nprice: { amount: 73, per: participants }\nask:\n  participants: { type: integer, min: 1, max: 6 }\n' });
    const result = evaluate(g, { offering: 'lesson', answers: { participants: 2 } }, { now: NOW });
    if (result.status !== 'qualified') throw new Error(result.status);
    for (const line of result.quote.lines) {
      if (line.unitAmountCents !== undefined && line.quantity !== undefined) expect(line.unitAmountCents * line.quantity).toBe(line.amountCents);
    }
    expect(result.quote.lines[0]).toMatchObject({ amountCents: 14600, quantity: 2, unitAmountCents: 7300 });
  });

  it('a missing required fact blocks with a generic FACTS_UNAVAILABLE that never names the fact', async () => {
    const g = await fixtureGraph(
      { tour: 'name: Tour\ndescription: A tour.\nprice: 10\nrules:\n  - { when: { secret_capacity: { lt: 1 } }, block: Full. }\n' },
      `${MINIMAL_BUSINESS_YAML}facts:\n  secret_capacity: { type: number, required: true }\n`,
    );
    const result = evaluate(g, { offering: 'tour' }, { now: NOW, trace: false });
    expect(result).toMatchObject({ status: 'blocked', reasons: [{ code: 'FACTS_UNAVAILABLE' }] });
    expect(JSON.stringify(result)).not.toContain('secret_capacity');
  });

  it('time conditions treat HH:MM and HH:MM:SS as the same time', async () => {
    const g = await fixtureGraph({
      dinner: `name: Dinner
description: Dinner.
price: 10
ask:
  start: { type: time }
rules:
  - { when: { start: { gte: "17:00:00" } }, block: Evenings are booked. }
`,
    });
    expect(evaluate(g, { offering: 'dinner', answers: { start: '17:00' } }, { now: NOW })).toMatchObject({ status: 'blocked' });
    expect(evaluate(g, { offering: 'dinner', answers: { start: '16:59' } }, { now: NOW }).status).not.toBe('blocked');
  });
});

describe('qualified addOns', () => {
  const LESSON = `name: Lesson
description: A lesson.
price: 80
ask:
  wetsuit: { type: boolean, default: false }
choose:
  extras:
    mode: multi
    options:
      photos: { price: 25 }
      snacks: {}
  wetsuit_size:
    options: [s, m]
  level:
    required: true
    options: [novice, improver]
rules:
  - { when: { wetsuit: true }, ask: wetsuit_size }
`;

  it('lists optional groups with price hints, never required groups or ones gated closed', async () => {
    const g = await fixtureGraph({ lesson: LESSON });
    const result = evaluate(g, { offering: 'lesson', selections: { level: 'novice' } }, { now: NOW });
    expect(result).toMatchObject({
      status: 'qualified',
      addOns: [{ key: 'extras', label: 'Extras', mode: 'multi', options: [{ key: 'photos', priceHint: '+$25.00' }, { key: 'snacks' }] }],
    });
  });

  it('drops options already chosen and omits the field when nothing is left to add', async () => {
    const g = await fixtureGraph({ lesson: LESSON });
    const some = evaluate(g, { offering: 'lesson', selections: { level: 'novice', extras: ['photos'] } }, { now: NOW });
    expect(some.status === 'qualified' && some.addOns?.[0]?.options.map((o) => o.key)).toEqual(['snacks']);
    const none = evaluate(g, { offering: 'lesson', answers: { wetsuit: true }, selections: { level: 'novice', extras: ['photos', 'snacks'], wetsuit_size: 's' } }, { now: NOW });
    expect(none.status).toBe('qualified');
    expect(none).not.toHaveProperty('addOns');
  });
});
