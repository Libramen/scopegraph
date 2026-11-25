# AGENTS.md — instructions for coding agents working in this repo

This repo is **scopegraph**: a template that turns a business's
offers into a machine-readable graph. A business models *what it sells, what
it needs to know before accepting, what it refuses, and what it costs* as a
directory of YAML files (`catalog/`), backs the model with executable specs
(`scenarios/`), and serves it to AI agents (MCP) and websites (HTTP) so buyers
can be scoped — asked the right questions, refused when the business would
say no, and quoted an exact price — by a machine that cannot guess. Your job
as the business owner's coding agent is to translate a real business into `catalog/*.yaml`
and keep `npm run validate` and `npm run scenarios` green. Everything else in
`src/` is a finished engine: you rarely need to touch it.

## The authoring loop

Work in this order. Do not skip steps and do not invent facts.

1. **Gather from the human.** Ask the business owner what they sell, what
   they need to know about a buyer before saying yes, what they refuse, and
   what things cost. Never invent prices, policies, or refusal rules: if the
   human has not stated it, ask. (If something genuinely is unknown, leave it
   out and say so in your summary.)
2. **Write scenarios FIRST**, in the human's own words, before any catalog
   YAML: `scenarios/*.yaml`. A scenario is one conversation you expect to
   have with a buyer — "two first-timers on Saturday" — plus the outcome the
   human just described (a question, a refusal, or an exact price). These
   are your acceptance tests; the catalog is done when they pass.
3. **Write or edit the catalog YAML** — from scratch or from
   `scopegraph init` scaffolding:
   `catalog/business.yaml` (currency, tax, facts, seasons, handoff, payments, disclosure)
   and `catalog/offerings/<id>.yaml` (price, questions, options, rules, price
   adjustments). Syntax reference: `docs/catalog-format.md`; how to think
   about it: `docs/modeling.md`. The example businesses in `examples/` (see
   `examples/README.md`) are for learning the format: never copy their
   prices, questions or rules into the human's catalog. Every catalog and scenario file starts
   with a `# yaml-language-server: $schema=…` line pointing at `schema/`
   (path relative to the file, e.g. `../../schema/offering.schema.json` in
   `catalog/offerings/`); keep it as the first line of files you create.
4. **`npm run validate`** until clean. Fix *every* error. Treat warnings
   seriously: they usually mean a rule or price can never fire.
5. **`npm run scenarios`** until green. When a scenario fails, decide whether
   the YAML or the expectation is wrong — the human's words win; anything you
   made up loses.
6. **`npm run simulate -- <offering-id> --explain`** with `--answers`,
   `--selections` and `--date` (see below) to walk the buyer experience
   yourself and sanity-check what gets asked, refused and charged
   (`--interactive` is for a human at a terminal). To see the whole compiled model
   at once — every question, option, rule and price exactly as the engine
   will evaluate it — run
   **`npm run --silent sg -- graph --format json [--offering <id>]`**. That
   is the way to inspect the model: read it rather than re-deriving the
   compiled shape from the YAML (money is in integer cents, percentages in
   millionths (`rateMicros`), package `scope`s are already flattened).
7. **Summarise to the human**: what the agent will now ask every buyer, what
   it refuses (and why), and what it charges — including edge cases you
   modeled. Confirm anything surprising.

## Exact commands

```bash
npm install                # once, in your copy (needs Node >= 22)
npm run sg -- init         # scaffold a fresh catalog/ + scenarios/ (asks questions in a terminal)
                           # (--dir, --name, --currency, --timezone, --tax-rate,
                           #  --payments off|owner_approves|instant, --force, --yes)
# as an agent, pass every answer as a flag:
npm run sg -- init --yes --force --name "Harbor City Cleaning" --currency USD --timezone America/New_York --tax-rate 8.5
npm run sg -- doctor       # health-check the setup, report problems
                           # (--catalog <dir>, --offline, --json)
npm run validate           # compile + lint catalog/ (add -- --catalog <dir> for another catalog)
npm run scenarios          # run scenarios/ against catalog/ (--scenarios <dir|file>, --filter <substr>)
npm run simulate -- surf-lesson --explain          # one request, explained
npm run simulate -- surf-lesson --interactive      # walk the question flow yourself
# simulate resolves facts through src/extend/facts.ts, like the server;
# --facts '<json>' merges over the hook (override single keys), --now <iso>
# pins the clock (default: the real current time):
npm run simulate -- surf-lesson --date 2026-07-04 --now 2026-07-01T00:00:00Z --facts '{"tide_ft":3}'
# a full request — answers, option-group selections and date — to a quote:
npm run simulate -- first-wave-weekend --date 2027-01-09 --now 2027-01-01T00:00:00Z --answers '{"surfers":2,"cold_water_ok":true,"surf_history":"first_time"}' --selections '{"hire":["foam_board"]}' --explain
#
# Scenario files NEVER call the hook: a scenario's facts come from its own
# `facts:` (or the file's `defaults.facts`) so specs stay deterministic.
npm run --silent sg -- graph --format json --offering surf-lesson   # the compiled model, as JSON
npm run sg -- graph --format json --out graph.json # …or the whole catalog, to a file
npm run sg -- graph --offering surf-lesson         # mermaid flowchart (paste into a ```mermaid block)
npm run dev                # serve HTTP + MCP locally on :3000; reloads catalog/ on save
npm run sg -- serve --stdio          # MCP over stdio (for MCP clients use the mcp-config output instead)
npm run --silent sg -- mcp-config   # ready-to-paste Claude Desktop / MCP client config
npm test                   # engine unit tests (no catalog needed)
```

## File map

| Path | You edit? | What it is |
|---|---|---|
| `catalog/business.yaml` | **yes** | currency, timezone, sales tax, server facts, seasons, handoff, payments, disclosure |
| `catalog/offerings/*.yaml` | **yes** | one file per product/package; file name = offering id |
| `scenarios/*.yaml` | **yes** | executable specs: inputs → expected outcome |
| `examples/*/` | **yes** | example businesses for learning the format (never copy their values) — see `examples/README.md`; `sea-stack-surf/` is a copy of the starter |
| `docs/connecting.md` | yes (docs) | HTTP + MCP + handoff + facts |
| `docs/payments.md` | yes (docs) | taking payment for quotes (doors, approval, Stripe) |
| `docs/deploy.md` | yes (docs) | deploying the server |
| `src/extend/facts.ts` | **yes** | supply trusted facts at request time (tide, staffing, VIP status…) |
| `src/extend/onQualified.ts` | **yes** | what happens after a qualified quote (booking URL, CRM, webhook) |
| `src/extend/orders.ts` | **yes** | payment hooks: notify on approval-needed / paid / closed |
| `src/` (everything else) | no | the engine, compiler, CLI, server — see below |
| `schema/*.schema.json` | no | JSON Schemas for the YAML files (editor checking), generated from `src/catalog/schema.ts` + `src/scenarios/schema.ts` by `npm run schema` |
| `.github/workflows/ci.yml` | rarely | CI: typecheck, tests, build, Docker, validate + scenarios everywhere |

## Modeling rules of thumb

Read `docs/modeling.md` before writing serious YAML. The short version:

- Model offerings, not conversations: the engine decides question order.
- A **parameter** is an answer; an **option group** is a choice of add-ons.
- Rules are `when → effect` with three-valued logic: a rule that cannot be
  decided *asks* the buyer instead of guessing. Write a requirement as a
  `block` that fires when it is *not* met
  (`when: { not: { cold_water_ok: true } }`), so a missing answer asks
  rather than blocks.
- Prices: per-unit needs a quantity parameter (`role: quantity`); option
  charges live on the option; weekend/peak/late-booking charges are
  `pricing:` lines with a `when:` on `isWeekend`, `isPeak`, `season` or
  `leadTimeHours`.
- Never invent an amount. If the human gave a price for a bundle, put the
  price on the package; if they priced parts, omit the package price.
- Don't duplicate a parameter across a package's products unless the
  definitions are identical (packages de-duplicate by name).
- Price set by a choice (dog size, room type): `price: 0` plus a
  required single-choice group with priced options — and then percent
  surcharges need `basis: running` (a `base` percent of $0 is $0).
- Optional option groups are never asked during scoping; a qualified result
  offers them to the buyer as `addOns`. If the owner wants every buyer to
  choose explicitly before quoting, ask them, and make the group required
  with an explicit `none` option.
- What buyer agents see before scoping is the owner's call:
  `disclosure: progressive` (the default — an overview, then one question at
  a time) or `disclosure: menu` in `catalog/business.yaml` (every question
  and add-on published up front through `describe_offering`). Leave the
  default unless the owner asks for the menu.

## Payments: business-level, never invented

Payment behaviour is a **business decision**, modeled in
`catalog/business.yaml` under `payments:` (confirmation mode, approval
window, quote TTL — see `docs/catalog-format.md`). Like prices and refusal
rules: **never invent payment settings.** If the human has not told you
whether they approve charges before capture, how long they have, or how
long a quote stays payable, ask — or leave the block out entirely (the
defaults: owner approves, 24h window, 30-minute quotes).

Payments are also **infrastructure-gated**: without `STRIPE_SECRET_KEY` in
the environment (or `.env`) the server simply doesn't mount payment doors,
and `scope_offering` returns quotes without payment ids. That is how you
test locally with zero Stripe setup:

```bash
npm run dev                     # no STRIPE_SECRET_KEY → payments off, everything else works
npm test                        # engine + CLI tests, no Stripe, no network
npm run scenarios               # catalog specs are payment-agnostic
```

Only test payment flows when the human provides test-mode Stripe variables
(`docs/payments.md` has the full setup). When
payments are on, the owner reviews orders with
`npm run sg -- orders list --status awaiting_approval` and
`… orders approve <id>`.

## The trust boundary

**Facts are server-side truths.** Things a buyer could lie about — "the tide
is safe", "we're at capacity", "this customer is a VIP" — must never be
questions or accepted inputs. Declare them under `facts:` in
`catalog/business.yaml` and supply them per-request in
`src/extend/facts.ts`. The server discards any `facts` key a caller sends.
Mark safety/legality-critical facts `required: true`: if your hook can't
resolve them, requests fail closed (`blocked`, `FACTS_UNAVAILABLE`) instead
of guessing.

## Where to add integrations

- `src/extend/facts.ts` — fetch live facts (tide API, staffing, inventory
  counts) per request.
- `src/extend/onQualified.ts` — fire on every qualified quote: booking-page
  URL, CRM record, Slack ping, webhook. Default: templates the `handoff.url`
  from `catalog/business.yaml`.
- `docs/connecting.md` — how websites and agents reach this server.

## What NOT to change

`src/engine/`, `src/conditions/`, `src/pricing/`, `src/compile/`,
`src/scenarios/`, `src/server/` implement the scoping semantics this whole
template promises (question order, three-valued rule logic, fail-closed
pricing, the facts boundary). Changing them silently changes what every
scenario and every deployed agent means. Model differences in YAML; if the
engine genuinely cannot express something the business needs, say so in your
summary and leave the engine alone unless the human asks for an engine change.
