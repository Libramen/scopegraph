/**
 * Regenerate the committed JSON Schemas in schema/ from the zod schemas:
 *
 *   npm run schema
 *
 * Commit the result; src/catalog/json-schema.test.ts fails when they are stale.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { renderAuthoringSchemas } from '../src/catalog/json-schema.js';
import { SCHEMA_DIR } from '../src/catalog/schema-files.js';

await mkdir(SCHEMA_DIR, { recursive: true });
for (const { file, text } of renderAuthoringSchemas()) {
  await writeFile(join(SCHEMA_DIR, file), text);
  process.stdout.write(`wrote schema/${file}\n`);
}
