/**
 * UCP door (docs/payments.md § The four doors): `GET /.well-known/ucp`, REST `/ucp/checkout-sessions…`
 * (UCP 2026-08-25 REST binding) and the five MCP tools on `/mcp`
 * (https://ucp.dev/2026-08-25/services/shopping/mcp.openrpc.json).
 *
 * Every response is a business outcome: HTTP 200/201 with the `ucp` envelope (validation
 * failures, unknown checkout ids and refused creates/updates — no live quote, checkout caps —
 * are protocol errors: 4xx/503 ErrorResponse, nothing stored). Idempotency-Key /
 * `meta['idempotency-key']` (≤ 255 chars) on complete and cancel replay the stored 2xx
 * response; the same key with a different body is rejected (409 / tool error).
 */
import { Router } from 'express';
import type { Request, Response } from 'express';
import type { CallToolResult } from '@modelcontextprotocol/server';
import {
  CheckoutCreateRequestSchema,
  CheckoutCompleteRequestSchema,
  CheckoutUpdateRequestSchema,
} from '@ucp-js/sdk';
import { z } from 'zod';
import type { Buyer, DoorDeps, DoorModule, PaymentMcpTool } from '../types.js';
import type { CheckoutCredential, CheckoutRefusal, CheckoutService, CheckoutView, LineItemInput } from '../checkout/index.js';
import { MAX_LINE_ITEMS, REFUSAL_STATUS } from '../checkout/index.js';
import { MAX_IDEMPOTENCY_KEY_LENGTH, createIdempotencyKeys, hashBody, idempotencyId, type IdempotencyKeys } from '../checkout/idempotency.js';
import {
  STRIPE_CREDENTIAL_TYPE,
  STRIPE_HANDLER_ID,
  buildUcpProfile,
  fieldPath,
  renderCheckoutResponse,
  renderErrorResponse,
  type UcpContext,
} from './render.js';

const UCP_IDEMPOTENCY_COLLECTION = 'ucp_idempotency';

type UcpBuyer = { first_name?: string; last_name?: string; email?: string; phone_number?: string };

function buyerFromUcp(buyer: UcpBuyer | undefined): Buyer | undefined {
  if (!buyer) return undefined;
  const out: Buyer = {};
  const name = [buyer.first_name, buyer.last_name].filter((part) => part && part.trim()).join(' ').trim();
  if (name) out.name = name;
  if (buyer.email?.trim()) out.email = buyer.email.trim();
  if (buyer.phone_number?.trim()) out.phone = buyer.phone_number.trim();
  return Object.keys(out).length > 0 ? out : undefined;
}

function lineItemsFromUcp(items: ReadonlyArray<{ item: { id: string }; quantity: number }> | undefined): LineItemInput[] | { error: string } {
  if (!items) return [];
  if (items.length > MAX_LINE_ITEMS) {
    return { error: `At most ${MAX_LINE_ITEMS} line items are accepted; a checkout holds one quote.` };
  }
  return items.map((line) => ({ id: line.item.id, quantity: line.quantity }));
}

/**
 * The complete payload selects exactly one instrument: `selected: true` + `handler_id:
 * stripe_payments` + credential `{ type: 'stripe_payment_token', token: 'spt_…' }` (Stripe
 * Payments handler 2026-06-25). Anything else is a recoverable `unsupported_instrument`.
 * Parsed from the RAW payload: the SDK's schemas strip unknown keys such as the token.
 */
const UcpPaymentPayload = z
  .object({
    instruments: z
      .array(
        z
          .object({
            handler_id: z.unknown().optional(),
            selected: z.unknown().optional(),
            credential: z.object({ type: z.unknown().optional(), token: z.unknown().optional() }).passthrough().optional(),
          })
          .passthrough(),
      )
      .optional(),
  })
  .passthrough();

function credentialFromUcp(payment: unknown): CheckoutCredential {
  const parsed = UcpPaymentPayload.safeParse(payment);
  const instruments = parsed.success ? parsed.data.instruments ?? [] : [];
  if (instruments.length === 0) return { ok: false, reason: 'The request has no payment instruments.' };
  const selected = instruments.filter((instrument) => instrument.selected === true);
  if (selected.length === 0) return { ok: false, reason: 'No payment instrument is marked "selected": true.' };
  if (selected.length > 1) return { ok: false, reason: 'Exactly one payment instrument must be selected.' };
  const instrument = selected[0]!;
  if (instrument.handler_id !== STRIPE_HANDLER_ID) {
    return { ok: false, reason: `Payment handler "${String(instrument.handler_id)}" is not available; use handler_id "${STRIPE_HANDLER_ID}".` };
  }
  const credential = instrument.credential;
  if (credential?.type !== STRIPE_CREDENTIAL_TYPE) {
    return { ok: false, reason: `Credential type "${String(credential?.type ?? '(missing)')}" is not supported; use "${STRIPE_CREDENTIAL_TYPE}".` };
  }
  if (typeof credential.token !== 'string' || credential.token.length === 0) {
    return { ok: false, reason: 'The payment credential has no token.' };
  }
  return { ok: true, spt: credential.token };
}

/** Same result shape as the other payment tools (`src/payments/link/index.ts`, `src/server/mcp.ts`). */
function ucpResult(payload: unknown): CallToolResult {
  return {
    structuredContent: payload,
    content: [{ type: 'text', text: JSON.stringify(payload) }],
  };
}

function ucpError(payload: unknown): CallToolResult {
  return {
    structuredContent: payload,
    content: [{ type: 'text', text: JSON.stringify(payload) }],
    isError: true,
  };
}

function validationMessages(error: z.ZodError): Array<{ code: string; content: string; path?: string }> {
  return [
    {
      code: 'invalid_request',
      content: `The request does not match the UCP checkout schema: ${error.issues[0]?.path.join('.') || ''} ${error.issues[0]?.message ?? ''}`.trim(),
      path: error.issues[0]?.path.length ? `$['${error.issues[0]!.path.join("']['")}']` : undefined,
    },
  ];
}

export function createUcpDoor(deps: DoorDeps & { checkout: CheckoutService }): DoorModule {
  const { checkout, config, store } = deps;
  const ownerApproves = config.confirmation === 'owner_approves';
  const ucpContext = (): UcpContext => ({
    business: deps.getGraph().business,
    publicUrl: config.publicUrl,
    livemode: config.stripe.livemode,
    profileId: config.stripe.profileId,
  });
  const keys: IdempotencyKeys = createIdempotencyKeys(store, UCP_IDEMPOTENCY_COLLECTION, deps.now);

  const notFound = (res: Response, id: string): void => {
    res.status(404).json(renderErrorResponse([{ code: 'not_found', content: `No checkout ${id}.` }], ucpContext()));
  };

  /** A refused create/update (nothing stored) carries the same guidance the checkout would. */
  function refusalBody(refusal: CheckoutRefusal) {
    const { message } = refusal;
    return renderErrorResponse([{ code: message.code, content: message.content, severity: message.severity, path: fieldPath(message.field) }], ucpContext());
  }

  const keyTooLong = () =>
    renderErrorResponse([{ code: 'invalid_idempotency_key', content: `The idempotency key must be at most ${String(MAX_IDEMPOTENCY_KEY_LENGTH)} characters.` }], ucpContext());

  /** Runs `fn` under the idempotency-key contract (Stripe-style: replay, in-flight 409, conflict 409). */
  async function withIdempotency(
    req: Request,
    res: Response,
    scope: string,
    fn: () => Promise<{ status: number; body: unknown; store?: boolean }>,
  ): Promise<void> {
    const key = req.header('idempotency-key');
    if (!key) {
      const { status, body } = await fn();
      res.status(status).json(body);
      return;
    }
    if (key.length > MAX_IDEMPOTENCY_KEY_LENGTH) {
      res.status(400).json(keyTooLong());
      return;
    }
    const result = await keys.run(idempotencyId(scope, key), hashBody(req.body), fn);
    switch (result.kind) {
      case 'replayed':
        res.status(result.status).json(result.body);
        return;
      case 'in_flight':
        res.status(409).setHeader('Retry-After', '1');
        res.json(renderErrorResponse([{ code: 'idempotency_in_flight', content: 'A request with this idempotency key is being processed; retry after the pause.' }], ucpContext()));
        return;
      case 'conflict':
        res.status(409).json(renderErrorResponse([{ code: 'idempotency_conflict', content: 'This idempotency key was used with a different request body.' }], ucpContext()));
        return;
      case 'executed':
        res.status(result.status).json(result.body);
        return;
    }
  }

  // ─── REST ───────────────────────────────────────────────────────────────────

  const router = Router();
  router.get('/.well-known/ucp', (_req, res) => {
    res.json(buildUcpProfile(ucpContext()));
  });

  router.post('/ucp/checkout-sessions', async (req, res) => {
    const parsed = CheckoutCreateRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json(renderErrorResponse(validationMessages(parsed.error), ucpContext()));
      return;
    }
    const items = lineItemsFromUcp(parsed.data.line_items);
    if (items instanceof Object && 'error' in items) {
      res.status(400).json(renderErrorResponse([{ code: 'invalid_request', content: items.error }], ucpContext()));
      return;
    }
    const result = await checkout.create('ucp', { lineItems: items, buyer: buyerFromUcp(parsed.data.buyer) });
    if (!result.ok) res.status(REFUSAL_STATUS[result.reason]).json(refusalBody(result));
    else res.status(201).json(renderCheckoutResponse(result.view, ucpContext()));
  });

  router.get('/ucp/checkout-sessions/:id', async (req, res) => {
    const view = await checkout.get('ucp', req.params.id);
    if (!view) notFound(res, req.params.id);
    else res.json(renderCheckoutResponse(view, ucpContext()));
  });

  router.put('/ucp/checkout-sessions/:id', async (req, res) => {
    const parsed = CheckoutUpdateRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json(renderErrorResponse(validationMessages(parsed.error), ucpContext()));
      return;
    }
    const items = lineItemsFromUcp(parsed.data.line_items);
    if ('error' in items) {
      res.status(400).json(renderErrorResponse([{ code: 'invalid_request', content: items.error }], ucpContext()));
      return;
    }
    // UCP update is full replacement: an absent buyer clears it.
    const result = await checkout.update('ucp', req.params.id, { lineItems: items, buyer: buyerFromUcp(parsed.data.buyer) ?? {} });
    if (!result) notFound(res, req.params.id);
    else if (!result.ok) res.status(REFUSAL_STATUS[result.reason]).json(refusalBody(result));
    else res.json(renderCheckoutResponse(result.view, ucpContext()));
  });

  router.post('/ucp/checkout-sessions/:id/complete', (req, res) =>
    withIdempotency(req, res, `ucp:complete:${req.params.id}`, async () => {
      const parsed = CheckoutCompleteRequestSchema.safeParse(req.body);
      if (!parsed.success) return { status: 400, body: renderErrorResponse(validationMessages(parsed.error), ucpContext()) };
      const view = await checkout.complete('ucp', req.params.id, {
        credential: credentialFromUcp(req.body?.payment),
      });
      if (!view) return { status: 404, body: renderErrorResponse([{ code: 'not_found', content: `No checkout ${req.params.id}.` }], ucpContext()) };
      // Only a call that changed state is replayed; a no-op or pending answer is re-derived on retry.
      return { status: 200, body: renderCheckoutResponse(view, ucpContext()), store: view.stateChanged === true };
    }),
  );

  router.post('/ucp/checkout-sessions/:id/cancel', (req, res) =>
    withIdempotency(req, res, `ucp:cancel:${req.params.id}`, async () => {
      const view = await checkout.cancel('ucp', req.params.id);
      if (!view) return { status: 404, body: renderErrorResponse([{ code: 'not_found', content: `No checkout ${req.params.id}.` }], ucpContext()) };
      return { status: 200, body: renderCheckoutResponse(view, ucpContext()), store: view.stateChanged === true };
    }),
  );

  // ─── MCP tools (2026-08-25 MCP binding; args {meta, id, checkout}) ─────────

  const metaSchema = {
    type: 'object',
    description: 'Request metadata. `ucp-agent.profile` identifies your platform; `idempotency-key` makes complete/cancel retries safe.',
    properties: {
      'ucp-agent': {
        type: 'object',
        required: ['profile'],
        properties: { profile: { type: 'string', description: 'URL of your platform UCP profile document.' } },
      },
      'idempotency-key': { type: 'string', description: 'Unique per logical request; reuse the same value when retrying complete_checkout or cancel_checkout.' },
    },
  };

  const lineItemsSchema = {
    type: 'array',
    description: 'Exactly one line item: the scoped quote.',
    items: {
      type: 'object',
      required: ['item', 'quantity'],
      properties: {
        item: {
          type: 'object',
          required: ['id'],
          properties: { id: { type: 'string', description: 'The quote id (qt_…) returned by scope_offering.' } },
        },
        quantity: { type: 'integer', minimum: 1, description: 'Always 1: quantities are part of the scoped request.' },
      },
    },
  };

  const buyerSchema = {
    type: 'object',
    description: 'Buyer contact. `buyer.email` is required before paying (the business confirms by email).',
    properties: {
      first_name: { type: 'string' },
      last_name: { type: 'string' },
      email: { type: 'string' },
      phone_number: { type: 'string' },
    },
  };

  const paymentSchema = {
    type: 'object',
    required: ['instruments'],
    description: 'The selected payment instrument.',
    properties: {
      instruments: {
        type: 'array',
        items: {
          type: 'object',
          required: ['id', 'handler_id', 'type', 'selected', 'credential'],
          properties: {
            id: { type: 'string', description: 'Instrument id, e.g. "card_1".' },
            handler_id: { type: 'string', const: STRIPE_HANDLER_ID, description: 'Use "stripe_payments".' },
            type: { type: 'string', const: 'card' },
            selected: { type: 'boolean', const: true },
            credential: {
              type: 'object',
              required: ['type', 'token'],
              properties: {
                type: { type: 'string', const: STRIPE_CREDENTIAL_TYPE, description: 'Stripe shared payment token credential.' },
                token: { type: 'string', description: 'The spt_… shared payment token.' },
              },
            },
          },
        },
      },
    },
  };

  function requireIdempotencyKey(args: Record<string, unknown>): string | undefined {
    const meta = args['meta'];
    if (!meta || typeof meta !== 'object' || !('idempotency-key' in meta)) return undefined;
    const key = meta['idempotency-key'];
    return typeof key === 'string' && key.length > 0 ? key : undefined;
  }

  /** Property of an `unknown` MCP argument object, without a cast. */
  function argProp(source: unknown, key: string): unknown {
    return typeof source === 'object' && source !== null && key in source ? (source as Record<string, unknown>)[key] : undefined;
  }

  function requireId(args: Record<string, unknown>): string | undefined {
    return typeof args.id === 'string' && args.id.length > 0 ? args.id : undefined;
  }

  const mcpTools: PaymentMcpTool[] = [
    {
      tool: {
        name: 'create_checkout',
        title: 'Create checkout for a scoped quote',
        description:
          'Open a checkout for a request that was already scoped. FIRST call scope_offering until it returns a quote id (quote.id, qt_…), then pass exactly one line item: {"item": {"id": "<quote.id>"}, "quantity": 1}. Amounts you send are ignored: totals, currency and expiry come from the server-frozen quote. Returns status ready_for_complete (or incomplete with a recoverable message, e.g. a missing buyer email). An unknown or expired quote id is a tool error with a recoverable quote_required/quote_expired message, and no checkout is created.',
        inputSchema: {
          type: 'object',
          required: ['meta', 'checkout'],
          properties: {
            meta: metaSchema,
            checkout: {
              type: 'object',
              required: ['line_items'],
              properties: { line_items: lineItemsSchema, buyer: buyerSchema },
            },
          },
        },
      },
      async call(args) {
        const parsed = CheckoutCreateRequestSchema.safeParse(args.checkout);
        if (!parsed.success) return ucpError(renderErrorResponse(validationMessages(parsed.error), ucpContext()));
        const items = lineItemsFromUcp(parsed.data.line_items);
        if (items instanceof Object && 'error' in items) {
          return ucpError(renderErrorResponse([{ code: 'invalid_request', content: items.error }], ucpContext()));
        }
        const result = await checkout.create('ucp', { lineItems: items, buyer: buyerFromUcp(parsed.data.buyer) });
        return result.ok ? ucpResult(renderCheckoutResponse(result.view, ucpContext())) : ucpError(refusalBody(result));
      },
    },
    {
      tool: {
        name: 'get_checkout',
        title: 'Get a checkout',
        description:
          ownerApproves
            ? 'Fetch the authoritative checkout by id. Poll this while status is complete_in_progress: expires_at is when the business\'s approval decision resolves (completed, or canceled with the hold released).'
            : 'Fetch the authoritative checkout by id. Poll this while status is complete_in_progress (the payment is still being confirmed).',
        inputSchema: {
          type: 'object',
          required: ['meta', 'id'],
          properties: { meta: metaSchema, id: { type: 'string', description: 'Checkout id (chk_…).' } },
        },
      },
      async call(args) {
        const id = requireId(args);
        if (!id) return ucpError(renderErrorResponse([{ code: 'invalid_request', content: 'Missing argument "id".' }], ucpContext()));
        const view = await checkout.get('ucp', id);
        return view ? ucpResult(renderCheckoutResponse(view, ucpContext())) : ucpError(renderErrorResponse([{ code: 'not_found', content: `No checkout ${id}.` }], ucpContext()));
      },
    },
    {
      tool: {
        name: 'update_checkout',
        title: 'Replace a checkout',
        description:
          'Full replacement of the checkout\'s line items and buyer. Use it to fix a rejected field (messages[].path points at it) or to supply buyer.email. Refused with checkout_locked once a payment is in progress; an unknown or expired quote id is a tool error and leaves the checkout unchanged.',
        inputSchema: {
          type: 'object',
          required: ['meta', 'id', 'checkout'],
          properties: { meta: metaSchema, id: { type: 'string', description: 'Checkout id (chk_…).' }, checkout: { type: 'object', required: ['line_items'], properties: { line_items: lineItemsSchema, buyer: buyerSchema } } },
        },
      },
      async call(args) {
        const id = requireId(args);
        if (!id) return ucpError(renderErrorResponse([{ code: 'invalid_request', content: 'Missing argument "id".' }], ucpContext()));
        const parsed = CheckoutUpdateRequestSchema.safeParse(args.checkout);
        if (!parsed.success) return ucpError(renderErrorResponse(validationMessages(parsed.error), ucpContext()));
        const items = lineItemsFromUcp(parsed.data.line_items);
        if ('error' in items) return ucpError(renderErrorResponse([{ code: 'invalid_request', content: items.error }], ucpContext()));
        const result = await checkout.update('ucp', id, { lineItems: items, buyer: buyerFromUcp(parsed.data.buyer) ?? {} });
        if (!result) return ucpError(renderErrorResponse([{ code: 'not_found', content: `No checkout ${id}.` }], ucpContext()));
        return result.ok ? ucpResult(renderCheckoutResponse(result.view, ucpContext())) : ucpError(refusalBody(result));
      },
    },
    {
      tool: {
        name: 'complete_checkout',
        title: 'Pay a checkout with a Stripe shared payment token',
        description:
          `Pay: payment.instruments[0] = {"id": "card_1", "selected": true, "handler_id": "${STRIPE_HANDLER_ID}", "type": "card", "credential": {"type": "${STRIPE_CREDENTIAL_TYPE}", "token": "spt_…"}}. ` +
          (ownerApproves
            ? 'Buyer email is not taken here: set checkout.buyer.email with create_checkout or update_checkout before paying (the business confirms the booking by email). ' +
              'The card is authorized now and charged only when the business approves (by expires_at); otherwise the hold is released. '
            : 'The card is charged immediately when the payment succeeds. ') +
          'Retry safely by reusing the same meta["idempotency-key"] and arguments. ' +
          'The result is complete_in_progress (poll get_checkout), completed, or back to ready_for_complete with a recoverable message on decline.',
        inputSchema: {
          type: 'object',
          required: ['meta', 'id', 'checkout'],
          properties: {
            meta: metaSchema,
            id: { type: 'string', description: 'Checkout id (chk_…).' },
            checkout: { type: 'object', required: ['payment'], properties: { payment: paymentSchema } },
          },
        },
      },
      async call(args) {
        const id = requireId(args);
        if (!id) return ucpError(renderErrorResponse([{ code: 'invalid_request', content: 'Missing argument "id".' }], ucpContext()));
        const key = requireIdempotencyKey(args);
        if (!key) {
          return ucpError(renderErrorResponse([{ code: 'idempotency_key_required', content: 'complete_checkout requires meta["idempotency-key"]; reuse the same value when retrying.' }], ucpContext()));
        }
        if (key.length > MAX_IDEMPOTENCY_KEY_LENGTH) return ucpError(keyTooLong());
        const parsed = CheckoutCompleteRequestSchema.safeParse(args.checkout);
        let completed: CheckoutView | undefined;
        const result = await keys.run(idempotencyId(`mcp:complete:${id}`, key), hashBody(args.checkout), async () => {
          if (!parsed.success) return { status: 400, body: renderErrorResponse(validationMessages(parsed.error), ucpContext()) };
          completed = await checkout.complete('ucp', id, { credential: credentialFromUcp(argProp(args.checkout, 'payment')) });
          if (!completed) return { status: 404, body: renderErrorResponse([{ code: 'not_found', content: `No checkout ${id}.` }], ucpContext()) };
          // Only a call that changed state is replayed; a no-op or pending answer is re-derived on retry.
          return { status: 200, body: renderCheckoutResponse(completed, ucpContext()), store: completed.stateChanged === true };
        });
        switch (result.kind) {
          case 'replayed':
            return ucpResult(result.body);
          case 'in_flight':
            return ucpError(renderErrorResponse([{ code: 'idempotency_in_flight', content: 'A request with this idempotency key is being processed; retry shortly.' }], ucpContext()));
          case 'conflict':
            return ucpError(renderErrorResponse([{ code: 'idempotency_conflict', content: 'This idempotency key was used with different arguments.' }], ucpContext()));
          case 'executed':
            return completed ? ucpResult(result.body) : ucpError(result.body);
        }
      },
    },
    {
      tool: {
        name: 'cancel_checkout',
        title: 'Cancel a checkout',
        description:
          'Cancel a checkout that is not paid: releases any card hold (may take a moment — poll get_checkout). meta["idempotency-key"] is required; reuse the same value when retrying.',
        inputSchema: {
          type: 'object',
          required: ['meta', 'id'],
          properties: { meta: metaSchema, id: { type: 'string', description: 'Checkout id (chk_…).' } },
        },
      },
      async call(args) {
        const id = requireId(args);
        if (!id) return ucpError(renderErrorResponse([{ code: 'invalid_request', content: 'Missing argument "id".' }], ucpContext()));
        const key = requireIdempotencyKey(args);
        if (!key) {
          return ucpError(renderErrorResponse([{ code: 'idempotency_key_required', content: 'cancel_checkout requires meta["idempotency-key"]; reuse the same value when retrying.' }], ucpContext()));
        }
        if (key.length > MAX_IDEMPOTENCY_KEY_LENGTH) return ucpError(keyTooLong());
        let canceled = false;
        const result = await keys.run(idempotencyId(`mcp:cancel:${id}`, key), hashBody(args), async () => {
          const view = await checkout.cancel('ucp', id);
          canceled = view !== undefined;
          return view
            ? { status: 200, body: renderCheckoutResponse(view, ucpContext()), store: view.stateChanged === true }
            : { status: 404, body: renderErrorResponse([{ code: 'not_found', content: `No checkout ${id}.` }], ucpContext()) };
        });
        switch (result.kind) {
          case 'replayed':
            return ucpResult(result.body);
          case 'in_flight':
            return ucpError(renderErrorResponse([{ code: 'idempotency_in_flight', content: 'A request with this idempotency key is being processed; retry shortly.' }], ucpContext()));
          case 'conflict':
            return ucpError(renderErrorResponse([{ code: 'idempotency_conflict', content: 'This idempotency key was used with different arguments.' }], ucpContext()));
          case 'executed':
            return canceled ? ucpResult(result.body) : ucpError(result.body);
        }
      },
    },
  ];

  return { router, mcpTools };
}
