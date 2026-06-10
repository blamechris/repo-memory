import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { hashContents } from '../cache/hash.js';
import { CacheStore } from '../cache/store.js';
import { ensureSummaryGeneration, summarizeForProject } from '../indexer/summarize.js';
import { TelemetryTracker } from '../telemetry/tracker.js';
import type { CacheEntry, FileSummary } from '../types.js';
import { toPosix } from '../utils/posix-path.js';

/** Max exports listed per result; the rest collapse into `exportsTruncated`. */
const MAX_EXPORTS_PER_RESULT = 5;

export interface SearchResult {
  path: string;
  purpose: string;
  exports: string[]; // capped at MAX_EXPORTS_PER_RESULT
  exportsTruncated?: number; // total export count, present only when `exports` was capped
  confidence: string;
}

export interface SearchByPurposeResult {
  results: SearchResult[];
  totalCached: number;
  scope?: string; // present when results were restricted to a pathPrefix
}

interface Match {
  matchedOn: string[];
  score: number;
}

/**
 * Lowercase word tokens of an identifier or free-text field: splits camelCase
 * and PascalCase boundaries, snake_case, kebab-case, dots, and path
 * separators. "CacheStore" -> ["cache","store"]; "get_file_summary" ->
 * ["get","file","summary"].
 */
function tokenize(text: string): string[] {
  return text
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/** Terms shorter than this only count on a whole-token match. */
const MIN_SUBSTRING_TERM = 3;

/**
 * Match quality of one query term against one field, tiered by specificity:
 * whole token (1.0) > token prefix (0.75) > bare substring (0.5). Short terms
 * must match a whole token — "id" landing inside "validation" is noise, but
 * "id" as an identifier word (findUserById) is a real hit.
 */
function termQuality(term: string, tokens: string[], raw: string): number {
  if (tokens.includes(term)) return 1;
  if (term.length < MIN_SUBSTRING_TERM) return 0;
  if (tokens.some((t) => t.startsWith(term))) return 0.75;
  if (raw.includes(term)) return 0.5;
  return 0;
}

/**
 * Score a cached entry against the query terms; null when nothing matched.
 * Field weights: purpose 3 > exports 2 > declarations 1 = path 1. Each term
 * contributes its match quality x the field weight, so a whole-word purpose
 * hit outranks any pile of incidental substrings. Path segments count as a
 * field of their own (sans extension) so directory and file names carry the
 * concept signal they naturally encode — src/telemetry/tracker.ts should
 * match "telemetry" even when its summary text doesn't say the word.
 */
function scoreEntry(path: string, summary: FileSummary, queryTerms: string[]): Match | null {
  const fields = [
    {
      name: 'purpose',
      weight: 3,
      tokens: tokenize(summary.purpose),
      raw: summary.purpose.toLowerCase(),
    },
    {
      name: 'exports',
      weight: 2,
      tokens: summary.exports.flatMap(tokenize),
      raw: summary.exports.join(' ').toLowerCase(),
    },
    {
      name: 'declarations',
      weight: 1,
      tokens: summary.topLevelDeclarations.flatMap(tokenize),
      raw: summary.topLevelDeclarations.join(' ').toLowerCase(),
    },
    {
      name: 'path',
      weight: 1,
      tokens: tokenize(path.replace(/\.[a-z0-9]+$/i, '')),
      raw: path.toLowerCase(),
    },
  ];

  const matchedOn: string[] = [];
  let score = 0;
  for (const field of fields) {
    let fieldScore = 0;
    for (const term of queryTerms) {
      fieldScore += termQuality(term, field.tokens, field.raw) * field.weight;
    }
    if (fieldScore > 0) {
      matchedOn.push(field.name);
      score += fieldScore;
    }
  }
  return matchedOn.length > 0 ? { matchedOn, score } : null;
}

interface Candidate {
  entry: CacheEntry;
  summary: FileSummary; // the summary actually served (fresh after validation)
  matchedOn: string[];
  score: number;
}

/**
 * Re-hash a matched candidate before serving it (never return stale data).
 * - Missing/unreadable file: evict the dead cache entry and drop the result.
 * - Hash mismatch: regenerate the summary through the standard path (same
 *   semantics as get_file_summary's cache-miss branch), re-score it against
 *   the query, and keep it only if it still matches.
 */
async function validateCandidate(
  projectRoot: string,
  store: CacheStore,
  candidate: Candidate,
  queryTerms: string[],
): Promise<Candidate | null> {
  let contents: string;
  try {
    contents = await readFile(join(projectRoot, candidate.entry.path), 'utf-8');
  } catch {
    store.deleteEntry(candidate.entry.path);
    return null;
  }

  const currentHash = hashContents(contents);
  if (currentHash === candidate.entry.hash) return candidate;

  const summary = await summarizeForProject(projectRoot, candidate.entry.path, contents);
  store.setEntry(candidate.entry.path, currentHash, summary);
  const match = scoreEntry(candidate.entry.path, summary, queryTerms);
  if (!match) return null;
  return { entry: candidate.entry, summary, matchedOn: match.matchedOn, score: match.score };
}

export async function searchByPurpose(
  projectRoot: string,
  query: string,
  limit?: number,
  pathPrefix?: string,
): Promise<SearchByPurposeResult> {
  // Never serve summaries from an invalidated generation (audit invariant I5).
  ensureSummaryGeneration(projectRoot);

  const store = new CacheStore(projectRoot);
  const effectiveLimit = limit ?? 20;

  // Optional scope: restrict the search to files at or under a directory/prefix.
  // Normalized so "src/cache", "src/cache/", "./src/cache", "/src/cache", and the
  // Windows form "src\cache" behave the same, and matched on a path boundary so
  // "src/cache" excludes "src/cache-utils.ts". (Stored paths are POSIX-style and
  // relative to root.)
  const normalizedPrefix = pathPrefix
    ? toPosix(pathPrefix.trim()).replace(/^(?:\.?\/)+/, '').replace(/\/+$/, '')
    : undefined;
  const allEntries = store.getAllEntries();
  // Normalize the stored side too, so a forward-slash prefix still scopes paths
  // that were cached on Windows (backslash separators) before posix-normalization
  // at the indexing boundary existed.
  const entries = normalizedPrefix
    ? allEntries.filter((e) => {
        const p = toPosix(e.path);
        return p === normalizedPrefix || p.startsWith(`${normalizedPrefix}/`);
      })
    : allEntries;

  const queryTerms = query.toLowerCase().split(/\s+/).filter(Boolean);
  const candidates: Candidate[] = [];

  for (const entry of entries) {
    if (!entry.summary) continue;
    const match = scoreEntry(entry.path, entry.summary, queryTerms);
    if (match) {
      candidates.push({ entry, summary: entry.summary, ...match });
    }
  }

  // Sort by score descending
  candidates.sort((a, b) => b.score - a.score);

  // Validate before serving: walk the sorted candidates in score order until
  // `limit` survive, so slots freed by dropped (deleted or no-longer-matching)
  // files are backfilled from the remaining candidates in one pass.
  const served: Candidate[] = [];
  for (const candidate of candidates) {
    if (served.length >= effectiveLimit) break;
    const validated = await validateCandidate(projectRoot, store, candidate, queryTerms);
    if (validated) served.push(validated);
  }

  // Telemetry: ONE summary_served event per query, not per hit. Per-hit
  // tracking booked every matched file as a full read avoided, inflating
  // "tokens saved" by up to `limit`x. The realistic counterfactual for one
  // search is the agent grepping and then reading roughly ONE candidate file
  // in full, so we book the estimated raw-content tokens of one average
  // served file (lineCount x ~40 chars/line / ~4 chars/token = lineCount x 10).
  // Best-effort: a telemetry write failure (e.g. locked DB) must never fail
  // the read path.
  if (served.length > 0) {
    try {
      const avgLineCount =
        served.reduce((sum, c) => sum + c.summary.lineCount, 0) / served.length;
      new TelemetryTracker(projectRoot).trackEvent(
        'summary_served',
        served[0].entry.path,
        Math.round(avgLineCount * 10),
        { query, resultCount: served.length },
      );
    } catch {
      // Telemetry is best-effort on read paths (audit invariant I8).
    }
  }

  return {
    results: served.map((c) => {
      const exports = c.summary.exports;
      const capped = exports.length > MAX_EXPORTS_PER_RESULT;
      return {
        path: c.entry.path,
        purpose: c.summary.purpose,
        exports: capped ? exports.slice(0, MAX_EXPORTS_PER_RESULT) : exports,
        ...(capped ? { exportsTruncated: exports.length } : {}),
        confidence: c.summary.confidence,
      };
    }),
    totalCached: entries.filter((e) => e.summary).length,
    ...(normalizedPrefix ? { scope: normalizedPrefix } : {}),
  };
}
