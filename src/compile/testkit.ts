/**
 * Test fixtures: write YAML catalogs into a fresh os.tmpdir() directory.
 * Pure test scaffolding — never imported by production code.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Diagnostic } from './diagnostics.js';
import type { Graph } from '../graph/types.js';
import { loadGraph } from './index.js';

/** A minimal valid business.yaml (USD, UTC). */
export const MINIMAL_BUSINESS_YAML = 'name: Test Co\ncurrency: USD\ntimezone: UTC\n';

/**
 * Compiles and lints `business.yaml` + `offerings/<id>.yaml` from a temp dir
 * (removed again before returning).
 */
export async function loadFixtureCatalog(
  offerings: Record<string, string>,
  business: string = MINIMAL_BUSINESS_YAML,
): Promise<{ graph?: Graph; diagnostics: Diagnostic[] }> {
  const files: Record<string, string> = { 'business.yaml': business };
  for (const [id, yaml] of Object.entries(offerings)) files[`offerings/${id}.yaml`] = yaml;
  const dir = await writeFixture(files);
  try {
    return await loadGraph(dir);
  } finally {
    await removeFixture(dir);
  }
}

/** Like `loadFixtureCatalog`, but the catalog must compile. */
export async function fixtureGraph(offerings: Record<string, string>, business?: string): Promise<Graph> {
  const { graph, diagnostics } = await loadFixtureCatalog(offerings, business);
  if (!graph) throw new Error(diagnostics.map((d) => d.message).join('\n'));
  return graph;
}

/** Writes `{ relPath: content }` under a fresh temp dir; returns the dir. */
export async function writeFixture(
  files: Record<string, string>,
): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'scopegraph-test-'));
  for (const [rel, content] of Object.entries(files)) {
    const target = join(dir, rel);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content, 'utf8');
  }
  return dir;
}

export async function removeFixture(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}

export const BUSINESS_YAML = `name: Kelp Point Surf School
description: Surf lessons on a quiet point break.
currency: USD
timezone: America/Halifax
taxRate: 6.25
facts:
  swell_ft:
    type: number
    description: Swell height in feet right now.
seasons:
  - name: high_season
    kind: peak
    from: 07-01
    to: 09-15
  - name: weekend_days
    kind: custom
    days: [sat, sun]
handoff:
  url: https://bookings.kelppoint.example/{offering}?{params}
`;

export const SURF_LESSON_YAML = `name: Surf Lesson
description: Ninety minutes in the white water with a coach.
category: lessons
price: 78
taxable: true
date: required
minNoticeHours: 18
ask:
  participants:
    type: integer
    min: 1
    max: 6
    default: 1
    role: quantity
  ability:
    type: select
    label: Ability
    options: [novice, improver]
    default: novice
choose:
  extras:
    mode: multi
    min: 1
    max: 2
    options:
      softboard:
        price: 18
      pickup:
        price: { amount: 12, per: participants }
        taxable: false
rules:
  - id: no_big_swell_novices
    when: { ability: novice, swell_ft: { gte: 6 } }
    block: Novices can't book while the swell is 6 ft or bigger.
  - when: { participants: { gte: 4 } }
    require: extras.softboard
    message: Groups of four or more need softboards.
  - when: { not: { selected: extras.pickup } }
    ask: participants
pricing:
  - id: crew_discount
    label: Crew discount
    kind: discount
    per: participants
    amount: 4
    when: { participants: { gt: 3 } }
minimumSpend:
  amount: 60
  mode: decline
`;

const WETSUIT_LOAN_YAML = `name: Wetsuit Loan
description: Winter wetsuit loan.
price: { amount: 14, per: days }
bookable: false
ask:
  days:
    type: integer
    min: 1
    default: 1
    role: quantity
`;

const SURF_CAMP_YAML = `name: Two-Day Surf Camp
description: Lesson plus wetsuits, bundled.
kind: package
contains:
  - surf-lesson
  - { offering: wetsuit-loan, quantity: 2 }
discount:
  percent: 12
ask:
  lodging:
    type: select
    options: [bunk, cabin]
choose:
  cover:
    required: true
    options: [standard, plus]
  extras:
    mode: multi
    min: 1
    max: 2
    options:
      softboard:
        price: 18
      pickup:
        price: { amount: 12, per: participants }
        taxable: false
rules:
  - when: { lodging: cabin }
    require: cover.plus
`;

/** The full happy-path catalog used by several test files. */
export function happyCatalog(): Record<string, string> {
  return {
    'business.yaml': BUSINESS_YAML,
    'offerings/surf-lesson.yaml': SURF_LESSON_YAML,
    'offerings/wetsuit-loan.yaml': WETSUIT_LOAN_YAML,
    'offerings/surf-camp.yaml': SURF_CAMP_YAML,
  };
}
