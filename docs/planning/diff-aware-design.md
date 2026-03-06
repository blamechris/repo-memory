# Diff-Aware Summary Update Strategy

**Issue:** #20
**Status:** Design spike
**Date:** 2026-03-06

## Problem

Currently, any file change triggers a full re-summarization via `src/indexer/summarizer.ts`. The summarizer uses regex-based extraction of exports, imports, top-level declarations, and purpose classification. While this is fast for small files (<1ms), it becomes wasteful at scale when most edits are body-only changes (implementation tweaks, comment edits, formatting) that don't affect the structural summary.

## Recommendation: Hybrid Approach with Smart Fallback

Use `git diff` to classify changes as structural vs non-structural, and only re-summarize when the file's public surface area has changed.

### Change Classification

**Structural changes** (trigger full re-summarize):
- Added or removed `export` statements
- Added or removed `import` statements
- New, renamed, or deleted top-level declarations (`function`, `class`, `interface`, `type`, `enum`, `const`, `let`, `var`)
- File rename or move (affects purpose classification)

**Non-structural changes** (skip re-summarize):
- Function/method body edits
- Comment additions or edits
- String literal changes
- Formatting / whitespace changes
- Changes inside class method bodies

### Detection Mechanism

Parse `git diff` hunks and scan added/removed lines (those prefixed with `+`/`-`) for structural keywords. If no structural patterns appear in the diff, the existing summary remains valid — only update `lineCount` and the content hash.

## Implementation Plan

### New module: `src/indexer/diff-analyzer.ts`

```typescript
interface DiffAnalysis {
  structural: boolean;
  affectedExports: string[];
  affectedImports: string[];
}

function analyzeDiff(
  filePath: string,
  oldSummary: FileSummary,
  projectRoot: string,
): DiffAnalysis;
```

**Steps:**

1. Run `git diff HEAD -- <file>` to get unified diff output.
2. Extract added/removed lines from hunks (lines starting with `+`/`-`, excluding `+++`/`---` headers).
3. Test each line against structural patterns:
   - `export` keyword at line start
   - `import` keyword at line start
   - Top-level declaration keywords: `function`, `class`, `interface`, `type`, `enum`, `const`, `let`, `var`, `abstract`
4. If any structural pattern matches, return `{ structural: true, ... }` with affected symbols.
5. If no structural patterns found, return `{ structural: false, affectedExports: [], affectedImports: [] }`.

### Integration with cache invalidation

```
file changed
  -> compute new hash
  -> if hash unchanged: skip (already handled)
  -> if hash changed:
      -> analyzeDiff(file, oldSummary, root)
      -> if structural: full re-summarize
      -> if non-structural: keep existing summary, update lineCount + hash
      -> if diff parse fails: full re-summarize (fallback)
```

### Confidence Tracking

Tag cache entries with a `summarySource` field:

```typescript
type SummarySource = 'full' | 'diff-partial';
```

This allows monitoring how often diff-skipping occurs and correlating with any summary staleness issues.

## Tradeoffs

| | Pro | Con |
|---|---|---|
| **Performance** | Saves re-parse time for body-only edits (the most common edit type) | For current file sizes (<500 lines), regex summarization is already fast (<1ms) |
| **Correctness** | Fallback to full re-summarize on any ambiguity keeps summaries accurate | Regex heuristics on diff hunks can miss edge cases (e.g., computed export names, re-exports via barrel files) |
| **Complexity** | Clear separation of concerns — diff analysis is a standalone module | Adds git as a runtime dependency for this path; need graceful degradation if not in a git repo |
| **Scale** | Main value emerges with large files (500+ lines) or large repos (1000+ files) where skipping unnecessary work compounds | Marginal benefit for small repos |

### Mitigations

- **Always fall back to full re-summarize** if diff parsing fails, returns ambiguous results, or if the file is not tracked by git.
- **Confidence tracking** via `summarySource` makes it easy to audit and roll back the optimization if issues arise.
- **Unit-testable**: `analyzeDiff` can be tested with synthetic diff output without needing a real git repo.

## Decision

Proceed with implementation when scaling warrants it. The design is ready; the current summarizer performance (~sub-millisecond per file) means this is not yet a bottleneck. Recommended trigger: when repo-memory is used on repos with 1000+ files or individual files exceeding 500 lines regularly.
