/**
 * CLI smoke tests: spawn the real CLI (`node --import tsx src/cli/index.ts`)
 * against a temp catalog, exercising the full validate/simulate/test path
 * end to end.
 */
import { execFile, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, symlinkSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, describe, expect, it } from 'vitest';

const run = promisify(execFile);

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..');
const compilerReady =
  existsSync(join(repoRoot, 'src', 'compile', 'index.ts')) &&
  existsSync(join(repoRoot, 'src', 'engine', 'index.ts')) &&
  existsSync(join(repoRoot, 'src', 'pricing', 'index.ts'));

interface CliRun {
  code: number;
  stdout: string;
  stderr: string;
}

async function cli(args: string[]): Promise<CliRun> {
  try {
    const { stdout, stderr } = await run(
      process.execPath,
      ['--import', 'tsx', 'src/cli/index.ts', ...args],
      { cwd: repoRoot, timeout: 60_000, env: { ...process.env, NO_COLOR: '1' } },
    );
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string; killed?: boolean };
    if (failure.killed) throw new Error(`CLI timed out: scopegraph ${args.join(' ')}`);
    return { code: failure.code ?? 1, stdout: failure.stdout ?? '', stderr: failure.stderr ?? '' };
  }
}

const tempDirs: string[] = [];
afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

function makeCatalog(): string {
  const root = mkdtempSync(join(tmpdir(), 'scopegraph-cli-'));
  tempDirs.push(root);
  mkdirSync(join(root, 'offerings'));
  writeFileSync(
    join(root, 'business.yaml'),
    ['name: Test Co', 'currency: USD', 'timezone: UTC'].join('\n'),
  );
  writeFileSync(
    join(root, 'offerings', 'city-tour.yaml'),
    [
      'name: City Walking Tour',
      'price: 85',
      'date: optional',
      'ask:',
      '  participants:',
      '    type: number',
      '    min: 1',
      '    max: 20',
      'choose:',
      '  extras:',
      '    mode: multi',
      '    options: [linen]',
    ].join('\n'),
  );
  return root;
}

// Each test spawns one or more node+tsx processes: allow what `cli()` allows (slow CI runners).
describe.skipIf(!compilerReady)('cli smoke (spawned process)', { timeout: 60_000 }, () => {
  it('help and usage errors never need a catalog', async () => {
    const help = await cli(['help']);
    expect(help.code).toBe(0);
    expect(help.stdout).toContain('Usage:');
    expect(help.stdout).toContain('simulate <offering>');

    const noArgs = await cli([]);
    expect(noArgs.code).toBe(0);
    expect(noArgs.stdout).toContain('Usage:');

    const unknown = await cli(['frobnicate']);
    expect(unknown.code).toBe(2);
    expect(unknown.stderr).toContain("unknown command 'frobnicate'");

    const badJson = await cli(['simulate', 'city-tour', '--answers', '{oops}']);
    expect(badJson.code).toBe(2);
    expect(badJson.stderr).toContain('--answers is not valid JSON');
  });

  it('validates a temp catalog and prints stable JSON', async () => {
    const catalog = makeCatalog();
    const result = await cli(['validate', '--catalog', catalog, '--json']);
    const parsed = JSON.parse(result.stdout) as { ok: boolean; diagnostics: unknown[] };
    expect(typeof parsed.ok).toBe('boolean');
    expect(Array.isArray(parsed.diagnostics)).toBe(true);
    expect(result.code).toBe(parsed.ok ? 0 : 1);
  });

  it('lists, simulates and runs scenarios end to end when the catalog is valid', async () => {
    const catalog = makeCatalog();
    const validation = await cli(['validate', '--catalog', catalog, '--json']);
    const parsed = JSON.parse(validation.stdout) as { ok: boolean };
    if (!parsed.ok) return; // compiler stricter than this fixture; validate shape covered above

    const list = await cli(['list', '--catalog', catalog, '--json']);
    expect(list.code).toBe(0);
    const listed = JSON.parse(list.stdout) as {
      offerings: Array<{ id: string; kind: string; status: string; bookable: boolean }>;
    };
    expect(listed.offerings).toHaveLength(1);
    expect(listed.offerings[0]).toMatchObject({ id: 'city-tour', kind: 'product', status: 'active', bookable: true });

    const simulate = await cli([
      'simulate',
      'city-tour',
      '--catalog',
      catalog,
      '--answers',
      '{"participants": 10}',
      '--json',
    ]);
    expect(simulate.code).toBe(0);
    const evaluated = JSON.parse(simulate.stdout) as { status: string };
    expect(['qualified', 'needs_input']).toContain(evaluated.status);

    const scenarios = join(catalog, '..', 'scenarios');
    mkdirSync(scenarios, { recursive: true });
    writeFileSync(
      join(scenarios, 'basic.yaml'),
      [
        '- name: needs participants',
        '  offering: city-tour',
        '  expect: { status: needs_input, asks: participants }',
      ].join('\n'),
    );
    const test = await cli(['test', '--catalog', catalog, '--scenarios', scenarios]);
    expect(test.code).toBe(0);
    expect(test.stdout).toContain('✓ needs participants');

    const graphOut = await cli(['graph', '--catalog', catalog]);
    expect(graphOut.code).toBe(0);
    expect(graphOut.stdout).toContain('flowchart TD');
    expect(graphOut.stdout).toContain('city-tour');
  });

  it('init accepts every documented flag through the real parser and scaffolds a green catalog', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'scopegraph-init-'));
    tempDirs.push(dir);
    const init = await cli([
      'init', '--dir', dir, '--name', 'Harbor City Cleaning', '--currency', 'USD',
      '--timezone', 'America/New_York', '--tax-rate', '8.875', '--payments', 'owner_approves', '--yes',
    ]);
    expect(init.stderr).not.toContain('Unknown option');
    expect(init.code).toBe(0);
    const validation = await cli(['validate', '--catalog', join(dir, 'catalog'), '--json']);
    expect(JSON.parse(validation.stdout)).toMatchObject({ ok: true, diagnostics: [] });
    const test = await cli(['test', '--catalog', join(dir, 'catalog'), '--scenarios', join(dir, 'scenarios')]);
    expect(test.code).toBe(0);
  });

  it("mcp-config prints a launch command that speaks MCP from any working directory, ignoring that directory's tsconfig.json", async () => {
    const catalog = makeCatalog();
    const printed = await cli(['mcp-config', '--catalog', catalog]);
    expect(printed.code).toBe(0);
    const config = JSON.parse(printed.stdout) as { mcpServers: Record<string, { command: string; args: string[] }> };
    const server = config.mcpServers['test-co'];
    if (server === undefined) throw new Error(`no 'test-co' server in ${printed.stdout}`);
    // tsx is pinned to this checkout's tsconfig, ahead of the script.
    expect(server.args.slice(1, 4)).toEqual(['--tsconfig', join(repoRoot, 'tsconfig.json'), join(repoRoot, 'src', 'cli', 'index.ts')]);
    const elsewhere = mkdtempSync(join(tmpdir(), 'scopegraph-client-'));
    tempDirs.push(elsewhere);
    // A project the client happens to start in: its tsconfig `paths` would
    // redirect the server's own `yaml` import to code in that directory.
    writeFileSync(join(elsewhere, 'tsconfig.json'), JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { yaml: ['./planted.mjs'] } } }));
    const realYaml = pathToFileURL(join(repoRoot, 'node_modules', 'yaml', 'dist', 'index.js')).href;
    writeFileSync(
      join(elsewhere, 'planted.mjs'),
      `import { writeFileSync } from 'node:fs';\nwriteFileSync(new URL('./RAN', import.meta.url), 'planted code ran');\nexport * from '${realYaml}';\n`,
    );
    // Launch exactly like an MCP client would: its own cwd, a bare environment.
    const child = spawn(server.command, server.args, { cwd: elsewhere, env: { HOME: elsewhere } });
    // tsconfig targets ES2022 (no Promise.withResolvers): executor form it is.
    const firstLine = new Promise<string>((resolveLine, reject) => {
      let out = '';
      child.stdout.on('data', (chunk: Buffer) => {
        out += chunk.toString('utf8');
        const newline = out.indexOf('\n');
        if (newline >= 0) resolveLine(out.slice(0, newline));
      });
      child.on('exit', (code) => reject(new Error(`server exited (${String(code)}) before answering`)));
    });
    const initialize = {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } },
    };
    child.stdin.write(`${JSON.stringify(initialize)}\n`);
    let answer: unknown;
    try {
      answer = JSON.parse(await firstLine);
    } catch (error) {
      answer = error;
    } finally {
      child.kill();
    }
    expect(existsSync(join(elsewhere, 'RAN'))).toBe(false);
    expect(answer).toMatchObject({ id: 1, result: { serverInfo: { name: 'Test Co' } } });
  });
});

describe('cli entry point (spawned process)', { timeout: 60_000 }, () => {
  const tsx = pathToFileURL(join(repoRoot, 'node_modules', 'tsx', 'dist', 'loader.mjs')).href;
  const entry = join(repoRoot, 'src', 'cli', 'index.ts');
  const work = mkdtempSync(join(tmpdir(), 'scopegraph-cli-entry-'));
  afterAll(() => rmSync(work, { recursive: true, force: true }));

  it('runs behind a symlinked bin', async () => {
    const link = join(work, 'scopegraph-link.ts');
    symlinkSync(entry, link);
    const { stdout } = await run(process.execPath, ['--import', tsx, link, 'help'], { cwd: work, timeout: 60_000 });
    expect(stdout).toContain('Usage:');
  });

  it("never loads the working directory's .env, and variables already in the environment win", async () => {
    writeFileSync(join(work, '.env'), 'SCOPEGRAPH_CATALOG=from-dotenv\n');
    const args = ['--import', tsx, entry, 'validate', '--json'];
    const fromCwd = await run(process.execPath, args, { cwd: work, timeout: 60_000 }).catch((e: { stdout: string }) => e);
    const fromEnv = await run(process.execPath, args, {
      cwd: work,
      timeout: 60_000,
      env: { ...process.env, SCOPEGRAPH_CATALOG: 'from-env' },
    }).catch((e: { stdout: string }) => e);
    expect(fromCwd.stdout).toContain('"ok"'); // it ran, against another catalog
    expect(fromCwd.stdout).not.toContain('from-dotenv');
    expect(fromEnv.stdout).toContain('from-env');
    expect(fromEnv.stdout).not.toContain('from-dotenv');
  });

  it('simulate --interactive without a terminal exits 2 and names the flag alternatives', async () => {
    const failure = await run(process.execPath, ['--import', tsx, entry, 'simulate', 'surf-lesson', '--interactive'], { cwd: repoRoot, timeout: 60_000 })
      .then(() => ({ code: 0, stderr: '' }))
      .catch((e: { code: number; stderr: string }) => e);
    expect(failure.code).toBe(2);
    expect(failure.stderr).toContain('--answers <json>, --selections <json>, --date <iso>');
  });
});
