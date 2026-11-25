/**
 * Catalog compiler entry point: validated `CatalogInput` → `Graph`.
 *
 * Pipeline: schema-parse business + offerings (zod issues become SCHEMA
 * diagnostics with exact paths), compile business (timezone, facts, seasons,
 * tax), compile each offering's own parts (parameters, option groups, base
 * price), then assemble scopes — products get their own scope, packages get a
 * flattened scope (own parameters first, then each contained product's, with
 * conflict detection). A graph is returned only when there are zero error
 * diagnostics.
 *
 * The compiler never throws and never reads the clock: everything is derived
 * from the input. Positions (line/column) come from the source metadata the
 * loader attached via `SOURCE_INFO`; calling `compileCatalog` with plain data
 * simply yields unpositioned diagnostics. The per-topic compilers live in the
 * sibling modules (business, parameters, options, conditions, values, rules,
 * pricing, scope); this module only orchestrates them and reports schema
 * issues.
 */
import { z } from 'zod';
import { BusinessInput, OfferingInput } from '../catalog/schema.js';
import type { CatalogInput } from '../catalog/schema.js';
import type { Business, Graph, OfferingScope } from '../graph/types.js';
import { compileBusiness } from './business.js';
import { RESERVED, Session } from './context.js';
import type { OfferingData, OwnParts } from './context.js';
import type { Diagnostic, Reporter } from './diagnostics.js';
import { SOURCE_INFO } from './load.js';
import type { LoadedEntry, SourceInfo } from './load.js';
import { compileOptionGroup } from './options.js';
import { compileParameter } from './parameters.js';
import { compileBaseAndKind } from './pricing.js';
import { buildOffering, packageScope, productScope } from './scope.js';

export function compileCatalog(
  input: CatalogInput,
): { graph?: Graph; diagnostics: Diagnostic[] } {
  const session = new Session();
  const businessEntry = input.business as LoadedEntry;
  const businessInfo = businessEntry[SOURCE_INFO];
  session.diagnostics.push(...(businessInfo?.loadDiagnostics ?? []));

  // Business
  let business: Business | undefined;
  if (businessEntry.data === null) {
    session
      .repFor(businessInfo?.file, businessInfo)
      .error(
        'SCHEMA',
        'business.yaml is empty',
        [],
        'add at least `name`; see docs/catalog-format.md',
      );
  } else if (businessEntry.data !== undefined) {
    const parsed = BusinessInput.safeParse(businessEntry.data);
    if (parsed.success) {
      business = compileBusiness(parsed.data, session.repFor(businessInfo?.file, businessInfo));
    } else {
      reportSchemaIssues(parsed.error.issues, session, businessEntry.file, businessInfo);
    }
  } else if (businessInfo === undefined) {
    session.diagnostics.push({
      severity: 'error',
      code: 'SCHEMA',
      message: 'business data is missing',
      path: [],
    });
  }

  // Offerings: schema-parse everything, keep the valid ones
  interface ParsedOffering {
    id: string;
    file: string;
    info?: SourceInfo;
    data?: OfferingData;
    valid: boolean;
  }
  const parsedOfferings: ParsedOffering[] = [];
  for (const entry of input.offerings) {
    const info = (entry as LoadedEntry)[SOURCE_INFO];
    session.diagnostics.push(...(info?.loadDiagnostics ?? []));
    const record: ParsedOffering = {
      id: entry.id,
      file: entry.file,
      info,
      valid: false,
    };
    if (entry.data === null) {
      session
        .repFor(entry.file, info)
        .error(
          'SCHEMA',
          `${entry.file} is empty`,
          [],
          'an offering file needs at least `name` and `price`',
        );
    } else if (entry.data !== undefined) {
      const parsed = OfferingInput.safeParse(entry.data);
      if (parsed.success) {
        record.data = parsed.data;
        record.valid = true;
      } else {
        reportSchemaIssues(parsed.error.issues, session, entry.file, info);
      }
    }
    parsedOfferings.push(record);
  }

  if (!business) return { diagnostics: session.diagnostics };

  // Own parts for every schema-valid offering
  const ownById = new Map<string, OwnParts>();
  for (const record of parsedOfferings) {
    if (!record.valid || !record.data) continue;
    ownById.set(
      record.id,
      compileOwnParts(
        record.id,
        record.file,
        record.info,
        record.data,
        business,
        session.repFor(record.file, record.info),
      ),
    );
  }

  // Scopes: products first, then packages (which flatten product scopes)
  const offeringIds = parsedOfferings
    .filter((r) => r.valid)
    .map((r) => r.id)
    .filter((id) => ownById.has(id));
  const scopeById = new Map<string, OfferingScope>();
  const containsById = new Map<string, Array<{ offeringId: string; quantity: number }>>();
  for (const id of offeringIds) {
    const parts = ownById.get(id)!;
    if (parts.data.kind !== 'product') continue;
    scopeById.set(id, productScope(parts, business, session));
    containsById.set(id, []);
  }
  for (const id of offeringIds) {
    const parts = ownById.get(id)!;
    if (parts.data.kind === 'product') continue;
    const assembled = packageScope(parts, business, ownById, scopeById, session);
    scopeById.set(id, assembled.scope);
    containsById.set(id, assembled.contains);
  }

  const graph: Graph = { business, offerings: {} };
  for (const id of offeringIds) {
    const parts = ownById.get(id)!;
    const scope = scopeById.get(id);
    if (!scope) continue;
    graph.offerings[id] = buildOffering(parts, scope, containsById.get(id) ?? []);
  }

  if (session.hasErrors) return { diagnostics: session.diagnostics };
  return { graph, diagnostics: session.diagnostics };
}

function reportSchemaIssues(
  issues: z.ZodIssue[],
  session: Session,
  file: string,
  info: SourceInfo | undefined,
): void {
  const rep = session.repFor(file, info);
  for (const issue of issues) {
    const label = issue.path.map(String).join('.');
    if (issue.code === 'invalid_union') {
      const { message, hint } = unionMessage(issue, label);
      rep.error('SCHEMA', message, issue.path, hint);
      continue;
    }
    const hint =
      issue.code === 'unrecognized_keys'
        ? 'remove or rename the unknown key(s); the authoring format is documented in docs/catalog-format.md'
        : undefined;
    rep.error(
      'SCHEMA',
      `${label ? `${label}: ` : ''}${issue.message}`,
      issue.path,
      hint,
    );
  }
}

/**
 * Zod union failures say only "Invalid input". Inspect `unionErrors` and
 * surface the most specific branch failure — unrecognized keys first (they
 * name the typo), then the deepest issue path — alongside what the field
 * accepts.
 */
function unionMessage(
  issue: z.ZodIssue & { code: 'invalid_union'; unionErrors: z.ZodError[] },
  label: string,
): { message: string; hint?: string } {
  const branchIssues = issue.unionErrors.flatMap((error) => error.issues);
  const closest = [...branchIssues].sort((a, b) => issueRank(b) - issueRank(a))[0];
  const closestText =
    closest === undefined
      ? undefined
      : `${closest.path.map(String).join('.')}: ${closest.message}`;

  const field = issue.path[issue.path.length - 1];
  if (field === 'price') {
    return {
      message: `${label ? `${label}: ` : ''}price must be a number (e.g. 64) or an object { amount: 64, per: <parameter> }`,
      hint: closestText,
    };
  }
  return {
    message: `${label ? `${label}: ` : ''}${issue.message} (expected one of the accepted shapes; closest attempt: ${closestText ?? 'n/a'})`,
    hint: 'the accepted shapes are documented in docs/catalog-format.md',
  };
}

/** Unrecognized-key failures rank highest (they name the offender), then depth. */
function issueRank(issue: z.ZodIssue): number {
  return (issue.code === 'unrecognized_keys' ? 100 : 0) + issue.path.length;
}

function compileOwnParts(
  id: string,
  file: string,
  info: SourceInfo | undefined,
  data: OfferingData,
  business: Business,
  rep: Reporter,
): OwnParts {
  const parts: OwnParts = {
    id,
    file,
    ...(info !== undefined ? { info } : {}),
    data,
    params: [],
    groups: [],
    contains: [],
    deferredOptionPer: [],
    deferredOptionPricing: [],
  };

  for (const [name, input] of Object.entries(data.ask ?? {})) {
    const path = ['ask', name];
    if (RESERVED.includes(name)) {
      rep.error(
        'RESERVED_NAME',
        `parameter name '${name}' is reserved by the system`,
        path,
        'reserved names are derived by the engine or used by the condition grammar; pick another name',
      );
      continue;
    }
    if (business.facts[name] !== undefined) {
      rep.error(
        'NAME_COLLISION',
        `parameter '${name}' collides with a fact of the same name in business.yaml`,
        path,
        'rename one of them; while both exist, conditions cannot see the fact',
      );
      continue;
    }
    const param = compileParameter(id, name, input, rep, path);
    if (param) parts.params.push(param);
  }

  for (const [key, input] of Object.entries(data.choose ?? {})) {
    const group = compileOptionGroup(
      id,
      key,
      input,
      parts.deferredOptionPer,
      parts.deferredOptionPricing,
      rep,
      ['choose', key],
    );
    if (group) parts.groups.push(group);
  }

  compileBaseAndKind(parts, rep);
  return parts;
}
