/**
 * Machine-readable export of the compiled graph (`graph --format json|yaml`):
 * exactly what the engine evaluates — the `Graph` from src/graph/types.ts,
 * references resolved, money in integer minor units, percentages in parts
 * per million, every offering with its pre-flattened `scope` — wrapped in a
 * versioned envelope:
 *
 *   { scopegraphGraphVersion: 1, business, offerings }
 *
 * Output is deterministic: object keys are sorted (byte order) at every
 * level below the envelope, arrays keep their order (it is meaningful:
 * questions are asked, rules run and adjustments apply in array order), and
 * absent optional fields are omitted. The same catalog always produces the
 * same bytes, so exports diff cleanly.
 */
import { stringify } from 'yaml';
import type { Business, Graph, Offering } from '../graph/types.js';
import { lookupOffering } from './mermaid.js';

/** Output formats of the `graph` command (mermaid is the default). */
export const GRAPH_FORMATS = ['mermaid', 'json', 'yaml'] as const;
export type GraphFormat = (typeof GRAPH_FORMATS)[number];

/** Bumped on any breaking change to the exported shape. */
export const GRAPH_DOCUMENT_VERSION = 1;

export interface GraphDocument {
  scopegraphGraphVersion: typeof GRAPH_DOCUMENT_VERSION;
  business: Business;
  /** Keyed by offering id; only the requested one with `--offering`. */
  offerings: Record<string, Offering>;
}

/** Deep copy with object keys sorted and `undefined` fields dropped; arrays keep their order. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value === null || typeof value !== 'object') return value;
  const record = value as Record<string, unknown>;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(record).sort()) {
    if (record[key] !== undefined) sorted[key] = canonical(record[key]);
  }
  return sorted;
}

/**
 * The export document for the whole graph, or for one offering. A package's
 * `scope` is already flattened, so a single exported package is
 * self-contained (its `contains` lists the product ids). Throws when
 * `offeringId` is unknown.
 */
export function graphDocument(graph: Graph, offeringId?: string): GraphDocument {
  const offerings =
    offeringId === undefined ? graph.offerings : { [offeringId]: lookupOffering(graph, offeringId) };
  return {
    scopegraphGraphVersion: GRAPH_DOCUMENT_VERSION,
    business: canonical(graph.business) as Business,
    offerings: canonical(offerings) as Record<string, Offering>,
  };
}

/** Serialize an export document; the text ends with a newline. */
export function formatGraphDocument(document: GraphDocument, format: 'json' | 'yaml'): string {
  if (format === 'json') return `${JSON.stringify(document, null, 2)}\n`;
  return stringify(document, { aliasDuplicateObjects: false, lineWidth: 0 });
}
