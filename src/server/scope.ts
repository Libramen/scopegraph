/**
 * Shared scope pipeline — the one place that enforces the facts boundary and
 * the evaluate → onQualified hand-off, used identically by the HTTP API
 * (`POST /api/offerings/:id/scope`) and the MCP tool (`scope_offering`).
 *
 * SECURITY: caller-supplied input is reduced to { answers, selections, date }
 * before it reaches the engine. Any `facts` key in a request body or tool
 * argument is discarded here — facts only ever come from `src/extend/facts.ts`
 * on the server. Buyers must not be able to forge "tide is fine" or "vip is
 * open".
 */
import type { Graph, Value } from '../graph/types.js';
import type { NeedsInput, Quote, QuestionReason, ScopeResult, Trace } from '../engine/types.js';
import { evaluate, factsContext } from '../engine/index.js';
import { isUnset } from '../engine/inputs.js';
import { getFacts } from '../extend/facts.js';
import { onQualified, type Handoff } from '../extend/onQualified.js';
import type { ScopePayments } from '../payments/index.js';

/** Longest offering search query (`GET /api/offerings?q=`, `list_offerings`) accepted. */
export const MAX_OFFERING_QUERY_LENGTH = 200;

/** The caller-controlled part of a scope request. Nothing else is accepted. */
export interface ScopeInput {
  answers?: Record<string, Value>;
  selections?: Record<string, string | string[]>;
  date?: string;
}

/** The hand-off plus, when payments are enabled and the quote is payable, how to pay it. */
export interface NextSteps extends Handoff {
  checkout?: string;
}

/**
 * With payments enabled, a qualified quote carries `payable`; payable quotes
 * also carry the stored quote id (`qt_…`) every payment door takes, and its expiry.
 */
export type PayableQuote = Quote & { payable: boolean; id?: string; expiresAt?: string };

/**
 * A scope result as served, plus the optional qualified hand-off (`next`).
 * `needs_input.reason` (why the question is asked) is present only when tracing
 * is on; a qualified result never carries the internal full `request`.
 */
export type ScopeOutcome = (Exclude<ScopeResult, NeedsInput> | (Omit<NeedsInput, 'reason'> & { reason?: QuestionReason })) & {
  next?: NextSteps;
};

/**
 * Validate and narrow unknown caller input down to a `ScopeInput`.
 * Unknown keys (including `facts`) are ignored — only the shape of the three
 * accepted keys is checked, so a malformed request fails fast with a 400 /
 * tool error instead of surprising the engine later.
 */
export function parseScopeInput(
  raw: unknown,
): { ok: true; input: ScopeInput } | { ok: false; message: string } {
  if (raw === undefined || raw === null) return { ok: true, input: {} };
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, message: 'Request body must be a JSON object.' };
  }
  const body = raw as Record<string, unknown>;
  const input: ScopeInput = {};

  if (body.answers !== undefined && body.answers !== null) {
    if (typeof body.answers !== 'object' || Array.isArray(body.answers)) {
      return { ok: false, message: '`answers` must be an object keyed by parameter name.' };
    }
    input.answers = body.answers as Record<string, Value>;
  }

  if (body.selections !== undefined && body.selections !== null) {
    if (typeof body.selections !== 'object' || Array.isArray(body.selections)) {
      return { ok: false, message: '`selections` must be an object keyed by option group.' };
    }
    const selections: Record<string, string | string[]> = {};
    for (const [group, value] of Object.entries(body.selections)) {
      if (typeof value === 'string') {
        selections[group] = value;
      } else if (
        Array.isArray(value) && value.every((item) => typeof item === 'string')
      ) {
        selections[group] = value as string[];
      } else {
        return {
          ok: false,
          message: `\`selections.${group}\` must be an option key or a list of option keys.`,
        };
      }
    }
    input.selections = selections;
  }

  if (body.date !== undefined && body.date !== null) {
    if (typeof body.date !== 'string') {
      return { ok: false, message: '`date` must be an ISO 8601 date or date-time string.' };
    }
    input.date = body.date;
  }

  // Every other key — `facts` included — is deliberately dropped.
  return { ok: true, input };
}

/**
 * Trace warnings that name server-side vocabulary: required or undeclared
 * facts, and pricing failures (formula text, internal parameter names).
 */
const PRIVATE_WARNING = /^(?:Required fact |Ignored undeclared fact |PRICING_ERROR: )/;

/**
 * The trace a buyer may see when EXPOSE_TRACE is on: server fact values and
 * internal-parameter values are removed from `values` and from rules'
 * `unknownRefs`, warnings about facts and pricing failures are dropped, and
 * pricing entries that did not apply (adjustments the buyer did not get, and
 * whether their conditions held) are dropped — applied entries already appear
 * as quote lines.
 */
function publicTrace(graph: Graph, offering: string, trace: Trace): Trace {
  const parameters = Object.hasOwn(graph.offerings, offering) ? graph.offerings[offering]?.scope.parameters ?? [] : [];
  const hidden = new Set([
    ...Object.keys(graph.business.facts),
    ...parameters.filter((p) => p.internal).map((p) => p.name),
  ]);
  const values: Record<string, Value> = Object.create(null);
  for (const [name, value] of Object.entries(trace.values)) if (!hidden.has(name)) values[name] = value;
  return {
    ...trace,
    values,
    rules: trace.rules.map((rule) => ({ ...rule, unknownRefs: rule.unknownRefs.filter((name) => !hidden.has(name)) })),
    pricing: trace.pricing.filter((entry) => entry.applied),
    warnings: trace.warnings.filter((warning) => !PRIVATE_WARNING.test(warning)),
  };
}

/**
 * Evaluate one scope request end to end:
 * server facts → engine → (on qualified) hand-off hook → (payments on) stored quote.
 *
 * Under `disclosure: progressive` the engine runs for the `buyer` audience:
 * unknown names, invalid values and unknown options are dropped (an invalid
 * value is reported only when its step is the next question), and a
 * `summary` of only the buyer's own answers. The stored quote still freezes the
 * full normalized request.
 *
 * Both hooks are fault-isolated: a crashing `getFacts` degrades to "no
 * facts" (required facts then block, fail closed) and a crashing
 * `onQualified` merely omits `next` — a fork's integration bug never turns
 * into a 500 for the buyer.
 *
 * `client` is the caller's rate-limit key (client IP); payments use it for the
 * per-client quota.
 */
export async function runScope(
  graph: Graph,
  offering: string,
  input: ScopeInput,
  exposeTrace: boolean,
  payments?: ScopePayments,
  client?: string,
): Promise<ScopeOutcome> {
  const now = new Date();
  const context = factsContext(graph, offering, input.date, now);
  let facts: Record<string, Value> = {};
  if (context !== undefined) {
    try {
      facts = await getFacts(context);
    } catch (err) {
      console.error(`getFacts failed for offering '${offering}':`, err);
    }
  }

  const result = evaluate(
    graph,
    {
      offering,
      ...(input.answers !== undefined ? { answers: input.answers } : {}),
      ...(input.selections !== undefined ? { selections: input.selections } : {}),
      ...(input.date !== undefined ? { date: input.date } : {}),
      facts,
    },
    { now, trace: exposeTrace, audience: graph.business.disclosure === 'progressive' ? 'buyer' : 'owner' },
  );

  if (result.status === 'blocked') {
    if (result.reasons.some((reason) => reason.code === 'FACTS_UNAVAILABLE')) {
      // Buyers only see a generic message; the operator needs the fact names.
      const missing = Object.values(graph.business.facts).filter((f) => f.required && isUnset(facts[f.name]));
      console.error(`getFacts did not supply required fact(s) for offering '${offering}': ${missing.map((f) => f.name).join(', ')}`);
    }
    // Rule ids are authoring names (`surf-lesson.tide_window`): only traced callers see them.
    if (!exposeTrace) result.reasons = result.reasons.map(({ ruleId: _ruleId, ...reason }) => reason);
  }

  if (result.trace !== undefined) result.trace = publicTrace(graph, offering, result.trace);
  if (result.status === 'needs_input') {
    // Whether an answer feeds a rule or a price is authoring detail: only traced callers see it.
    if (exposeTrace) return result;
    const { reason: _reason, ...untraced } = result;
    return untraced;
  }
  if (result.status !== 'qualified') return result;

  // Owner-audience results (`disclosure: menu`) carry no `request`: their summary is the full request.
  const { request = result.summary, ...qualified } = result;
  let next: NextSteps | undefined;
  try {
    const handoff = await onQualified(qualified, {
      business: graph.business,
      request: {
        offering,
        ...(input.answers !== undefined ? { answers: input.answers } : {}),
        ...(input.selections !== undefined ? { selections: input.selections } : {}),
        ...(input.date !== undefined ? { date: input.date } : {}),
      },
    });
    if (handoff && (handoff.url !== undefined || handoff.message !== undefined)) next = handoff;
  } catch (err) {
    console.error(`onQualified failed for offering '${offering}':`, err);
  }

  if (payments === undefined) return next === undefined ? qualified : { ...qualified, next };

  // The stored quote freezes the full normalized request + price; doors only ever take its id.
  const stored = await payments.createQuote(offering, request, qualified.quote, client);
  if (stored === undefined) {
    const quote: PayableQuote = { ...qualified.quote, payable: false };
    return { ...qualified, quote, ...(next !== undefined ? { next } : {}) };
  }
  const quote: PayableQuote = { ...qualified.quote, id: stored.id, expiresAt: stored.expiresAt, payable: true };
  return { ...qualified, quote, next: { ...next, checkout: payments.checkoutGuidance(stored) } };
}
