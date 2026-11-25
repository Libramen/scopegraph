import { describe, expect, it } from 'vitest';
import { adjustment, graph, group, offering, p, param, rule, selected } from '../engine/testing.js';
import { renderMermaid } from './mermaid.js';

const tour = offering('city-tour', {
  name: 'City Walking Tour',
  scope: {
    parameters: [
      param('participants', { type: 'number', required: true }),
      param('internal_flag', { required: false, internal: true }),
    ],
    optionGroups: [
      group('extras', [
        {
          key: 'linen',
          adjustments: [
            adjustment(
              'city-tour.extras.linen.price',
              { type: 'fixed', amountCents: 1500 },
              { kind: 'addon', label: 'Linen service' },
            ),
          ],
        },
        { key: 'towels' },
      ]),
    ],
    rules: [
      rule('city-tour.no_linen', { kind: 'block', message: 'no linen today' }, { when: p('participants', 'gt', 20) }),
      rule(
        'city-tour.needs_linen',
        { kind: 'require', target: { type: 'option', id: 'extras.linen' } },
        { when: selected('extras') },
      ),
      rule('city-tour.no_towels', { kind: 'exclude', target: { type: 'option', id: 'extras.towels' } }),
      rule('city-tour.gate', { kind: 'ask', target: { type: 'parameter', id: 'participants' } }),
    ],
    baseLines: [],
    adjustments: [],
  },
});

const package_ = offering('weekend-pkg', {
  kind: 'package',
  name: 'Weekend Package',
  contains: [{ offeringId: 'city-tour', quantity: 2 }],
  scope: {},
});

const fixtureGraph = graph([tour, package_]);

describe('renderMermaid', () => {
  it('renders the full catalog with typed nodes and labelled rule edges', () => {
    const mermaid = renderMermaid(fixtureGraph);
    const lines = mermaid.split('\n');
    expect(lines[0]).toBe('flowchart TD');
    expect(mermaid).toContain('o_city_tour["city-tour · City Walking Tour · product"]');
    expect(mermaid).toContain('o_weekend_pkg[["weekend-pkg · Weekend Package · package"]]');
    expect(mermaid).toContain('p_city_tour_participants("participants · number · required")');
    expect(mermaid).toContain('p_city_tour_internal_flag("internal_flag · string · optional · internal")');
    expect(mermaid).toContain('g_city_tour_extras["extras · single"]');
    expect(mermaid).toContain('opt_city_tour_extras_linen("linen")');
    expect(mermaid).toContain('opt_city_tour_extras_towels("towels")');
    expect(mermaid).toContain('o_city_tour -.-> p_city_tour_participants');
    expect(mermaid).toContain('o_city_tour --> g_city_tour_extras');
    expect(mermaid).toContain('g_city_tour_extras --> opt_city_tour_extras_linen');
    // Rule nodes and effect-labelled edges
    expect(mermaid).toContain('r_city_tour_city_tour_no_linen{');
    expect(mermaid).toContain('block: no linen today');
    expect(mermaid).toContain('r_city_tour_city_tour_needs_linen -->|require| opt_city_tour_extras_linen');
    expect(mermaid).toContain('r_city_tour_city_tour_no_towels -->|exclude| opt_city_tour_extras_towels');
    expect(mermaid).toContain('r_city_tour_city_tour_gate -->|ask| p_city_tour_participants');
    // Package containment, thick edge with quantity
    expect(mermaid).toContain('o_weekend_pkg ==>|contains ×2| o_city_tour');
  });

  it('renders a single offering without expanding others', () => {
    const mermaid = renderMermaid(fixtureGraph, 'weekend-pkg');
    expect(mermaid).toContain('o_weekend_pkg');
    expect(mermaid).toContain('==>|contains ×2| o_city_tour');
    expect(mermaid).not.toContain('p_city_tour_participants');
  });

  it('marks non-active offerings', () => {
    const paused = offering('paused-tour', { status: 'paused' });
    const mermaid = renderMermaid(graph([paused]));
    expect(mermaid).toContain('· product · paused');
  });

  it('throws for an unknown offering id', () => {
    expect(() => renderMermaid(fixtureGraph, 'ghost')).toThrow(/ghost/);
  });

  it('escapes labels and sanitizes node ids', () => {
    const weird = offering('weird-id', {
      name: 'Tour "deluxe" [2026]',
      scope: {
        rules: [
          rule('weird-id.block', { kind: 'block', message: 'no\nway |today|' }),
        ],
        baseLines: [],
        adjustments: [],
      },
    });
    const mermaid = renderMermaid(graph([weird]));
    expect(mermaid).toContain('o_weird_id[');
    expect(mermaid).toContain("Tour 'deluxe' (2026)");
    expect(mermaid).not.toContain('"deluxe"');
    expect(mermaid).not.toContain('\nway');
    expect(mermaid).toContain('way /today/');
  });
});
