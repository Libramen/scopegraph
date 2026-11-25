/**
 * Payments wiring: store + Stripe gateway + order service + doors + owner
 * surfaces, behind one handle the HTTP server mounts.
 *
 *   const payments = await setupPayments({ getGraph, config });
 *   createApp({ getGraph, payments });   // mounts routes, MCP tools, quotes on scope
 *   payments.start();                    // 60s reconciler sweep
 *   await payments.stop();               // stop sweep, drain hooks, flush + unlock the store
 *
 * Only for HTTP serving with a valid `PaymentsConfig` (see `loadPaymentsConfig`).
 * Never used in stdio mode.
 */
import type { Express } from 'express';
import type { CallToolResult } from '@modelcontextprotocol/server';
import type { Quote } from '../engine/types.js';
import type { Value } from '../graph/types.js';
import type { FactsContext } from '../extend/facts.js';
import type {
  DoorDeps,
  DoorModule,
  OrderService,
  PaymentMcpTool,
  PaymentsConfig,
  PaymentsDeps,
  ScopedRequest,
  StoredQuote,
} from './types.js';
import { PaymentsStore, isId } from './store/index.js';
import { StripeGateway } from './stripe/index.js';
import { createOrderService } from './orders/index.js';
import type { DefaultOrderService, OrderHooks } from './orders/index.js';
import { createApprovalRouter, hasOwnerCredential, isOwnerRoute } from './approval/index.js';
import { createWebhookRouter } from './webhooks/index.js';
import { createCheckoutService } from './checkout/index.js';
import { createLinkDoor } from './link/index.js';
import { createUcpDoor } from './ucp/index.js';
import { createAcpDoor, deliverPendingAcpWebhooks } from './acp/index.js';
import { createMppDoor } from './mpp/index.js';

export { loadPaymentsConfig, paymentsReloadConflict } from './config.js';
export { STRIPE_WEBHOOK_EVENTS } from './webhooks/index.js';

const SWEEP_INTERVAL_MS = 60_000;

/** What the scope pipeline needs to attach a payable quote to a qualified result. */
export interface ScopePayments {
  /** Undefined when not payable (see `OrderService.createQuote`); `client` = per-client quota key (client IP). */
  createQuote(offering: string, request: ScopedRequest, quote: Quote, client?: string): Promise<StoredQuote | undefined>;
  /** One paragraph telling an agent how to pay this quote through the enabled doors. */
  checkoutGuidance(quote: StoredQuote): string;
}

interface SetupPaymentsOptions extends PaymentsDeps {
  /** Default: the durable file store in `config.dataDir` (takes the DATA_DIR lockfile). */
  store?: PaymentsStore;
  /** Default: `src/extend/orders.ts`. */
  hooks?: OrderHooks;
  /** Default: `src/extend/facts.ts`. */
  getFacts?: (ctx: FactsContext) => Promise<Record<string, Value>>;
  log?: (line: string) => void;
}

export interface PaymentsHandle {
  config: PaymentsConfig;
  service: DefaultOrderService;
  store: PaymentsStore;
  /** Core `get_order` + the doors' tools, registered on HTTP `/mcp` only. */
  mcpTools: PaymentMcpTool[];
  scope: ScopePayments;
  /** Owner approval pages/POSTs and `/admin`: never in the public bucket. */
  isOwnerRoute(path: string): boolean;
  /**
   * An owner-route request with a valid ADMIN_TOKEN bearer or a valid, unexpired
   * approval token: not rate limited at all. Others go to the owner bucket.
   */
  hasOwnerCredential(request: { path: string; authorization: string | undefined; token: unknown }): boolean;
  /** Mount webhook, approval/admin and door routes (after the app's JSON parser and rate limiter). */
  mount(app: Express): void;
  /**
   * One reconciler pass, then ACP outbox delivery. Each is coalesced on its own
   * (concurrent calls share the running one), so a slow delivery never stops
   * the next reconcile from starting.
   */
  sweep(): Promise<void>;
  start(): void;
  stop(): Promise<void>;
}

function toolResult(payload: unknown, isError = false): CallToolResult {
  return {
    structuredContent: payload as Record<string, unknown>,
    content: [{ type: 'text', text: JSON.stringify(payload) }],
    ...(isError ? { isError: true } : {}),
  };
}

function getOrderTool(service: OrderService): PaymentMcpTool {
  return {
    tool: {
      name: 'get_order',
      title: 'Get order',
      description:
        'Current state of an order created by a payment (UCP checkout, payment link, ACP or MPP): status, frozen quote lines and total, ' +
        'approvalDeadline while the business decides, the payment url for an unpaid payment link, and the public status page. No buyer details. ' +
        'Statuses: awaiting_payment (payment link not yet paid), authorizing/capturing/voiding (in progress — poll again shortly), ' +
        'awaiting_approval (card authorized, NOT charged; charged only if the business approves by approvalDeadline, otherwise released), ' +
        'paid, rejected, expired, canceled, payment_failed, refunded.',
      inputSchema: {
        type: 'object',
        properties: { order: { type: 'string', description: 'Order id (`ord_…`).' } },
        required: ['order'],
      },
      annotations: { readOnlyHint: true },
    },
    async call(args) {
      const id = args['order'];
      const order = isId('ord', id) ? await service.getOrder(id) : undefined;
      if (order === undefined) {
        return toolResult({ error: 'not_found', message: 'Order not found.' }, true);
      }
      return toolResult(service.toPublic(order));
    },
  };
}

function checkoutGuidance(config: PaymentsConfig, quote: StoredQuote): string {
  const id = quote.id;
  const base = config.publicUrl;
  const doors = [
    `UCP (agent holding a Stripe shared payment token): create_checkout with line_items [{ "item": { "id": "${id}" }, "quantity": 1 }]`
      + ` (MCP, or POST ${base}/ucp/checkout-sessions), then complete_checkout with the token`
      + (config.confirmation === 'owner_approves' ? ' and the buyer\'s email' : ''),
    `payment link for a human or browser agent: create_payment_link { "quote": "${id}" } (MCP) or POST ${base}/api/quotes/${id}/payment-link`,
  ];
  if (config.acp !== undefined) doors.push(`ACP: POST ${base}/acp/checkout_sessions with items [{ "id": "${id}", "quantity": 1 }]`);
  if (config.mppEnabled) doors.push(`MPP: POST ${base}/mpp/quotes/${id}/pay`);
  const approval = config.confirmation === 'owner_approves'
    ? ` The business approves each order: the card is authorized now and charged only if the business approves`
      + ` (within ${String(config.approvalWindowHours)} hours at most); otherwise the authorization is released. Track it with get_order.`
    : ' Payment is charged immediately.';
  return `To pay, use quote ${id} (valid until ${quote.expiresAt}; amount and currency are fixed by the quote). `
    + `Options: ${doors.map((d, i) => `(${String(i + 1)}) ${d}`).join('; ')}.${approval}`;
}

export async function setupPayments(options: SetupPaymentsOptions): Promise<PaymentsHandle> {
  const { config, getGraph } = options;
  const now = options.now ?? (() => new Date());
  const store = options.store ?? (await PaymentsStore.open(config.dataDir));
  const gateway = options.gateway ?? (await StripeGateway.create(config.stripe));
  const service = createOrderService({
    store,
    gateway,
    config,
    getGraph,
    now,
    ...(options.hooks !== undefined ? { hooks: options.hooks } : {}),
    ...(options.getFacts !== undefined ? { getFacts: options.getFacts } : {}),
    ...(options.log !== undefined ? { log: options.log } : {}),
  });

  const doorDeps: DoorDeps = { service, config, getGraph, store, now };
  const checkout = createCheckoutService(doorDeps);
  const doors: DoorModule[] = [
    createLinkDoor(doorDeps),
    createUcpDoor({ ...doorDeps, checkout }),
    ...(config.acp !== undefined ? [createAcpDoor({ ...doorDeps, checkout })] : []),
    ...(config.mppEnabled ? [createMppDoor(doorDeps)] : []),
  ];

  let reconciling: Promise<void> | undefined;
  const reconcile = (): Promise<void> => {
    reconciling ??= service
      .reconcile()
      .catch((err: unknown) => {
        console.error('scopegraph payments: reconcile sweep failed:', err);
      })
      .finally(() => {
        reconciling = undefined;
      });
    return reconciling;
  };
  let delivering: Promise<void> | undefined;
  const deliver = (): Promise<void> => {
    if (config.acp?.webhookUrl === undefined) return Promise.resolve();
    // ACP order events are an outbox: queued by checkout transitions, delivered here with backoff.
    delivering ??= deliverPendingAcpWebhooks({ ...doorDeps, checkout })
      .catch((err: unknown) => {
        console.error('scopegraph payments: ACP webhook delivery failed:', err);
      })
      .finally(() => {
        delivering = undefined;
      });
    return delivering;
  };
  const sweep = (): Promise<void> => reconcile().then(deliver);

  let timer: NodeJS.Timeout | undefined;

  return {
    config,
    service,
    store,
    mcpTools: [getOrderTool(service), ...doors.flatMap((door) => door.mcpTools ?? [])],
    scope: {
      createQuote: (offering, request, quote, client) => service.createQuote(offering, request, quote, client),
      checkoutGuidance: (quote) => checkoutGuidance(config, quote),
    },
    isOwnerRoute,
    hasOwnerCredential: (request) => hasOwnerCredential(request, config, now()),
    mount(app) {
      app.use(createWebhookRouter({ gateway, service, onTrigger: () => void sweep() }));
      app.use(createApprovalRouter({ service, store, config, getGraph, now }));
      for (const door of doors) if (door.router !== undefined) app.use(door.router);
    },
    sweep,
    start() {
      if (timer !== undefined) return;
      timer = setInterval(() => void sweep(), SWEEP_INTERVAL_MS);
      timer.unref();
      void sweep();
    },
    async stop() {
      clearInterval(timer);
      timer = undefined;
      await reconciling;
      await delivering;
      await service.drainHooks();
      await store.close();
    },
  };
}
