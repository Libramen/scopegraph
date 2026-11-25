# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-11-24

Initial release.

### Added

- **Catalog format** — model a business as `catalog/business.yaml` plus one
  YAML file per offering: products and packages, questions (`ask:`),
  add-on choices (`choose:`), refusal/requirement rules, and price
  adjustments (flat, per-unit, percent, tiered, formula) with exact
  fraction arithmetic and fail-closed pricing. JSON Schemas in `schema/`
  give editors validation as you type.
- **Deterministic scoping engine** — every request resolves to exactly one of
  five outcomes (`qualified`, `needs_input`, `blocked`, `invalid`,
  `unavailable`); three-valued rule logic asks instead of guessing; derived
  date values (`isWeekend`, `isPeak`, `season`, lead time, …) and server-side
  facts with a strict trust boundary (caller-supplied facts are discarded).
  Catalog regular expressions run on a linear-time RE2 engine.
- **Progressive disclosure by default** — buyer agents get an offering
  overview, then one question at a time, and qualified results offer the
  optional add-ons still open as `addOns`; rules, pricing logic, facts and
  rule ids stay on the server; an invalid answer is reported only for a
  step that is still open (unknown names and closed steps are ignored), and
  unlisted offerings all answer `NOT_FOUND`.
  `disclosure: menu` in `business.yaml` publishes every question and add-on
  through `describe_offering` instead.
- **Scenarios** — executable specs (`scenarios/*.yaml`) that pin expected
  questions, refusals, and exact totals.
- **CLI** — `init`, `doctor`, `validate`, `list`, `describe`, `simulate`
  (incl. `--interactive` and `--explain`), `test`, `graph` (mermaid, or the
  compiled graph as JSON/YAML), `serve` (`--watch` reloads the catalog on
  save; `npm run dev` uses it), `mcp-config` (ready-to-paste Claude Desktop
  config), and `orders` for owner approval. The CLI loads the checkout's
  `.env` (never the working directory's, never its `NODE_*` keys, and none
  under `NODE_ENV=production`); variables already set win.
- **Server** — one process serving an HTTP API for websites and an MCP
  (Streamable HTTP + stdio) endpoint for AI agents, with CORS allow-listing,
  per-client rate limits on every route but `/health`, discovery via
  `/.well-known/mcp.json` and `/llms.txt`, compact JSON tool results, and
  JSON errors for every route (400/413/415 for unreadable requests, 404 for
  unknown routes).
- **Payments (optional, Stripe)** — qualified quotes become frozen, payable
  quotes through four doors: hosted payment link, UCP and ACP agent checkout,
  and MPP machine payments; owner approval by default (card held until you
  approve or reject), durable order store, verified webhooks, signed approval
  links, and bounded state: per-client and per-IPv6-/48 quotas and an
  atomic open-order cap per payment route.
- **Extension points** — `src/extend/facts.ts`, `onQualified.ts`, and
  `orders.ts` hooks for live facts, post-quote hand-off, and order
  notifications.
- **Deploy tooling** — Dockerfile (non-root, pinned base image, health
  check) and `.nvmrc`.
- **Examples and docs** — starter catalog + scenarios (Sea Stack Surf
  School), example businesses in `examples/` (plus a copy of the starter),
  and guides for the catalog format, modeling, connecting, payments and
  deployment.

### Security

See `SECURITY.md` for how to report a vulnerability and an operator
checklist. The server refuses unsafe settings at boot (`TRUST_PROXY=true`,
short or reused payment secrets, a loopback `PUBLIC_URL` with a live Stripe
key) and `doctor` flags risky ones. Known advisory: zod 3
(GHSA-mrhx-c7xc-m3w5), whose memory-exhaustion path is bounded by the 32 KB
request-body limit.

[Unreleased]: https://github.com/Libramen/scopegraph/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/Libramen/scopegraph/releases/tag/v0.1.0
