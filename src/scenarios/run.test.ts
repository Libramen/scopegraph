import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Evaluate, EvaluateOptions, Quote, ScopeRequest, ScopeResult } from '../engine/types.js';
import { evaluate as realEvaluate } from '../engine/index.js';
import { adjustment, baseLine, d, graph, group, offering, p, param, rule } from '../engine/testing.js';
import { DEFAULT_NOW } from './schema.js';
import type { Scenario } from './schema.js';
import { listScenarioFiles, runScenario, runScenarioFiles } from './run.js';

// ─── Fixture graph (real engine) ─────────────────────────────────────────────

const tour = offering('tour', {
  name: 'Guided Tour',
  date: 'none',
  scope: {
    parameters: [
      param('participants', { type: 'number', required: true, min: 1, max: 20 }),
      param('size', {
        type: 'select',
        required: false,
        options: [
          { value: 's', label: 'Small' },
          { value: 'l', label: 'Large' },
        ],
      }),
    ],
    optionGroups: [
      group(
        'extras',
        [
          {
            key: 'linen',
            adjustments: [
              adjustment(
                'tour.extras.linen.price',
                { type: 'fixed', amountCents: 1500 },
                { kind: 'addon', label: 'Linen service' },
              ),
            ],
          },
          { key: 'towels' },
        ],
        { mode: 'multi', required: false },
      ),
    ],
    rules: [
      rule(
        'tour.big_needs_linen',
        { kind: 'require', target: { type: 'option', id: 'extras.linen' } },
        { when: p('participants', 'gt', 10) },
      ),
    ],
    baseLines: [baseLine(8500, { per: 'participants', label: 'Guided tour' })],
    adjustments: [],
  },
});


// `weekday` reference makes the engine ask for a date first, so this
// offering exists separately from the date-less `tour`.
const sundayTour = offering('sunday-tour', {
  name: 'Sunday Tour',
  date: 'optional',
  scope: {
    parameters: [],
    optionGroups: [],
    rules: [
      rule(
        'sunday-tour.no_sunday',
        { kind: 'block', message: 'closed on Sundays' },
        { when: d('weekday', 'eq', 'sun') },
      ),
    ],
    baseLines: [baseLine(5000)],
    adjustments: [],
  },
});

const fixtureGraph = graph([tour, sundayTour]);

// ─── Stub plumbing ───────────────────────────────────────────────────────────

function stubEvaluate(resultFor: (request: ScopeRequest, options?: EvaluateOptions) => ScopeResult): {
  evaluate: Evaluate;
  calls: Array<{ request: ScopeRequest; now?: Date }>;
} {
  const calls: Array<{ request: ScopeRequest; now?: Date }> = [];
  const evaluate: Evaluate = (_graph, request, options) => {
    calls.push({ request, now: options?.now });
    return resultFor(request, options);
  };
  return { evaluate, calls };
}

function quoteOf(lines: Array<{ id: string; label: string; amountCents: number }>): Quote {
  const subtotalCents = lines.reduce((sum, line) => sum + line.amountCents, 0);
  return {
    currency: 'USD',
    lines: lines.map((line) => ({
      id: line.id,
      label: line.label,
      kind: 'base' as const,
      amountCents: line.amountCents,
      taxable: true,
      source: { offering: 'tour' },
    })),
    subtotalCents,
    taxCents: 0,
    totalCents: subtotalCents,
  };
}

function qualified(quote: Quote): ScopeResult {
  return {
    status: 'qualified',
    offering: 'tour',
    quote,
    summary: { answers: {}, selections: {} },
  };
}

// ─── Temp files ──────────────────────────────────────────────────────────────

const dirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'scopegraph-scenarios-'));
  dirs.push(dir);
  return dir;
}

const writeYaml = (path: string, content: string) => writeFile(path, content, 'utf8');

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

// ─── runScenario against the real engine ─────────────────────────────────────

describe('runScenario (real engine)', () => {
  const scenario = (
    overrides: Partial<Omit<Scenario, 'expect'>> & { expect: Scenario['expect'] },
  ): Scenario => ({
    name: 'case',
    offering: 'tour',
    ...overrides,
  });

  it('matches a qualified quote with money in major units', () => {
    const outcome = runScenario(
      fixtureGraph,
      {
        name: 'ten guests with linen',
        offering: 'tour',
        answers: { participants: 10 },
        selections: { extras: 'linen' },
        expect: {
          status: 'qualified',
          total: 865,
          subtotal: 865,
          tax: 0,
          lines: [
            { label: 'Guided tour', amount: 850 },
            { label: 'Linen service', amount: 15 },
          ],
        },
      },
      realEvaluate,
    );
    expect(outcome.mismatches).toEqual([]);
    expect(outcome.ok).toBe(true);
  });

  it('reports money mismatches in major units with two decimals', () => {
    const outcome = runScenario(
      fixtureGraph,
      {
        name: 'wrong total',
        offering: 'tour',
        answers: { participants: 10 },
        expect: { status: 'qualified', total: 900 },
      },
      realEvaluate,
    );
    expect(outcome.ok).toBe(false);
    expect(outcome.mismatches).toContain('expected total 900.00, got 850.00');
  });

  it('matches asks for needs_input', () => {
    const outcome = runScenario(
      fixtureGraph,
      scenario({ expect: { status: 'needs_input', asks: 'participants' } }),
      realEvaluate,
    );
    expect(outcome.ok).toBe(true);
    expect(outcome.result?.status).toBe('needs_input');
  });

  it('matches a rule block by rule id suffix and by message substring', () => {
    const outcome = runScenario(
      fixtureGraph,
      {
        name: 'sunday',
        offering: 'sunday-tour',
        date: '2026-07-05',
        expect: { status: 'blocked', rule: 'no_sunday', reason: 'closed on sundays' },
      },
      realEvaluate,
    );
    expect(outcome.mismatches).toEqual([]);
  });

  it('matches a require violation by full rule id', () => {
    const outcome = runScenario(
      fixtureGraph,
      {
        name: 'big group needs linen',
        offering: 'tour',
        answers: { participants: 11 },
        selections: { extras: 'towels' },
        expect: { status: 'blocked', rule: 'tour.big_needs_linen' },
      },
      realEvaluate,
    );
    expect(outcome.mismatches).toEqual([]);
  });

  it('matches invalid fields by bare name and prefixed name', () => {
    for (const error of ['nope', 'answers.nope']) {
      const outcome = runScenario(
        fixtureGraph,
        scenario({ answers: { nope: 1 }, expect: { status: 'invalid', error } }),
        realEvaluate,
      );
      expect(outcome.mismatches, `error: ${error}`).toEqual([]);
    }
  });

  it('matches unavailable for an unknown offering', () => {
    const outcome = runScenario(
      fixtureGraph,
      scenario({ offering: 'ghost', expect: { status: 'unavailable' } }),
      realEvaluate,
    );
    expect(outcome.ok).toBe(true);
    expect(outcome.result).toMatchObject({ status: 'unavailable', code: 'NOT_FOUND' });
  });
});

// ─── Expectation matching edge cases (stubbed engine) ────────────────────────

describe('runScenario matching (stubbed engine)', () => {
  const base: Scenario = {
    name: 'case',
    offering: 'tour',
    expect: { status: 'qualified', total: 100 },
  };

  it('status mismatch includes a hint about the actual outcome', () => {
    const { evaluate } = stubEvaluate(() => ({
      status: 'needs_input',
      offering: 'tour',
      question: { kind: 'parameter', key: 'participants', label: 'Participants', type: 'number', required: true },
      reason: 'required',
    }));
    const outcome = runScenario(fixtureGraph, base, evaluate);
    expect(outcome.mismatches).toEqual(["expected status qualified, got needs_input (asks 'participants')"]);
  });

  it('reason matches an exact code or a case-insensitive message substring', () => {
    const blocked = (code: string, message: string, ruleId?: string): ScopeResult => ({
      status: 'blocked',
      offering: 'tour',
      reasons: [{ code: code as 'RULE', message, ...(ruleId !== undefined && { ruleId }) }],
    });
    const cases: Array<[string, ScopeResult, boolean]> = [
      ['MINIMUM_SPEND', blocked('MINIMUM_SPEND', 'minimum spend not met'), true],
      ['sunday', blocked('MINIMUM_SPEND', 'minimum spend not met'), false], // not an exact code, not in the message
      ['Not enough notice', blocked('DATE_TOO_SOON', 'Not enough notice — book 48h ahead'), true],
    ];
    for (const [reason, result, shouldPass] of cases) {
      const { evaluate } = stubEvaluate(() => result);
      const outcome = runScenario(
        fixtureGraph,
        { ...base, expect: { status: 'blocked', reason } },
        evaluate,
      );
      expect(outcome.ok, `reason: ${reason}`).toBe(shouldPass);
      if (!shouldPass) {
        expect(outcome.mismatches[0]).toContain("expected a reason matching");
      }
    }
  });

  it('reason mismatch lists the actual codes with messages', () => {
    const { evaluate } = stubEvaluate(() => ({
      status: 'blocked',
      offering: 'tour',
      reasons: [{ code: 'RULE', message: 'Not available with linen', ruleId: 'tour.rule1' }],
    }));
    const outcome = runScenario(
      fixtureGraph,
      { ...base, expect: { status: 'blocked', reason: 'DATE_TOO_SOON' } },
      evaluate,
    );
    expect(outcome.mismatches[0]).toContain('RULE [tour.rule1] ("Not available with linen")');
  });

  it('hints that scenarios never call the facts hook on unexpected FACTS_UNAVAILABLE', () => {
    const blockedFacts: ScopeResult = {
      status: 'blocked',
      offering: 'tour',
      reasons: [{ code: 'FACTS_UNAVAILABLE', message: 'Required information "tide" is unavailable' }],
    };
    const surprised = runScenario(
      fixtureGraph,
      { ...base, expect: { status: 'qualified', total: 10 } },
      stubEvaluate(() => blockedFacts).evaluate,
    );
    expect(surprised.ok).toBe(false);
    expect(surprised.mismatches.at(-1)).toBe(
      'hint: scenarios never call src/extend/facts.ts — set facts in the scenario or in defaults.facts',
    );

    const expected = runScenario(
      fixtureGraph,
      { ...base, expect: { status: 'blocked', reason: 'FACTS_UNAVAILABLE' } },
      stubEvaluate(() => blockedFacts).evaluate,
    );
    expect(expected.ok).toBe(true);
    expect(expected.mismatches).toEqual([]);
  });

  it('rule matches the part after the offering dot', () => {
    const blocked: ScopeResult = {
      status: 'blocked',
      offering: 'pkg',
      reasons: [{ code: 'RULE', message: 'no', ruleId: 'inner-product.rule7' }],
    };
    for (const ruleValue of ['inner-product.rule7', 'rule7']) {
      const { evaluate } = stubEvaluate(() => blocked);
      const outcome = runScenario(fixtureGraph, { ...base, expect: { status: 'blocked', rule: ruleValue } }, evaluate);
      expect(outcome.ok, `rule: ${ruleValue}`).toBe(true);
    }
    const { evaluate } = stubEvaluate(() => blocked);
    const outcome = runScenario(fixtureGraph, { ...base, expect: { status: 'blocked', rule: 'rule8' } }, evaluate);
    expect(outcome.mismatches[0]).toContain("expected blocked by rule 'rule8', got inner-product.rule7");
  });

  it('line expectations are a subset: extras ignored, amounts in major units', () => {
    const result = qualified(
      quoteOf([
        { id: 'tour.base', label: 'Guided tour', amountCents: 8500 },
        { id: 'tour.extras.linen.price', label: 'Linen service', amountCents: 1500 },
      ]),
    );
    const { evaluate } = stubEvaluate(() => result);
    const outcome = runScenario(
      fixtureGraph,
      {
        ...base,
        expect: {
          status: 'qualified',
          lines: [
            { id: 'tour.base', amount: 85 },
            { label: 'Linen service' },
          ],
        },
      },
      evaluate,
    );
    expect(outcome.mismatches).toEqual([]);
  });

  it('line amount mismatch and missing line are reported', () => {
    const result = qualified(quoteOf([{ id: 'tour.base', label: 'Guided tour', amountCents: 8500 }]));
    const { evaluate } = stubEvaluate(() => result);
    const outcome = runScenario(
      fixtureGraph,
      {
        ...base,
        expect: {
          status: 'qualified',
          lines: [
            { id: 'tour.base', amount: 84 },
            { label: 'Linen service', amount: 15 },
          ],
        },
      },
      evaluate,
    );
    expect(outcome.mismatches).toHaveLength(2);
    expect(outcome.mismatches[0]).toContain("expected a quote line matching 'tour.base' (84.00)");
    expect(outcome.mismatches[1]).toContain("expected a quote line matching 'Linen service' (15.00)");
    expect(outcome.mismatches[1]).toContain('tour.base "Guided tour"');
  });

  it('subtotal and tax mismatches use their own words', () => {
    const result = qualified({
      ...quoteOf([{ id: 'b', label: 'Base', amountCents: 8500 }]),
      subtotalCents: 8500,
      taxCents: 723,
      totalCents: 9223,
    });
    const { evaluate } = stubEvaluate(() => result);
    const outcome = runScenario(
      fixtureGraph,
      { ...base, expect: { status: 'qualified', subtotal: 80, tax: 8 } },
      evaluate,
    );
    expect(outcome.mismatches).toEqual([
      'expected subtotal 80.00, got 85.00',
      'expected tax 8.00, got 7.23',
    ]);
  });

  it('fractional major units round to exact cents', () => {
    const result = qualified(quoteOf([{ id: 'b', label: 'Base', amountCents: 11550 }]));
    const { evaluate } = stubEvaluate(() => result);
    const outcome = runScenario(
      fixtureGraph,
      { ...base, expect: { status: 'qualified', total: 115.5 } },
      evaluate,
    );
    expect(outcome.ok).toBe(true);
  });
});

// ─── File-level behaviour ────────────────────────────────────────────────────

describe('runScenarioFiles', () => {
  it('runs a bare list file and an object file with defaults', async () => {
    const dir = await tempDir();
    const listFile = join(dir, 'list.yaml');
    const objectFile = join(dir, 'object.yaml');
    await writeYaml(
      listFile,
      [
        '- name: ten guests',
        '  offering: tour',
        '  answers: { participants: 10 }',
        '  expect: { status: qualified, total: 850 }',
        '- name: no answers',
        '  offering: tour',
        '  expect: { status: needs_input, asks: participants }',
      ].join('\n'),
    );
    await writeYaml(
      objectFile,
      [
        'defaults:',
        '  now: 2026-05-01T00:00:00Z',
        'scenarios:',
        '  - name: linen for ten',
        '    offering: tour',
        '    answers: { participants: 10 }',
        '    selections: { extras: linen }',
        '    expect: { status: qualified, total: 865 }',
      ].join('\n'),
    );
    const report = await runScenarioFiles(fixtureGraph, [listFile, objectFile]);
    expect(report.ok).toBe(true);
    expect(report.passed).toBe(3);
    expect(report.failed).toBe(0);
    expect(report.files.map((file) => file.results.length)).toEqual([2, 1]);
  });

  it('applies file defaults: now fallback, facts merge with scenario precedence', async () => {
    const dir = await tempDir();
    const file = join(dir, 'defaults.yaml');
    await writeYaml(
      file,
      [
        'defaults:',
        '  now: 2026-05-01T00:00:00Z',
        '  facts: { vip: true, region: north }',
        'scenarios:',
        '  - name: overrides region',
        '    offering: tour',
        '    facts: { region: south }',
        '    now: 2026-06-01T00:00:00Z',
        '    expect: { status: needs_input }',
        '  - name: inherits everything',
        '    offering: tour',
        '    expect: { status: needs_input }',
      ].join('\n'),
    );
    const { evaluate, calls } = stubEvaluate(() => ({
      status: 'needs_input',
      offering: 'tour',
      question: { kind: 'parameter', key: 'participants', label: 'Participants', type: 'number', required: true },
      reason: 'required',
    }));
    const report = await runScenarioFiles(fixtureGraph, [file], { evaluate });
    expect(report.ok).toBe(true);
    expect(calls[0]?.request.facts).toEqual({ vip: true, region: 'south' });
    expect(calls[0]?.now?.toISOString()).toBe('2026-06-01T00:00:00.000Z');
    expect(calls[1]?.request.facts).toEqual({ vip: true, region: 'north' });
    expect(calls[1]?.now?.toISOString()).toBe('2026-05-01T00:00:00.000Z');
  });

  it('uses the deterministic default now when nothing is set', async () => {
    const dir = await tempDir();
    const file = join(dir, 'plain.yaml');
    await writeYaml(file, '- name: a\n  offering: tour\n  expect: { status: needs_input }\n');
    const { evaluate, calls } = stubEvaluate(() => ({
      status: 'needs_input',
      offering: 'tour',
      question: { kind: 'parameter', key: 'participants', label: 'Participants', type: 'number', required: true },
      reason: 'required',
    }));
    await runScenarioFiles(fixtureGraph, [file], { evaluate });
    expect(calls[0]?.now?.toISOString()).toBe('2026-01-01T00:00:00.000Z');
    expect(DEFAULT_NOW).toBe('2026-01-01T00:00:00Z');
  });

  it('reports scenario schema errors with path, not thrown', async () => {
    const dir = await tempDir();
    const file = join(dir, 'bad.yaml');
    await writeYaml(
      file,
      [
        '- name: good one',
        '  offering: tour',
        '  expect: { status: needs_input, asks: participants }',
        '- name: bad status',
        '  offering: tour',
        '  asnwers: { participants: 2 }',
        '  expect: { status: qualifed }',
        '- name: wrong field for status',
        '  offering: tour',
        '  expect: { status: blocked, asks: date }',
      ].join('\n'),
    );
    const report = await runScenarioFiles(fixtureGraph, [file]);
    expect(report.ok).toBe(false);
    expect(report.passed).toBe(1);
    expect(report.failed).toBe(2);
    const [good, badStatus, wrongField] = report.files[0]!.results;
    expect(good?.ok).toBe(true);
    expect(badStatus?.error).toContain("scenarios[1].expect.status");
    expect(badStatus?.error).toContain('asnwers');
    expect(wrongField?.error).toContain('scenarios[2].expect.asks');
    expect(wrongField?.error).toContain('only applies to expect.status: needs_input');
  });

  it('reports file-level errors: YAML parse error and bad root shape', async () => {
    const dir = await tempDir();
    const broken = join(dir, 'broken.yaml');
    const wrongShape = join(dir, 'shape.yaml');
    await writeYaml(broken, 'scenarios: [ oops\n');
    await writeYaml(wrongShape, 'name: not a scenario file\n');
    const report = await runScenarioFiles(fixtureGraph, [broken, wrongShape]);
    expect(report.ok).toBe(false);
    expect(report.failed).toBe(2);
    expect(report.files[0]?.error).toContain('YAML parse error');
    expect(report.files[1]?.error).toContain('{ defaults, scenarios }');
  });

  it('filters by name (case-insensitive) and counts skips', async () => {
    const dir = await tempDir();
    const file = join(dir, 'filter.yaml');
    await writeYaml(
      file,
      [
        '- name: weekday booking',
        '  offering: tour',
        '  expect: { status: needs_input, asks: participants }',
        '- name: WEEKEND booking',
        '  offering: tour',
        '  expect: { status: needs_input, asks: participants }',
      ].join('\n'),
    );
    const report = await runScenarioFiles(fixtureGraph, [file], undefined, { filter: 'weekend' });
    expect(report.ok).toBe(true);
    expect(report.passed).toBe(1);
    expect(report.skipped).toBe(1);
    expect(report.files[0]?.results.map((result) => result.skipped)).toEqual([true, undefined]);
  });
});

describe('listScenarioFiles', () => {
  it('collects yaml and yml recursively, sorted, ignoring other files', async () => {
    const dir = await tempDir();
    await mkdir(join(dir, 'sub'));
    await writeYaml(join(dir, 'b.yaml'), '[]');
    await writeYaml(join(dir, 'a.yml'), '[]');
    await writeYaml(join(dir, 'sub', 'c.yaml'), '[]');
    await writeYaml(join(dir, 'README.md'), 'nope');
    const files = await listScenarioFiles(dir);
    expect(files.map((file) => file.replace(/\\/g, '/'))).toEqual([
      expect.stringMatching(/a\.yml$/),
      expect.stringMatching(/b\.yaml$/),
      expect.stringMatching(/sub\/c\.yaml$/),
    ]);
  });
});
