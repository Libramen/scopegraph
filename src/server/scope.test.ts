/**
 * The shared scope pipeline (`runScope`): what the facts hook may see, and what
 * a public (untraced) result carries under each `disclosure`.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Graph } from '../graph/types.js';
import { MINIMAL_BUSINESS_YAML, fixtureGraph } from '../compile/testkit.js';
import { baseLine, f, graph as engineGraph, offering, p, param, rule } from '../engine/testing.js';
import { getFacts } from '../extend/facts.js';
import type { ScopePayments } from '../payments/index.js';
import { runScope } from './scope.js';

vi.mock('../extend/facts.js', () => ({ getFacts: vi.fn(async () => ({})) }));

describe('runScope', () => {
  const facts = vi.mocked(getFacts);
  beforeEach(() => facts.mockClear());

  it('calls getFacts only for listed offerings, and passes the date only when it parses', async () => {
    const graph = await fixtureGraph({ tour: 'name: Tour\ndescription: A tour.\nprice: 10\ndate: optional\n' });
    await runScope(graph, '../../x', { date: '2026-08-01' }, false);
    await runScope(graph, '__proto__', {}, false);
    expect(facts).not.toHaveBeenCalled();
    await runScope(graph, 'tour', { date: "'; drop table t; --" }, false);
    expect(facts.mock.calls[0]![0]).toEqual({ offering: 'tour', business: graph.business });
    await runScope(graph, 'tour', { date: '2027-08-01' }, false);
    expect(facts.mock.calls[1]![0]).toMatchObject({ offering: 'tour', date: '2027-08-01' });
  });

  it('exposes blocked.reasons[].ruleId only when tracing is on', async () => {
    const graph = await fixtureGraph({ tour: 'name: Tour\ndescription: A tour.\nprice: 10\nrules:\n  - { id: always, block: No. }\n' });
    const hidden = await runScope(graph, 'tour', {}, false);
    const shown = await runScope(graph, 'tour', {}, true);
    expect(hidden.status === 'blocked' && hidden.reasons[0]).not.toHaveProperty('ruleId');
    expect(shown.status === 'blocked' && shown.reasons[0]).toMatchObject({ ruleId: 'tour.always' });
  });

  it('folded YAML descriptions reach buyers without a trailing newline', async () => {
    const graph = await fixtureGraph(
      { tour: 'name: Tour\ndescription: >\n  A tour\n  of the bay.\nprice: 10\n' },
      `${MINIMAL_BUSINESS_YAML}description: >\n  We run tours.\n`,
    );
    expect(graph.business.description).toBe('We run tours.');
    expect(graph.offerings['tour']?.description).toBe('A tour of the bay.');
  });

  describe('disclosure', () => {
    // `meal` is asked only for hard tours; `level` and `meal` have defaults.
    const TOUR = `name: Tour
description: A tour.
price: { amount: 10, per: guests }
ask:
  guests:
    type: integer
    min: 1
    max: 8
    role: quantity
  level:
    type: select
    options: [easy, hard]
    default: easy
  meal:
    type: select
    options: [veg, meat]
    default: veg
choose:
  extras:
    mode: multi
    max: 1
    options:
      photos:
        price: 5
      snacks:
        price: 3
rules:
  - when: { level: hard }
    ask: meal
`;
    const BUSINESS = `${MINIMAL_BUSINESS_YAML}handoff:\n  url: https://book.example.com/{offering}?{params}\n`;
    let progressive: Graph;
    let menu: Graph;
    beforeEach(async () => {
      progressive = await fixtureGraph({ tour: TOUR }, BUSINESS);
      menu = await fixtureGraph({ tour: TOUR }, `${BUSINESS}disclosure: menu\n`);
    });

    it('progressive: only the next question\'s invalid value is reported, with its detail; menu reports all', async () => {
      const input = { answers: { guests: 20, level: 'zzz' }, selections: { extras: ['zzz'] } };
      const buyer = await runScope(progressive, 'tour', input, false);
      expect(buyer.status === 'invalid' && buyer.errors).toEqual([
        { field: 'answers.guests', code: 'INVALID_VALUE', message: 'Invalid answer for "Guests": must be at most 8.' },
      ]);
      const owner = await runScope(menu, 'tour', input, false);
      expect(owner.status === 'invalid' && owner.errors.map((e) => e.message)).toEqual([
        'Guests must be at most 8',
        'Level must be one of these values: easy, hard',
        '"zzz" is not an option of Extras. Options: photos, snacks.',
      ]);
      // `extras` is optional and never asked, but open: a buyer's invalid pick is reported before
      // pricing instead of being dropped from a payable quote.
      const tooMany = { answers: { guests: 2 }, selections: { extras: ['photos', 'snacks'] } };
      const buyerTooMany = await runScope(progressive, 'tour', tooMany, true);
      expect(buyerTooMany.status === 'invalid' && buyerTooMany.errors).toEqual([
        { field: 'selections.extras', code: 'TOO_MANY_SELECTIONS', message: 'Too many options selected for "Extras": pick one.' },
      ]);
      const ownerTooMany = await runScope(menu, 'tour', tooMany, false);
      expect(ownerTooMany.status === 'invalid' && ownerTooMany.errors[0]?.message).toBe('Extras takes at most 1 choice.');
    });

    it('progressive reports an unknown option next to valid ones instead of quoting without it', async () => {
      const createQuote = vi.fn<ScopePayments['createQuote']>(async () => undefined);
      const payments: ScopePayments = { createQuote, checkoutGuidance: () => '' };
      const input = { answers: { guests: 2 }, selections: { extras: ['photos', 'zzz'] } };
      const buyer = await runScope(progressive, 'tour', input, false, payments);
      expect(buyer.status === 'invalid' && buyer.errors.map((e) => [e.field, e.code])).toEqual([['selections.extras', 'UNKNOWN_OPTION']]);
      expect(createQuote).not.toHaveBeenCalled();
    });

    it('progressive: an over-limit answer is never quoted at a default; `{}` junk only surfaces for open steps', async () => {
      const createQuote = vi.fn<ScopePayments['createQuote']>(async () => undefined);
      const payments: ScopePayments = { createQuote, checkoutGuidance: () => '' };
      const junk = { answers: { guests: {}, level: {}, meal: {}, nope: {} } as never, selections: { extras: ['zzz'], nada: ['x'] } };
      const probed = await runScope(progressive, 'tour', junk, false, payments);
      expect(probed.status === 'invalid' && probed.errors.map((e) => e.field)).toEqual(['answers.guests']);
      // With `guests` valid, the open `level` and `extras` are reported; the gated `meal` and unknown names stay silent.
      const rest = await runScope(progressive, 'tour', { ...junk, answers: { ...(junk.answers as object), guests: 2 } as never }, false, payments);
      expect(rest.status === 'invalid' && rest.errors.map((e) => e.field)).toEqual(['answers.level', 'selections.extras']);
      const gatedOnly = await runScope(progressive, 'tour', { answers: { guests: 2, meal: {} as never }, selections: { nada: ['x'] } }, false, payments);
      expect(gatedOnly.status === 'qualified' && gatedOnly.summary).toEqual({ answers: { guests: 2 }, selections: {} });
      expect(createQuote).toHaveBeenCalledTimes(1);
    });

    it('EXPOSE_TRACE hides fact names, internal names and pricing failures from buyers', async () => {
      const tour = offering('tour', {
        scope: {
          parameters: [param('hours', { type: 'number', required: false, internal: true })],
          baseLines: [baseLine(1000, { per: 'hours' })],
          rules: [
            rule('r1', { kind: 'block', message: 'Too rough.' }, { when: f('tide_ft', 'gt', 3) }),
            rule('r2', { kind: 'block', message: 'Too long.' }, { when: p('hours', 'gt', 8) }),
          ],
        },
      });
      const facts = { tide_ft: { name: 'tide_ft', type: 'number' as const, required: false } };
      // Unknown fact and internal refs, then a pricing failure on the internal parameter.
      const priced = await runScope(engineGraph([tour], { facts }), 'tour', {}, true);
      expect(priced.status === 'blocked' && priced.reasons[0]?.code).toBe('PRICING_ERROR');
      // A required fact the hook did not supply.
      const required = { ...facts, storm: { name: 'storm', type: 'boolean' as const, required: true } };
      const missing = await runScope(engineGraph([tour], { facts: required }), 'tour', {}, true);
      expect(missing.status === 'blocked' && missing.reasons[0]?.code).toBe('FACTS_UNAVAILABLE');
      for (const result of [priced, missing]) {
        const text = JSON.stringify(result.trace);
        for (const name of ['tide_ft', 'storm', 'hours']) expect(text).not.toContain(name);
        expect(result.trace?.warnings).toEqual([]);
      }
      expect(priced.trace?.rules.map((r) => r.unknownRefs)).toEqual([[], []]);
    });

    it('progressive ignores unknown answer and selection names (trace warning); menu rejects them as UNKNOWN_FIELD', async () => {
      const input = { answers: { guests: 2, vip_code: 'x' }, selections: { upgrades: 'y' } };
      const buyer = await runScope(progressive, 'tour', input, true);
      expect(buyer.status).toBe('qualified');
      expect(buyer.trace?.warnings).toEqual([
        'Ignored answer "vip_code": not a question for this offering.',
        'Ignored selection "upgrades": not a choice for this offering.',
      ]);
      const owner = await runScope(menu, 'tour', input, false);
      expect(owner.status === 'invalid' && owner.errors.map((e) => [e.field, e.code])).toEqual([
        ['answers.vip_code', 'UNKNOWN_FIELD'],
        ['selections.upgrades', 'UNKNOWN_FIELD'],
      ]);
    });

    it('progressive summary.answers (and the hand-off) echo only applicable buyer answers; the stored quote gets the full request', async () => {
      const createQuote = vi.fn<ScopePayments['createQuote']>(async () => undefined);
      const payments: ScopePayments = { createQuote, checkoutGuidance: () => '' };
      // `meal` is dropped: its gate (level: hard) is closed.
      const input = { answers: { guests: 2, meal: 'meat' }, selections: { extras: 'photos' } };
      const full = { answers: { guests: 2, level: 'easy', meal: 'veg' }, selections: { extras: ['photos'] } };

      const buyer = await runScope(progressive, 'tour', input, false, payments);
      expect(buyer.status === 'qualified' && buyer.summary).toEqual({ answers: { guests: 2 }, selections: { extras: ['photos'] } });
      expect(buyer).not.toHaveProperty('request');
      expect(buyer.next?.url).toBe('https://book.example.com/tour?guests=2&extras=photos');
      expect(createQuote).toHaveBeenLastCalledWith('tour', full, expect.objectContaining({ totalCents: 2500 }), undefined);

      const owner = await runScope(menu, 'tour', input, false, payments);
      expect(owner.status === 'qualified' && owner.summary).toEqual(full);
      expect(owner).not.toHaveProperty('request');
      expect(createQuote).toHaveBeenLastCalledWith('tour', full, expect.anything(), undefined);
    });

    it('needs_input.reason only when tracing is on', async () => {
      const hidden = await runScope(progressive, 'tour', {}, false);
      expect(hidden.status).toBe('needs_input');
      expect(hidden).not.toHaveProperty('reason');
      const shown = await runScope(progressive, 'tour', {}, true);
      expect(shown).toMatchObject({ status: 'needs_input', reason: 'required' });
    });
  });
});
