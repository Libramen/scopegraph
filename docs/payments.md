# Payments: quotes, doors, approval

scopegraph can sell, not just quote. When Stripe is configured, every
qualified request becomes a server-frozen **quote**, a buyer pays it through
one of four **doors**, and (by default) you approve the charge before any
money moves. Nothing about this changes scoping: prices always come from the
engine, never from the buyer or the agent.

Payments are optional and off by default — without `STRIPE_SECRET_KEY` no
payment routes or tools are mounted and scope results carry no quote ids.
They are never available over stdio MCP
(`serve --stdio` registers scoping tools only): webhooks and background
reconciliation need the HTTP server.

When something doesn't mount the way this doc says it should,
`npm run sg -- doctor` is the first check.

## The shape of a payment

```
scope_offering / POST /api/offerings/:id/scope   (qualified, total ≥ $0.50)
  └─ quote qt_…  — frozen request + price, valid 30 min by default
       ├─ payment link → hosted Stripe page        (a human pays by card)
       ├─ UCP checkout  → agent pays with a Stripe shared payment token
       ├─ ACP checkout   → same, over the ACP REST protocol
       └─ MPP 402-pay    → machine payments (instant only)
  └─ order ord_…  — card held
       owner_approves → you approve or reject → charged / released
       instant        → charged immediately
```

- **Quotes** are the only entry point. The server freezes the request
  (answers, selections, date) and the price at quote time; a door can never
  introduce its own amount. A quote lives for `quoteTtlMinutes` (30 min
  default, 30–240) in server memory until a payment starts, so a restart
  means re-scoping. Totals under Stripe's minimum charge for the currency
  (e.g. $0.50) are never payable — `scope_offering` returns the quote with
  `payable: false` and no quote id.
- **Late quotes for near dates aren't payable.** Under
  `confirmation: owner_approves`, a quote is only payable if, at the moment
  the quote expires, the business would still have at least 5 minutes to
  approve. Approval closes 1 hour before the booked start, and a date-only
  booking starts at local midnight. With the default 30-minute quote
  lifetime, that means a date-only booking must be quoted before about
  22:25 local time the day before. Later quotes come back `payable: false`.
- **One live order per quote.** The first door a buyer uses binds the order;
  every other door on that quote is refused until that order is dead or paid.
  This is what makes "agent starts UCP, human also clicks the link" safe —
  it cannot double-charge.
- **Before a held card goes to you for approval** (or, with `instant`,
  before it is captured) the server re-evaluates the request with fresh
  facts and the current time. If the outcome or price changed (price, tides,
  notice window), the hold is released and the buyer is asked to re-scope.
  Your approval then captures the hold as-is.

## The four doors — when to use which

| Door | Who pays | How | Good for |
|---|---|---|---|
| **Payment link** | a human (or browser agent) | `POST /api/quotes/:id/payment-link` or the MCP tool `create_payment_link` returns a hosted Stripe Checkout URL | anything with a browser: send the link in an email or chat |
| **UCP** | an AI agent | agent-native checkout protocol (`/ucp` REST + MCP tools `create_checkout`/`complete_checkout`) with a Stripe **shared payment token** (SPT) | agents on UCP platforms that negotiate payment themselves |
| **ACP** | an AI agent | same checkout over the ACP REST protocol (`POST /acp/checkout_sessions…`, discovery at `GET /.well-known/acp.json`; bearer tokens you issue) | closed agent networks you control; `ACP_BEARER_TOKENS` enables it |
| **MPP** | a machine | `POST /mpp/quotes/:id/pay`: HTTP `402` + `WWW-Authenticate: Payment` challenge; client retries with a credential | autonomous machine-to-machine payments; **instant confirmation only** (`confirmation: instant`), because the MPP Stripe charge settles on arrival |

UCP is first-class: the server publishes a UCP profile at
`/.well-known/ucp` advertising the Stripe payment handler, and speaks the
checkout operations both as REST (`POST /ucp/checkout-sessions`,
`GET|PUT /ucp/checkout-sessions/:id`, `POST …/complete`, `POST …/cancel`)
and as MCP tools on `/mcp` (`create_checkout`, `get_checkout`,
`update_checkout`, `complete_checkout`, `cancel_checkout`; plus
`get_order` for any door's order). ACP reuses the
same internal checkout. Getting *listed* in a platform's agent-payment
surface (Google, ChatGPT, …) is each operator's own onboarding with that
platform — scopegraph serves the protocol endpoints; it cannot list you.

## Owner approval vs instant

`confirmation: owner_approves` (the default) means the buyer's card is
**authorized (held) but not charged** when they pay. You then approve or
reject. `confirmation: instant` charges on the spot.

- **Approve** → the hold is captured: `paid`.
- **Reject** (with an optional reason) → the hold is released: `rejected`.
- **Do nothing** → at the approval deadline the hold is released and the
  order expires. Nothing is ever captured by default.

**The approval deadline** is the tightest of:

1. now + `approvalWindowHours` (default 24, max 96),
2. one hour before the requested service date, if any,
3. one hour before the card hold itself expires (`capture_before`).

Card holds do not last forever: about **7 days** for most customer-initiated
card authorizations (**5 days** for Visa merchant-initiated ones) unless
extended authorization is in play. That is why the window is capped at 96h
and why the server automatically tightens it against the service date — you
cannot approve a charge for a lesson that already happened, and you cannot
approve a hold that already lapsed. If the buyer's card was held but you do
nothing, the money is simply released; no refund needed.

**MPP only works with `instant`.** Machine payments settle immediately by
protocol; if you set `MPP_ENABLED=true` with `owner_approves`, the server
warns at boot and does not mount the MPP door.

## Approving from the terminal

```bash
npm run sg -- orders list                          # newest first
npm run sg -- orders list --status awaiting_approval
npm run sg -- orders show ord_…                    # full detail: buyer, request, quote lines
npm run sg -- orders approve ord_…                 # capture the held payment
npm run sg -- orders reject ord_… --reason "no boards left that weekend"
```

The CLI talks to the admin API (`GET/POST /admin/orders…`) with the bearer
token from `ADMIN_TOKEN`; point it at another server with `--url` and get
raw JSON with `--json`. If you wire `onApprovalNeeded` in
`src/extend/orders.ts` to email or message you (see hooks below), the signed
approve/reject links it receives work in a browser.

## Stripe setup

Payments run through one Stripe account per deployment; Stripe is the only
supported processor.

1. **Secret key** — create a **restricted key** with exactly:
   - Payment Intents — **write**
   - Checkout Sessions — **write**
   - Charges and Refunds — **write** (the automatic safety refunds, and
     reading a payment's charge; Stripe's permission reference lists it as
     `charge_write`)
   - Shared Payment Tokens — **read**

   Set it as `STRIPE_SECRET_KEY`. Its prefix (`sk_test_`/`sk_live_` or the
   restricted `rk_…` forms) decides the mode the UCP handler advertises.
2. **Webhook endpoint** — in the Stripe Dashboard add
   `https://<your PUBLIC_URL>/webhooks/stripe` and subscribe to exactly
   these events (the server treats events as triggers and re-reads state
   from Stripe, so extra events are harmless but these are the ones used):

   - `checkout.session.completed`
   - `checkout.session.expired`
   - `payment_intent.amount_capturable_updated`
   - `payment_intent.succeeded`
   - `payment_intent.payment_failed`
   - `payment_intent.canceled`
   - `charge.refunded`

   Put the signing secret in `STRIPE_WEBHOOK_SECRET`.
3. **Agent business profile** — enable agentic commerce in Stripe (Dashboard
   → Settings → Agentic commerce) and copy the profile id
   (`profile_test_…` in test mode) into `STRIPE_PROFILE_ID`. The SPT doors
   advertise it; agents grant shared payment tokens *to that profile*.
4. **Currencies** — the catalog currency must be a two-decimal currency
   (`USD`, `EUR`, …); `validate` rejects others (`UNSUPPORTED_CURRENCY`), so
   zero-decimal currencies (`JPY`) are not supported yet.

### Environment variables

Set these in the server's environment, or locally in the checkout's `.env`
(next to `package.json`; the CLI reads it at startup, never a `.env` in the
working directory). Variables already set in the environment win, `NODE_*`
keys in the file are ignored, and with `NODE_ENV=production` the file is not
read at all. In Docker (which sets `NODE_ENV=production`), pass the file with
`docker run --env-file .env`.

| Variable | Meaning | Notes |
|---|---|---|
| `STRIPE_SECRET_KEY` | enables payments | restricted key above; unset = payments off |
| `STRIPE_WEBHOOK_SECRET` | webhook signature verification | required when payments are on; `whsec_` plus at least 16 characters (copy it from the webhook endpoint) |
| `STRIPE_PROFILE_ID` | agent business profile | SPT doors (UCP/ACP/MPP); test: `profile_test_…` |
| `PUBLIC_URL` | absolute https base URL | **required when payments are on**; used for payment links, approval links, order pages (plain http only for localhost); a loopback URL (`localhost`, `127.x.x.x`, `[::1]`) is refused with a live key |
| `ADMIN_TOKEN` | admin API + `orders` CLI bearer | **required when payments are on**; ≥ 32 chars, generate e.g. `openssl rand -hex 32` |
| `ORDER_SIGNING_SECRET` | signs approve/reject links | **required when payments are on**; ≥ 32 bytes, `openssl rand -hex 32`; must differ from `ADMIN_TOKEN` |
| `DATA_DIR` | where `payments.json` lives | default `./data`; keep it on a persistent volume |
| `ACP_BEARER_TOKENS` | enables the ACP door | comma-separated tokens you hand to agents; each ≥ 32 characters (`openssl rand -hex 32`), none equal to `ADMIN_TOKEN` |
| `ACP_WEBHOOK_URL` / `ACP_WEBHOOK_SECRET` | optional ACP order webhooks | set both or neither; the secret is ≥ 32 characters |
| `MPP_ENABLED` | `true` enables the MPP door | instant confirmation only |

The payment behaviour itself lives in `catalog/business.yaml` (scaffolded by
`npm run sg -- init --payments owner_approves|instant`; fields in
[`docs/catalog-format.md`](catalog-format.md#payments)):

```yaml
payments:
  confirmation: owner_approves   # or instant (required for MPP)
  approvalWindowHours: 24
  quoteTtlMinutes: 30
```

### Test it locally

Before going live, walk a whole order in Stripe test mode. Set the
test-mode variables with `PUBLIC_URL=http://localhost:3000` (`stripe listen
--forward-to localhost:3000/webhooks/stripe` prints the `whsec_…` to use as
`STRIPE_WEBHOOK_SECRET`) and run `npm run dev`. Scope a qualified quote,
open `PUBLIC_URL/quotes/<qt_…>/pay`, pay with Stripe's test card
`4242 4242 4242 4242`, then run `npm run sg -- orders list --status
awaiting_approval` and `npm run sg -- orders approve <ord_…>`.

## Preview status: shared payment tokens

Charging an SPT requires Stripe's **preview** API version — the server pins
one (`STRIPE_SPT_API_VERSION` in `src/payments/stripe/`) and uses it for
every SPT call. Consequences:

- The behaviour can change under you when Stripe revises the preview;
  re-test the agent doors in test mode after bumping anything.
- SPTs are available to businesses in the **US, Canada and about 30
  European countries** (and to agents/customers in the same set). Outside
  that set, the payment-link door still works everywhere Stripe does.
- SPTs are single-use, scoped to one business profile, one currency, a
  maximum amount and an expiry. The server never stores the raw token —
  only a fingerprint.

## Hooks: react to orders

`src/extend/orders.ts` is yours to edit (like `facts.ts`):

- `onApprovalNeeded(order, links)` — a card is held and waiting for you;
  `links.approveUrl` / `links.rejectUrl` are the signed URLs (anyone holding
  one can approve or reject until `links.expiresAt`, so deliver them
  privately). Default: one stderr line with the order id, total, deadline
  and the `npm run sg -- orders approve <id>` command — never the links.
  Commented examples show email/Slack/CRM integrations.
- `onPaid(order)` — money moved.
- `onClosed(order)` — rejected / expired / canceled / failed / refunded.

The full order (including buyer contact) is passed. Owner-approves orders
from UCP/ACP require the buyer's email on the checkout (`buyer.email`, set
with `create_checkout` or `update_checkout`) before `complete_checkout`, so
you can always reach the buyer. Buyer fields are stored with control
characters, bidi overrides and isolates, and line separators removed, and
each is capped at 320 characters. This applies to fields from UCP/ACP
checkouts and from Stripe Checkout. An email that does not look like
`name@example.com` is refused:

- create and update return 400 `invalid_buyer_email` (field `buyer.email`)
  and store nothing;
- complete returns the checkout with that error and starts no payment.

## Abuse limits

Quotes, checkouts and unpaid orders are free for anonymous agents to
create, so they are bounded:

- A UCP/ACP checkout is stored only when its line item is a live quote id
  (`qt_…`); otherwise the agent gets a 400 error with the same
  `quote_required` / `quote_expired` guidance and nothing is saved.
- At most 3 checkouts per quote (409 `too_many_checkouts`). Checkouts that
  never reached a paid order: at most 5,000 from anonymous UCP agents, and
  separately at most 1,000 per ACP bearer token (503 `checkouts_full`), so
  UCP traffic never blocks your ACP platforms. A checkout that never
  started paying is dropped an hour after its quote expires.
- One client (an IPv4 address or an IPv6 /64, as resolved by `TRUST_PROXY`)
  holds at most 50 unpaid things: unexpired quotes no order has started,
  plus orders it started in the last quote lifetime that never held money
  (unpaid payment links, declined or junk payment tokens). Past that its new
  scope results are not payable until some expire (logged once a minute).
  Asking again for the same offering, answers and price returns the quote
  it already holds.
- All clients in one IPv6 /48 together hold at most 200 such unpaid things,
  so rotating through /64s does not multiply the per-client limit. Past
  that, new scope results from that /48 are not payable until some expire
  (logged once a minute). IPv4 has no such network quota: agent platforms
  and carrier NAT share IPv4 ranges.
- Each payment route (payment link, UCP, ACP, MPP) has at most 2,000 open
  unpaid orders. Unpaid payment links can only fill the link route, and
  token checkouts stay open. Past that, new orders on that route are refused
  with `door_unavailable`. The cap check and the order insert are atomic, so
  concurrent requests never push a route past its cap. Payment-link orders
  that close without money ever being held are deleted an hour later
  instead of after 48 hours.
- Idempotency keys are at most 255 characters. A response is kept for
  replay only when the call changed something (a cancel that canceled, a
  complete that started a payment); other answers are recomputed on retry.
- Stripe webhook bodies over 256 KB are refused.

## Money safety, in one paragraph

Amounts are integer minor units, compared exactly; currency is compared
case-insensitively. Every order transition is written durably before the
Stripe call that follows it, locks + version CAS keep concurrent
approve/reject/webhook races to one outcome, webhooks re-read the
PaymentIntent from Stripe instead of trusting event payloads, and anything
unexpected (amount mismatch, double evidence) is flagged as a `discrepancy`
rather than silently absorbed. Refunds return the exact captured amount.
