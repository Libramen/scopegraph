import * as http from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import type { Express } from 'express';
import type { IncomingMessage, Server } from 'node:http';
import { afterEach, afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Graph } from '../graph/types.js';
import { clientBucketKey, createApp, FixedWindowLimiter, parseTrustProxy } from './app.js';
import { buildFactsGraph, buildTestGraph } from './test-graph.js';

// tsconfig targets ES2022 (no Promise.withResolvers): executor form it is.
function listen(app: Express): Promise<Server> {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1');
    server.once('listening', () => resolve(server));
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
  });
}

function baseUrl(server: Server): string {
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

function post(url: string, body: unknown): Promise<Response> {
  return fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

describe('createApp HTTP surface', () => {
  let server: Server;
  let base: string;

  beforeAll(async () => {
    server = await listen(createApp({ getGraph: buildTestGraph }));
    base = baseUrl(server);
  });

  afterAll(async () => {
    await close(server);
  });

  it('GET /health reports ok and the offering count', async () => {
    const res = await fetch(`${base}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, offerings: 1 });
  });

  it('GET /api/business returns public business info', async () => {
    const res = await fetch(`${base}/api/business`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      name: 'Kelp Point Surf School',
      description: 'Surf lessons on a quiet point break.',
      website: 'https://kelppoint.example',
      currency: 'USD',
      timezone: 'America/Halifax',
    });
  });

  it('GET /api/offerings lists and filters with q', async () => {
    const all = (await (await fetch(`${base}/api/offerings`)).json()) as {
      offerings: Array<{ id: string; name: string; kind: string }>;
    };
    expect(all.offerings).toHaveLength(1);
    expect(all.offerings[0]).toMatchObject({
      id: 'surf-lesson',
      name: 'Surf Lesson',
      kind: 'product',
    });

    const none = (await (
      await fetch(`${base}/api/offerings?q=kayaking`)
    ).json()) as { offerings: unknown[] };
    expect(none.offerings).toEqual([]);

    const hit = (await (
      await fetch(`${base}/api/offerings?q=surf`)
    ).json()) as { offerings: unknown[] };
    expect(hit.offerings).toHaveLength(1);
  });

  it('GET /api/offerings/:id shows an overview without questions or choices by default (progressive), or 404s', async () => {
    const res = await fetch(`${base}/api/offerings/surf-lesson`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ id: 'surf-lesson', disclosure: 'progressive', timezone: 'America/Halifax' });
    expect(body.next).toBe('Scope this offering with what the buyer has told you (MCP: scope_offering; HTTP: POST /api/offerings/surf-lesson/scope); it asks one question at a time.');
    expect(body).not.toHaveProperty('questions');
    expect(body).not.toHaveProperty('choices');

    const missing = await fetch(`${base}/api/offerings/nope`);
    expect(missing.status).toBe(404);
    const missingBody = (await missing.json()) as { error: string };
    expect(missingBody.error).toBe('not_found');
  });

  it('GET /api/offerings/:id publishes questions and choices under disclosure: menu', async () => {
    const menuGraph = buildTestGraph();
    menuGraph.business.disclosure = 'menu';
    const menuServer = await listen(createApp({ getGraph: () => menuGraph }));
    try {
      const body = (await (await fetch(`${baseUrl(menuServer)}/api/offerings/surf-lesson`)).json()) as {
        disclosure: string;
        questions: Array<{ key: string }>;
        choices: Array<{ key: string }>;
      };
      expect(body.disclosure).toBe('menu');
      expect(body.questions.map((q) => q.key)).toEqual(['participants']);
      expect(body.choices.map((c) => c.key)).toEqual(['board']);
    } finally {
      await close(menuServer);
    }
  });

  it('llms.txt never lists questions or add-ons under progressive disclosure (the from-price may name its per-unit count)', async () => {
    const text = await (await fetch(`${base}/llms.txt`)).text();
    expect(text).not.toMatch(/board/i);
    expect(text).not.toMatch(/questions|choices/i);
  });

  it('POST scope returns needs_input (200) then qualified (200) with next', async () => {
    const needs = await post(`${base}/api/offerings/surf-lesson/scope`, {});
    expect(needs.status).toBe(200);
    const needsBody = (await needs.json()) as {
      status: string;
      question: { key: string };
    };
    expect(needsBody.status).toBe('needs_input');
    expect(needsBody.question.key).toBe('participants');

    const qualified = await post(`${base}/api/offerings/surf-lesson/scope`, {
      answers: { participants: 2 },
    });
    expect(qualified.status).toBe(200);
    const body = (await qualified.json()) as {
      status: string;
      quote: { currency: string; totalCents: number };
      summary: { answers: Record<string, unknown>; selections: Record<string, unknown> };
      next?: { url: string; message: string };
      trace?: unknown;
    };
    expect(body.status).toBe('qualified');
    expect(body.quote.currency).toBe('USD');
    expect(body.quote.totalCents).toBe(14_600);
    expect(body.summary.answers).toEqual({ participants: 2 });
    expect(body.summary.selections).toEqual({});
    expect(body.next).toEqual({
      url: 'https://bookings.kelppoint.example/surf-lesson?amount=14600&participants=2',
      message: 'Reserve your lesson',
    });
    // Traces are stripped from public responses unless EXPOSE_TRACE.
    expect('trace' in body).toBe(false);
  });

  it('POST scope prices option selections and includes them in the hand-off params', async () => {
    const res = await post(`${base}/api/offerings/surf-lesson/scope`, {
      answers: { participants: 2 },
      selections: { board: 'epoxy' },
    });
    const body = (await res.json()) as {
      status: string;
      quote: { totalCents: number };
      next?: { url: string };
    };
    expect(body.status).toBe('qualified');
    expect(body.quote.totalCents).toBe(16_100);
    expect(body.next?.url).toBe(
      'https://bookings.kelppoint.example/surf-lesson?amount=16100&participants=2&board=epoxy',
    );
  });

  it('POST scope 400s on malformed bodies', async () => {
    for (const bad of [
      '"just a string"',
      '[1,2]',
      '{"answers": "nope"}',
      '{"selections": {"board": 7}}',
      '{"date": 42}',
    ]) {
      const res = await post(`${base}/api/offerings/surf-lesson/scope`, bad);
      expect(res.status, bad).toBe(400);
      const errorBody = (await res.json()) as { error: string };
      expect(errorBody.error).toBe('invalid_request');
    }
  });

  it('POST /api/… with a non-JSON body gets 415; a bodyless POST is still scoped', async () => {
    const form = await fetch(`${base}/api/offerings/surf-lesson/scope`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'answers[participants]=2',
    });
    expect(form.status).toBe(415);
    expect(await form.json()).toMatchObject({ error: 'unsupported_media_type' });
    const bare = await fetch(`${base}/api/offerings/surf-lesson/scope`, { method: 'POST' });
    expect(bare.status).toBe(200);
    expect(await bare.json()).toMatchObject({ status: 'needs_input' });
  });

  it('unknown routes get a JSON 404, never an HTML page', async () => {
    for (const path of ['/', '/api', '/api/nope', '/nope/deeper']) {
      const res = await fetch(`${base}${path}`);
      expect(res.status, path).toBe(404);
      expect(res.headers.get('content-type'), path).toContain('application/json');
      expect(await res.json(), path).toMatchObject({ error: 'not_found' });
    }
  });

  it('POST scope returns unavailable (200) for an unknown offering', async () => {
    const res = await post(`${base}/api/offerings/ghost/scope`, {});
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; code: string };
    expect(body.status).toBe('unavailable');
    expect(body.code).toBe('NOT_FOUND');
  });

  it('SECURITY: caller-supplied facts are ignored — required facts fail closed', async () => {
    const factsServer = await listen(
      createApp({ getGraph: buildFactsGraph, allowedOrigins: [], rateLimitPerMinute: 1000 }),
    );
    try {
      // A forged `facts.vip_open` must not reach the engine: with the default
      // getFacts (server-side, returns {}) the required fact is missing.
      const res = await post(`${baseUrl(factsServer)}/api/offerings/dawn-patrol/scope`, {
        facts: { vip_open: true },
        answers: {},
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        status: string;
        reasons: Array<{ code: string }>;
      };
      expect(body.status).toBe('blocked');
      expect(body.reasons[0]?.code).toBe('FACTS_UNAVAILABLE');
    } finally {
      await close(factsServer);
    }
  });

  it('GET /.well-known/mcp.json advertises the MCP endpoint and tools', async () => {
    const res = await fetch(`${base}/.well-known/mcp.json`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      name: string;
      transport: string;
      url: string;
      tools: Array<{ name: string }>;
    };
    expect(body.name).toBe('Kelp Point Surf School');
    expect(body.transport).toBe('streamable-http');
    expect(body.url).toBe(`${base}/mcp`);
    expect(body.tools.map((t) => t.name)).toEqual([
      'list_offerings',
      'describe_offering',
      'scope_offering',
    ]);
  });

  it('GET /.well-known/mcp.json prefers PUBLIC_URL for the endpoint URL', async () => {
    const previous = process.env['PUBLIC_URL'];
    process.env['PUBLIC_URL'] = 'https://scope.example.com/';
    try {
      const body = (await (await fetch(`${base}/.well-known/mcp.json`)).json()) as {
        url: string;
      };
      expect(body.url).toBe('https://scope.example.com/mcp');
    } finally {
      if (previous === undefined) delete process.env['PUBLIC_URL'];
      else process.env['PUBLIC_URL'] = previous;
    }
  });

  it('GET /llms.txt renders a markdown brief with offerings and both APIs', async () => {
    const res = await fetch(`${base}/llms.txt`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/plain');
    const text = await res.text();
    expect(text).toContain('# Kelp Point Surf School');
    expect(text).toContain('`surf-lesson`');
    expect(text).toContain('/mcp');
    expect(text).toContain('/api/offerings/:id/scope');
    expect(text).toContain('Timezone: America/Halifax');
    expect(text).toContain('Every scoping outcome is HTTP 200; a malformed request gets 400');
    expect(text).not.toContain('every outcome is HTTP 200');
  });
});

describe('CORS', () => {
  it('preflights allowed origins and echoes them', async () => {
    const server = await listen(
      createApp({
        getGraph: buildTestGraph,
        allowedOrigins: ['https://partner.example'],
        rateLimitPerMinute: 1000,
      }),
    );
    const base = baseUrl(server);
    try {
      const allowed = await fetch(`${base}/api/offerings/surf-lesson/scope`, {
        method: 'OPTIONS',
        headers: {
          origin: 'https://partner.example',
          'access-control-request-method': 'POST',
          'access-control-request-headers': 'content-type',
        },
      });
      expect(allowed.status).toBe(204);
      expect(allowed.headers.get('access-control-allow-origin')).toBe('https://partner.example');
      expect(allowed.headers.get('access-control-allow-methods')).toContain('POST');

      const denied = await fetch(`${base}/api/offerings`, {
        method: 'OPTIONS',
        headers: {
          origin: 'https://evil.example',
          'access-control-request-method': 'GET',
        },
      });
      expect(denied.status).toBe(204);
      expect(denied.headers.get('access-control-allow-origin')).toBeNull();
    } finally {
      await close(server);
    }
  });

  it("supports '*' wildcard mode", async () => {
    const server = await listen(
      createApp({ getGraph: buildTestGraph, allowedOrigins: ['*'], rateLimitPerMinute: 1000 }),
    );
    try {
      const res = await fetch(`${baseUrl(server)}/api/offerings`, {
        headers: { origin: 'https://anywhere.example' },
      });
      expect(res.headers.get('access-control-allow-origin')).toBe('*');
    } finally {
      await close(server);
    }
  });

  it('sets no CORS headers when no origin is configured', async () => {
    const server = await listen(
      createApp({ getGraph: buildTestGraph, allowedOrigins: [], rateLimitPerMinute: 1000 }),
    );
    try {
      const res = await fetch(`${baseUrl(server)}/api/offerings`, {
        headers: { origin: 'https://anywhere.example' },
      });
      expect(res.headers.get('access-control-allow-origin')).toBeNull();
    } finally {
      await close(server);
    }
  });
});

describe('rate limiting', () => {
  it('429s per IP beyond the fixed window limit, with Retry-After; /health unlimited', async () => {
    const server = await listen(
      createApp({ getGraph: buildTestGraph, rateLimitPerMinute: 3 }),
    );
    try {
      const base = baseUrl(server);
      const statuses: number[] = [];
      for (let i = 0; i < 4; i += 1) {
        statuses.push((await fetch(`${base}/api/offerings`)).status);
      }
      expect(statuses).toEqual([200, 200, 200, 429]);
      const limited = await fetch(`${base}/api/offerings`);
      expect(limited.headers.get('retry-after')).toMatch(/^\d+$/);
      const limitedBody = (await limited.json()) as { error: string };
      expect(limitedBody.error).toBe('rate_limited');

      const health = await fetch(`${base}/health`);
      expect(health.status).toBe(200);
    } finally {
      await close(server);
    }
  });
});

describe('TRUST_PROXY', () => {
  it('parses false, hop counts and address lists', () => {
    expect(parseTrustProxy(undefined)).toBeUndefined();
    expect(parseTrustProxy('  ')).toBeUndefined();
    expect(parseTrustProxy('false')).toBe(false);
    expect(parseTrustProxy('1')).toBe(1);
    expect(parseTrustProxy('loopback, 10.0.0.0/8')).toBe('loopback, 10.0.0.0/8');
  });

  it('refuses `true`: it would trust the client-written X-Forwarded-For', () => {
    const message = 'TRUST_PROXY=true trusts client-written X-Forwarded-For; set the number of proxies in front (e.g. 1)';
    for (const raw of ['true', ' TRUE ', 'True']) expect(() => parseTrustProxy(raw)).toThrow(message);
  });

  it('refuses ranges broad enough to trust every client; normal proxy addresses and ranges still parse', () => {
    const broad = [
      ['0.0.0.0/1,128.0.0.0/1,::/1,8000::/1', '0.0.0.0/1'],
      ['10.0.0.0/8, 0.0.0.0/0', '0.0.0.0/0'],
      ['10.0.0.0/7', '10.0.0.0/7'],
      ['0.0.0.0/128.0.0.0', '0.0.0.0/128.0.0.0'],
      ['2001:db8::/32, ::/0', '::/0'],
      ['2000::/3', '2000::/3'],
      ['::ffff:0:0/96', '::ffff:0:0/96'],
    ] as const;
    for (const [raw, entry] of broad) {
      expect(() => parseTrustProxy(raw), raw).toThrow(`TRUST_PROXY range ${entry} trusts too many addresses; list your proxy's addresses or use the hop count (e.g. 1)`);
    }
    for (const raw of ['10.0.0.0/8', '172.16.0.0/12, 192.168.0.0/16', '203.0.113.7', '10.0.0.0/255.0.0.0', 'fd00::/16', '2001:db8::/32', '::ffff:10.0.0.0/104', 'loopback, uniquelocal', '2']) {
      expect(() => parseTrustProxy(raw), raw).not.toThrow();
    }
  });

  it('behind a trusted proxy the limiter keys on the client IP, not the proxy', async () => {
    const trusted = await listen(createApp({ getGraph: buildTestGraph, rateLimitPerMinute: 1, trustProxy: 'loopback' }));
    const untrusted = await listen(createApp({ getGraph: buildTestGraph, rateLimitPerMinute: 1 }));
    try {
      const from = (ip: string) => ({ headers: { 'x-forwarded-for': ip } });
      expect((await fetch(`${baseUrl(trusted)}/api/offerings`, from('203.0.113.1'))).status).toBe(200);
      expect((await fetch(`${baseUrl(trusted)}/api/offerings`, from('203.0.113.2'))).status).toBe(200);
      expect((await fetch(`${baseUrl(trusted)}/api/offerings`, from('203.0.113.2'))).status).toBe(429);
      // Without trust proxy every client behind the proxy shares one bucket.
      expect((await fetch(`${baseUrl(untrusted)}/api/offerings`, from('203.0.113.1'))).status).toBe(200);
      expect((await fetch(`${baseUrl(untrusted)}/api/offerings`, from('203.0.113.2'))).status).toBe(429);
    } finally {
      await close(trusted);
      await close(untrusted);
    }
  });
});

// ── Request limits and abuse resistance ───────────────────────────────────────

const MCP_HEADERS = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };

describe('request limits and abuse resistance', () => {
  const servers: Server[] = [];
  async function start(app: Express): Promise<string> {
    const server = await listen(app);
    servers.push(server);
    return baseUrl(server);
  }

  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(servers.splice(0).map(close));
  });

  it('a non-JSON /mcp upload gets 415 before the body is read (never buffered)', async () => {
    const base = await start(createApp({ getGraph: buildTestGraph, rateLimitPerMinute: 1000 }));
    const { port } = new URL(base);
    const req = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/mcp', headers: { 'content-type': 'text/plain' } });
    req.on('error', () => undefined);
    let response: IncomingMessage | undefined;
    const answered = new Promise<IncomingMessage>((resolve) => {
      req.once('response', (res: IncomingMessage) => {
        response = res;
        resolve(res);
      });
    });
    // An endless upload must be refused without being read into memory.
    const chunk = Buffer.alloc(1 << 20, 97);
    let sentMiB = 0;
    while (response === undefined && sentMiB < 64) {
      if (!req.write(chunk)) await Promise.race([once(req, 'drain'), answered]);
      sentMiB += 1;
    }
    const res = await answered;
    req.destroy();
    expect(res.statusCode).toBe(415);
    expect(sentMiB).toBeLessThan(64);
  });

  it('a JSON /mcp body over 32 kb is 413', async () => {
    const base = await start(createApp({ getGraph: buildTestGraph, rateLimitPerMinute: 1000 }));
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping', params: { pad: 'x'.repeat(40_000) } });
    const res = await fetch(`${base}/mcp`, { method: 'POST', headers: MCP_HEADERS, body });
    expect(res.status).toBe(413);
  });

  it('only POST gets the early 415; other methods reach the SDK, which caps what it reads', async () => {
    const base = await start(createApp({ getGraph: buildTestGraph, rateLimitPerMinute: 1000 }));
    expect((await fetch(`${base}/mcp`, { method: 'DELETE' })).status).toBe(405);
    const oversized = await fetch(`${base}/mcp`, { method: 'PUT', headers: { 'content-type': 'text/plain' }, body: 'x'.repeat(40_000) });
    expect(oversized.status).toBe(413);
  });

  it('path case and trailing slashes do not escape the limiter; unknown routes are limited; /health is not', async () => {
    const variants: Array<[string, RequestInit]> = [
      ['/API/offerings', {}],
      ['/api/offerings/', {}],
      ['/Api/Offerings/surf-lesson/Scope', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }],
      ['/Mcp', { method: 'POST', headers: MCP_HEADERS, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }) }],
      ['/mcp/', { method: 'POST', headers: MCP_HEADERS, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }) }],
      ['/LLMS.TXT', {}],
      ['/no-such-route', {}],
    ];
    for (const [path, init] of variants) {
      // A fresh app per variant: the 429 is this path's own.
      const base = await start(createApp({ getGraph: buildTestGraph, rateLimitPerMinute: 2 }));
      const statuses: number[] = [];
      for (let i = 0; i < 3; i += 1) statuses.push((await fetch(`${base}${path}`, init)).status);
      expect(statuses.slice(0, 2), path).not.toContain(429);
      expect(statuses[2], path).toBe(429);
    }
    const base = await start(createApp({ getGraph: buildTestGraph, rateLimitPerMinute: 1 }));
    for (let i = 0; i < 5; i += 1) {
      expect((await fetch(`${base}/health`)).status).toBe(200);
      expect((await fetch(`${base}/HEALTH/`)).status).toBe(200);
    }
  });

  it('the limiter drops every stale counter when the window rolls', () => {
    const limiter = new FixedWindowLimiter(1);
    for (let i = 0; i < 1000; i += 1) expect(limiter.hit(`198.51.100.${String(i)}`, 1_000)).toBeUndefined();
    expect(limiter.size).toBe(1000);
    expect(limiter.hit('198.51.100.1', 2_000)).toBe(58);
    expect(limiter.hit('203.0.113.1', 61_000)).toBeUndefined();
    expect(limiter.size).toBe(1);
    expect(limiter.hit('198.51.100.1', 61_500)).toBeUndefined();
  });

  it('clients key by IPv4 address or IPv6 /64; IPv4-mapped IPv6 is plain IPv4', async () => {
    expect(clientBucketKey('203.0.113.5')).toBe('203.0.113.5');
    expect(clientBucketKey('::ffff:203.0.113.5')).toBe('203.0.113.5');
    expect(clientBucketKey('::FFFF:cb00:7105')).toBe('203.0.113.5');
    expect(clientBucketKey('2001:db8:1:2::1')).toBe('2001:db8:1:2::/64');
    expect(clientBucketKey('2001:0DB8:0001:0002:ffff:0:0:9')).toBe('2001:db8:1:2::/64');
    expect(clientBucketKey('2001:db8::1')).toBe('2001:db8:0:0::/64');
    expect(clientBucketKey('fe80::1%en0')).toBe('fe80:0:0:0::/64');
    expect(clientBucketKey('::1')).toBe('0:0:0:0::/64');

    const fetchFrom = async (base: string, ip: string) => (await fetch(`${base}/api/offerings`, { headers: { 'x-forwarded-for': ip } })).status;
    const sixtyFour = await start(createApp({ getGraph: buildTestGraph, rateLimitPerMinute: 1, trustProxy: 'loopback' }));
    expect(await fetchFrom(sixtyFour, '2001:db8:1:2::1')).toBe(200);
    expect(await fetchFrom(sixtyFour, '2001:db8:1:2:dead:beef:0:7')).toBe(429);
    expect(await fetchFrom(sixtyFour, '2001:db8:1:3::1')).toBe(200);
    const mapped = await start(createApp({ getGraph: buildTestGraph, rateLimitPerMinute: 1, trustProxy: 'loopback' }));
    expect(await fetchFrom(mapped, '::ffff:203.0.113.5')).toBe(200);
    expect(await fetchFrom(mapped, '203.0.113.5')).toBe(429);
    expect(await fetchFrom(mapped, '203.0.113.6')).toBe(200);
  });

  it('rejected MCP requests log one bounded line each, never a stack', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const base = await start(createApp({ getGraph: buildTestGraph, rateLimitPerMinute: 1000 }));
    const junk = JSON.stringify({ jsonrpc: '2.0', id: 1, method: { nested: '\n'.repeat(50) }, params: 'x'.repeat(5_000) });
    for (const init of [
      { method: 'POST', headers: MCP_HEADERS, body: junk },
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: junk },
      { method: 'POST', headers: MCP_HEADERS, body: JSON.stringify({ not: 'json-rpc' }) },
    ]) {
      const res = await fetch(`${base}/mcp`, init);
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(res.status).toBeLessThan(500);
    }
    expect(errors).toHaveBeenCalled();
    for (const args of errors.mock.calls) {
      expect(args).toHaveLength(1);
      const [line] = args as [unknown];
      expect(typeof line).toBe('string');
      expect(line as string).not.toContain('\n');
      expect((line as string).length).toBeLessThan(300);
    }
  });

  it('Host-derived discovery documents are no-store; PUBLIC_URL ones are cacheable', async () => {
    const previous = process.env['PUBLIC_URL'];
    delete process.env['PUBLIC_URL'];
    try {
      const base = await start(createApp({ getGraph: buildTestGraph, rateLimitPerMinute: 1000 }));
      for (const path of ['/.well-known/mcp.json', '/llms.txt']) {
        // fetch cannot forge Host; the link is built from it all the same.
        const hostDerived = await fetch(`${base}${path}`);
        expect(hostDerived.headers.get('cache-control'), path).toBe('no-store');
        expect(await hostDerived.text()).toContain(base);
      }
      process.env['PUBLIC_URL'] = 'https://scope.example.com';
      for (const path of ['/.well-known/mcp.json', '/llms.txt']) {
        expect((await fetch(`${base}${path}`)).headers.get('cache-control'), path).toBeNull();
      }
    } finally {
      if (previous === undefined) delete process.env['PUBLIC_URL'];
      else process.env['PUBLIC_URL'] = previous;
    }
  });

  it('an exposed trace carries no fact values, internal parameters or unapplied pricing', async () => {
    const graph = buildTestGraph();
    const lesson = graph.offerings['surf-lesson'];
    if (lesson === undefined) throw new Error('fixture: surf-lesson missing');
    const traced: Graph = {
      // The default getFacts answers `tide_ft: 3` whenever the business declares `tide_ft`.
      business: { ...graph.business, facts: { tide_ft: { name: 'tide_ft', type: 'number', required: false } } },
      offerings: {
        'surf-lesson': {
          ...lesson,
          scope: {
            ...lesson.scope,
            parameters: [
              ...lesson.scope.parameters,
              { name: 'margin_pct', label: 'Margin', type: 'integer', required: false, default: 35, internal: true, ownerOfferingId: 'surf-lesson' },
            ],
            adjustments: [{
              id: 'surf-lesson.big-swell',
              label: 'Secret big-swell surcharge',
              kind: 'surcharge',
              method: { type: 'fixed', amountCents: 2000 },
              when: { ref: 'fact', name: 'tide_ft', op: 'gte', value: 6 },
              taxable: true,
              order: 300,
              ownerOfferingId: 'surf-lesson',
            }],
          },
        },
      },
    };
    const base = await start(createApp({ getGraph: () => traced, exposeTrace: true, rateLimitPerMinute: 1000 }));
    const res = await post(`${base}/api/offerings/surf-lesson/scope`, { answers: { participants: 2 }, selections: { board: 'epoxy' } });
    const body = (await res.json()) as { status: string; trace: { values: Record<string, unknown>; pricing: Array<{ id: string; applied: boolean }> } };
    expect(body.status).toBe('qualified');
    expect(body.trace.values).toEqual({ participants: 2 });
    expect(body.trace.pricing.map((p) => p.id)).toEqual(['surf-lesson.board.epoxy.price']);
    expect(JSON.stringify(body)).not.toContain('big-swell');
  });

  it('GET /api/offerings rejects a q longer than 200 characters', async () => {
    const base = await start(createApp({ getGraph: buildTestGraph, rateLimitPerMinute: 1000 }));
    const tooLong = await fetch(`${base}/api/offerings?q=${'s'.repeat(201)}`);
    expect(tooLong.status).toBe(400);
    expect(((await tooLong.json()) as { error: string }).error).toBe('invalid_request');
    expect((await fetch(`${base}/api/offerings?q=${'s'.repeat(200)}`)).status).toBe(200);
  });
});
