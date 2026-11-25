/**
 * Facts hook — THE FILE FORKERS EDIT to connect live business data.
 *
 * Facts are trusted, server-side values (e.g. "is the tide safe today?",
 * "how many guides are on shift?") that catalog rules and pricing can
 * reference in `when` conditions. They are resolved HERE, on the server, on
 * every scope request — never accepted from the caller. Callers cannot forge
 * them: any `facts` key in an HTTP body or MCP tool argument is ignored
 * before evaluation, and a buyer answer can never stand in for a fact.
 *
 * Only keys declared in `catalog/business.yaml` under `facts:` are used;
 * undeclared keys you return are ignored (with a trace warning).
 * A declared fact marked `required: true` that is missing when this
 * function returns makes the request `blocked` with `FACTS_UNAVAILABLE`
 * (fail closed) — so if your data source is down, you never accidentally
 * sell something you cannot deliver.
 */
import type { Business, Value } from '../graph/types.js';

/** Context for resolving facts. */
export interface FactsContext {
  /** The offering being scoped — always a listed (active, bookable) offering id. */
  offering: string;
  /**
   * The buyer's requested date (`YYYY-MM-DD` or ISO date-time), only when it
   * parses as a real date; otherwise absent. Still buyer input — escape it
   * before putting it in a query, path or URL.
   */
  date?: string;
  /** The compiled business (declared facts, currency, timezone, seasons). */
  business: Business;
}

/**
 * Resolve server-side facts for one scope request.
 * Keep it fast — it runs on every scope call.
 */
export async function getFacts(ctx: FactsContext): Promise<Record<string, Value>> {
  // DEMO for the starter catalog (Sea Stack Surf School declares a required
  // `tide_ft` fact). Pretends the tide is always 3 ft so `npm run dev` works
  // out of the box. Replace this with your own data source — see the example below.
  if (Object.hasOwn(ctx.business.facts, 'tide_ft')) return { tide_ft: 3 };
  return {};

  // ── EXAMPLE: a live data source ─────────────────────────────────────────
  // A kayak-tour business that depends on the tide. `catalog/business.yaml`:
  //
  //   facts:
  //     channel_depth_m:
  //       type: number
  //       description: Water depth in metres over the launch channel right now
  //       required: true
  //
  // A rule in `catalog/offerings/kayak-tour.yaml` can then read it:
  //
  //   rules:
  //     - id: channel_too_shallow
  //       when: { channel_depth_m: { lt: 0.8 } }
  //       block: The launch channel is too shallow to paddle out right now.
  //
  // And this hook makes it live:
  //
  //   const res = await fetch(
  //     `https://api.tides.example/v1/depth?spot=north-cove&date=${encodeURIComponent(ctx.date ?? 'today')}`,
  //     { signal: AbortSignal.timeout(2000) },
  //   );
  //   if (!res.ok) return {}; // required fact missing → blocked FACTS_UNAVAILABLE (fail closed)
  //   const data = (await res.json()) as { depth_m: number };
  //   return { channel_depth_m: data.depth_m };
}
