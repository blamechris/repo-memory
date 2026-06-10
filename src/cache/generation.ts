/**
 * Summarizer generation bookkeeping, shared by the cache store and the
 * indexer. This lives below both layers so `CacheStore` can enforce the
 * generation rules on summary writes without importing the indexer (which
 * itself imports the store).
 *
 * The generation tag stored in the meta table has the form `<mode>:<N>`
 * (e.g. `ast:3`). Two rules govern it:
 *
 * - **Numeric monotonicity.** The numeric generation `N` may only increase.
 *   A process running an older package version than the one that last tagged
 *   the database must never clear summaries, never write summaries, and never
 *   regress the tag. Real workflows hit this: a long-running MCP server and an
 *   `npx` post-merge hook can share one cache at different package versions.
 * - **Mode is last-writer-wins.** A mode difference (regex vs ast) at the same
 *   `N` means per-process configuration disagrees, which is a user
 *   misconfiguration; flipping the mode legitimately clears and re-tags, so
 *   the monotonicity rule applies to the numeric generation only.
 */

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
export const SUMMARIZER_GENERATION = 3;

/** Meta table key holding the generation tag (`<mode>:<N>`). */
export const GENERATION_META_KEY = 'summarizer_generation';

let generationOverride: number | null = null;

/** Test hook: pretend this process runs a different package generation. */
export function setSummarizerGenerationForTests(generation: number | null): void {
  generationOverride = generation;
}

/** The summarizer generation this process writes. */
export function currentSummarizerGeneration(): number {
  return generationOverride ?? SUMMARIZER_GENERATION;
}

/** Parse a stored `<mode>:<N>` tag. Returns null for missing or unparseable tags. */
export function parseGenerationTag(
  tag: string | null,
): { mode: string; generation: number } | null {
  if (tag === null) return null;
  const match = /^([a-z]+):(\d+)$/.exec(tag);
  if (!match) return null;
  return { mode: match[1], generation: Number(match[2]) };
}

/**
 * True when the stored tag was written by a strictly newer generation than
 * this process — in which case this process must not persist summaries or
 * touch the tag (see module doc).
 */
export function isStoredGenerationNewer(storedTag: string | null): boolean {
  const parsed = parseGenerationTag(storedTag);
  return parsed !== null && parsed.generation > currentSummarizerGeneration();
}
