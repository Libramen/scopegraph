import { describe, expect, it } from 'vitest';
import type { Graph } from '../graph/types.js';
import { compileCatalog, formatDiagnostic, loadGraph } from './index.js';
import type { Diagnostic } from './diagnostics.js';
import { loadCatalog } from './load.js';
import {
  BUSINESS_YAML,
  happyCatalog,
  loadFixtureCatalog,
  removeFixture,
  writeFixture,
} from './testkit.js';

async function compileFiles(
  files: Record<string, string>,
): Promise<{ graph?: Graph; diagnostics: Diagnostic[] }> {
  const dir = await writeFixture(files);
  try {
    return compileCatalog(await loadCatalog(dir));
  } finally {
    await removeFixture(dir);
  }
}

async function errorsOf(files: Record<string, string>) {
  const { diagnostics } = await compileFiles(files);
  return diagnostics.filter((d) => d.severity === 'error');
}

const PRODUCT = 'name: Widget\nprice: 12.50\n';

describe('compileCatalog — happy path', () => {
  it('compiles the surf catalog into the expected graph shape', async () => {
    const { graph, diagnostics } = await compileFiles(happyCatalog());
    expect(diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    expect(graph).toBeDefined();

    // Business: taxRate% → millionths, seasons normalized, facts passthrough.
    const business = graph!.business;
    expect(business.name).toBe('Kelp Point Surf School');
    expect(business.currency).toBe('USD');
    expect(business.timezone).toBe('America/Halifax');
    expect(business.taxRateMicros).toBe(62500);
    expect(business.facts['swell_ft']).toEqual({
      name: 'swell_ft',
      type: 'number',
      description: 'Swell height in feet right now.',
      required: false,
    });
    expect(business.seasons).toEqual([
      { name: 'high_season', kind: 'peak', from: '07-01', to: '09-15' },
      { name: 'weekend_days', kind: 'custom', days: [6, 0] },
    ]);
    expect(business.handoff?.url).toBe('https://bookings.kelppoint.example/{offering}?{params}');

    // Offerings keyed by id in file-name order.
    expect(Object.keys(graph!.offerings)).toEqual([
      'surf-camp',
      'surf-lesson',
      'wetsuit-loan',
    ]);

    // Product: money → cents, humanized labels, option defaults, rules, pricing.
    const lesson = graph!.offerings['surf-lesson']!;
    expect(lesson.scope.baseLines).toEqual([
      {
        offeringId: 'surf-lesson',
        label: 'Surf Lesson',
        amountCents: 7800,
        quantity: 1,
        taxable: true,
      },
    ]);
    expect(lesson.scope.parameters.map((p) => [p.name, p.label, p.required])).toEqual([
      ['participants', 'Participants', true],
      ['ability', 'Ability', true],
    ]);
    expect(lesson.scope.parameters[0]).toMatchObject({
      type: 'integer',
      min: 1,
      max: 6,
      default: 1,
      role: 'quantity',
      internal: false,
      ownerOfferingId: 'surf-lesson',
    });
    expect(lesson.scope.parameters[1]!.options).toEqual([
      { value: 'novice', label: 'novice' },
      { value: 'improver', label: 'improver' },
    ]);

    const extras = lesson.scope.optionGroups[0]!;
    expect(extras).toMatchObject({
      key: 'extras',
      label: 'Extras',
      mode: 'multi',
      required: false,
      minSelections: 1,
      maxSelections: 2,
    });
    expect(extras.options[0]).toMatchObject({
      id: 'extras.softboard',
      key: 'softboard',
      label: 'Softboard',
    });
    // Option price sugar → addon adjustments.
    expect(extras.options[0]!.adjustments).toEqual([
      {
        id: 'surf-lesson.extras.softboard.price',
        label: 'Softboard',
        kind: 'addon',
        method: { type: 'fixed', amountCents: 1800 },
        taxable: true,
        order: 100,
        ownerOfferingId: 'surf-lesson',
        ownerOptionId: 'extras.softboard',
      },
    ]);
    expect(extras.options[1]!.adjustments[0]).toMatchObject({
      id: 'surf-lesson.extras.pickup.price',
      method: { type: 'per_unit', amountCents: 1200, per: 'participants' },
      taxable: false,
    });

    // Rules: author id preserved, defaults rule<N>, canonical effects.
    expect(lesson.scope.rules.map((r) => r.id)).toEqual([
      'surf-lesson.no_big_swell_novices',
      'surf-lesson.rule2',
      'surf-lesson.rule3',
    ]);
    expect(lesson.scope.rules[0]!.when).toEqual({
      op: 'all',
      conditions: [
        { ref: 'parameter', name: 'ability', op: 'eq', value: 'novice' },
        { ref: 'fact', name: 'swell_ft', op: 'gte', value: 6 },
      ],
    });
    expect(lesson.scope.rules[1]!.effect).toEqual({
      kind: 'require',
      target: { type: 'option', id: 'extras.softboard' },
      message: 'Groups of four or more need softboards.',
    });
    expect(lesson.scope.rules[2]!.effect).toEqual({
      kind: 'ask',
      target: { type: 'parameter', id: 'participants' },
    });
    expect(lesson.scope.rules[2]!.when).toEqual({
      op: 'not',
      conditions: [
        { ref: 'option', name: 'extras.pickup', op: 'selected' },
      ],
    });
    expect(lesson.scope.rules[1]).toMatchObject({ priority: 0, active: true });

    // Pricing: per-unit discount, default order by kind.
    expect(lesson.scope.adjustments).toEqual([
      {
        id: 'surf-lesson.crew_discount',
        label: 'Crew discount',
        kind: 'discount',
        method: { type: 'per_unit', amountCents: 400, per: 'participants' },
        when: { ref: 'parameter', name: 'participants', op: 'gt', value: 3 },
        taxable: true,
        order: 200,
        ownerOfferingId: 'surf-lesson',
      },
    ]);
    expect(lesson.minimumSpend).toEqual({ amountCents: 6000, mode: 'decline' });
    expect(lesson.date).toBe('required');
    expect(lesson.minNoticeHours).toBe(18);

    // Per-unit product base.
    const wetsuit = graph!.offerings['wetsuit-loan']!;
    expect(wetsuit.bookable).toBe(false);
    expect(wetsuit.scope.baseLines).toEqual([
      {
        offeringId: 'wetsuit-loan',
        label: 'Wetsuit Loan',
        amountCents: 1400,
        per: 'days',
        quantity: 1,
        taxable: true,
      },
    ]);

    // Package: flattened scope, own groups only, bundle discount.
    const camp = graph!.offerings['surf-camp']!;
    expect(camp.kind).toBe('package');
    expect(camp.contains).toEqual([
      { offeringId: 'surf-lesson', quantity: 1 },
      { offeringId: 'wetsuit-loan', quantity: 2 },
    ]);
    expect(camp.scope.parameters.map((p) => p.name)).toEqual([
      'lodging',
      'participants',
      'ability',
      'days',
    ]);
    expect(camp.scope.optionGroups.map((g) => g.key)).toEqual(['cover', 'extras']);
    // own rule first (resolved against the flattened scope), then contained.
    expect(camp.scope.rules.map((r) => r.id)).toEqual([
      'surf-camp.rule1',
      'surf-lesson.no_big_swell_novices',
      'surf-lesson.rule2',
      'surf-lesson.rule3',
    ]);
    expect(camp.scope.rules[0]!.when).toEqual({
      ref: 'parameter',
      name: 'lodging',
      op: 'eq',
      value: 'cabin',
    });
    expect(camp.scope.adjustments.map((a) => a.id)).toEqual([
      'surf-lesson.crew_discount',
    ]);
    expect(camp.scope.baseLines).toEqual([
      {
        offeringId: 'surf-lesson',
        label: 'Surf Lesson',
        amountCents: 7800,
        quantity: 1,
        taxable: true,
      },
      {
        offeringId: 'wetsuit-loan',
        label: 'Wetsuit Loan',
        amountCents: 1400,
        per: 'days',
        quantity: 2,
        taxable: true,
      },
    ]);
    expect(camp.scope.bundleDiscount).toEqual({ type: 'percent', rateMicros: 120000 });
    expect(camp.scope.inactiveContents).toEqual([]);
  });

  it('returns no graph when any error diagnostic exists', async () => {
    const { graph, diagnostics } = await compileFiles({
      'business.yaml': BUSINESS_YAML,
      'offerings/p.yaml': PRODUCT + 'ask:\n  q:\n    type: string\n    unknown_key: 1\n',
    });
    expect(graph).toBeUndefined();
    expect(diagnostics.some((d) => d.severity === 'error')).toBe(true);
  });
});

describe('compileCatalog — schema and load errors', () => {
  it('maps zod issues to positioned SCHEMA diagnostics', async () => {
    const errors = await errorsOf({
      'business.yaml': BUSINESS_YAML,
      'offerings/p.yaml': [
        'name: P',
        'price: 10',
        'ask:',
        '  n:',
        '    type: integer',
        '    min: oops',
      ].join('\n'),
    });
    expect(errors).toContainEqual(
      expect.objectContaining({
        code: 'SCHEMA',
        severity: 'error',
        file: 'offerings/p.yaml',
        path: ['ask', 'n', 'min'],
        line: 6,
      }),
    );
  });

  it('skips cross-referencing when business.yaml fails schema', async () => {
    const errors = await errorsOf({
      'business.yaml': 'name: B\ncurrency: 5\n',
      'offerings/p.yaml': PRODUCT,
    });
    expect(errors.some((d) => d.code === 'SCHEMA' && d.file === 'business.yaml')).toBe(true);
  });

  it('rejects reserved parameter and fact names (RESERVED_NAME)', async () => {
    const errors = await errorsOf({
      'business.yaml': BUSINESS_YAML,
      'offerings/p.yaml': PRODUCT + 'ask:\n  date:\n    type: string\n',
    });
    expect(errors).toContainEqual(
      expect.objectContaining({
        code: 'RESERVED_NAME',
        path: ['ask', 'date'],
      }),
    );
    const factErrors = await errorsOf({
      'business.yaml': 'name: B\nfacts:\n  season:\n    type: boolean\n',
      'offerings/p.yaml': PRODUCT,
    });
    expect(factErrors).toContainEqual(
      expect.objectContaining({ code: 'RESERVED_NAME', path: ['facts', 'season'] }),
    );
  });

  it('forbids parameter/fact name collisions (NAME_COLLISION)', async () => {
    const errors = await errorsOf({
      'business.yaml': 'name: B\nfacts:\n  swell_ft:\n    type: number\n',
      'offerings/p.yaml': PRODUCT + 'ask:\n  swell_ft:\n    type: number\n',
    });
    expect(errors).toContainEqual(
      expect.objectContaining({
        code: 'NAME_COLLISION',
        path: ['ask', 'swell_ft'],
      }),
    );
  });

  it('rejects invalid timezones (INVALID_TIMEZONE)', async () => {
    const errors = await errorsOf({
      'business.yaml': 'name: B\ntimezone: Mars/Olympus\n',
      'offerings/p.yaml': PRODUCT,
    });
    expect(errors).toContainEqual(
      expect.objectContaining({
        code: 'INVALID_TIMEZONE',
        path: ['timezone'],
        hint: expect.stringContaining('IANA'),
      }),
    );
  });

  it('handoff.url must be an absolute http(s) URL after placeholder fill (INVALID_HANDOFF)', async () => {
    for (const url of ['javascript:alert(1)//{total}', 'data:text/html,{params}', '{business}/book?{params}', '/book/{offering}']) {
      const errors = await errorsOf({
        'business.yaml': `name: B\ntimezone: UTC\nhandoff:\n  url: '${url}'\n`,
        'offerings/p.yaml': PRODUCT,
      });
      expect(errors, url).toContainEqual(expect.objectContaining({ code: 'INVALID_HANDOFF', path: ['handoff', 'url'] }));
    }
    for (const url of ['https://book.example.com/{offering}?total={total}&{params}', 'http://localhost:8080/?b={business}']) {
      const errors = await errorsOf({
        'business.yaml': `name: B\ntimezone: UTC\nhandoff:\n  url: '${url}'\n`,
        'offerings/p.yaml': PRODUCT,
      });
      expect(errors, url).toEqual([]);
    }
  });

  it('handoff.url host must be literal (no placeholder in scheme, host or port)', async () => {
    for (const url of ['https://{params}/', 'https://{offering}.example.com/', 'https://book.example.com{params}/x', 'https://book.example.com:80{total_cents}/']) {
      const errors = await errorsOf({
        'business.yaml': `name: B\ntimezone: UTC\nhandoff:\n  url: '${url}'\n`,
        'offerings/p.yaml': PRODUCT,
      });
      expect(errors, url).toContainEqual(expect.objectContaining({ code: 'INVALID_HANDOFF', path: ['handoff', 'url'] }));
    }
    const errors = await errorsOf({
      'business.yaml': "name: B\ntimezone: UTC\nhandoff:\n  url: 'https://user@book.example.com:8443/{offering}/{business}#{params}'\n",
      'offerings/p.yaml': PRODUCT,
    });
    expect(errors).toEqual([]);
  });

  it('validates seasons (INVALID_SEASON)', async () => {
    const cases: Array<[season: string, path: (string | number)[]]> = [
      ['{ name: s1, kind: peak, from: 2026-02-30, to: 2026-03-01 }', ['seasons', 0, 'from']],
      ['{ name: s2, kind: peak, from: 2026-06-01, to: 2026-05-01 }', ['seasons', 0, 'from']],
      ['{ name: none, kind: peak, from: 05-15, to: 09-30 }', ['seasons', 0]],
    ];
    for (const [season, path] of cases) {
      const errors = await errorsOf({
        'business.yaml': `name: B\nseasons:\n  - ${season}\n`,
        'offerings/p.yaml': PRODUCT,
      });
      expect(errors, season).toContainEqual(
        expect.objectContaining({ code: 'INVALID_SEASON', path }),
      );
    }
  });
});

describe('compileCatalog — parameters, groups, rules, pricing', () => {
  const BASE = { 'business.yaml': BUSINESS_YAML };

  it('requires options for select/multiselect and rejects them elsewhere', async () => {
    const errors = await errorsOf({
      ...BASE,
      'offerings/p.yaml':
        PRODUCT +
        'ask:\n  level:\n    type: select\n  free:\n    type: string\n    options: [a]\n',
    });
    const codes = errors.filter((d) => d.code === 'INVALID_PARAMETER');
    expect(codes).toContainEqual(
      expect.objectContaining({ path: ['ask', 'level', 'options'] }),
    );
    expect(codes).toContainEqual(
      expect.objectContaining({ path: ['ask', 'free', 'options'] }),
    );
  });

  it('validates defaults against the parameter type and options', async () => {
    const errors = await errorsOf({
      ...BASE,
      'offerings/p.yaml':
        PRODUCT +
        [
          'ask:',
          '  level:',
          '    type: select',
          '    options: [a, b]',
          '    default: c',
          '  count:',
          '    type: integer',
          '    min: 1',
          '    default: 0',
          '  hidden:',
          '    type: string',
          '    internal: true',
        ].join('\n'),
    });
    expect(errors).toContainEqual(
      expect.objectContaining({ code: 'INVALID_PARAMETER', path: ['ask', 'level', 'default'] }),
    );
    expect(errors).toContainEqual(
      expect.objectContaining({ code: 'INVALID_PARAMETER', path: ['ask', 'count', 'default'] }),
    );
    expect(errors).toContainEqual(
      expect.objectContaining({ code: 'INVALID_PARAMETER', path: ['ask', 'hidden', 'internal'] }),
    );
  });

  it('rejects min > max and unusable (non-RE2) patterns', async () => {
    const errors = await errorsOf({
      ...BASE,
      'offerings/p.yaml':
        PRODUCT +
        [
          'ask:',
          '  count:',
          '    type: integer',
          '    min: 10',
          '    max: 2',
          '  promo:',
          '    type: string',
          "    pattern: '(a)\\1'",
        ].join('\n'),
    });
    expect(errors).toContainEqual(
      expect.objectContaining({ code: 'INVALID_PARAMETER', path: ['ask', 'count', 'min'] }),
    );
    expect(errors).toContainEqual(
      expect.objectContaining({
        code: 'INVALID_PARAMETER',
        path: ['ask', 'promo', 'pattern'],
        message: expect.stringContaining('invalid escape sequence: `\\1`'),
        hint: expect.stringContaining('RE2'),
      }),
    );
  });

  it('validates option groups (single max, min ≤ options)', async () => {
    const errors = await errorsOf({
      ...BASE,
      'offerings/p.yaml':
        PRODUCT +
        [
          'choose:',
          '  size:',
          '    mode: single',
          '    max: 2',
          '    options: [s, m]',
          '  addons:',
          '    mode: multi',
          '    min: 3',
          '    options: [a, b]',
          '  shape:',
          '    mode: single',
          '    min: 2',
          '    options: [x, y]',
        ].join('\n'),
    });
    const group = errors.filter((d) => d.code === 'INVALID_OPTION_GROUP');
    expect(group).toContainEqual(expect.objectContaining({ path: ['choose', 'size', 'max'] }));
    expect(group).toContainEqual(expect.objectContaining({ path: ['choose', 'addons', 'min'] }));
    expect(group).toContainEqual(expect.objectContaining({ path: ['choose', 'shape', 'min'] }));
  });

  it('validates rules (exactly one effect, message placement, targets)', async () => {
    const errors = await errorsOf({
      ...BASE,
      'offerings/p.yaml':
        PRODUCT +
        [
          'rules:',
          '  - block: no',
          '    require: size',
          '  - block: no',
          '    message: extra',
          '  - require: nope',
          'choose:',
          '  size:',
          '    options: [s]',
        ].join('\n'),
    });
    const ruleErrors = errors.filter((d) => d.code === 'INVALID_RULE');
    expect(ruleErrors).toContainEqual(
      expect.objectContaining({ path: ['rules', 0] }),
    );
    expect(ruleErrors).toContainEqual(
      expect.objectContaining({ path: ['rules', 1, 'message'] }),
    );
    expect(errors).toContainEqual(
      expect.objectContaining({
        code: 'UNKNOWN_REFERENCE',
        path: ['rules', 2, 'require'],
        hint: expect.stringContaining('size'),
      }),
    );
  });

  it('rejects duplicate rule and pricing ids (DUPLICATE_ID)', async () => {
    const errors = await errorsOf({
      ...BASE,
      'offerings/p.yaml':
        PRODUCT +
        [
          'rules:',
          '  - id: same',
          '    block: a',
          '  - id: same',
          '    block: b',
        ].join('\n'),
    });
    expect(errors).toContainEqual(
      expect.objectContaining({
        code: 'DUPLICATE_ID',
        path: ['rules', 1, 'id'],
      }),
    );
  });

  it('validates pricing method combinations (INVALID_PRICING)', async () => {
    const errors = await errorsOf({
      ...BASE,
      'offerings/p.yaml':
        PRODUCT +
        [
          'pricing:',
          '  - label: both',
          '    kind: surcharge',
          '    amount: 1',
          '    percent: 10',
          '  - label: basis',
          '    kind: discount',
          '    amount: 1',
          '    basis: base',
        ].join('\n'),
    });
    const pricing = errors.filter((d) => d.code === 'INVALID_PRICING');
    expect(pricing).toContainEqual(expect.objectContaining({ path: ['pricing', 0] }));
    expect(pricing).toContainEqual(expect.objectContaining({ path: ['pricing', 1, 'basis'] }));
  });

  it('accepts a flat object price ({ amount } without per)', async () => {
    const { graph, diagnostics } = await compileFiles({
      ...BASE,
      'offerings/p.yaml': 'name: P\nprice: { amount: 64 }\n',
    });
    expect(diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    expect(graph?.offerings['p']?.scope.baseLines).toEqual([
      {
        offeringId: 'p',
        label: 'P',
        amountCents: 6400,
        quantity: 1,
        taxable: true,
      },
    ]);
  });

  it('compiles option pricing entries with option-scoped ids and validation', async () => {
    const { graph, diagnostics } = await compileFiles({
      ...BASE,
      'offerings/p.yaml': [
        'name: P',
        'price: 10',
        'ask:',
        '  paddlers:',
        '    type: integer',
        '    min: 1',
        'choose:',
        '  boats:',
        '    options:',
        '      tandem:',
        '        pricing:',
          '          - label: Tandem discount',
          '            kind: discount',
          '            per: paddlers',
          '            amount: 5',
      ].join('\n'),
    });
    expect(diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    const option = graph?.offerings['p']?.scope.optionGroups[0]?.options[0];
    expect(option?.adjustments).toEqual([
      {
        id: 'p.boats.tandem.pricing1',
        label: 'Tandem discount',
        kind: 'discount',
        method: { type: 'per_unit', amountCents: 500, per: 'paddlers' },
        taxable: true,
        order: 200,
        ownerOfferingId: 'p',
        ownerOptionId: 'boats.tandem',
      },
    ]);

    // semantic validation applies: unknown per is an error, not a silent drop
    const bad = await errorsOf({
      ...BASE,
      'offerings/p.yaml': [
        'name: P',
        'price: 10',
        'choose:',
        '  boats:',
        '    options:',
        '      tandem:',
        '        pricing:',
        '          - label: Tandem discount',
        '            kind: discount',
        '            per: crew',
        '            amount: 5',
      ].join('\n'),
    });
    expect(bad).toContainEqual(
      expect.objectContaining({
        code: 'UNKNOWN_REFERENCE',
        path: ['choose', 'boats', 'options', 'tandem', 'pricing', 0, 'per'],
      }),
    );
  });

  it('maps union failures to actionable SCHEMA messages', async () => {
    const errors = await errorsOf({
      ...BASE,
      'offerings/p.yaml': 'name: P\nprice: { ammount: 64 }\n',
    });
    expect(errors).toContainEqual(
      expect.objectContaining({
        code: 'SCHEMA',
        path: ['price'],
        message: expect.stringContaining(
          'price must be a number (e.g. 64) or an object { amount: 64, per: <parameter> }',
        ),
      }),
    );
    // closest-attempt hint points at the typo
    expect(errors).toContainEqual(
      expect.objectContaining({
        code: 'SCHEMA',
        hint: expect.stringContaining('ammount'),
      }),
    );
  });

  it('requires a price on products and validates per/formula quantity rules', async () => {
    const noPrice = await errorsOf({
      ...BASE,
      'offerings/p.yaml': 'name: Free?\n',
    });
    expect(noPrice).toContainEqual(
      expect.objectContaining({ code: 'INVALID_PRICING', path: ['price'] }),
    );

    // base per needs min > 0
    const basePer = await errorsOf({
      ...BASE,
      'offerings/p.yaml':
        'name: P\nprice: { amount: 10, per: guests }\nask:\n  guests:\n    type: integer\n    min: 0\n',
    });
    expect(basePer).toContainEqual(
      expect.objectContaining({
        code: 'INVALID_PRICING',
        path: ['price', 'per'],
        hint: expect.stringContaining('min: 1'),
      }),
    );

    // adjustment per needs min ≥ 0
    const adjPer = await errorsOf({
      ...BASE,
      'offerings/p.yaml':
        PRODUCT +
        'ask:\n  guests:\n    type: integer\npricing:\n  - label: per person\n    kind: surcharge\n    amount: 3\n    per: guests\n',
    });
    expect(adjPer).toContainEqual(
      expect.objectContaining({
        code: 'INVALID_PRICING',
        path: ['pricing', 0, 'per'],
        hint: expect.stringContaining('min: 0'),
      }),
    );

    // formula deps must be numeric and declare min ≥ 0
    const formula = await errorsOf({
      ...BASE,
      'offerings/p.yaml':
        PRODUCT +
        [
          'ask:',
          '  hours:',
          '    type: integer',
          '    min: 0',
          '  level:',
          '    type: select',
          '    options: [a]',
          'pricing:',
          '  - label: calc',
          '    kind: fee',
          '    formula: hours * 10 + level',
        ].join('\n'),
    });
    expect(formula).toContainEqual(
      expect.objectContaining({
        code: 'INVALID_PRICING',
        path: ['pricing', 0, 'formula'],
        message: expect.stringContaining('level'),
      }),
    );
    const badFormula = await errorsOf({
      ...BASE,
      'offerings/p.yaml':
        PRODUCT + 'ask:\n  hours:\n    type: integer\n    min: 0\npricing:\n  - label: calc\n    kind: fee\n    formula: hours ** 2\n',
    });
    expect(badFormula).toContainEqual(
      expect.objectContaining({
        code: 'INVALID_PRICING',
        path: ['pricing', 0, 'formula'],
        message: expect.stringContaining('formula does not parse'),
      }),
    );
  });

  it('validates tiers: overlap is an error, gaps warn', async () => {
    const errors = await errorsOf({
      ...BASE,
      'offerings/p.yaml':
        PRODUCT +
        [
          'ask:',
          '  hours:',
          '    type: integer',
          '    min: 0',
          'pricing:',
          '  - label: tiers',
          '    kind: surcharge',
          '    per: hours',
          '    tiers:',
          '      - from: 0',
          '        to: 4',
          '        amount: 10',
          '      - from: 2',
          '        to: 8',
          '        amount: 8',
        ].join('\n'),
    });
    expect(errors).toContainEqual(
      expect.objectContaining({ code: 'INVALID_PRICING', path: ['pricing', 0, 'tiers', 1, 'from'] }),
    );
    const { diagnostics } = await compileFiles({
      ...BASE,
      'offerings/p.yaml':
        PRODUCT +
        [
          'ask:',
          '  hours:',
          '    type: integer',
          '    min: 0',
          'pricing:',
          '  - label: tiers',
          '    kind: surcharge',
          '    per: hours',
          '    tiers:',
          '      - from: 1',
          '        to: 4',
          '        amount: 10',
          '      - from: 6',
          '        amount: 8',
        ].join('\n'),
    });
    expect(diagnostics).toContainEqual(
      expect.objectContaining({
        severity: 'warning',
        code: 'INVALID_PRICING',
        message: expect.stringContaining('5'),
      }),
    );
  });
});

describe('compileCatalog — packages', () => {
  const BASE = { 'business.yaml': BUSINESS_YAML };

  it('validates contains (self, missing, packages, duplicates)', async () => {
    const cases: Array<[contains: string, path: (string | number)[]]> = [
      ['[pkg]', ['contains', 0]],
      ['[ghost]', ['contains', 0]],
      ['[p, p]', ['contains', 1]],
    ];
    for (const [contains, path] of cases) {
      const errors = await errorsOf({
        ...BASE,
        'offerings/p.yaml': PRODUCT,
        'offerings/pkg.yaml': `name: PKG\nkind: package\ncontains: ${contains}\ndiscount: { amount: 1 }\n`,
      });
      expect(errors, contains).toContainEqual(
        expect.objectContaining({ path }),
      );
    }
  });

  it('rejects contains/discount on products (INVALID_PACKAGE)', async () => {
    const errors = await errorsOf({
      ...BASE,
      'offerings/p.yaml': PRODUCT + 'contains: [q]\n',
      'offerings/q.yaml': PRODUCT,
    });
    expect(errors).toContainEqual(
      expect.objectContaining({ code: 'INVALID_PACKAGE', path: ['contains'] }),
    );
  });

  it('reports differing flattened parameters at both locations (PARAMETER_CONFLICT)', async () => {
    const errors = await errorsOf({
      ...BASE,
      'offerings/a.yaml':
        'name: A\nprice: 10\nask:\n  participants:\n    type: integer\n    min: 1\n    max: 8\n    default: 1\n',
      'offerings/pkg.yaml':
        'name: PKG\nkind: package\ncontains: [a]\ndiscount: { amount: 1 }\nask:\n  participants:\n    type: integer\n    min: 1\n    max: 4\n    default: 1\n',
    });
    const conflicts = errors.filter((d) => d.code === 'PARAMETER_CONFLICT');
    expect(conflicts.map((d) => d.file).sort()).toEqual([
      'offerings/a.yaml',
      'offerings/pkg.yaml',
    ]);
    expect(conflicts.every((d) => d.path.join('.') === 'ask.participants')).toBe(true);
  });

  it('merges identical parameters silently', async () => {
    const participants =
      'ask:\n  participants:\n    type: integer\n    min: 1\n    max: 6\n    default: 1\n';
    const { graph, diagnostics } = await compileFiles({
      ...BASE,
      'offerings/a.yaml': `name: A\nprice: 10\n${participants}`,
      'offerings/b.yaml': `name: B\nprice: 5\n${participants}`,
      'offerings/pkg.yaml': `name: PKG\nkind: package\ncontains: [a, b]\ndiscount: { amount: 2 }\n`,
    });
    expect(diagnostics.filter((d) => d.code === 'PARAMETER_CONFLICT')).toEqual([]);
    const scope = graph?.offerings['pkg']?.scope;
    expect(scope?.parameters.filter((p) => p.name === 'participants')).toHaveLength(1);
  });

  it('reports contained option references the package cannot offer (PACKAGE_OPTION_REF)', async () => {
    const errors = await errorsOf({
      ...BASE,
      'offerings/a.yaml':
        PRODUCT +
        'choose:\n  extras:\n    options: [x]\nrules:\n  - require: extras.x\n',
      'offerings/pkg.yaml': 'name: PKG\nkind: package\ncontains: [a]\ndiscount: { amount: 1 }\n',
    });
    expect(errors).toContainEqual(
      expect.objectContaining({
        code: 'PACKAGE_OPTION_REF',
        file: 'offerings/a.yaml',
        path: ['rules', 0],
        hint: expect.stringContaining("its own 'extras' option group"),
      }),
    );
  });

  it('tracks inactive contents and multiplies base line quantities', async () => {
    const { graph } = await compileFiles({
      ...BASE,
      'offerings/a.yaml': PRODUCT,
      'offerings/b.yaml': 'name: B\nprice: 7\nstatus: paused\n',
      'offerings/pkg.yaml':
        'name: PKG\nkind: package\ncontains:\n  - { offering: a, quantity: 3 }\n  - b\n',
    });
    const scope = graph?.offerings['pkg']?.scope;
    expect(scope?.inactiveContents).toEqual(['b']);
    expect(scope?.baseLines).toEqual([
      expect.objectContaining({ offeringId: 'a', amountCents: 1250, quantity: 3 }),
      expect.objectContaining({ offeringId: 'b', amountCents: 700, quantity: 1 }),
    ]);
  });
});

describe('formatDiagnostic', () => {
  it('renders file:line:col severity CODE message (hint: …)', () => {
    expect(
      formatDiagnostic({
        severity: 'error',
        code: 'INVALID_TIMEZONE',
        message: "timezone 'Mars' is not valid",
        file: 'business.yaml',
        path: ['timezone'],
        line: 3,
        column: 12,
        hint: 'use an IANA name',
      }),
    ).toBe(
      "business.yaml:3:12 error INVALID_TIMEZONE timezone 'Mars' is not valid (hint: use an IANA name)",
    );
    expect(
      formatDiagnostic({ severity: 'warning', code: 'UNUSED_FACT', message: 'x', path: [] }),
    ).toBe('warning UNUSED_FACT x');
  });
});

describe('loadGraph', () => {
  it('sorts diagnostics errors first, then by file and line', async () => {
    const dir = await writeFixture({
      'business.yaml': 'name: B\ntimezone: Bad/Zone\n',
      'offerings/p.yaml': PRODUCT + 'ask:\n  n:\n    type: string\n    min: oops\n',
      'offerings/q.yaml': PRODUCT,
    });
    try {
      const { graph, diagnostics } = await loadGraph(dir);
      expect(graph).toBeUndefined();
      expect(diagnostics.length).toBeGreaterThan(1);
      const severities = diagnostics.map((d) => d.severity);
      expect(severities).toEqual([...severities].sort((a, b) => (a === b ? 0 : a === 'error' ? -1 : 1)));
      const files = diagnostics.map((d) => d.file ?? '');
      expect(files).toEqual([...files].sort());
    } finally {
      await removeFixture(dir);
    }
  });
});

describe('currency, internal per-unit and number-tier checks', () => {
  it('rejects currencies without exactly two minor units (UNSUPPORTED_CURRENCY)', async () => {
    for (const currency of ['JPY', 'KWD']) {
      const { graph, diagnostics } = await loadFixtureCatalog(
        { tour: 'name: Tour\ndescription: A tour.\nprice: 1000\n' },
        `name: X\ncurrency: ${currency}\ntimezone: UTC\n`,
      );
      expect(graph).toBeUndefined();
      expect(diagnostics.find((d) => d.code === 'UNSUPPORTED_CURRENCY')?.message).toBe(
        `currency '${currency}' is not supported yet: catalog money is compiled to 1/100 units, so only two-decimal currencies (USD, EUR, GBP, …) price correctly`,
      );
    }
  });

  it('rejects per-unit pricing on an internal parameter (its quantity would show on the quote)', async () => {
    const { graph, diagnostics } = await loadFixtureCatalog({
      crew: `name: Crew
description: A crew.
price: { amount: 50, per: crew_size }
ask:
  crew_size: { type: integer, min: 1, default: 2, internal: true }
`,
    });
    expect(graph).toBeUndefined();
    expect(diagnostics.some((d) => d.code === 'INVALID_PRICING' && d.message.includes("'crew_size' is internal; per-unit lines show their quantity on the quote"))).toBe(true);
  });

  it('warns that tiers on a number parameter leave fractional gaps', async () => {
    const { diagnostics } = await loadFixtureCatalog({
      boat: `name: Boat
description: A boat.
price: 0
ask:
  hours: { type: number, min: 0, max: 7 }
pricing:
  - { label: Hours, kind: addon, per: hours, tiers: [{ from: 0, to: 3, amount: 10 }, { from: 4, to: 7, amount: 8 }] }
`,
    });
    expect(diagnostics.some((d) => d.severity === 'warning' && d.message.includes("'hours' is a number parameter: no tier covers values between 3 and 4"))).toBe(true);
  });
});

describe('business disclosure', () => {
  it('defaults to progressive, accepts menu and rejects anything else', async () => {
    const offerings = { tour: 'name: Tour\ndescription: A tour.\nprice: 10\n' };
    expect((await loadFixtureCatalog(offerings)).graph?.business.disclosure).toBe('progressive');
    expect((await loadFixtureCatalog(offerings, 'name: X\ndisclosure: menu\n')).graph?.business.disclosure).toBe('menu');
    const bad = await loadFixtureCatalog(offerings, 'name: X\ndisclosure: everything\n');
    expect(bad.graph).toBeUndefined();
    expect(bad.diagnostics.some((d) => d.severity === 'error' && d.path?.includes('disclosure'))).toBe(true);
  });
});
