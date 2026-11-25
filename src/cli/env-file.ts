/**
 * The checkout's `.env`: where it lives and how the CLI reads it.
 *
 * Only `<checkout>/.env` is read, never the working directory's: an MCP client
 * or a shell can start the CLI anywhere, and a `.env` planted there must not
 * configure the server or the `orders` client. Rules:
 * - variables already in the environment win (an empty string included);
 * - `NODE_*` keys are ignored (e.g. NODE_TLS_REJECT_UNAUTHORIZED, NODE_OPTIONS,
 *   NODE_ENV): they change how Node itself behaves, which a config file must not;
 * - with NODE_ENV=production nothing is read: production takes its variables
 *   from the real environment (`docker run --env-file .env`, the platform's
 *   settings).
 */
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';

/** The scopegraph checkout root: the CLI lives at <root>/src/cli or <root>/dist/cli. */
export const CHECKOUT_ROOT = fileURLToPath(new URL('../../', import.meta.url));

/** Load `file` into `env` under the rules above; `warn` gets one line per thing ignored. */
export function loadEnvFileInto(file: string, env: NodeJS.ProcessEnv, warn: (message: string) => void): void {
  if (!existsSync(file)) return;
  if (env.NODE_ENV === 'production') {
    warn(`NODE_ENV=production: ${file} is not read; set these variables in the environment (docker run --env-file, or your platform's settings)`);
    return;
  }
  const parsed = parseEnv(readFileSync(file, 'utf8'));
  for (const [key, value] of Object.entries(parsed)) {
    if (value === undefined) continue;
    if (key.toUpperCase().startsWith('NODE_')) {
      warn(`${key} in ${file} is ignored: NODE_* variables must come from the environment`);
      continue;
    }
    if (env[key] === undefined) env[key] = value;
  }
}
