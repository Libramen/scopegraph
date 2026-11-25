/**
 * The committed JSON Schemas in schema/ must be exactly what the zod
 * schemas generate (`npm run schema`), must accept every catalog and
 * scenario file in the repo (root + examples), and must reject obviously
 * wrong files. Every repo authoring file must start with the modeline that
 * points editors at its schema.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Ajv } from 'ajv';
import type { ValidateFunction } from 'ajv';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { renderAuthoringSchemas } from './json-schema.js';
import { SCHEMA_DIR, SCHEMA_FILES, schemaModeline } from './schema-files.js';
import type { SchemaKind } from './schema-files.js';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));

const ajv = new Ajv({ strict: true, allErrors: true, formats: { uri: (value: string) => URL.canParse(value) } });
const validators = Object.fromEntries(
  (Object.keys(SCHEMA_FILES) as SchemaKind[]).map((kind) => [
    kind,
    ajv.compile(JSON.parse(readFileSync(join(SCHEMA_DIR, SCHEMA_FILES[kind]), 'utf8')) as object),
  ]),
) as Record<SchemaKind, ValidateFunction>;

function yamlFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => /\.ya?ml$/.test(name))
    .sort()
    .map((name) => join(dir, name));
}

/** Every catalog + scenario file: the root fork and each examples/<name>/. */
function authoringFiles(): Array<{ file: string; kind: SchemaKind }> {
  const examples = join(repoRoot, 'examples');
  const projects = [
    repoRoot,
    ...readdirSync(examples, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(examples, entry.name)),
  ];
  return projects.flatMap((project) => [
    { file: join(project, 'catalog', 'business.yaml'), kind: 'business' as const },
    ...yamlFiles(join(project, 'catalog', 'offerings')).map((file) => ({ file, kind: 'offering' as const })),
    ...yamlFiles(join(project, 'scenarios')).map((file) => ({ file, kind: 'scenarios' as const })),
  ]);
}

function errorsOf(kind: SchemaKind, data: unknown): string {
  const validate = validators[kind];
  return validate(data) ? '' : ajv.errorsText(validate.errors);
}

describe('schema/*.schema.json', () => {
  it('match the zod schemas (run `npm run schema` and commit when this fails)', () => {
    for (const { file, text } of renderAuthoringSchemas()) {
      expect(readFileSync(join(SCHEMA_DIR, file), 'utf8'), `schema/${file} is stale`).toBe(text);
    }
  });

  const files = authoringFiles();

  it('cover business, offering and scenario files from the root and every example', () => {
    for (const kind of Object.keys(SCHEMA_FILES) as SchemaKind[]) {
      expect(files.filter((entry) => entry.kind === kind).length, kind).toBeGreaterThanOrEqual(8);
    }
  });

  it.each(files.map((entry) => [entry.file.slice(repoRoot.length), entry] as const))(
    'accept %s and it starts with its schema modeline',
    (_name, { file, kind }) => {
      const text = readFileSync(file, 'utf8');
      expect(text.split('\n')[0]).toBe(schemaModeline(file, kind));
      expect(errorsOf(kind, parse(text))).toBe('');
    },
  );

  it('reject an obviously wrong business file', () => {
    const errors = errorsOf('business', { currency: 'dollars', taxRate: 150, website: 'not a url', colour: 'blue' });
    expect(errors).toContain("must have required property 'name'");
    expect(errors).toContain('/currency must match pattern');
    expect(errors).toContain('/taxRate must be <= 100');
    expect(errors).toContain('/website must match format "uri"');
    expect(errors).toContain('must NOT have additional properties');
  });

  it('reject an obviously wrong offering file', () => {
    const errors = errorsOf('offering', {
      name: 'Surf Lesson',
      prise: 85,
      kind: 'service',
      ask: { 'Group Size': { type: 'count' } },
      rules: [{ block: 42 }],
    });
    expect(errors).toContain('must NOT have additional properties');
    expect(errors).toContain('/kind must be equal to one of the allowed values');
    expect(errors).toContain("property name must be valid");
    expect(errors).toContain('/rules/0/block must be string');
  });

  it('reject an obviously wrong scenarios file', () => {
    const errors = errorsOf('scenarios', {
      scenarios: [{ name: 'two surfers', offering: 'surf-lesson', expect: { status: 'approved', totl: 146 } }],
    });
    expect(errors).toContain('/scenarios/0/expect/status must be equal to one of the allowed values');
    expect(errors).toContain('must NOT have additional properties');
  });
});
