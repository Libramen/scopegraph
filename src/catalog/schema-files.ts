/**
 * Where the committed JSON Schemas for the authoring files live, and the
 * `yaml-language-server` modeline that points a YAML file at one of them.
 *
 * The schemas themselves are generated from the zod schemas (see
 * ./json-schema.ts and `npm run schema`); this module has no dependency on
 * the generator so runtime code (`scopegraph init`) can use it.
 */
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/** `<package root>/schema/` — two levels up from src/catalog (or dist/catalog). */
export const SCHEMA_DIR = fileURLToPath(new URL('../../schema/', import.meta.url));

/** Schema file name per authoring file kind. */
export const SCHEMA_FILES = {
  business: 'business.schema.json',
  offering: 'offering.schema.json',
  scenarios: 'scenarios.schema.json',
} as const;

export type SchemaKind = keyof typeof SCHEMA_FILES;

/**
 * First line for a YAML file at `yamlFile` so editors running the
 * yaml-language-server (e.g. the VS Code YAML extension) validate and
 * complete it: `# yaml-language-server: $schema=<path relative to the file>`.
 */
export function schemaModeline(yamlFile: string, kind: SchemaKind): string {
  const schemaPath = relative(dirname(resolve(yamlFile)), join(SCHEMA_DIR, SCHEMA_FILES[kind]));
  return `# yaml-language-server: $schema=${schemaPath.split(sep).join('/')}`;
}
