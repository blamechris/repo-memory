import { loadConfig } from '../config.js';
import { CacheStore } from '../cache/store.js';
import {
  GENERATION_META_KEY,
  currentSummarizerGeneration,
  isStoredGenerationNewer,
} from '../cache/generation.js';
import { summarizeFile } from './summarizer.js';
import { summarizeFileAst } from './ast-summarizer.js';
import type { FileSummary } from '../types.js';

/**
 * Config-aware summarizer dispatch. Call sites that generate summaries go
 * through here so the `summarizer` setting in .repo-memory.json takes effect.
 *
 * The generation constant and tag rules live in src/cache/generation.ts so
 * the cache store can enforce them on every summary write.
 */

export type SummarizerMode = 'regex' | 'ast';

const generationChecked = new Map<string, string>();

export function getSummarizerMode(projectRoot: string): SummarizerMode {
  return loadConfig(projectRoot).summarizer ?? 'ast';
}

/** Generate a summary using the summarizer configured for this project. */
export async function summarizeForProject(
  projectRoot: string,
  filePath: string,
  contents: string,
): Promise<FileSummary> {
  if (getSummarizerMode(projectRoot) === 'ast') {
    return summarizeFileAst(filePath, contents);
  }
  return summarizeFile(filePath, contents);
}

/**
 * Ensure cached summaries were produced by the currently configured
 * summarizer. When the mode (or generation) changes, all stored summaries are
 * dropped — hashes stay, so change detection is unaffected and summaries
 * regenerate lazily — and the new generation tag is recorded, atomically with
 * the clear.
 *
 * Generations are monotonic: when the stored tag belongs to a *newer*
 * generation than this process (e.g. an npx post-merge hook at a newer
 * package version retagged the cache while this long-running server kept an
 * older build in memory), this process must not clear, must not regress the
 * tag, and must not persist its own summaries. It keeps working read-through:
 * summaries it computes are served from memory, and CacheStore strips them on
 * write (see setEntry/setEntries), so the cache never mixes generations and
 * old/new version alternation cannot cause clear-storms. Mode flips (regex vs
 * ast) at the same numeric generation are last-writer-wins by design — see
 * src/cache/generation.ts.
 *
 * Must run before any cache lookup that can return a stored summary.
 */
export function ensureSummaryGeneration(projectRoot: string): void {
  const tag = `${getSummarizerMode(projectRoot)}:${currentSummarizerGeneration()}`;
  if (generationChecked.get(projectRoot) === tag) return;

  const store = new CacheStore(projectRoot);
  // Read-decide-write under the write lock, so another process cannot bump
  // the generation between our read of the tag and our clear (Guardian I3).
  const reconciled = store.withWriteLock(() => {
    const stored = store.getMeta(GENERATION_META_KEY);
    if (stored === tag) return true;
    if (isStoredGenerationNewer(stored)) {
      // Never downgrade — a newer package version owns this cache.
      return false;
    }
    // Regex output is unchanged since generation 1, so summaries produced by
    // any earlier regex generation — including pre-marker databases, which
    // carried no tag — are still valid under regex generation 3 and only need
    // re-tagging.
    const stillValid = tag === 'regex:3' && (stored === null || /^regex:[12]$/.test(stored));
    if (stillValid) {
      store.setMeta(GENERATION_META_KEY, tag);
    } else {
      store.clearAllSummariesAndSetMeta(GENERATION_META_KEY, tag);
    }
    return true;
  });

  // Memoize the happy path only. A process running behind the stored
  // generation re-checks on every call (one cheap row read) so it recovers
  // immediately if it is ever upgraded in place; its summary writes are
  // independently guarded inside CacheStore either way.
  if (reconciled) generationChecked.set(projectRoot, tag);
}

/** Test hook: forget which projects already had their generation verified. */
export function clearSummaryGenerationCache(): void {
  generationChecked.clear();
}
