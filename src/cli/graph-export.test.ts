/**
 * `graph --format json|yaml [--offering] [--out]`: the compiled graph in a
 * versioned envelope with deterministic (sorted) keys; `--json` keeps its
 * `{ ok, … }` envelope meaning; mermaid output is unchanged.
 */
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { parse } from 'yaml';
import { loadGraph } from '../compile/index.js';
import { cmdGraph } from './commands.js';
import { GRAPH_DOCUMENT_VERSION } from './graph-export.js';
import type { GraphDocument } from './graph-export.js';
import { main } from './index.js';
import { renderMermaid } from './mermaid.js';

const tempDirs: string[] = [];
afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

function tmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'scopegraph-graph-'));
  tempDirs.push(dir);
  return dir;
}

function makeCatalog(): string {
  const root = tmpDir();
  mkdirSync(join(root, 'offerings'));
  writeFileSync(
    join(root, 'business.yaml'),
    ['name: Test Co', 'currency: USD', 'timezone: UTC', 'taxRate: 8.5'].join('\n'),
  );
  writeFileSync(
    join(root, 'offerings', 'city-tour.yaml'),
    [
      'name: City Tour',
      'price: { amount: 85, per: participants }',
      'ask:',
      '  participants:',
      '    type: integer',
      '    role: quantity',
      '    min: 1',
      'rules:',
      '  - id: too_big',
      '    when: { participants: { gt: 20 } }',
      '    block: At most 20 people',
    ].join('\n'),
  );
  writeFileSync(
    join(root, 'offerings', 'weekend.yaml'),
    ['kind: package', 'name: Weekend', 'contains: [city-tour]', 'discount: { percent: 10 }'].join('\n'),
  );
  return root;
}

function capture(): () => { stdout: string; stderr: string } {
  let stdout = '';
  let stderr = '';
  const outSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    stdout += String(chunk);
    return true;
  });
  const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    stderr += String(chunk);
    return true;
  });
  return () => {
    outSpy.mockRestore();
    errSpy.mockRestore();
    return { stdout, stderr };
  };
}

type GraphOptions = Parameters<typeof cmdGraph>[0];

async function graph(options: Partial<GraphOptions> & { catalogDir: string }) {
  const read = capture();
  const code = await cmdGraph({ json: false, format: 'mermaid', scenariosDir: './scenarios', dataDir: './data', ...options });
  return { code, ...read() };
}

/** Every object's keys are in sorted order, at every depth. */
function keysSorted(value: unknown): boolean {
  if (Array.isArray(value)) return value.every(keysSorted);
  if (value === null || typeof value !== 'object') return true;
  const keys = Object.keys(value);
  return keys.join('\n') === [...keys].sort().join('\n') && Object.values(value).every(keysSorted);
}

describe('graph --format json', () => {
  it('emits the compiled graph in a versioned envelope with sorted keys', async () => {
    const catalogDir = makeCatalog();
    const { code, stdout, stderr } = await graph({ catalogDir, format: 'json' });
    expect(code).toBe(0);
    // Lint warnings go to stderr; stdout stays pure JSON.
    expect(stderr).toContain('warning MISSING_DESCRIPTION');
    const document = JSON.parse(stdout) as GraphDocument;
    expect(Object.keys(document)).toEqual(['scopegraphGraphVersion', 'business', 'offerings']);
    expect(document.scopegraphGraphVersion).toBe(GRAPH_DOCUMENT_VERSION);
    expect(keysSorted(document.business)).toBe(true);
    expect(keysSorted(document.offerings)).toBe(true);

    // Exactly the compiled Graph, only re-keyed.
    const compiled = (await loadGraph(catalogDir)).graph!;
    expect(document.business).toEqual(JSON.parse(JSON.stringify(compiled.business)));
    expect(document.offerings).toEqual(JSON.parse(JSON.stringify(compiled.offerings)));
    expect(document.business.taxRateMicros).toBe(85_000);
    expect(Object.keys(document.offerings)).toEqual(['city-tour', 'weekend']);
    expect(document.offerings['city-tour']!.scope.rules[0]!.id).toBe('city-tour.too_big');
    expect(document.offerings.weekend!.contains).toEqual([{ offeringId: 'city-tour', quantity: 1 }]);

    // Deterministic: a second run is byte-identical.
    expect((await graph({ catalogDir, format: 'json' })).stdout).toBe(stdout);
  });

  it('--offering keeps only that offering (a package scope is already flattened)', async () => {
    const catalogDir = makeCatalog();
    const { code, stdout } = await graph({ catalogDir, format: 'json', offering: 'weekend' });
    expect(code).toBe(0);
    const document = JSON.parse(stdout) as GraphDocument;
    expect(Object.keys(document.offerings)).toEqual(['weekend']);
    expect(document.offerings.weekend!.scope.parameters.map((p) => p.name)).toEqual(['participants']);
    expect(document.business.name).toBe('Test Co');
  });

  it('an unknown --offering fails with exit 1 (stderr, or {ok:false} with --json)', async () => {
    const catalogDir = makeCatalog();
    const human = await graph({ catalogDir, format: 'json', offering: 'nope' });
    expect(human.code).toBe(1);
    expect(human.stdout).toBe('');
    expect(human.stderr).toContain("offering 'nope' not found in catalog");
    const json = await graph({ catalogDir, format: 'json', offering: 'nope', json: true });
    expect(json.code).toBe(1);
    expect(JSON.parse(json.stdout)).toEqual({ ok: false, error: "offering 'nope' not found in catalog" });
  });

  it('--json wraps it as { ok, graph }', async () => {
    const catalogDir = makeCatalog();
    const bare = JSON.parse((await graph({ catalogDir, format: 'json' })).stdout) as GraphDocument;
    const { code, stdout } = await graph({ catalogDir, format: 'json', json: true });
    expect(code).toBe(0);
    expect(JSON.parse(stdout)).toEqual({ ok: true, graph: bare });
  });
});

describe('graph --format yaml', () => {
  it('emits the same document as YAML (no anchors/aliases)', async () => {
    const catalogDir = makeCatalog();
    const json = JSON.parse((await graph({ catalogDir, format: 'json' })).stdout) as GraphDocument;
    const { code, stdout } = await graph({ catalogDir, format: 'yaml' });
    expect(code).toBe(0);
    expect(stdout.startsWith('scopegraphGraphVersion: 1\nbusiness:\n')).toBe(true);
    expect(stdout).not.toMatch(/[&*][a-z]\d/);
    expect(parse(stdout)).toEqual(json);
    const wrapped = await graph({ catalogDir, format: 'yaml', json: true });
    expect(JSON.parse(wrapped.stdout)).toEqual({ ok: true, yaml: stdout });
  });
});

describe('graph mermaid (default)', () => {
  it('is unchanged: the flowchart on stdout, { ok, mermaid } with --json', async () => {
    const catalogDir = makeCatalog();
    const compiled = (await loadGraph(catalogDir)).graph!;
    const human = await graph({ catalogDir });
    expect(human.stdout).toBe(`${renderMermaid(compiled)}\n`);
    const json = await graph({ catalogDir, json: true, offering: 'city-tour' });
    expect(JSON.parse(json.stdout)).toEqual({ ok: true, mermaid: renderMermaid(compiled, 'city-tour') });
  });
});

describe('graph --out', () => {
  it('writes exactly the stdout payload to the file, for every format', async () => {
    const catalogDir = makeCatalog();
    const outDir = tmpDir();
    for (const format of ['mermaid', 'json', 'yaml'] as const) {
      const expected = (await graph({ catalogDir, format, offering: 'city-tour' })).stdout;
      const file = join(outDir, `graph.${format}`);
      const { code, stdout } = await graph({ catalogDir, format, offering: 'city-tour', out: file });
      expect(code).toBe(0);
      expect(stdout).toBe(`wrote the ${format} graph to ${file}\n`);
      expect(readFileSync(file, 'utf8')).toBe(expected);
    }
  });

  it('reports { ok, format, out } with --json, and fails cleanly on an unwritable path', async () => {
    const catalogDir = makeCatalog();
    const file = join(tmpDir(), 'graph.json');
    const ok = await graph({ catalogDir, format: 'json', out: file, json: true });
    expect(JSON.parse(ok.stdout)).toEqual({ ok: true, format: 'json', out: file });
    expect((JSON.parse(readFileSync(file, 'utf8')) as GraphDocument).scopegraphGraphVersion).toBe(1);

    const bad = await graph({ catalogDir, format: 'json', out: join(file, 'nested', 'graph.json') });
    expect(bad.code).toBe(1);
    expect(bad.stderr).toContain('could not write');
  });
});

describe('graph safety', () => {
  it('looks offerings up by own property and never writes --out into the catalog or a non-graph file', async () => {
    const catalogDir = makeCatalog();
    const before = readFileSync(join(catalogDir, 'business.yaml'), 'utf8');
    const base = { catalogDir, scenariosDir: join(catalogDir, 'scenarios') };
    const proto = await graph({ ...base, format: 'json', offering: 'constructor' });
    const intoCatalog = await graph({ ...base, format: 'yaml', out: join(catalogDir, 'business.yaml') });
    const notGraph = await graph({ ...base, format: 'json', out: join(tmpDir(), 'graph.ts') });
    expect([proto.code, intoCatalog.code, notGraph.code]).toEqual([1, 1, 1]);
    expect(proto.stderr).toContain("offering 'constructor' not found");
    expect(intoCatalog.stderr).toContain('refusing to overwrite catalog or scenario files');
    expect(notGraph.stderr).toContain('--out must name a');
    expect(readFileSync(join(catalogDir, 'business.yaml'), 'utf8')).toBe(before);
  });
});

describe('graph --out guard', () => {
  it('refuses a case variant of the catalog path on a case-insensitive volume', async () => {
    const catalogDir = makeCatalog();
    const before = readFileSync(join(catalogDir, 'business.yaml'), 'utf8');
    const variant = join(dirname(catalogDir), basename(catalogDir).toUpperCase());
    const run = await graph({ catalogDir, format: 'yaml', out: join(variant, 'business.yaml') });
    expect(run.code).toBe(1);
    // macOS (APFS default) folds case; on a case-sensitive volume the variant simply doesn't exist.
    expect(run.stderr).toContain(existsSync(variant) ? 'refusing to overwrite catalog or scenario files' : 'could not write');
    expect(readFileSync(join(catalogDir, 'business.yaml'), 'utf8')).toBe(before);
  });

  it('never writes through a symlink, a symlinked directory or onto a non-regular file', async () => {
    const catalogDir = makeCatalog();
    const before = readFileSync(join(catalogDir, 'business.yaml'), 'utf8');
    const outside = tmpDir();
    symlinkSync(join(catalogDir, 'business.yaml'), join(outside, 'link.yaml'));
    symlinkSync(catalogDir, join(outside, 'catalog-link'));
    mkdirSync(join(outside, 'folder.json'));

    const viaFile = await graph({ catalogDir, format: 'yaml', out: join(outside, 'link.yaml') });
    const viaDir = await graph({ catalogDir, format: 'yaml', out: join(outside, 'catalog-link', 'business.yaml') });
    const ontoDir = await graph({ catalogDir, format: 'json', out: join(outside, 'folder.json') });
    expect([viaFile.code, viaDir.code, ontoDir.code]).toEqual([1, 1, 1]);
    expect(viaFile.stderr).toContain('is not a regular file');
    expect(viaDir.stderr).toContain('refusing to overwrite catalog or scenario files');
    expect(ontoDir.stderr).toContain('is not a regular file');
    expect(readFileSync(join(catalogDir, 'business.yaml'), 'utf8')).toBe(before);
  });

  it('never overwrites a hard link to a catalog file', async () => {
    const catalogDir = makeCatalog();
    const before = readFileSync(join(catalogDir, 'business.yaml'), 'utf8');
    const hard = join(tmpDir(), 'hard.yaml'); // same volume as the catalog (both in tmpdir)
    linkSync(join(catalogDir, 'business.yaml'), hard);
    const run = await graph({ catalogDir, format: 'yaml', out: hard });
    expect(run.code).toBe(1);
    expect(run.stderr).toContain('refusing to overwrite a hard-linked file');
    expect(readFileSync(join(catalogDir, 'business.yaml'), 'utf8')).toBe(before);
  });

  it("treats '..x.yaml' as a file name: refused inside the catalog, allowed outside it", async () => {
    const catalogDir = makeCatalog();
    const inside = await graph({ catalogDir, format: 'yaml', out: join(catalogDir, '..x.yaml') });
    expect(inside.code).toBe(1);
    expect(inside.stderr).toContain('refusing to overwrite catalog or scenario files');
    expect(existsSync(join(catalogDir, '..x.yaml'))).toBe(false);

    const outsideFile = join(tmpDir(), '..x.yaml');
    const outside = await graph({ catalogDir, format: 'yaml', out: outsideFile });
    expect(outside.code).toBe(0);
    expect(existsSync(outsideFile)).toBe(true);
  });

  it('refuses targets inside DATA_DIR', async () => {
    const catalogDir = makeCatalog();
    const dataDir = tmpDir();
    mkdirSync(join(dataDir, 'nested'));
    const top = await graph({ catalogDir, dataDir, format: 'json', out: join(dataDir, 'payments.json') });
    const nested = await graph({ catalogDir, dataDir, format: 'json', out: join(dataDir, 'nested', 'graph.json') });
    expect([top.code, nested.code]).toEqual([1, 1]);
    expect(top.stderr).toContain('refusing to write over payment records');
    expect(nested.stderr).toContain('refusing to write over payment records');
    expect(existsSync(join(dataDir, 'payments.json'))).toBe(false);
    expect(existsSync(join(dataDir, 'nested', 'graph.json'))).toBe(false);
  });
});

describe('graph CLI flags', () => {
  it('rejects an unknown --format as a usage error', async () => {
    await expect(main(['graph', '--format', 'svg'])).rejects.toThrow('--format must be one of mermaid, json, yaml');
  });
});
