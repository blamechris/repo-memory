/**
 * File extensions the import extractor (src/indexer/imports.ts) understands.
 * This is the single source of truth for which files participate in the
 * dependency graph — the graph tools, the summary write path, and the
 * freshness pass must all agree on it.
 */
export const GRAPH_INDEXABLE_EXTENSIONS: ReadonlySet<string> = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.py',
  '.go',
  '.rs',
  '.kt',
  '.kts',
  '.java',
]);

/** Whether import edges can be extracted from the file at this path. */
export function isGraphIndexable(filePath: string): boolean {
  const dot = filePath.lastIndexOf('.');
  if (dot === -1) return false;
  return GRAPH_INDEXABLE_EXTENSIONS.has(filePath.slice(dot).toLowerCase());
}
