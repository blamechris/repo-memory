import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { hashContents } from '../cache/hash.js';
import { CacheStore } from '../cache/store.js';
import { ensureSummaryGeneration, summarizeForProject } from '../indexer/summarize.js';
import { TelemetryTracker } from '../telemetry/tracker.js';
import type { CacheEntry, FileSummary } from '../types.js';
import { toPosix } from '../utils/posix-path.js';

export interface SearchResult {
  path: string;
  purpose: string;
  matchedOn: string[]; // which fields matched: "purpose", "exports", "declarations"
  exports: string[];
  confidence: string;
}

export interface SearchByPurposeResult {
  query: string;
  results: SearchResult[];
  totalCached: number;
  scope?: string; // present when results were restricted to a pathPrefix
}

interface Match {
  matchedOn: string[];
  score: number;
}

/** Score a summary against the query terms; null when nothing matched. */
function scoreSummary(summary: FileSummary, queryTerms: string[]): Match | null {
  const matchedOn: string[] = [];
  let score = 0;

  const purpose = summary.purpose.toLowerCase();
  const purposeMatches = queryTerms.filter((term) => purpose.includes(term));
  if (purposeMatches.length > 0) {
    matchedOn.push('purpose');
    score += purposeMatches.length * 3; // purpose matches weighted highest
  }

  const exportsLower = summary.exports.map((e) => e.toLowerCase());
  const exportMatches = queryTerms.filter((term) =>
    exportsLower.some((exp) => exp.includes(term)),
  );
  if (exportMatches.length > 0) {
    matchedOn.push('exports');
    score += exportMatches.length * 2;
  }

  const declsLower = summary.topLevelDeclarations.map((d) => d.toLowerCase());
  const declMatches = queryTerms.filter((term) => declsLower.some((decl) => decl.includes(term)));
  if (declMatches.length > 0) {
    matchedOn.push('declarations');
    score += declMatches.length;
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
  const match = scoreSummary(summary, queryTerms);
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
    const match = scoreSummary(entry.summary, queryTerms);
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
    query,
    results: served.map((c) => ({
      path: c.entry.path,
      purpose: c.summary.purpose,
      matchedOn: c.matchedOn,
      exports: c.summary.exports,
      confidence: c.summary.confidence,
    })),
    totalCached: entries.filter((e) => e.summary).length,
    ...(normalizedPrefix ? { scope: normalizedPrefix } : {}),
  };
}
