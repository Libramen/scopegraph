/**
 * Catalog loading: `business.yaml` + `offerings/*.yaml|*.yml` → `CatalogInput`.
 *
 * Loading never throws. YAML syntax errors, a missing `business.yaml` and
 * non-conforming offering file names become load diagnostics that ride along
 * with the parsed entry (via the `SOURCE_INFO` symbol) so `compileCatalog`
 * can surface them. Each entry also carries a path→line/column locator built
 * from a `LineCounter`, so compile diagnostics point into the source file.
 */
import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { LineCounter, Scalar, YAMLMap, YAMLSeq, isNode, isPair, parseDocument } from 'yaml';
import type { Node } from 'yaml';
import { OFFERING_ID_PATTERN } from '../catalog/schema.js';
import type { Diagnostic, Locator } from './diagnostics.js';
import { Reporter } from './diagnostics.js';

/** Out-of-band per-source metadata (position locator + load diagnostics). */
export interface SourceInfo {
  /** Catalog-relative file path, e.g. `offerings/camp.yaml`. */
  file: string;
  /** Resolves a data path inside this file to its 1-based YAML position. */
  locate: Locator;
  /** Problems found while reading/parsing (already carry file/line). */
  loadDiagnostics: Diagnostic[];
}

export const SOURCE_INFO: unique symbol = Symbol('scopegraph.sourceInfo');

export interface LoadedEntry {
  file: string;
  data: unknown;
  [SOURCE_INFO]?: SourceInfo;
}

/** `CatalogInput` with source metadata attached; assignable to `CatalogInput`. */
export interface LoadedCatalogInput {
  business: LoadedEntry;
  offerings: Array<LoadedEntry & { id: string }>;
}

interface ParsedSource {
  data: unknown;
  info: SourceInfo;
}

function firstLine(message: string): string {
  const line = message.split('\n', 1)[0] ?? message;
  return line.replace(/\s+$/, '');
}


/** Value node of `segment` in a YAML map (merge-key Pairs are ignored). */
function mapValueAt(
  map: YAMLMap,
  segment: string | number,
): Node | null | undefined {
  for (const pair of map.items) {
    const key = pair.key;
    if (key instanceof Scalar && String(key.value) === String(segment)) {
      const value = pair.value;
      return isNode(value) && !isPair(value) ? value : undefined;
    }
  }
  return undefined;
}

/** Parses one YAML source; syntax errors and warnings become diagnostics. */
function parseSource(
  file: string,
  text: string,
  out: Diagnostic[],
): ParsedSource {
  const lineCounter = new LineCounter();
  const doc = parseDocument(text, { lineCounter });
  const rep = new Reporter(out, file);

  const positionDiagnostic = (
    diagnostic: Diagnostic,
    offset: number,
  ): void => {
    const pos = lineCounter.linePos(offset);
    diagnostic.line = pos.line;
    diagnostic.column = pos.col;
  };

  for (const err of doc.errors) {
    const diagnostic = rep.error(
      'YAML_SYNTAX',
      `YAML syntax error: ${firstLine(err.message)}`,
      [],
      'fix the YAML indentation/structure at this line; nothing else in the file was read',
    );
    positionDiagnostic(diagnostic, err.pos[0]!);
  }
  for (const warning of doc.warnings) {
    const diagnostic = rep.warn(
      'YAML_SYNTAX',
      `YAML warning: ${firstLine(warning.message)}`,
      [],
      'usually a duplicate key: keep only one',
    );
    positionDiagnostic(diagnostic, warning.pos[0]!);
  }

  let data: unknown;
  if (doc.errors.length > 0) {
    data = undefined; // the document is not trustworthy; compile skips it
  } else {
    try {
      data = doc.toJS();
    } catch {
      data = undefined;
      rep.error('YAML_SYNTAX', 'YAML document could not be converted', []);
    }
  }

  const locate: Locator = (path) => {
    let node: Node | null | undefined = doc.contents;
    for (const segment of path) {
      let next: Node | null | undefined;
      if (node instanceof YAMLMap) {
        next = mapValueAt(node, segment);
      } else if (node instanceof YAMLSeq && typeof segment === 'number') {
        const item = node.items[segment];
        next = isNode(item) ? item : undefined;
      } else {
        return undefined;
      }
      node = next;
    }
    if (node === null || node === undefined) return undefined;
    const range = node.range;
    if (!range) return undefined;
    const pos = lineCounter.linePos(range[0]!);
    return { line: pos.line, column: pos.col };
  };

  return { data, info: { file, locate, loadDiagnostics: out } };
}

async function readTextIfExists(
  file: string,
): Promise<{ text?: string; exists: boolean }> {
  try {
    const stats = await stat(file);
    if (!stats.isFile()) return { exists: false };
    return { text: await readFile(file, 'utf8'), exists: true };
  } catch {
    return { exists: false };
  }
}

/**
 * Loads a catalog directory into a `CatalogInput` (with source metadata).
 * Never throws: every problem becomes a diagnostic for `compileCatalog`.
 */
export async function loadCatalog(dir: string): Promise<LoadedCatalogInput> {
  const businessDiagnostics: Diagnostic[] = [];
  const businessRep = new Reporter(businessDiagnostics, 'business.yaml');

  let businessFile = 'business.yaml';
  let businessText: string | undefined;
  const yamlCandidate = await readTextIfExists(join(dir, 'business.yaml'));
  if (yamlCandidate.exists) {
    businessText = yamlCandidate.text;
  } else {
    const ymlCandidate = await readTextIfExists(join(dir, 'business.yml'));
    if (ymlCandidate.exists) {
      businessFile = 'business.yml';
      businessText = ymlCandidate.text;
    }
  }

  let business: LoadedEntry;
  if (businessText === undefined) {
    businessRep.error(
      'MISSING_FILE',
      `required file business.yaml is missing (looked in ${dir})`,
      [],
      'create business.yaml with at least `name`; see docs/catalog-format.md',
    );
    business = {
      file: businessFile,
      data: undefined,
      [SOURCE_INFO]: {
        file: businessFile,
        locate: () => undefined,
        loadDiagnostics: businessDiagnostics,
      },
    };
  } else {
    const parsed = parseSource(businessFile, businessText, businessDiagnostics);
    business = {
      file: businessFile,
      data: parsed.data,
      [SOURCE_INFO]: { ...parsed.info, loadDiagnostics: businessDiagnostics },
    };
  }

  const offerings: Array<LoadedEntry & { id: string }> = [];
  const offeringsDir = join(dir, 'offerings');
  let entries: string[] = [];
  try {
    const dirents = await readdir(offeringsDir, { withFileTypes: true });
    entries = dirents
      .filter((d) => d.isFile() && /\.ya?ml$/.test(d.name))
      .map((d) => d.name)
      .sort();
  } catch {
    businessRep.warn(
      'MISSING_DIR',
      'no offerings/ directory found; the catalog has no offerings',
      ['offerings'],
      'create offerings/<id>.yaml files (one offering each, id = file name)',
    );
  }

  for (const name of entries) {
    const id = name.replace(/\.ya?ml$/, '');
    const file = relative(dir, join(offeringsDir, name));
    const loadDiagnostics: Diagnostic[] = [];
    const rep = new Reporter(loadDiagnostics, file);
    if (!OFFERING_ID_PATTERN.test(id)) {
      rep.error(
        'INVALID_OFFERING_ID',
        `offering file name "${name}" is not a valid offering id`,
        [],
        'use lowercase letters, digits, "_" or "-", starting with a letter (e.g. surf-lesson.yaml)',
      );
    }
    const text = await readFile(join(offeringsDir, name), 'utf8');
    const parsed = parseSource(file, text, loadDiagnostics);
    offerings.push({
      id,
      file,
      data: parsed.data,
      [SOURCE_INFO]: { ...parsed.info, loadDiagnostics },
    });
  }

  return { business, offerings };
}

