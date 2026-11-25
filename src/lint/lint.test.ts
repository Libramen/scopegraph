import { describe, expect, it } from 'vitest';
import { lintGraph } from './index.js';
import {
  BUSINESS_YAML,
  happyCatalog,
  loadFixtureCatalog,
  removeFixture,
  writeFixture,
} from '../compile/testkit.js';
import { compileCatalog } from '../compile/index.js';
import { loadCatalog } from '../compile/load.js';
import type { Diagnostic } from '../compile/diagnostics.js';
import type { Graph } from '../graph/types.js';

async function lintFiles(
  files: Record<string, string>,
): Promise<{ graph?: Graph; warnings: Diagnostic[] }> {
  const dir = await writeFixture(files);
  try {
    const compiled = compileCatalog(await loadCatalog(dir));
    if (!compiled.graph) return { warnings: [] };
    return { graph: compiled.graph, warnings: lintGraph(compiled.graph) };
  } finally {
    await removeFixture(dir);
  }
}

const BASE = { 'business.yaml': BUSINESS_YAML };
const PRODUCT = 'name: Widget\nprice: 12.50\ndescription: A widget.\n';

describe('lintGraph', () => {
  it('warns on the happy catalog only where intended', async () => {
    const { warnings } = await lintFiles(happyCatalog());
    const codes = warnings.map((w) => w.code).sort();
    // swell_ft is optional and read by a block rule; participants is
    // required-with-default and gated. Both rules also live in surf-camp's
    // flattened scope, so each warning fires once per scope.
    expect(codes).toEqual([
      'FACT_FAIL_OPEN',
      'FACT_FAIL_OPEN',
      'GATE_ON_REQUIRED_DEFAULT',
      'GATE_ON_REQUIRED_DEFAULT',
    ]);
  });

  it('NO_PRICE — product with zero base and no adjustments', async () => {
    const { warnings } = await lintFiles({
      ...BASE,
      'offerings/free.yaml': 'name: Free\nprice: 0\ndescription: Nothing.\n',
    });
    expect(warnings).toContainEqual(
      expect.objectContaining({ code: 'NO_PRICE', path: ['offerings', 'free', 'price'] }),
    );
  });

  it('NO_PRICE — skips bundle-only components priced by their package', async () => {
    const { warnings } = await lintFiles({
      ...BASE,
      'offerings/part.yaml': 'name: Part\nprice: 0\nbookable: false\ndescription: Bundle-only part.\n',
    });
    expect(warnings.map((w) => w.code)).not.toContain('NO_PRICE');
  });

  it('MISSING_DESCRIPTION — offerings without a description', async () => {
    const { warnings } = await lintFiles({
      ...BASE,
      'offerings/p.yaml': 'name: P\nprice: 1\n',
    });
    expect(warnings).toContainEqual(
      expect.objectContaining({
        code: 'MISSING_DESCRIPTION',
        path: ['offerings', 'p'],
        hint: expect.stringContaining('description'),
      }),
    );
  });

  it('UNUSED_FACT and FACT_FAIL_OPEN', async () => {
    const { warnings } = await lintFiles({
      'business.yaml': [
        'name: B',
        'facts:',
        '  storm_warning:',
        '    type: boolean',
        '  never_read:',
        '    type: boolean',
      ].join('\n'),
      'offerings/p.yaml': [
        PRODUCT,
        'rules:',
        '  - when: { storm_warning: true }',
        '    block: No tours in storms.',
      ].join('\n'),
    });
    expect(warnings).toContainEqual(
      expect.objectContaining({
        code: 'FACT_FAIL_OPEN',
        path: ['business', 'facts', 'storm_warning'],
        hint: expect.stringContaining('required: true'),
      }),
    );
    expect(warnings).toContainEqual(
      expect.objectContaining({ code: 'UNUSED_FACT', path: ['business', 'facts', 'never_read'] }),
    );
  });

  it('GATE_ON_INTERNAL — gating a parameter that is never asked', async () => {
    const { warnings } = await lintFiles({
      ...BASE,
      'offerings/p.yaml': [
        PRODUCT,
        'ask:',
        '  region:',
        '    type: string',
        '    internal: true',
        '    default: eu',
        'rules:',
        '  - when: { isWeekend: true }',
        '    ask: region',
      ].join('\n'),
    });
    expect(warnings).toContainEqual(
      expect.objectContaining({
        code: 'GATE_ON_INTERNAL',
        message: expect.stringContaining('region'),
      }),
    );
  });

  it('GATE_ON_REQUIRED_DEFAULT — gating a required parameter with a default', async () => {
    const { graph, warnings } = await lintFiles(happyCatalog());
    expect(graph).toBeDefined();
    expect(warnings).toContainEqual(
      expect.objectContaining({
        code: 'GATE_ON_REQUIRED_DEFAULT',
        message: expect.stringContaining('participants'),
      }),
    );
  });
});

describe('lintGraph pricing and date warnings', () => {
  it('warns on an unbounded per-unit discount, a percent of a $0 base, and date values on a dateless offering', async () => {
    const { diagnostics } = await loadFixtureCatalog({
      clean: `name: Clean
description: House cleaning.
price: 0
ask:
  rooms: { type: integer, min: 1 }
choose:
  size:
    required: true
    options:
      small: { price: 100 }
      large: { price: 200 }
pricing:
  - { label: Per-room discount, kind: discount, per: rooms, amount: 5 }
  - { label: Service fee, kind: fee, percent: 10, basis: base }
  - { label: Weekend, kind: surcharge, amount: 20, when: { isWeekend: true } }
`,
    });
    const codes = diagnostics.filter((d) => d.severity === 'warning').map((d) => d.code);
    expect(codes).toEqual(expect.arrayContaining(['DISCOUNT_UNBOUNDED_QUANTITY', 'PERCENT_OF_ZERO_BASE', 'DATE_VALUE_WITHOUT_DATE']));
  });

  it('stays quiet when the base price per unit covers the discount per unit, and for package-only components', async () => {
    const { diagnostics } = await loadFixtureCatalog({
      tandem: `name: Tandem
description: Tandem kayak.
price: { amount: 40, per: paddlers }
ask:
  paddlers: { type: integer, min: 1 }
pricing:
  - { label: Paddler discount, kind: discount, per: paddlers, amount: 10 }
`,
      part: `name: Part
description: A component.
price: 10
bookable: false
pricing:
  - { label: Weekend, kind: surcharge, amount: 5, when: { isWeekend: true } }
`,
      trip: `name: Trip
description: A trip.
kind: package
date: required
contains: [part]
`,
    });
    const codes = diagnostics.filter((d) => d.severity === 'warning').map((d) => d.code);
    expect(codes).not.toContain('DISCOUNT_UNBOUNDED_QUANTITY');
    expect(codes).not.toContain('DATE_VALUE_WITHOUT_DATE');
  });
});
