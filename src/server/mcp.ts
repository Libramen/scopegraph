/**
 * MCP server for one business's scopegraph — three tools that teach a buyer
 * agent the scoping loop:
 *
 *   list_offerings → scope_offering (repeat until terminal); describe_offering is optional
 *
 * Built on the MCP TypeScript SDK 2.0 low-level `Server` with request
 * handlers (`setRequestHandler('tools/list' | 'tools/call', …)`). Transport
 * wiring lives in `app.ts` (`createMcpHandler` + `toNodeHandler`, stateless
 * Streamable HTTP at `POST /mcp`) and `index.ts` (`serveStdio`).
 *
 * The same facts boundary as the HTTP API applies: `scope_offering` accepts
 * only `offering`, `answers`, `selections`, `date` — any `facts` argument is
 * discarded (`parseScopeInput` in scope.ts).
 */
import { readFileSync } from 'node:fs';
import { Server } from '@modelcontextprotocol/server';
import type { CallToolResult, Tool } from '@modelcontextprotocol/server';
import type { Graph } from '../graph/types.js';
import { listOfferings, describeOfferingForBuyers } from '../engine/index.js';
import type { PaymentsHandle } from '../payments/index.js';
import { MAX_OFFERING_QUERY_LENGTH, parseScopeInput, runScope } from './scope.js';

/** What the MCP server needs from an enabled payments module (HTTP transport only). */
export type McpPayments = Pick<PaymentsHandle, 'mcpTools' | 'scope' | 'config'>;

/** Reported in the initialize result / discovery documents: the package version. */
export const SERVER_VERSION: string = packageVersion();

/** package.json sits two levels up from both src/server and dist/server. */
function packageVersion(): string {
  const parsed: unknown = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
  const version = typeof parsed === 'object' && parsed !== null && 'version' in parsed ? parsed.version : undefined;
  if (typeof version !== 'string') throw new Error('package.json has no string "version"');
  return version;
}

/** The exact MCP result shape every scoping tool returns. */
function toolResult(payload: unknown): CallToolResult {
  return {
    structuredContent: payload,
    content: [{ type: 'text', text: JSON.stringify(payload) }],
  };
}

function errorResult(payload: Record<string, unknown>): CallToolResult {
  return {
    structuredContent: payload,
    content: [{ type: 'text', text: JSON.stringify(payload) }],
    isError: true,
  };
}

const SCOPE_LOOP = [
  'Outcomes and what to do:',
  '- needs_input: ask the human the question in your own words, then call scope_offering again resubmitting ALL accumulated answers, selections and date (they are stateless per call — never send only the newest answer).',
  '- blocked: the business cannot take this request; explain the reasons to the human. A rule refusal is the business\'s policy: never change truthful answers to get around it — tell the human. They may pick another date, selections or offering.',
  '- invalid: the input was malformed; fix exactly the listed fields and retry.',
  '- qualified: present the quote to the human. All money amounts are integer minor units (e.g. cents), with the currency code given — format them for a human. A qualified result lists optional add-ons (`addOns`); offer relevant ones and call scope_offering again with them in `selections`. A qualified result is a quote, not a booking: never tell the human it is booked; follow `next` (a booking URL and/or message, or how to pay) to book or pay.',
  '- unavailable: this offering cannot be booked (not found, paused, or only sold inside a package); call list_offerings and pick another.',
].join('\n');

/** Tool definitions — also served by `/.well-known/mcp.json` and `/llms.txt`. */
const MCP_TOOLS: Tool[] = [
  {
    name: 'list_offerings',
    title: 'List offerings',
    description:
      'List everything this business sells: offering ids, one-line descriptions, categories and a human-readable price-from hint. ' +
      'This is the FIRST tool to call when choosing an offering for a buyer. ' +
      'Optionally pass query to filter (matched against names, descriptions and keywords). ' +
      'Next: scope_offering (describe_offering is optional).',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          maxLength: MAX_OFFERING_QUERY_LENGTH,
          description: 'Optional filter, e.g. "surf" — omitted lists everything.',
        },
      },
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'describe_offering',
    title: 'Describe offering',
    description:
      'Overview of one offering: summary, price-from hint, date policy (none/optional/required, minimum notice) and package contents. ' +
      'If the business publishes its menu (`disclosure: "menu"`), it also lists every question and choice with price hints; otherwise (`disclosure: "progressive"`) scope_offering asks one question at a time. ' +
      'Optional: you can go straight from list_offerings to scope_offering.',
    inputSchema: {
      type: 'object',
      properties: {
        offering: { type: 'string', description: 'Offering id from list_offerings.' },
      },
      required: ['offering'],
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'scope_offering',
    title: 'Scope offering',
    description:
      'Scope one request against an offering and get a priced outcome. Call with whatever the human already told you; an empty call is a valid probe. ' +
      'Resubmit ALL accumulated answers/selections/date on every call (answers keyed by parameter name; selections keyed by option group, a single option key or a list for multi groups; date as ISO 8601). ' +
      'Facts (tide, staffing, …) are resolved server-side and cannot be passed in. ' +
      SCOPE_LOOP,
    inputSchema: {
      type: 'object',
      properties: {
        offering: { type: 'string', description: 'Offering id from list_offerings.' },
        answers: {
          type: 'object',
          description: 'Parameter answers by name, e.g. {"<parameter>": <value>}. Include every answer so far.',
        },
        selections: {
          type: 'object',
          description: 'Option selections by group, e.g. {"<group>": "<option>"} or {"<group>": ["<option>", "<option>"]} for a multi group. Include every selection so far.',
        },
        date: {
          type: 'string',
          description: 'Requested date (`YYYY-MM-DD`) or date-time (ISO 8601), when the offering uses dates.',
        },
      },
      required: ['offering'],
    },
    annotations: { readOnlyHint: true },
  },
];

/** Server `instructions` — the business summary a connected agent sees first. */
export function mcpInstructions(graph: Graph, payments?: McpPayments): string {
  const { business, offerings } = graph;
  const names = Object.values(offerings)
    .filter((o) => o.status === 'active')
    .map((o) => o.name)
    .join(', ');
  return [
    `This MCP server scopes requests for ${business.name}.`,
    business.description ?? '',
    `What it sells: ${names || 'no active offerings'}.`,
    `Prices are quoted in ${business.currency}.`,
    `The business's timezone is ${business.timezone}: dates, notice periods and date-based prices use its local time.`,
    '',
    'HOW TO USE: call list_offerings, then scope_offering with what the buyer told you (describe_offering is optional); scope_offering asks one question at a time.',
    'Never invent answers — ask the human. Facts about the business (tide, staffing, inventory) are fetched server-side automatically and cannot be supplied by you or the buyer.',
    '',
    SCOPE_LOOP,
    ...(payments !== undefined ? ['', paymentLoop(payments)] : []),
  ]
    .filter((line) => line !== '')
    .join('\n');
}

function paymentLoop(payments: McpPayments): string {
  const names = new Set(payments.mcpTools.map((t) => t.tool.name));
  const lines = [
    'PAYMENTS: a qualified, payable scope_offering result carries quote.id (`qt_…`, valid until quote.expiresAt). The buyer pays for exactly that quote — amount and currency are fixed server-side.',
  ];
  if (names.has('create_checkout')) {
    lines.push('- If you hold a Stripe shared payment token for the buyer: create_checkout with line_items [{ "item": { "id": "<qt_…>" }, "quantity": 1 }] and the buyer\'s email, then complete_checkout with the token. Poll get_checkout until it is completed or canceled.');
  }
  if (names.has('create_payment_link')) {
    lines.push('- Otherwise: create_payment_link { "quote": "<qt_…>" } and give the url to the human (or a browser agent) to pay on Stripe\'s page.');
  }
  lines.push('- get_order { "order": "<ord_…>" } shows the order status at any time.');
  if (payments.config.confirmation === 'owner_approves') {
    lines.push('The business approves every order: the card is authorized now and charged only when the business approves, by the approvalDeadline; otherwise the authorization is released. Never tell the buyer they have been charged while the status is awaiting_approval.');
  }
  return lines.join('\n');
}

/** Scoping tools plus (payments on) the payment tools; scope_offering learns about quote ids. */
export function mcpTools(payments?: McpPayments): Tool[] {
  if (payments === undefined) return MCP_TOOLS;
  return [
    ...MCP_TOOLS.map((tool) => tool.name === 'scope_offering'
      ? {
        ...tool,
        description: `${tool.description ?? ''}\nPayments: a payable qualified result has quote.id (qt_…) and next.checkout explaining how to pay it (create_checkout / create_payment_link).`,
      }
      : tool),
    ...payments.mcpTools.map((t) => t.tool),
  ];
}

/**
 * Create a low-level MCP `Server` for the current graph snapshot.
 * Instantiated per request by the transport factory, so it always reads the
 * latest compiled graph (hot-swap on `--watch`). `client` is the HTTP caller's
 * rate-limit key (client IP), passed to payments for the per-client quote quota.
 */
export function createScopeMcpServer(
  getGraph: () => Graph,
  exposeTrace: boolean,
  payments?: McpPayments,
  client?: string,
): Server {
  const graph = getGraph();
  const server = new Server(
    { name: graph.business.name, version: SERVER_VERSION },
    { capabilities: { tools: {} }, instructions: mcpInstructions(graph, payments) },
  );
  const tools = mcpTools(payments);

  server.setRequestHandler('tools/list', async () => ({ tools }));

  server.setRequestHandler('tools/call', async (request) => {
    const { name, arguments: args } = request.params;
    const rawArgs = (args ?? {}) as Record<string, unknown>;

    if (name === 'list_offerings') {
      if (typeof rawArgs.query === 'string' && rawArgs.query.length > MAX_OFFERING_QUERY_LENGTH) {
        return errorResult({
          error: 'invalid_arguments',
          message: `\`query\` must be at most ${String(MAX_OFFERING_QUERY_LENGTH)} characters.`,
        });
      }
      const query = typeof rawArgs.query === 'string' && rawArgs.query.trim() !== ''
        ? rawArgs.query
        : undefined;
      return toolResult({ offerings: listOfferings(graph, query) });
    }

    if (name === 'describe_offering') {
      const offering = rawArgs.offering;
      if (typeof offering !== 'string' || offering === '') {
        return errorResult({
          error: 'invalid_arguments',
          message: "`offering` is required (an offering id from list_offerings).",
        });
      }
      const description = describeOfferingForBuyers(graph, offering);
      if (!description) {
        return errorResult({
          error: 'not_found',
          message: `Offering '${offering}' not found. Call list_offerings for valid ids.`,
        });
      }
      return toolResult(description);
    }

    if (name === 'scope_offering') {
      const offering = rawArgs.offering;
      if (typeof offering !== 'string' || offering === '') {
        return errorResult({
          error: 'invalid_arguments',
          message: "`offering` is required (an offering id from list_offerings).",
        });
      }
      const parsed = parseScopeInput(rawArgs);
      if (!parsed.ok) {
        return errorResult({ error: 'invalid_arguments', message: parsed.message });
      }
      const result = await runScope(graph, offering, parsed.input, exposeTrace, payments?.scope, client);
      return toolResult(result);
    }

    const paymentTool = payments?.mcpTools.find((t) => t.tool.name === name);
    if (paymentTool !== undefined) {
      try {
        return await paymentTool.call(rawArgs);
      } catch (err) {
        console.error(`MCP tool ${name} failed:`, err);
        return errorResult({ error: 'internal_error', message: 'The tool failed; retry shortly.' });
      }
    }

    return errorResult({
      error: 'unknown_tool',
      message: `Unknown tool '${name}'. Available: ${tools.map((t) => t.name).join(', ')}.`,
    });
  });

  return server;
}
