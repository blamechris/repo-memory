import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { hashContents } from '../cache/hash.js';
import { CacheStore } from '../cache/store.js';
import { isGraphIndexable } from '../indexer/source-extensions.js';
import { summarizeForProject, ensureSummaryGeneration } from '../indexer/summarize.js';
import { DependencyGraph } from '../graph/dependency-graph.js';
import { TelemetryTracker } from '../telemetry/tracker.js';
import { estimateTokensSaved } from '../telemetry/tokens.js';
import type { FileSummary } from '../types.js';
import { validatePath } from '../utils/validate-path.js';

export interface FileSummaryResult {
  path: string;
  summary: FileSummary;
  fromCache: boolean;
  /** Seconds since the cached entry was last validated; only present on cache hits. */
  cacheAge?: number;
  suggestFullRead: boolean;
}

export interface GetFileSummaryOptions {
  /**
   * Record cache_hit/cache_miss telemetry (default true). Bulk operations like
   * the `index` prewarm CLI disable this so they don't distort agent-traffic
   * hit-ratio stats.
   */
  trackTelemetry?: boolean;
}

export async function getFileSummary(
  projectRoot: string,
  relativePath: string,
  options: GetFileSummaryOptions = {},
): Promise<FileSummaryResult> {
  const trackTelemetry = options.trackTelemetry ?? true;
  relativePath = validatePath(projectRoot, relativePath);
  ensureSummaryGeneration(projectRoot);
  const store = new CacheStore(projectRoot);
  const absolutePath = join(projectRoot, relativePath);

  // Read and hash the file
  const contents = await readFile(absolutePath, 'utf-8');
  const currentHash = hashContents(contents);

  // Check cache
  const cached = store.getEntry(relativePath);

  const tracker = new TelemetryTracker(projectRoot);

  if (cached && cached.hash === currentHash && cached.summary) {
    if (trackTelemetry) {
      const tokensSaved = estimateTokensSaved(contents, cached.summary);
      tracker.trackEvent('cache_hit', relativePath, tokensSaved);
    }

    return {
      path: relativePath,
      summary: cached.summary,
      fromCache: true,
      cacheAge: Math.floor((Date.now() - cached.lastChecked) / 1000),
      suggestFullRead: cached.summary.confidence === 'low',
    };
  }

  // Generate fresh summary
  const summary = await summarizeForProject(projectRoot, relativePath, contents);

  // Persist this file's import edges alongside the summary (contents are
  // already in hand), so the dependency graph stays as fresh as the summary
  // cache. Edges go first: if the entry write never happens, a stale hash
  // simply re-triggers extraction — the reverse order could mark stale edges
  // as fresh.
  if (isGraphIndexable(relativePath)) {
    new DependencyGraph(projectRoot).updateFile(relativePath, contents);
  }
  store.setEntry(relativePath, currentHash, summary);

  if (trackTelemetry) {
    tracker.trackEvent('cache_miss', relativePath, 0);
  }

  return {
    path: relativePath,
    summary,
    fromCache: false,
    suggestFullRead: summary.confidence === 'low',
  };
}
