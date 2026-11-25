# Security policy

## Supported versions

scopegraph is pre-1.0. Only the latest release on the default branch receives
security fixes; there are no backport branches yet.

## Reporting a vulnerability

**Do not open a public issue for a vulnerability.** Instead, use GitHub's
private vulnerability reporting: **Security → Report a vulnerability** on this
repository. That reaches the maintainers privately and lets us coordinate a
fix and an advisory.

Please include what you found, how to reproduce it, and any impact you can
demonstrate. If you have a proposed fix, mention it — a pull request is
welcome *after* a private report, so the fix isn't public before a release
carries it.

## Scope highlights

scopegraph handles money and buyer-facing refusals, so these areas matter
most:

- **Payments** (`src/payments/`) — quotes, orders, Stripe calls, refunds.
  Invariants (integer minor units, durable state before external calls,
  webhooks re-read state from Stripe, one live order per quote) are described
  in [`docs/payments.md`](docs/payments.md) under "Money safety".
- **Owner approval links** — signed approve/reject URLs (`ORDER_SIGNING_SECRET`)
  and the admin API bearer token (`ADMIN_TOKEN`). Signature bypass or
  token-bruteforce findings are in scope.
- **Webhook verification and door auth** — Stripe webhook signatures
  (`STRIPE_WEBHOOK_SECRET`), ACP bearer tokens (`ACP_BEARER_TOKENS`) and the
  signatures on outbound ACP order webhooks (`ACP_WEBHOOK_SECRET`); anything
  that lets an unsigned or unauthenticated request mutate order state is in
  scope.
- **The facts trust boundary** — caller-supplied `facts` must be discarded
  before evaluation; `src/extend/facts.ts` is the only source of server-side
  truth. Any path where a buyer or agent can assert a fact (tide, capacity,
  VIP status) is in scope.
- **Untrusted input handling** — buyers and agents are anonymous. Anything
  that lets a single request (or a handful under the rate limit) exhaust
  memory, disk or the event loop is in scope — oversized bodies, regex
  backtracking (catalog patterns run on a linear-time RE2 engine), state that
  grows without bound, rate-limit bypasses. So is buyer-supplied text that can
  forge what the owner sees (terminal escapes, fake links, injected
  instructions aimed at the owner's coding agent).
- The deterministic engine itself (rule evaluation, exact-money pricing in
  `src/pricing/`) — a wrong price or a rule that fires when it shouldn't is a
  correctness bug and worth reporting too.

Out of scope: your own deployment's secrets, Stripe account configuration,
and volumetric (many-IP) denial-of-service — put a CDN or WAF in front for
that.

## Operator checklist

Before taking real payments:

- Run `doctor` with your production environment: `npm run sg -- doctor` in a
  checkout, or `node dist/cli/index.js doctor` inside the Docker image (which
  has no tsx), e.g. `docker run --rm --env-file .env <image> node
  dist/cli/index.js doctor`. It flags the settings below.
- `PUBLIC_URL` is set to your https URL (discovery documents and payment links
  use it; without it they fall back to the request's Host header).
- `ADMIN_TOKEN`, `ORDER_SIGNING_SECRET` and each ACP bearer token are
  distinct long random values (`openssl rand -hex 32`), never copied from an
  example. The server refuses to start when the signing secret or an ACP
  token equals `ADMIN_TOKEN`, or when an ACP token or `ACP_WEBHOOK_SECRET` is
  shorter than 32 characters.
- Behind a reverse proxy, set `TRUST_PROXY` to the number of proxy hops
  (usually `1`) so rate limits key on the real client. `true` is refused at
  boot: it would trust an `X-Forwarded-For` the client writes.
- `DATA_DIR` sits on a persistent, private volume (`doctor` creates it 0700
  and warns when other users can read or write it): it holds buyer contact
  details and the IP address (or IPv6 /64) each paid-for request came from,
  kept for abuse limits. Back it up like any customer database and delete it
  when you decommission the server.
- Approve/reject links are bearer credentials until the approval deadline:
  deliver them only to the owner (the default hook prints the order id, not
  the links).
- Keep `EXPOSE_TRACE` off in production (with `NODE_ENV=production` the
  server and `doctor` warn when it is on), and leave `ALLOWED_ORIGINS` unset
  or list your origins; `*` is a `doctor` warning.

## Disclosure expectations

We aim to acknowledge private reports within a few days and to ship a fix on
the default branch promptly. Once a fix is released we publish a GitHub
security advisory crediting the reporter (unless you prefer to stay
anonymous). Please give us a reasonable window before publishing details;
we'll coordinate timing with you.
