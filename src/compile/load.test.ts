import { describe, expect, it } from 'vitest';
import { loadGraph } from './index.js';
import { loadCatalog } from './load.js';
import { BUSINESS_YAML, SURF_LESSON_YAML, writeFixture, removeFixture } from './testkit.js';

describe('loadCatalog', () => {
  it('reports MISSING_FILE when business.yaml is absent', async () => {
    const dir = await writeFixture({
      'offerings/p.yaml': SURF_LESSON_YAML,
    });
    try {
      const result = await loadGraph(dir);
      expect(result.graph).toBeUndefined();
      const diagnostic = result.diagnostics.find((d) => d.code === 'MISSING_FILE');
      expect(diagnostic).toMatchObject({
        severity: 'error',
        file: 'business.yaml',
      });
      expect(diagnostic?.message).toContain('business.yaml');
    } finally {
      await removeFixture(dir);
    }
  });

  it('turns YAML syntax errors into positioned YAML_SYNTAX diagnostics', async () => {
    const dir = await writeFixture({
      'business.yaml': 'name: B\ncurrency: USD\nask: [unclosed\n',
      'offerings/p.yaml': SURF_LESSON_YAML,
    });
    try {
      const input = await loadCatalog(dir);
      const result = await loadGraph(dir);
      const diagnostic = result.diagnostics.find((d) => d.code === 'YAML_SYNTAX');
      expect(diagnostic).toBeDefined();
      expect(diagnostic?.severity).toBe('error');
      expect(diagnostic?.file).toBe('business.yaml');
      expect(diagnostic?.line).toBe(4); // parser points just past the unterminated sequence
      expect(input.business.data).toBeUndefined();
    } finally {
      await removeFixture(dir);
    }
  });

  it('rejects offering file names that are not valid ids', async () => {
    const dir = await writeFixture({
      'business.yaml': BUSINESS_YAML,
      'offerings/Surf Lesson.yaml': 'name: X\nprice: 1\n',
    });
    try {
      const result = await loadGraph(dir);
      expect(result.diagnostics).toContainEqual(
        expect.objectContaining({ code: 'INVALID_OFFERING_ID' }),
      );
    } finally {
      await removeFixture(dir);
    }
  });
  it('accepts .yml and loads offerings sorted by file name', async () => {
    const dir = await writeFixture({
      'business.yaml': BUSINESS_YAML,
      'offerings/b.yaml': 'name: B2\nprice: 2\n',
      'offerings/a.yml': 'name: A\nprice: 1\n',
    });
    try {
      const input = await loadCatalog(dir);
      expect(input.business.file).toBe('business.yaml');
      expect(input.offerings.map((o) => o.id)).toEqual(['a', 'b']);
      const result = await loadGraph(dir);
      expect(Object.keys(result.graph?.offerings ?? {})).toEqual(['a', 'b']);
    } finally {
      await removeFixture(dir);
    }
  });

  it('warns when the offerings directory is missing', async () => {
    const dir = await writeFixture({ 'business.yaml': BUSINESS_YAML });
    try {
      const result = await loadGraph(dir);
      expect(result.diagnostics).toContainEqual(
        expect.objectContaining({ code: 'MISSING_DIR', severity: 'warning' }),
      );
    } finally {
      await removeFixture(dir);
    }
  });

  it('turns duplicate YAML keys into diagnostics (never throws)', async () => {
    const dir = await writeFixture({
      'business.yaml': BUSINESS_YAML,
      'offerings/p.yaml': 'name: P\nname: Q\nprice: 1\n',
    });
    try {
      const result = await loadGraph(dir);
      expect(result.diagnostics).toContainEqual(
        expect.objectContaining({
          code: 'YAML_SYNTAX',
          severity: 'error',
          line: 2,
        }),
      );
      expect(result.graph).toBeUndefined();
    } finally {
      await removeFixture(dir);
    }
  });
});
