import { loadConfig } from '../config.js';
import { CacheStore } from '../cache/store.js';
import { summarizeFile } from './summarizer.js';
import { summarizeFileAst } from './ast-summarizer.js';
import type { FileSummary } from '../types.js';

/**
 * Config-aware summarizer dispatch. Call sites that generate summaries go
 * through here so the `summarizer` setting in .repo-memory.json takes effect.
 */

export type SummarizerMode = 'regex' | 'ast';

/**
 * Bump when summary output changes in a way that should invalidate previously
 * cached summaries (combined with the mode into the generation tag).
 *
 * Generation 2: the AST summarizer gained Python/Go/Rust support, so summaries
 * for those languages cached under ast mode (which were regex-produced
 * fallbacks at generation 1) must lazily regenerate.
 *
 * Generation 3: the AST summarizer gained Kotlin/Java support, so summaries
 * for those languages cached under ast mode (regex-produced generic
 * classifications at earlier generations) must lazily regenerate.
 */
const SUMMARIZER_GENERATION = 3;

const META_KEY = 'summarizer_generation';

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
 * regenerate lazily — and the new generation tag is recorded.
 *
 * Must run before any cache lookup that can return a stored summary.
 */
export function ensureSummaryGeneration(projectRoot: string): void {
  const tag = `${getSummarizerMode(projectRoot)}:${SUMMARIZER_GENERATION}`;
  if (generationChecked.get(projectRoot) === tag) return;

  const store = new CacheStore(projectRoot);
  const stored = store.getMeta(META_KEY);
  if (stored !== tag) {
    // Regex output is unchanged since generation 1, so summaries produced by
    // any earlier regex generation — including pre-marker databases, which
    // carried no tag — are still valid under regex generation 3 and only need
    // re-tagging.
    const stillValid = tag === 'regex:3' && (stored === null || /^regex:[12]$/.test(stored));
    if (!stillValid) {
      store.clearAllSummaries();
    }
    store.setMeta(META_KEY, tag);
  }
  generationChecked.set(projectRoot, tag);
}

/** Test hook: forget which projects already had their generation verified. */
export function clearSummaryGenerationCache(): void {
  generationChecked.clear();
}
