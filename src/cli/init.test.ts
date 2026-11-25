/**
 * `scopegraph init`: the generated starter must validate with zero errors
 * AND zero warnings and its scenarios must pass (checked here against the
 * real compiler + scenario runner, not init's own self-check); overwrite
 * protection, --force, flag/prompt resolution and the payments/tax variants.
 */
import { existsSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { SCHEMA_DIR } from '../catalog/schema-files.js';
import { loadGraph } from '../compile/index.js';
import { runScenarioFiles } from '../scenarios/run.js';
import { runInit } from './init.js';
import type { InitIo } from './init.js';

const tempDirs: string[] = [];
afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

function tmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'scopegraph-init-'));
  tempDirs.push(dir);
  return dir;
}

/** Non-interactive terminal: any prompt is a bug in init. */
function nullIo(): InitIo {
  return {
    interactive: false,
    ask: async () => {
      throw new Error('init asked a question while non-interactive');
    },
    confirm: async () => {
      throw new Error('init asked for confirmation while non-interactive');
    },
  };
}

/** Interactive terminal replaying scripted answers ('' = keep the default). */
function scriptedIo(
  answers: string[],
  confirmResult = false,
): InitIo & { questions: string[]; confirms: string[] } {
  const questions: string[] = [];
  const confirms: string[] = [];
  let next = 0;
  return {
    interactive: true,
    questions,
    confirms,
    ask: async (question) => {
      questions.push(question);
      const answer = answers[next] ?? '';
      next += 1;
      return answer;
    },
    confirm: async (question) => {
      confirms.push(question);
      return confirmResult;
    },
  };
}

function captureOutput(): () => { stdout: string; stderr: string } {
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

function seedExisting(root: string): void {
  mkdirSync(join(root, 'catalog', 'offerings'), { recursive: true });
  writeFileSync(join(root, 'catalog', 'offerings', 'keep.yaml'), 'kind: product\nname: Keep\nprice: 10\n');
}

describe('runInit non-interactive', () => {
  it('--yes generates a catalog that validates clean (0 errors, 0 warnings) and passes its scenarios', async () => {
    const dir = tmpDir();
    const read = captureOutput();
    const code = await runInit({ dir, yes: true }, nullIo());
    const { stdout, stderr } = read();
    expect(code).toBe(0);
    expect(stderr).toBe('');
    expect(existsSync(join(dir, 'catalog', 'business.yaml'))).toBe(true);
    expect(existsSync(join(dir, 'catalog', 'offerings', 'example-service.yaml'))).toBe(true);
    expect(existsSync(join(dir, 'scenarios', 'example-service.yaml'))).toBe(true);

    const loaded = await loadGraph(join(dir, 'catalog'));
    expect(loaded.graph).toBeDefined();
    expect(loaded.diagnostics).toEqual([]);

    const report = await runScenarioFiles(loaded.graph!, [join(dir, 'scenarios', 'example-service.yaml')]);
    expect(report.ok).toBe(true);
    expect(report.passed).toBe(3);
    expect(report.failed).toBe(0);

    expect(stdout).toContain('validates clean (0 errors, 0 warnings)');
    expect(stdout).toContain('scenarios pass (3 passed, 0 failed)');
    expect(stdout).toContain('AGENTS.md');
    expect(stdout).toContain('npm run validate');
    expect(stdout).toContain('npm run scenarios');
    expect(stdout).toContain('npm run simulate -- example-service --interactive');
    expect(stdout).toContain('npm run dev');
    // payments off: no doctor/env steps
    expect(stdout).not.toContain('npm run sg -- doctor');
    expect(stdout).not.toContain('.env.example');
  });

  it('defaults to My Business / USD / UTC with no payments block', async () => {
    const dir = tmpDir();
    const code = await runInit({ dir, yes: true }, nullIo());
    expect(code).toBe(0);
    const business = readFileSync(join(dir, 'catalog', 'business.yaml'), 'utf8');
    expect(business).toContain('name: "My Business"');
    expect(business).toContain('currency: USD');
    expect(business).toContain('timezone: "UTC"');
    expect(business).not.toMatch(/^payments:/m);
    expect(business).toContain('# payments:');
  });

  it('starts every generated file with a yaml-language-server modeline that resolves to the schema', async () => {
    const dir = tmpDir();
    expect(await runInit({ dir, yes: true }, nullIo())).toBe(0);
    const files = [
      ['catalog/business.yaml', 'business.schema.json'],
      ['catalog/offerings/example-service.yaml', 'offering.schema.json'],
      ['scenarios/example-service.yaml', 'scenarios.schema.json'],
    ] as const;
    for (const [file, schema] of files) {
      const firstLine = readFileSync(join(dir, file), 'utf8').split('\n')[0]!;
      const match = /^# yaml-language-server: \$schema=(.+)$/.exec(firstLine);
      expect(match, file).not.toBeNull();
      const target = resolve(dirname(join(dir, file)), match![1]!);
      expect(target).toBe(join(SCHEMA_DIR, schema));
      expect(existsSync(target), file).toBe(true);
    }
  });

  it('writes the payments block for owner_approves and instant, with the follow-up steps', async () => {
    for (const mode of ['owner_approves', 'instant'] as const) {
      const dir = tmpDir();
      const read = captureOutput();
      const code = await runInit({ dir, yes: true, payments: mode }, nullIo());
      const { stdout } = read();
      expect(code).toBe(0);
      const business = readFileSync(join(dir, 'catalog', 'business.yaml'), 'utf8');
      expect(business).toMatch(/^payments:$/m);
      expect(business).toContain(`confirmation: ${mode}`);
      expect(stdout).toContain('cp .env.example .env');
      expect(stdout).toContain('npm run sg -- doctor');
    }
  });

  it('bakes the exact taxed total into the qualified scenario (--tax-rate)', async () => {
    const dir = tmpDir();
    const code = await runInit({ dir, yes: true, taxRate: '10' }, nullIo());
    expect(code).toBe(0);
    const business = readFileSync(join(dir, 'catalog', 'business.yaml'), 'utf8');
    expect(business).toContain('taxRate: 10');
    const scenario = readFileSync(join(dir, 'scenarios', 'example-service.yaml'), 'utf8');
    expect(scenario).toContain('total: 148.5');
    expect(scenario).toContain('tax: 13.5');

    // The starter must still be green with tax — run it against the engine.
    const loaded = await loadGraph(join(dir, 'catalog'));
    const report = await runScenarioFiles(loaded.graph!, [join(dir, 'scenarios', 'example-service.yaml')]);
    expect(report.ok).toBe(true);
  });

  it('refuses to overwrite a non-empty catalog and leaves it untouched', async () => {
    const dir = tmpDir();
    seedExisting(dir);
    const read = captureOutput();
    const code = await runInit({ dir, yes: true }, nullIo());
    const { stderr } = read();
    expect(code).toBe(1);
    expect(stderr).toContain('refusing to overwrite');
    expect(stderr).toContain('--force');
    expect(existsSync(join(dir, 'catalog', 'offerings', 'keep.yaml'))).toBe(true);
    expect(existsSync(join(dir, 'catalog', 'offerings', 'example-service.yaml'))).toBe(false);
  });

  it('refuses to overwrite non-empty scenarios/ even when catalog/ is absent', async () => {
    const dir = tmpDir();
    mkdirSync(join(dir, 'scenarios'), { recursive: true });
    writeFileSync(join(dir, 'scenarios', 'keep.yaml'), '- name: keep\n');
    const code = await runInit({ dir, yes: true }, nullIo());
    expect(code).toBe(1);
    expect(existsSync(join(dir, 'scenarios', 'keep.yaml'))).toBe(true);
  });

  it('a plain file or a symlink named catalog/scenarios needs --force (never silently deleted)', async () => {
    const fileDir = tmpDir();
    writeFileSync(join(fileDir, 'catalog'), 'my notes\n');
    const read = captureOutput();
    expect(await runInit({ dir: fileDir, yes: true }, nullIo())).toBe(1);
    expect(read().stderr).toContain('--force');
    expect(readFileSync(join(fileDir, 'catalog'), 'utf8')).toBe('my notes\n');

    const linkDir = tmpDir();
    mkdirSync(join(linkDir, 'elsewhere'));
    symlinkSync(join(linkDir, 'elsewhere'), join(linkDir, 'scenarios'));
    const readLink = captureOutput();
    expect(await runInit({ dir: linkDir, yes: true }, nullIo())).toBe(1);
    readLink();
    expect(lstatSync(join(linkDir, 'scenarios')).isSymbolicLink()).toBe(true);
  });

  it('--force replaces the existing catalog and scenarios', async () => {
    const dir = tmpDir();
    seedExisting(dir);
    mkdirSync(join(dir, 'scenarios'), { recursive: true });
    writeFileSync(join(dir, 'scenarios', 'keep.yaml'), '- name: keep\n');
    const code = await runInit({ dir, yes: true, force: true }, nullIo());
    expect(code).toBe(0);
    expect(existsSync(join(dir, 'catalog', 'offerings', 'keep.yaml'))).toBe(false);
    expect(existsSync(join(dir, 'scenarios', 'keep.yaml'))).toBe(false);
    expect(existsSync(join(dir, 'catalog', 'offerings', 'example-service.yaml'))).toBe(true);
  });

  it('rejects flag misuse with exit code 2', async () => {
    const cases: Array<Record<string, string>> = [
      { currency: 'euros' },
      { timezone: 'Mars/Olympus' },
      { taxRate: '8.12345' },
      { taxRate: '150' },
      { payments: 'sometimes' },
      { name: '   ' },
      { name: 'n'.repeat(201) },
    ];
    for (const flags of cases) {
      const read = captureOutput();
      const code = await runInit({ dir: tmpDir(), yes: true, ...flags }, nullIo());
      const { stderr } = read();
      expect(code, `expected usage error for ${JSON.stringify(flags)}`).toBe(2);
      expect(stderr).toContain('error:');
      expect(stderr).toContain('Usage:');
    }
  });

  it('non-interactive without --yes and with missing flags is a usage error', async () => {
    const read = captureOutput();
    const code = await runInit({ dir: tmpDir() }, nullIo());
    const { stderr } = read();
    expect(code).toBe(2);
    expect(stderr).toContain('--yes');
    expect(stderr).toContain('Usage:');
  });

  it('non-interactive with every flag set works without --yes', async () => {
    const dir = tmpDir();
    const code = await runInit(
      { dir, name: 'Wave Co', currency: 'eur', timezone: 'Europe/Berlin', taxRate: '7', payments: 'off' },
      nullIo(),
    );
    expect(code).toBe(0);
    const business = readFileSync(join(dir, 'catalog', 'business.yaml'), 'utf8');
    expect(business).toContain('name: "Wave Co"');
    expect(business).toContain('currency: EUR');
    expect(business).toContain('timezone: "Europe/Berlin"');
    expect(business).toContain('taxRate: 7');
  });
});

describe('runInit interactive', () => {
  it('prompts for every missing value and accepts the defaults on empty answers', async () => {
    const dir = tmpDir();
    const io = scriptedIo([]);
    const code = await runInit({ dir }, io);
    expect(code).toBe(0);
    expect(io.questions).toHaveLength(5);
    expect(io.questions[0]).toContain('Business name');
    expect(io.questions[1]).toContain('Currency');
    expect(io.questions[2]).toContain('Timezone');
    expect(io.questions[3]).toContain('tax');
    expect(io.questions[4]).toContain('Payments');
    const business = readFileSync(join(dir, 'catalog', 'business.yaml'), 'utf8');
    expect(business).toContain('name: "My Business"');
  });

  it('--yes skips the prompts even on a terminal (defaults win)', async () => {
    const dir = tmpDir();
    const io = scriptedIo(['never used']);
    const code = await runInit({ dir, yes: true }, io);
    expect(code).toBe(0);
    expect(io.questions).toHaveLength(0);
    expect(readFileSync(join(dir, 'catalog', 'business.yaml'), 'utf8')).toContain('name: "My Business"');
  });

  it('skips prompts for values passed as flags and re-asks invalid answers', async () => {
    const dir = tmpDir();
    // currency invalid → re-asked; timezone, tax and payments answered once.
    const io = scriptedIo(['euro', 'EUR', 'Europe/Berlin', '12', 'instant']);
    const code = await runInit({ dir, name: 'Wave Co' }, io);
    expect(code).toBe(0);
    expect(io.questions).toHaveLength(5);
    expect(io.questions[0]).toContain('Currency');
    expect(io.questions[1]).toContain('Currency');
    expect(io.questions[2]).toContain('Timezone');
    const business = readFileSync(join(dir, 'catalog', 'business.yaml'), 'utf8');
    expect(business).toContain('name: "Wave Co"');
    expect(business).toContain('currency: EUR');
    expect(business).toContain('timezone: "Europe/Berlin"');
    expect(business).toContain('taxRate: 12');
    expect(business).toContain('confirmation: instant');
  });

  it('asks before overwriting: a declined confirm writes nothing, an accepted one does', async () => {
    const declined = tmpDir();
    seedExisting(declined);
    const no = scriptedIo([], false);
    const noCode = await runInit({ dir: declined }, no);
    expect(noCode).toBe(1);
    expect(no.confirms).toHaveLength(1);
    expect(no.confirms[0]).toContain('Replace');
    expect(existsSync(join(declined, 'catalog', 'offerings', 'keep.yaml'))).toBe(true);

    const accepted = tmpDir();
    seedExisting(accepted);
    const yes = scriptedIo([], true);
    const yesCode = await runInit({ dir: accepted }, yes);
    expect(yesCode).toBe(0);
    expect(existsSync(join(accepted, 'catalog', 'offerings', 'keep.yaml'))).toBe(false);
    expect(existsSync(join(accepted, 'catalog', 'offerings', 'example-service.yaml'))).toBe(true);
  });
});

describe('runInit currency', () => {
  it('refuses a currency without two minor units as a usage error (exit 2)', async () => {
    const dir = tmpDir();
    const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const code = await runInit({ dir, currency: 'jpy', yes: true });
    const written = errSpy.mock.calls.map((call) => String(call[0])).join('');
    errSpy.mockRestore();
    expect(code).toBe(2);
    expect(written).toContain("currency 'JPY' is not supported yet");
    expect(existsSync(join(dir, 'catalog'))).toBe(false);
  });
});
