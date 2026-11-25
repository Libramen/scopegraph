/**
 * `simulate` facts resolution must match the server: the
 * src/extend/facts.ts hook always runs, --facts merges over its result, and
 * human output says where facts came from (--json stays a bare ScopeResult).
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { cmdSimulate } from './commands.js';

const tempDirs: string[] = [];
afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

function makeCatalog(withTideFact: boolean): string {
  const root = mkdtempSync(join(tmpdir(), 'scopegraph-sim-'));
  tempDirs.push(root);
  mkdirSync(join(root, 'offerings'));
  writeFileSync(
    join(root, 'business.yaml'),
    [
      'name: Test Co',
      'currency: USD',
      ...(withTideFact ? ['facts:', '  tide_ft:', '    type: number', '    required: true'] : []),
    ].join('\n'),
  );
  writeFileSync(
    join(root, 'offerings', 'city-tour.yaml'),
    ['name: City Tour', 'price: 72', 'ask:', '  participants:', '    type: number'].join('\n'),
  );
  return root;
}

function captureStdout(): () => string {
  let buffer = '';
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    buffer += String(chunk);
    return true;
  });
  return () => {
    spy.mockRestore();
    return buffer;
  };
}

describe('cmdSimulate facts resolution', () => {
  it('calls the extend hook when --facts is absent and says so', async () => {
    const catalog = makeCatalog(true); // declares required fact `tide_ft`
    const read = captureStdout();
    const code = await cmdSimulate({
      catalogDir: catalog,
      json: false,
      explain: false,
      interactive: false,
      offering: 'city-tour',
    });
    const stdout = read();
    expect(code).toBe(0);
    expect(stdout).toContain('facts: from src/extend/facts.ts');
    // The starter hook answers `tide_ft`, so the required fact must NOT block.
    expect(stdout).toContain('status: needs_input');
    expect(stdout).not.toContain('FACTS_UNAVAILABLE');
  });

  it('merges --facts over the hook result and says so', async () => {
    const catalog = makeCatalog(false);
    const read = captureStdout();
    const code = await cmdSimulate({
      catalogDir: catalog,
      json: false,
      explain: false,
      interactive: false,
      offering: 'city-tour',
      answers: { participants: 2 },
      facts: { vip: true },
    });
    const stdout = read();
    expect(code).toBe(0);
    expect(stdout).toContain('facts: hook + --facts override');
    expect(stdout).toContain('status: qualified');
  });

  it('keeps --json a bare ScopeResult (no facts note)', async () => {
    const catalog = makeCatalog(true);
    const read = captureStdout();
    await cmdSimulate({
      catalogDir: catalog,
      json: true,
      explain: false,
      interactive: false,
      offering: 'city-tour',
    });
    const stdout = read();
    const parsed = JSON.parse(stdout) as { status: string };
    expect(parsed.status).toBe('needs_input');
    expect(stdout).not.toContain('facts:');
  });
});
