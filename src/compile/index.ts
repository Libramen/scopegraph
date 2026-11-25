/**
 * Compiler public API: load → compile → lint.
 *
 * `loadGraph(dir)` is the one-call entry point used by the CLI and server:
 * it loads the catalog, compiles it, lints the graph (when compilation
 * succeeded) and returns diagnostics sorted errors-first by file/line.
 */
import type { Graph } from '../graph/types.js';
import { lintGraph } from '../lint/index.js';
import { compileCatalog } from './compile.js';
import type { Diagnostic } from './diagnostics.js';
import { sortDiagnostics } from './diagnostics.js';
import { loadCatalog } from './load.js';

export { compileCatalog } from './compile.js';
export { loadCatalog } from './load.js';
export type { LoadedCatalogInput, LoadedEntry, SourceInfo } from './load.js';
export { formatDiagnostic } from './diagnostics.js';
export type { Diagnostic, Locator } from './diagnostics.js';

export async function loadGraph(
  dir: string,
): Promise<{ graph?: Graph; diagnostics: Diagnostic[] }> {
  const input = await loadCatalog(dir);
  const { graph, diagnostics } = compileCatalog(input);
  const lint = graph !== undefined ? lintGraph(graph) : [];
  return { graph, diagnostics: sortDiagnostics([...diagnostics, ...lint]) };
}
