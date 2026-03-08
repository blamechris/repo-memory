import { CacheStore } from '../cache/store.js';
import { TelemetryTracker } from '../telemetry/tracker.js';

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
}

export function searchByPurpose(
  projectRoot: string,
  query: string,
  limit?: number,
): SearchByPurposeResult {
  const store = new CacheStore(projectRoot);
  const allEntries = store.getAllEntries();
  const effectiveLimit = limit ?? 20;

  const queryTerms = query.toLowerCase().split(/\s+/).filter(Boolean);
  const results: Array<SearchResult & { score: number }> = [];

  for (const entry of allEntries) {
    if (!entry.summary) continue;

    const matchedOn: string[] = [];
    let score = 0;

    const purpose = entry.summary.purpose.toLowerCase();
    const purposeMatches = queryTerms.filter(term => purpose.includes(term));
    if (purposeMatches.length > 0) {
      matchedOn.push('purpose');
      score += purposeMatches.length * 3; // purpose matches weighted highest
    }

    const exportsLower = entry.summary.exports.map(e => e.toLowerCase());
    const exportMatches = queryTerms.filter(term =>
      exportsLower.some(exp => exp.includes(term))
    );
    if (exportMatches.length > 0) {
      matchedOn.push('exports');
      score += exportMatches.length * 2;
    }

    const declsLower = entry.summary.topLevelDeclarations.map(d => d.toLowerCase());
    const declMatches = queryTerms.filter(term =>
      declsLower.some(decl => decl.includes(term))
    );
    if (declMatches.length > 0) {
      matchedOn.push('declarations');
      score += declMatches.length;
    }

    if (matchedOn.length > 0) {
      results.push({
        path: entry.path,
        purpose: entry.summary.purpose,
        matchedOn,
        exports: entry.summary.exports,
        confidence: entry.summary.confidence,
        score,
      });
    }
  }

  // Sort by score descending
  results.sort((a, b) => b.score - a.score);

  const matched = results.slice(0, effectiveLimit);

  // Track each matched file as a summary_served event.
  // Token estimate: approximate raw file tokens from lineCount (avg ~40 chars/line).
  const tracker = new TelemetryTracker(projectRoot);
  for (const result of matched) {
    const entry = allEntries.find(e => e.path === result.path);
    // Approximate raw file tokens from lineCount (avg ~40 chars/line, ~4 chars/token)
    const estimatedRawTokens = entry?.summary ? entry.summary.lineCount * 10 : 0;
    tracker.trackEvent('summary_served', result.path, estimatedRawTokens);
  }

  return {
    query,
    results: matched.map(({ score: _score, ...rest }) => rest),
    totalCached: allEntries.filter(e => e.summary).length,
  };
}
