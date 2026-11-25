import { afterEach, describe, expect, it, vi } from 'vitest';
import { exposeTraceWarning, newestReloadWins, runServe } from './index.js';

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (err: unknown) => void;
}

// tsconfig targets ES2022 (no Promise.withResolvers): executor form it is.
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('serve --watch reloads', () => {
  it('a slower earlier reload never overwrites the graph of a newer one', async () => {
    const loads = [deferred<string>(), deferred<string>()];
    let calls = 0;
    const applied: string[] = [];
    const failed: unknown[] = [];
    const reload = newestReloadWins(
      () => {
        const load = loads[calls++];
        if (load === undefined) throw new Error('unexpected reload');
        return load.promise;
      },
      (graph) => applied.push(graph),
      (err) => failed.push(err),
    );

    const older = reload();
    const newer = reload();
    loads[1]?.resolve('catalog v2');
    await newer;
    loads[0]?.resolve('catalog v1');
    await older;
    expect(applied).toEqual(['catalog v2']);

    // A stale failure is not reported over the newer result either.
    const loadsAgain = [deferred<string>(), deferred<string>()];
    loads.splice(0, loads.length, ...loadsAgain);
    calls = 0;
    const olderFailing = reload();
    const newest = reload();
    loadsAgain[1]?.resolve('catalog v3');
    loadsAgain[0]?.reject(new Error('stale compile failed'));
    await Promise.all([olderFailing, newest]);
    expect(applied).toEqual(['catalog v2', 'catalog v3']);
    expect(failed).toEqual([]);
  });
});

describe('serve boot checks', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  /** Run runServe until it calls process.exit; return the exit code and everything written to stderr. */
  async function bootUntilExit(): Promise<{ code: unknown; stderr: string[] }> {
    const stderr: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      stderr.push(args.map(String).join(' '));
    });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(process, 'exit').mockImplementation((code) => {
      throw new Error(`process.exit(${String(code)})`);
    });
    const outcome = await runServe({ catalogDir: 'catalog' }).then(() => 'resolved', (err: unknown) => err);
    return { code: outcome instanceof Error ? outcome.message : outcome, stderr };
  }

  it('refuses to start with TRUST_PROXY=true (client-written X-Forwarded-For)', async () => {
    vi.stubEnv('TRUST_PROXY', 'true');
    const { code, stderr } = await bootUntilExit();
    expect(code).toBe('process.exit(1)');
    expect(stderr).toContain('scopegraph: TRUST_PROXY=true trusts client-written X-Forwarded-For; set the number of proxies in front (e.g. 1)');
  });

  it('warns loudly on stderr when EXPOSE_TRACE=true under NODE_ENV=production', async () => {
    vi.stubEnv('EXPOSE_TRACE', 'true');
    vi.stubEnv('NODE_ENV', 'production');
    expect(exposeTraceWarning({ EXPOSE_TRACE: 'true', NODE_ENV: 'development' })).toBeUndefined();
    expect(exposeTraceWarning({ NODE_ENV: 'production' })).toBeUndefined();
    // TRUST_PROXY=true stops the boot right after the warning, before anything listens.
    vi.stubEnv('TRUST_PROXY', 'true');
    const { stderr } = await bootUntilExit();
    expect(stderr[0]).toMatch(/^scopegraph: WARNING: EXPOSE_TRACE=true with NODE_ENV=production\./);
  });
});
