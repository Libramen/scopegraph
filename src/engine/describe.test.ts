import { describe, expect, it } from 'vitest';
import { describeOffering, listOfferings } from './describe.js';
import { adjustment, baseLine, graph, group, offering, param } from './testing.js';
import { MINIMAL_BUSINESS_YAML, fixtureGraph } from '../compile/testkit.js';

const g = graph([
  offering('surf-lesson', {
    name: 'Surf Lesson',
    description: 'Two hours on the water with a coach.',
    category: 'Lessons',
    keywords: ['surfing', 'novice'],
    date: 'required',
    minNoticeHours: 24,
    scope: {
      parameters: [
        param('participants', { type: 'integer', label: 'Participant', role: 'quantity', min: 1 }),
        param('zone', { internal: true, default: 'north' }),
      ],
      optionGroups: [
        group('board', [{ key: 'hard', label: 'Hard board', adjustments: [adjustment('h', { type: 'fixed', amountCents: 1500 }, { kind: 'addon' })] }, 'soft'], {
          label: 'Board',
          required: true,
        }),
      ],
      baseLines: [baseLine(7300, { per: 'participants' })],
    },
  }),
  offering('yoga', { name: 'Beach Yoga', keywords: ['stretch'], scope: { baseLines: [baseLine(2000)] } }),
  offering('component', { name: 'Surf Wax', bookable: false }),
  offering('old', { name: 'Old surf tour', status: 'archived' }),
  offering('retreat', {
    kind: 'package',
    name: 'Surf Retreat',
    contains: [
      { offeringId: 'surf-lesson', quantity: 2 },
      { offeringId: 'yoga', quantity: 1 },
    ],
    scope: {
      parameters: [param('participants', { type: 'integer', label: 'Guest', ownerOfferingId: 'surf-lesson' })],
      baseLines: [
        baseLine(7300, { offeringId: 'surf-lesson', per: 'participants', quantity: 2 }),
        baseLine(2000, { offeringId: 'yoga' }),
      ],
      bundleDiscount: { type: 'percent', rateMicros: 100_000 },
    },
  }),
]);

describe('listOfferings', () => {
  it('active + bookable only, catalog order', () => {
    expect(listOfferings(g).map((o) => o.id)).toEqual(['surf-lesson', 'yoga', 'retreat']);
  });

  it('summary shape with priceFrom', () => {
    expect(listOfferings(g)[0]).toEqual({
      id: 'surf-lesson',
      kind: 'product',
      name: 'Surf Lesson',
      description: 'Two hours on the water with a coach.',
      category: 'Lessons',
      keywords: ['surfing', 'novice'],
      priceFrom: '$73.00 × participants',
    });
    expect(listOfferings(g)[1]?.priceFrom).toBe('$20.00');
    // Mixed fixed + per-unit parts, percent bundle discount applied to each.
    expect(listOfferings(g)[2]?.priceFrom).toBe('$18.00 + $131.40 × participants');
  });

  it('query: case-insensitive over name / description / keywords / category, best match first', () => {
    expect(listOfferings(g, 'SURF').map((o) => o.id)).toEqual(['surf-lesson', 'retreat']);
    expect(listOfferings(g, 'lessons').map((o) => o.id)).toEqual(['surf-lesson']); // category, stem
    expect(listOfferings(g, 'stretch').map((o) => o.id)).toEqual(['yoga']);
    expect(listOfferings(g, 'coach').map((o) => o.id)).toEqual(['surf-lesson']);
    expect(listOfferings(g, 'beach retreat').map((o) => o.id)).toEqual(['yoga', 'retreat']);
    expect(listOfferings(g, 'surf retreat').map((o) => o.id)).toEqual(['retreat', 'surf-lesson']);
    expect(listOfferings(g, 'wax')).toEqual([]); // not bookable
    expect(listOfferings(g, '   ').length).toBe(3);
  });
});

describe('describeOffering', () => {
  it('buyer-facing description; internal parameters omitted', () => {
    expect(describeOffering(g, 'surf-lesson')).toEqual({
      id: 'surf-lesson',
      kind: 'product',
      name: 'Surf Lesson',
      description: 'Two hours on the water with a coach.',
      category: 'Lessons',
      keywords: ['surfing', 'novice'],
      priceFrom: '$73.00 × participants',
      currency: 'USD',
      timezone: 'UTC',
      date: 'required',
      minNoticeHours: 24,
      questions: [{ kind: 'parameter', key: 'participants', label: 'Participant', type: 'integer', required: true, min: 1 }],
      choices: [
        {
          kind: 'choice',
          key: 'board',
          label: 'Board',
          mode: 'single',
          minSelections: 1,
          maxSelections: 1,
          options: [
            { key: 'hard', label: 'Hard board', priceHint: '+$15.00' },
            { key: 'soft', label: 'soft' },
          ],
        },
      ],
    });
  });

  it('packages list their contents', () => {
    expect(describeOffering(g, 'retreat')?.contains).toEqual([
      { offering: 'surf-lesson', name: 'Surf Lesson', quantity: 2 },
      { offering: 'yoga', name: 'Beach Yoga', quantity: 1 },
    ]);
  });

  it('undefined for missing, unlisted or prototype keys', () => {
    expect(describeOffering(g, 'nope')).toBeUndefined();
    expect(describeOffering(g, 'component')).toBeUndefined();
    expect(describeOffering(g, 'old')).toBeUndefined();
    expect(describeOffering(g, 'constructor')).toBeUndefined();
  });
});

describe('describe_offering from compiled catalogs', () => {
  it('never shows a price hint for conditional option pricing', async () => {
    const g = await fixtureGraph({
      lesson: `name: Lesson
description: A lesson.
price: 100
choose:
  rate:
    options:
      member:
        pricing:
          - { label: Member rate, kind: discount, amount: 30, when: { vip_member: true } }
      wetsuit:
        price: 15
`,
    }, `${MINIMAL_BUSINESS_YAML}facts:\n  vip_member: { type: boolean }\n`);
    const options = describeOffering(g, 'lesson')!.choices[0]!.options;
    expect(options.find((o) => o.key === 'member')!.priceHint).toBeUndefined();
    expect(options.find((o) => o.key === 'wetsuit')!.priceHint).toBe('+$15.00');
  });

  it('priceFrom adds the cheapest required choice and never undercuts a minimum spend', async () => {
    const g = await fixtureGraph({
      clean: `name: Clean
description: House cleaning.
price: 0
choose:
  size:
    required: true
    options:
      small: { price: 100 }
      large: { price: 200 }
`,
      dinner: `name: Dinner
description: Private dinner.
price: { amount: 50, per: guests }
ask:
  guests: { type: integer, min: 2, max: 20 }
minimumSpend: { amount: 400, mode: top_up }
`,
    });
    const from = Object.fromEntries(listOfferings(g).map((s) => [s.id, s.priceFrom]));
    expect(from.clean).toBe('$100.00');
    expect(from.dinner).toBe('$400.00');
  });

  it('marks questions behind an `ask` rule as conditional', async () => {
    const g = await fixtureGraph({
      surf: `name: Surf
description: Surf lesson.
price: 80
ask:
  wetsuit: { type: boolean, default: false }
  wetsuit_size: { type: select, options: [s, m, l] }
rules:
  - { when: { wetsuit: true }, ask: wetsuit_size }
`,
    });
    const questions = describeOffering(g, 'surf')!.questions;
    expect(questions.find((q) => q.key === 'wetsuit_size')).toMatchObject({ conditional: true });
    expect(questions.find((q) => q.key === 'wetsuit')).not.toHaveProperty('conditional');
  });
});
