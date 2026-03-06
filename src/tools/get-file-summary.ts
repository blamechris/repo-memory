import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { hashContents } from '../cache/hash.js';
import { CacheStore } from '../cache/store.js';
import { summarizeFile } from '../indexer/summarizer.js';
import type { FileSummary } from '../types.js';
import { validatePath } from '../utils/validate-path.js';

export interface FileSummaryResult {
  path: string;
  hash: string;
  summary: FileSummary;
  fromCache: boolean;
  reason: string;
  cacheAge: number | null;
  suggestFullRead: boolean;
}

export async function getFileSummary(
  projectRoot: string,
  relativePath: string,
): Promise<FileSummaryResult> {
  relativePath = validatePath(projectRoot, relativePath);
  const store = new CacheStore(projectRoot);
  const absolutePath = join(projectRoot, relativePath);

  // Read and hash the file
  const contents = await readFile(absolutePath, 'utf-8');
  const currentHash = hashContents(contents);

  // Check cache
  const cached = store.getEntry(relativePath);
  const cacheAge = cached
    ? Math.floor((Date.now() - cached.lastChecked) / 1000)
    : null;

  if (cached && cached.hash === currentHash && cached.summary) {
    return {
      path: relativePath,
      hash: currentHash,
      summary: cached.summary,
      fromCache: true,
      reason: 'cache_hit: hash unchanged',
      cacheAge,
      suggestFullRead: cached.summary.confidence === 'low',
    };
  }

  // Generate fresh summary
  const summary = summarizeFile(relativePath, contents);
  store.setEntry(relativePath, currentHash, summary);

  let reason: string;
  if (!cached) {
    reason = 'cache_miss: no prior entry';
  } else if (cached.hash !== currentHash) {
    reason = 'cache_miss: hash changed';
  } else {
    reason = 'cache_miss: no summary in cache';
  }

  return {
    path: relativePath,
    hash: currentHash,
    summary,
    fromCache: false,
    reason,
    cacheAge,
    suggestFullRead: summary.confidence === 'low',
  };
}
