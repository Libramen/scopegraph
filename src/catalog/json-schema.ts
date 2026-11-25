/**
 * JSON Schema export of the authoring formats, generated from the zod
 * schemas (catalog: ./schema.ts, scenarios: ../scenarios/schema.ts). The
 * output is committed under schema/ for editor support; `npm run schema`
 * rewrites it and a test fails when it is stale.
 *
 * The JSON Schemas check SHAPE only, like the zod schemas — and a little
 * less: zod refinements (money has at most two decimals, a scenario line
 * expectation needs `id` or `label`, …) have no JSON Schema equivalent and
 * stay with `npm run validate` / `npm run scenarios`.
 */
import type { ZodTypeAny } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { ScenarioFile } from '../scenarios/schema.js';
import { BusinessInput, OfferingInput } from './schema.js';
import { SCHEMA_FILES } from './schema-files.js';
import type { SchemaKind } from './schema-files.js';

interface AuthoringSchema {
  kind: SchemaKind;
  title: string;
  description: string;
  zod: ZodTypeAny;
}

const AUTHORING_SCHEMAS: AuthoringSchema[] = [
  {
    kind: 'business',
    title: 'scopegraph business.yaml',
    description: 'Business-wide settings of a scopegraph catalog (catalog/business.yaml). Reference: docs/catalog-format.md',
    zod: BusinessInput,
  },
  {
    kind: 'offering',
    title: 'scopegraph offering',
    description: 'One offering of a scopegraph catalog (catalog/offerings/<id>.yaml; the file name is the id). Reference: docs/catalog-format.md',
    zod: OfferingInput,
  },
  {
    kind: 'scenarios',
    title: 'scopegraph scenarios',
    description: 'Executable specs for a scopegraph catalog (scenarios/*.yaml): a list of scenarios or { defaults, scenarios }. Reference: docs/catalog-format.md',
    zod: ScenarioFile,
  },
];

/** One generated schema file: name under schema/ and its exact contents. */
export interface SchemaFile {
  kind: SchemaKind;
  file: string;
  text: string;
}

/**
 * Render every authoring schema (draft-07, fully inlined — no `$ref`s, so
 * editors show the real constraint on hover). Deterministic: the same zod
 * schemas always produce the same bytes.
 */
export function renderAuthoringSchemas(): SchemaFile[] {
  return AUTHORING_SCHEMAS.map(({ kind, title, description, zod }) => {
    const { $schema, ...body } = zodToJsonSchema(zod, { target: 'jsonSchema7', $refStrategy: 'none' });
    const schema = { $schema, title, description, ...body };
    return { kind, file: SCHEMA_FILES[kind], text: `${JSON.stringify(schema, null, 2)}\n` };
  });
}
