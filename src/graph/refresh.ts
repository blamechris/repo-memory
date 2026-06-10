import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { hashContents } from '../cache/hash.js';
import { CacheStore } from '../cache/store.js';
import { scanProject } from '../indexer/scanner.js';
import { isGraphIndexable } from '../indexer/source-extensions.js';
import { DependencyGraph } from './dependency-graph.js';

/**
 * Meta key recording that the persisted graph has been fully built at least
 * once by this implementation. Caches created before the graph was wired into
 * the write path have file rows but no edges — without this marker those
 * files would look "fresh" forever and never get indexed. Bump the value to
 * force a one-time full re-extraction after a change to the edge format.
 */
const GRAPH_GENERATION_KEY = 'graph_generation';
const GRAPH_GENERATION = '1';

/**
 * Load the persisted dependency graph and bring it up to date without
 * re-reading unchanged files.
 *
 * Freshness strategy:
 * 1. `load()` the persisted edges, then prune nodes whose files are gone from
 *    the project file list.
 * 2. For each graph-indexable file, `stat` it (cheap, no content read). If a
 *    `files` row exists and the mtime predates the row's `last_checked`, the
 *    content cannot have changed since the stored hash was computed — skip.
 * 3. Otherwise read the file once, hash it, and compare with the stored hash:
 *    only a real change (or a missing row) re-extracts edges. Edge writes and
 *    summary-cache rows share the same hash bookkeeping, so edges have the
 *    same freshness semantics as summaries (never-stale invariant).
 *
 * @param scannedFiles Optional pre-scanned project file list (avoids a second
 *   scan when the caller already has one).
 */
export async function loadFreshGraph(
  projectRoot: string,
  scannedFiles?: string[],
): Promise<DependencyGraph> {
  const files = scannedFiles ?? (await scanProject(projectRoot));
  const store = new CacheStore(projectRoot);
  const graph = new DependencyGraph(projectRoot);
  graph.load();

  // Legacy caches (or a bumped edge format) need one full re-extraction pass.
  const fullRebuild = store.getMeta(GRAPH_GENERATION_KEY) !== GRAPH_GENERATION;

  // Files that left the project take their edges with them. (Files still in
  // the git index but deleted from disk are caught by the stat pass below.)
  graph.prune(new Set(files));

  for (const file of files) {
    if (!isGraphIndexable(file)) continue;

    const absolutePath = join(projectRoot, file);
    let mtimeMs: number;
    try {
      mtimeMs = (await stat(absolutePath)).mtimeMs;
    } catch {
      // Tracked in git but missing on disk (or deleted mid-pass): the file
      // does not exist anymore, so its edges must not be served.
      graph.removeFile(file);
      continue;
    }

    const entry = store.getEntry(file);
    if (!fullRebuild && entry && mtimeMs < entry.lastChecked) {
      // Unmodified since the stored hash was computed — do not re-read.
      continue;
    }

    let contents: string;
    try {
      contents = await readFile(absolutePath, 'utf-8');
    } catch {
      graph.removeFile(file);
      continue;
    }

    const currentHash = hashContents(contents);
    if (entry && entry.hash === currentHash) {
      // Content unchanged; edges for this hash are already persisted (unless
      // this is the one-time full rebuild). Bump last_checked so the next
      // pass can skip on mtime alone.
      if (fullRebuild) graph.updateFile(file, contents);
      if (mtimeMs >= entry.lastChecked) store.touchEntry(file);
    } else {
      graph.updateFile(file, contents);
      // Record the hash the edges were extracted from. A pre-existing summary
      // was computed from different content, so it must not survive the hash
      // update (same rule as the summary cache itself).
      store.setEntry(file, currentHash, null);
    }
  }

  if (fullRebuild) {
    store.setMeta(GRAPH_GENERATION_KEY, GRAPH_GENERATION);
  }

  return graph;
}
