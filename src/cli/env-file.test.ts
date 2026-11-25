/**
 * The checkout `.env` loader: set variables win, NODE_* keys are ignored, and
 * nothing is read under NODE_ENV=production.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { CHECKOUT_ROOT, loadEnvFileInto } from './env-file.js';

const dir = mkdtempSync(join(tmpdir(), 'scopegraph-env-file-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function envFile(name: string, text: string): string {
  const file = join(dir, name);
  writeFileSync(file, text);
  return file;
}

describe('loadEnvFileInto', () => {
  it('adds unset variables; values already set (even empty) win', () => {
    const file = envFile('basic.env', 'PORT=4000\nHOST=127.0.0.1\nPUBLIC_URL="https://from-file.example"\n');
    const env: NodeJS.ProcessEnv = { HOST: '', PUBLIC_URL: 'https://from-env.example' };
    const warnings: string[] = [];
    loadEnvFileInto(file, env, (message) => warnings.push(message));
    expect(env).toEqual({ PORT: '4000', HOST: '', PUBLIC_URL: 'https://from-env.example' });
    expect(warnings).toEqual([]);
  });

  it('ignores every NODE_* key, in any case, and says so', () => {
    const file = envFile(
      'node.env',
      'NODE_TLS_REJECT_UNAUTHORIZED=0\nNODE_OPTIONS=--require ./evil.cjs\nnode_env=production\nADMIN_TOKEN=kept\n',
    );
    const env: NodeJS.ProcessEnv = {};
    const warnings: string[] = [];
    loadEnvFileInto(file, env, (message) => warnings.push(message));
    expect(env).toEqual({ ADMIN_TOKEN: 'kept' });
    expect(warnings).toHaveLength(3);
    expect(warnings.join('\n')).toContain('NODE_TLS_REJECT_UNAUTHORIZED');
  });

  it('reads nothing under NODE_ENV=production, with one warning', () => {
    const file = envFile('prod.env', 'EXPOSE_TRACE=true\n');
    const env: NodeJS.ProcessEnv = { NODE_ENV: 'production' };
    const warnings: string[] = [];
    loadEnvFileInto(file, env, (message) => warnings.push(message));
    expect(env).toEqual({ NODE_ENV: 'production' });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('NODE_ENV=production');
  });

  it('a missing file is a silent no-op', () => {
    const env: NodeJS.ProcessEnv = {};
    const warnings: string[] = [];
    loadEnvFileInto(join(dir, 'absent.env'), env, (message) => warnings.push(message));
    expect(env).toEqual({});
    expect(warnings).toEqual([]);
  });

  it('CHECKOUT_ROOT is the directory holding the scopegraph package.json', () => {
    const manifest = join(CHECKOUT_ROOT, 'package.json');
    expect(existsSync(manifest)).toBe(true);
    expect(JSON.parse(readFileSync(manifest, 'utf8'))).toMatchObject({ name: 'scopegraph' });
  });
});
