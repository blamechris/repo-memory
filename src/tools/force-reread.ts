import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { hashContents } from '../cache/hash.js';
import { CacheStore } from '../cache/store.js';
import { summarizeForProject, ensureSummaryGeneration } from '../indexer/summarize.js';
import { TelemetryTracker } from '../telemetry/tracker.js';
import { estimateTokens } from '../telemetry/tokens.js';
import type { FileSummary } from '../types.js';
import { validatePath } from '../utils/validate-path.js';

export async function forceReread(
  projectRoot: string,
  relativePath: string,
): Promise<{ path: string; hash: string; summary: FileSummary; reread: true; reason: string }> {
  relativePath = validatePath(projectRoot, relativePath);
  ensureSummaryGeneration(projectRoot);
  const absolutePath = join(projectRoot, relativePath);
  const contents = await readFile(absolutePath, 'utf-8');
  const hash = hashContents(contents);
  const summary = await summarizeForProject(projectRoot, relativePath, contents);

  const store = new CacheStore(projectRoot);
  store.setEntry(relativePath, hash, summary);

  const tracker = new TelemetryTracker(projectRoot);
  tracker.trackEvent('force_reread', relativePath, estimateTokens(contents));

  return { path: relativePath, hash, summary, reread: true, reason: 'force_reread: explicitly requested' };
}
