import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import type { Express } from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client, StreamableHTTPClientTransport, InMemoryTransport } from '@modelcontextprotocol/client';
import type { CallToolResult } from '@modelcontextprotocol/client';
import { createApp } from './app.js';
import { SERVER_VERSION, createScopeMcpServer } from './mcp.js';
import { buildFactsGraph, buildTestGraph } from './test-graph.js';

/**
 * Round-trip through the real SDK: an official `Client` speaks Streamable
 * HTTP to `POST /mcp` over a listening socket — the same wire a buyer agent
 * uses. Exercises list tools, describe, and the needs_input → qualified
 * scoping loop, plus the facts boundary.
 */

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


function endpointUrl(server: Server): URL {
  return new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`);
}

describe('MCP endpoint (/mcp)', () => {
  let server: Server;
  let client: Client;

  beforeAll(async () => {
    server = await listen(createApp({ getGraph: buildTestGraph, rateLimitPerMinute: 1000 }));
    client = new Client({ name: 'scopegraph-test-client', version: '1.0.0' }, { capabilities: {} });
    await client.connect(new StreamableHTTPClientTransport(endpointUrl(server)));
  });

  afterAll(async () => {
    await client.close().catch(() => undefined);
    await close(server);
  });

  it('instructions name the business timezone and the refusal and quote-not-booking rules', () => {
    const instructions = client.getInstructions() ?? '';
    expect(instructions).toContain("The business's timezone is America/Halifax");
    expect(instructions).toContain('never change truthful answers to get around it');
    expect(instructions).toContain('a quote, not a booking');
  });

  it('lists the three scoping tools', async () => {
    const result = await client.listTools();
    expect(result.tools.map((t) => t.name)).toEqual([
      'list_offerings',
      'describe_offering',
      'scope_offering',
    ]);
    for (const tool of result.tools) {
      expect(tool.inputSchema.type).toBe('object');
      expect(tool.description).toBeTruthy();
    }
    const scope = result.tools.find((t) => t.name === 'scope_offering');
    expect(scope?.annotations?.readOnlyHint).toBe(true);
  });

  it('list_offerings returns the catalog', async () => {
    const result = (await client.callTool({
      name: 'list_offerings',
      arguments: {},
    })) as CallToolResult;
    const offerings = result.structuredContent as {
      offerings: Array<{ id: string; name: string }>;
    };
    expect(offerings.offerings).toHaveLength(1);
    expect(offerings.offerings[0]?.id).toBe('surf-lesson');
    expect(result.content[0]).toMatchObject({ type: 'text' });
  });

  it('list_offerings rejects a query longer than 200 characters', async () => {
    const tooLong = (await client.callTool({ name: 'list_offerings', arguments: { query: 's'.repeat(201) } })) as CallToolResult;
    expect(tooLong.isError).toBe(true);
    expect(tooLong.structuredContent).toMatchObject({ error: 'invalid_arguments' });
    const longest = (await client.callTool({ name: 'list_offerings', arguments: { query: 's'.repeat(200) } })) as CallToolResult;
    expect(longest.isError).toBeFalsy();
  });

  it('describe_offering returns a progressive overview without questions or choices, or a not-found error', async () => {
    const result = (await client.callTool({
      name: 'describe_offering',
      arguments: { offering: 'surf-lesson' },
    })) as CallToolResult;
    const described = result.structuredContent as Record<string, unknown>;
    expect(described).toMatchObject({ id: 'surf-lesson', disclosure: 'progressive' });
    expect(described).not.toHaveProperty('questions');
    expect(described).not.toHaveProperty('choices');

    const missing = (await client.callTool({
      name: 'describe_offering',
      arguments: { offering: 'nope' },
    })) as CallToolResult;
    expect(missing.isError).toBe(true);
    expect(missing.structuredContent).toMatchObject({ error: 'not_found' });
  });

  it('walks scope_offering from needs_input to qualified with a hand-off', async () => {
    // Round 1: nothing known — the offering asks for its required parameter.
    const round1 = (await client.callTool({
      name: 'scope_offering',
      arguments: { offering: 'surf-lesson' },
    })) as CallToolResult;
    const needs = round1.structuredContent as { status: string; question: { key: string } };
    expect(needs.status).toBe('needs_input');
    expect(needs.question.key).toBe('participants');
    expect(needs).not.toHaveProperty('reason'); // why it is asked is trace-only

    // Round 2: the human answered — resubmit ALL accumulated input.
    const round2 = (await client.callTool({
      name: 'scope_offering',
      arguments: {
        offering: 'surf-lesson',
        answers: { participants: 2 },
        selections: { board: 'epoxy' },
      },
    })) as CallToolResult;
    const qualified = round2.structuredContent as {
      status: string;
      quote: { currency: string; totalCents: number };
      next?: { url: string; message: string };
    };
    expect(qualified.status).toBe('qualified');
    expect(qualified.quote.currency).toBe('USD');
    expect(qualified.quote.totalCents).toBe(16_100);
    expect(qualified.next?.url).toBe(
      'https://bookings.kelppoint.example/surf-lesson?amount=16100&participants=2&board=epoxy',
    );
    expect(qualified.next?.message).toBe('Reserve your lesson');
  });

  it('SECURITY: ignores a forged facts argument (facts fail closed server-side)', async () => {
    const factsServer = await listen(
      createApp({ getGraph: buildFactsGraph, rateLimitPerMinute: 1000 }),
    );
    const factsClient = new Client(
      { name: 'scopegraph-test-client', version: '1.0.0' },
      { capabilities: {} },
    );
    try {
      await factsClient.connect(new StreamableHTTPClientTransport(endpointUrl(factsServer)));
      const result = (await factsClient.callTool({
        name: 'scope_offering',
        // `facts` is not an accepted argument; it must be dropped before
        // evaluation, so the required business fact stays missing.
        arguments: { offering: 'dawn-patrol', facts: { vip_open: true } },
      })) as CallToolResult;
      const blocked = result.structuredContent as {
        status: string;
        reasons: Array<{ code: string }>;
      };
      expect(blocked.status).toBe('blocked');
      expect(blocked.reasons[0]?.code).toBe('FACTS_UNAVAILABLE');
    } finally {
      await factsClient.close().catch(() => undefined);
      await close(factsServer);
    }
  });

  it('returns an error result for an unknown tool', async () => {
    const result = (await client.callTool({
      name: 'does_not_exist',
      arguments: {},
    })) as CallToolResult;
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ error: 'unknown_tool' });
  });
});

describe('createScopeMcpServer over a direct transport (stdio-compatible)', () => {
  // The Streamable HTTP tests above exercise toNodeHandler wiring; this one
  // drives the same Server factory over InMemoryTransport — the transport-
  // independent path `runServe({ stdio: true })` uses via serveStdio.
  it('serves the same tools and scoping loop without HTTP', async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createScopeMcpServer(buildTestGraph, false);
    await server.connect(serverTransport);
    const client = new Client(
      { name: 'scopegraph-test-client', version: '1.0.0' },
      { capabilities: {} },
    );
    try {
      await client.connect(clientTransport);
      const tools = await client.listTools();
      expect(tools.tools).toHaveLength(3);
      const result = (await client.callTool({
        name: 'scope_offering',
        arguments: { offering: 'surf-lesson', answers: { participants: 3 } },
      })) as CallToolResult;
      const qualified = result.structuredContent as {
        status: string;
        quote: { totalCents: number };
      };
      expect(qualified.status).toBe('qualified');
      expect(qualified.quote.totalCents).toBe(3 * 7_300);
    } finally {
      await client.close().catch(() => undefined);
      await server.close().catch(() => undefined);
    }
  });
});

describe('SERVER_VERSION', () => {
  it('is the package.json version', () => {
    const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string };
    expect(SERVER_VERSION).toBe(pkg.version);
  });
});
