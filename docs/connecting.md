# Connecting a website and agents

The server (`npm run dev` locally, see `docs/deploy.md` for production)
serves one catalog to two audiences from one process: a plain **HTTP API**
for your website and an **MCP endpoint** for AI agents.

Needs Node 22 or newer. If the server or an agent client can't connect,
`npm run sg -- doctor` checks the local setup and reports problems.

- `GET /health` — liveness
- `GET /api/business` — public business info (name, description, website,
  currency, timezone)
- `GET /api/offerings?q=…` — list offerings
- `GET /api/offerings/:id` — one offering: an overview by default, every
  question and choice with `disclosure: menu` (see below)
- `POST /api/offerings/:id/scope` — scope one request
- `GET /.well-known/mcp.json` — MCP discovery document
- `GET /llms.txt` — agent-facing markdown brief
- `POST /mcp` — MCP Streamable HTTP endpoint (stateless: there are no
  sessions, so `GET`/`DELETE /mcp` answer 405); POST takes JSON bodies only
  (`Content-Type: application/json`, ≤ 32 kb — anything else is 415/413)

Browser access is controlled by CORS (`ALLOWED_ORIGINS`, see `.env.example`);
non-browser clients send no Origin header and are unaffected. Every route
except `/health` is rate-limited per client (`RATE_LIMIT_PER_MINUTE`),
whatever the path's case or trailing slash; a client is one IPv4 address or
one IPv6 /64. Owner routes (the approve/reject links and `/admin`) get their
own larger bucket so public traffic can never block an approval, and so does
the Stripe webhook. Behind a
reverse proxy set `TRUST_PROXY` to the number of proxies
in front (usually `1`) so limits key on the real client IP — never `true`,
which trusts a client-forged `X-Forwarded-For`. The offering search `q` (and
the MCP `list_offerings` `query`) is capped at 200 characters.

## HTTP API

Discover, then scope. Requests send `{ answers, selections, date }` — nothing
else is accepted (any `facts` key is discarded; see the trust boundary in
`AGENTS.md`).

```bash
# What can this business sell?
curl -s localhost:3000/api/offerings | jq '.offerings[] | {id, name, priceFrom}'

# What is it? (an overview — the questions come one at a time from /scope)
curl -s localhost:3000/api/offerings/surf-lesson | jq '{name, priceFrom, date, disclosure, next}'

# Scope a request (the weekend package owns the hire choice; use a
# future date — past or too-soon dates are blocked)
curl -s -X POST localhost:3000/api/offerings/first-wave-weekend/scope \
  -H 'content-type: application/json' \
  -d '{
        "date": "2027-01-09",
        "answers": { "surfers": 2, "cold_water_ok": true, "surf_history": "first_time" },
        "selections": { "hire": ["foam_board"] }
      }' | jq
```

**Resubmit everything on every call**: `answers` and `selections` replace the
previous request's, they don't merge.

Every scope call returns exactly one of five outcomes:

| `status` | Meaning | Payload | Your website should… |
|---|---|---|---|
| `qualified` | Yes — here's the price | `quote` (`currency`, `lines`, `subtotalCents`, `taxCents`, `totalCents` — integer minor units), `summary`, `next` (when a hand-off is configured), `addOns` (when optional add-ons are still open) | show the quote and any add-ons, send the buyer to `next` |
| `needs_input` | One missing answer | `question` (a parameter, choice or date question), plus `reason` only with `EXPOSE_TRACE=true` | render it, then call again with the answer added |
| `blocked` | No — a business rule refused it | `reasons[]` of `{ code, message }` (rule message, minimum spend, notice window, facts unavailable…) | show the best reason verbatim |
| `invalid` | Caller bug (bad value, unknown option, too many selections) | `errors[]` of `{ field, code, message }` | fix the client, never show raw |
| `unavailable` | Offering not found / paused / not bookable | `code` | hide the offering |

A qualified response's `next` is the hand-off (below).

Every scoping outcome is HTTP 200, with the outcome in `status`. A request
the server cannot read gets an error status and `{ error, message }`
instead: 400 for malformed JSON or a body of the wrong shape, 413 for a body
over 32 kb, 415 for a POST body that is not `application/json` (a POST with
no body is fine). An unknown route gets a JSON 404 (`{ "error": "not_found" }`).

Optional add-on groups are never asked during scoping. Instead a qualified
result lists the ones the buyer could still choose, with price hints:

```json
"addOns": [
  { "key": "hire", "label": "Board and suit hire", "mode": "multi",
    "options": [ { "key": "hooded_suit", "label": "5/4 hooded suit", "priceHint": "+$30.00 × surfers" } ] }
]
```

Options already chosen, groups behind a closed `ask` gate, single-choice
groups that already have a selection and multi-choice groups at their `max`
are left out; the field is absent when nothing is left to offer. To add one,
call scope again with it in `selections` (e.g.
`"hire": ["foam_board", "hooded_suit"]`) and continue the loop: the add-on
may unlock a follow-up question (here, the suit size) before the new
quote.

Blocked reasons never name your rules: `ruleId` (e.g. `surf-lesson.cold_water`)
is only included over HTTP/MCP when `EXPOSE_TRACE=true` (the CLI `simulate`
and scenario runs always show it). A `FACTS_UNAVAILABLE` reason carries one
generic message ("Some information needed to quote this is unavailable right
now; please try again later."); the missing fact names are logged on the
server.

Under `disclosure: progressive`, while questions remain, an invalid answer
is treated like an unknown name: it is dropped, with a trace warning. The
result comes back `invalid` for that one field only when that parameter or
choice is the next question. The error carries the detail the question
itself shows, for example:

- `Invalid answer for "How many people are surfing?": must be at most 10.`
- `Invalid choice for "Board and suit hire": "bodyboard" is not one of its options (foam_board, hooded_suit).`
- `Too many options selected for "Session length": pick one.`

Ask the buyer that question again.

Before a quote is priced, any invalid answer or selection for a step that
is still open (not behind a closed `ask` gate) comes back `invalid`, even if
that step is never asked. Examples:

- an over-limit number on a parameter that has a default;
- a bad value for a select parameter that has a default;
- an unknown option in an optional group.

A quote is never priced with a default or a dropped option standing in for
what the buyer sent. Values for steps behind a closed gate, and unknown
names, are still ignored, so junk values reveal nothing beyond what the open
steps' own questions show. A malformed `date` is still reported straight
away (`INVALID_DATE`). Unknown answer or selection names are ignored with a
trace warning rather than rejected as `UNKNOWN_FIELD`.

Under `disclosure: menu` (and in the CLI and scenarios), every invalid value
is reported at once, a group with an unknown option is rejected whole, and
unknown names are still `UNKNOWN_FIELD`. The error `code`s are the same in
both modes.

Under `disclosure: progressive`, `summary.answers` echoes only the answers
the buyer supplied that still apply. Answers to a question behind a closed
gate are dropped, and defaults are not echoed. Groups answered with none
(`[]`) are left out of `summary.selections`; the stored request keeps them.
The hand-off `{params}` follows `summary`. A payable stored quote still
freezes the full normalized request, defaults included. Under
`disclosure: menu`, `summary.answers` includes defaults.

Under `disclosure: progressive`, buyers get `unavailable` / `NOT_FOUND`
(`No offering "<id>".`) for any offering that is not listed: paused,
archived, or sold only inside a package. They get `CONTENTS_UNAVAILABLE`
with a generic message that names no contained products.

`needs_input.reason` (why the engine asked) is only included with
`EXPOSE_TRACE=true`, in both disclosure modes. With `EXPOSE_TRACE=true`, the
trace omits fact names, internal parameter names, fact-related warnings and
pricing-failure warnings.

### What describe returns

`GET /api/offerings/:id` and the MCP `describe_offering` depend on the
catalog's `disclosure` setting (`catalog/business.yaml`):

- **`progressive` (default):** an overview only — `id`, `kind`, `name`,
  `description`, `category`, `keywords`, `priceFrom`, `currency`,
  `timezone` (the business's IANA timezone: dates, notice periods and
  date-based prices use its local time), `date`, `minNoticeHours`,
  `contains` (packages), `disclosure: "progressive"` and `next` ("Scope this
  offering with what the buyer has told you (MCP: scope_offering; HTTP: POST
  /api/offerings/<id>/scope); it asks one question at a time."). No
  questions, no choices: the engine reveals them one at a time.
- **`menu`:** the same fields with `disclosure: "menu"`, plus `questions`
  and `choices` — every question and add-on group with price hints.
  Questions and choices that are only asked when an earlier answer makes
  them relevant (an `ask` rule) carry `conditional: true`; don't ask them up
  front.

The owner's CLI `npm run sg -- describe <offering>` always shows everything.

```js
// A minimal scoping widget loop:
let answers = {}, selections = {}, date;
for (let i = 0; i < 20; i++) {
  const res = await fetch(`${API}/api/offerings/surf-lesson/scope`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ answers, selections, date }),
  }).then((r) => r.json());

  if (res.status === 'qualified') return showQuote(res); // + res.next.url, res.addOns
  if (res.status === 'needs_input') {
    const a = await ask(res.question);          // render the one question
    if (res.question.kind === 'date') date = a;
    else if (res.question.kind === 'choice')
      selections[res.question.key] = a;         // option key or list
    else answers[res.question.key] = a;
    continue;
  }
  return showRefusal(res); // blocked / invalid / unavailable
}
```

## MCP for AI agents

Agents connect over **Streamable HTTP** at `https://<your-host>/mcp`. The
endpoint announces itself at `/.well-known/mcp.json`, and `/llms.txt`
describes the business and its API in markdown. Three scoping tools (plus
the payment tools below when Stripe is configured):

- `list_offerings` — everything the business sells, with price-from hints.
- `scope_offering` — one scope request; same five outcomes as HTTP, plus
  `next` and any `addOns` on qualified. Call it with what the buyer has
  already said; it asks one question at a time.
- `describe_offering` — optional: the offering overview, or with
  `disclosure: menu` every question and add-on (see
  [What describe returns](#what-describe-returns)).

An agent calls `list_offerings`, then `scope_offering` until it gets a terminal outcome.

Add a remote server in any MCP client (Claude, Cursor, …) with URL
`https://<your-host>/mcp` (Streamable HTTP; no local command needed).

### Claude Desktop / local MCP

Generate the config for your checkout and paste it into your MCP client:

```bash
npm run --silent sg -- mcp-config
```

It prints a `claude_desktop_config.json` entry with absolute paths (the node
binary, tsx, this checkout's `tsconfig.json` and your `catalog/`), so it
works no matter which directory or PATH the client starts it with, and tells
you where the config file lives. Files in the client's working directory
(a `tsconfig.json`, a `.env`) never affect the server: it reads only this
checkout's. Merge the `mcpServers` entry, restart the client, and your
business's tools appear. Catalog and `src/extend/` edits apply on the next
client restart.

Don't point a client at `npm run sg -- serve --stdio` directly: `npm run`
prints a banner on stdout, which breaks the stdio protocol.

## CORS for your website

Browser origins are allow-listed, not open. In `.env`:

```
ALLOWED_ORIGINS=https://your-site.example.com,https://app.your-site.example.com
```

Set `PUBLIC_URL` when running behind a proxy so `/.well-known/mcp.json` and
`/llms.txt` link correctly.

## Taking payment for the quote

If the operator has configured Stripe (see [`docs/payments.md`](payments.md)),
a `qualified` response also carries a frozen **quote**: the usual `quote`
object (lines, subtotal, tax, total) gains an `id`, `expiresAt` and
`payable: true`, and `next` gains a `checkout` string naming the payment
doors this server has enabled:

```json
{ "status": "qualified",
  "quote": { "currency": "USD", "lines": [ … ], "subtotalCents": 21000,
             "taxCents": 1890, "totalCents": 22890,
             "id": "qt_…", "expiresAt": "2026-11-20T12:30:00.000Z", "payable": true },
  "next": { "url": "https://book.seastacksurf.example/new?…", "message": "…",
            "checkout": "To pay, use quote qt_…: one sentence per enabled door …" } }
```

(`next.url`/`next.message` appear only when a `handoff` is configured or
`src/extend/onQualified.ts` returns one. Totals under $0.50 come back
`payable: false` with no quote id; with payments off, a qualified response
carries no `id`, `expiresAt`, `payable` or `next.checkout`.)

The quote id is the handle every payment door accepts. Doors are exclusive:
the first one used binds the order; others are refused while it is live —
you cannot double-charge one quote.

**Website (card, hosted by Stripe):**

```bash
curl -s -X POST localhost:3000/api/quotes/qt_…/payment-link | jq .url
# → { "order": {…}, "url": "https://checkout.stripe.com/c/pay/cs_test_…",
#     "expiresAt": "…" }   — 303 the buyer there; the same call while the
#                           order is open returns the same URL (idempotent)
```

Buyers can also open `PUBLIC_URL/quotes/qt_…/pay` directly: it shows the
quote and a continue button (the page never creates an order until the
buyer posts, so link unfurlers cannot lock the quote).

**Agents (MCP tools on `/mcp`):**

- Human-in-the-loop: `create_payment_link { quote }` → hosted URL to hand
  to the buyer.
- UCP-native: `create_checkout` with `line_items[0].item.id = qt_…`, then
  `complete_checkout` with the buyer's Stripe **shared payment token**
  (`credential { type: 'stripe_payment_token', token: 'spt_…' }`);
  `get_checkout` polls the result, `update_checkout` fixes rejected fields
  (e.g. adds `buyer.email`), `cancel_checkout` cancels. The same
  checkout protocol is available as REST under `/ucp` and (if enabled) ACP
  under `/acp`.
- Order tracking: `get_order { order: ord_… }` — public status of any
  door's order (no buyer details).

By default the buyer's card is only **held**: the order waits as
`awaiting_approval` until the business approves (capture) or rejects
(release), and every order has a public, PII-free status page at
`PUBLIC_URL/orders/<id>`.

## After a qualified quote: the hand-off

1. **Default, no code**: set `handoff` in `catalog/business.yaml`. The
   qualified response carries `next: { url, message }` with the URL templated
   from the quote — `{offering}`, `{total}`, `{total_cents}`, `{currency}`,
   `{params}` (URL-encoded answers/selections/date), `{business}` (business
   name):
   ```yaml
   handoff:
     url: https://book.seastacksurf.example/new?offering={offering}&{params}
     message: Choose a session time on the Sea Stack booking page.
   ```

   The `{total}`, `{total_cents}` and `{params}` in the URL are a
   convenience for pre-filling the booking page, nothing more: anyone can
   edit a URL. Your booking page must re-check the price server-side —
   scope the same answers, selections and date again
   (`POST /api/offerings/:id/scope`) or take payment through the payments
   module, which charges the stored quote — and never charge the amount the
   URL carries.

2. **Custom, code**: edit `src/extend/onQualified.ts`. It runs on every
   qualified quote — build a pre-filled booking URL, create a CRM record,
   ping Slack, call a webhook — and return the one next action as `next`.
   Secrets live in env vars (`CRM_TOKEN` in `.env.example`), not in YAML.

## Facts: live business truth per request

Things the buyer must not decide — tide state, staffing, capacity, VIP
status — are declared in `catalog/business.yaml` under `facts:` and resolved
**on the server** in `src/extend/facts.ts` on every scope request (HTTP and
MCP alike; caller-supplied `facts` are discarded before evaluation). Mark
safety-critical facts `required: true`: if your source is down, requests
block (`FACTS_UNAVAILABLE`) instead of guessing. Example in the file's
comments.
