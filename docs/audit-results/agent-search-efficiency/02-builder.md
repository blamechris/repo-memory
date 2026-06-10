# Builder's Audit: Agent-Facing Search & Retrieval Efficiency

**Agent**: Builder -- pragmatic full-stack dev who will implement this; revises effort estimates, identifies file-by-file changes
**Overall Rating**: 4.0 / 5
**Date**: 2026-06-09

All claims verified against the working tree and the live `.repo-memory/cache.db` (164 file rows, schema v6).

## Ground truth established before scoping

- **FTS5 is available.** Verified at runtime against the installed `better-sqlite3@12.x`: bundled SQLite 3.53.1, compile options include `ENABLE_FTS5`. `CREATE VIRTUAL TABLE ... USING fts5(...)` succeeds. No new dependency needed.
- **The `imports` table is write-only dead weight.** Live DB: `files`=164 rows, `imports`=0 rows. `DependencyGraph.load()` (src/graph/dependency-graph.ts:16) is **never called anywhere** (grep confirms only the class itself references it). The table is populated solely as a side effect of `updateFile()` during the full rebuilds that `get_related_files` (src/tools/get-related-files.ts:27–53) and `get_dependency_graph` (src/tools/get-dependency-graph.ts:27–43) perform on every call. The prewarm CLI (src/cli/index-command.ts:54–70) writes summaries only — it never touches the graph.
- **Summary write path is centralized.** All summary writes flow through `CacheStore.setEntry/setEntries` (src/cache/store.ts:36, 65), called from get-file-summary.ts:72, force-reread.ts:23, get-changed-files.ts:46. Deletes: store.ts:60 (`deleteEntry`, used by invalidate.ts and gc.ts) and `clearAllSummaries` (store.ts:110, used by the generation-bump mechanism in src/indexer/summarize.ts:56–74). This is exactly the choke point an FTS index and a graph index both need — good news.
- **Migration system is trivially extensible.** Versioned, append-only, transactional (src/persistence/db.ts:109–138). Adding migration 7 is a 10-line change.
- **Summaries are small and flat.** `FileSummary` = `{purpose, exports, imports, lineCount, topLevelDeclarations, confidence}` (src/types.ts:8–15). `topLevelDeclarations` are display strings like `"interface GCOptions"` — no symbol kind/line structure. `imports` are raw specifiers (`"../persistence/db.js"`, `"node:crypto"`), not resolved file paths.

---

## 1. Candidate-by-candidate assessment

### A. SQLite FTS5 / BM25 ranking for `search_by_purpose`

**Implementability: 5/5** — FTS5 verified present; single choke point for index maintenance; migration system ready. **Effort: M, 6–10h** including tests.

Current state: search-by-purpose.ts:37 calls `store.getAllEntries()`, JSON-parses every summary, and substring-matches in JS with hand weights 3/2/1 (lines 57–80). At 164 files this is milliseconds; at 2,000 it's still tens of ms. **Be honest: FTS5 here is a ranking-quality win (BM25, multi-term coherence), not a latency win** at this repo scale.

File-by-file:
- `src/persistence/db.ts` — migration 7: `CREATE VIRTUAL TABLE files_fts USING fts5(path, purpose, exports, declarations, tokenize='porter unicode61')` (plain duplicate-content table is simplest and safest given summaries are tiny).
- `src/cache/store.ts` — sync FTS rows inside `setEntry`, `setEntries`, `deleteEntry`, `clearAllSummaries` (wrap in the existing transactions). Add `searchSummaries(query, limit, pathPrefix)` using `bm25(files_fts, w_path, w_purpose, w_exports, w_decls)` to reproduce the 3/2/1 weighting.
- New small helper — **identifier pre-tokenization**: split camelCase/snake_case (`getRelatedFiles` → `get related files`) when writing exports/declarations into the FTS columns, else recall craters vs. today's `includes()` matching. This is the hidden work item.
- `src/tools/search-by-purpose.ts` — query via FTS with `term*` prefix expansion; keep the current substring scan as fallback when FTS returns nothing (preserves today's infix-match contract).
- `src/indexer/summarize.ts` — no change needed; `clearAllSummaries` already runs on generation bump. Add a meta key (`fts_generation`) + one-time backfill from existing `files` rows.
- Tests: extend search-by-purpose, store, persistence (migration), one integration case.

Dependencies: **none new.** Risks: FTS query syntax injection (sanitize/quote user terms — FTS5 treats `-`, `"`, `NEAR` specially); behavior change from substring→token matching (mitigated by fallback); double-write consistency (mitigated by same-transaction writes — honors "cache correctness over performance").

### B. Persisted dependency graph reusing the `imports` table

**Implementability: 4/5** — 80% of the machinery exists and is unused; the missing 20% is real work (target normalization, freshness). **Effort: M, 8–14h** including tests.

Current cost: every `get_related_files` call re-runs `scanProject` + reads **every source file in the repo** + regex-extracts imports. For a 2,000-file repo that's 2,000 file reads + 565 lines of regex extractors per tool call. This is the single biggest latency/IO problem in the search path and the highest-ROI fix.

The blocker nobody mentioned: **stored edge targets don't match `files.path`.** `resolveTarget` (imports.ts:10–21) keeps the specifier's extension — `'./store.js'` → `src/cache/store.js` while the actual file is `src/cache/store.ts` — and bare specifiers (`zod`, `node:crypto`) are stored verbatim. The `getPathVariants` hack papers over this at query time. A persisted graph that other code trusts must resolve targets to **real file paths at write time** (probe the `files` table / disk for `.ts|.tsx|/index.ts` variants) and either drop or flag external/bare targets.

File-by-file:
- `src/indexer/imports.ts` — add a resolution step: map resolved relative targets to existing files (extension swap + index resolution), tag externals.
- `src/graph/dependency-graph.ts` — make `load()` the default read path; add a freshness check (per-source `hash` join against `files`, or a cheap `graph_generation` meta key).
- `src/tools/get-file-summary.ts` (~line 72) and `force-reread.ts` — after `setEntry`, also write import edges for that file (contents already in hand). This makes the prewarm CLI populate the graph for free since it routes through `getFileSummary`.
- `src/tools/get-related-files.ts` — replace the rebuild loop with `graph.load()` + staleness pass only over changed files.
- `src/tools/get-dependency-graph.ts` — same replacement; **also fixes the existing kt/kts/java extension-list drift** vs get-related-files.
- `src/cache/gc.ts` — already removes orphan imports, no change.
- Optional migration: clear legacy `imports` rows (old unresolved format).

Dependencies: none new. Risks: **correctness vs. the project invariant** — a persisted graph can be stale if files changed since last summarization. Recommend lazy per-neighborhood hash refresh (hash-check only the queried file's neighborhood, ~10 file reads instead of 2,000). WAL mode plus per-file transactional edge replacement keeps multi-process safe.

### C. Embeddings / semantic search

**Implementability: 2/5. Effort: L, 20–40h+ and ongoing weight. Recommendation: skip.**

The server is headless/offline/stdio. Local model via transformers.js (WASM) means a 30–90MB model download, slow CPU/WASM inference, embedding regeneration on every summary change, and a vector store (`sqlite-vec` is a native extension — violates the no-native-deps lean). API embeddings mean keys, cost, network in an offline tool. The kicker: at 100–2,000 files with one-line AST purposes, FTS5+BM25 with identifier tokenization covers the realistic query set. Embeddings buy recall on paraphrase queries — marginal for an agent that can issue 2–3 keyword variants for ~0 cost. Revisit only if FTS recall is demonstrably failing in telemetry.

### D. Symbol-level search index

**Implementability: 3/5. Shallow version S (2–3h folded into FTS); deep version M/L, 10–16h. Recommendation: shallow only, defer deep.**

Shallow: exports and `topLevelDeclarations` become FTS columns in candidate A — symbol queries work immediately with column weighting. Also, `getEdgesBySymbol` (dependency-graph.ts:83–105) currently does a **full-table scan + JSON.parse of `specifiers` per row** — a normalized `import_specifiers(source, target, specifier)` child table (written in the same `updateFile` transaction, queried by index) fixes that in ~2h as part of candidate B.

Deep (per-symbol rows with kind/line/signature): requires restructuring ast-summarizer.ts output (6 language suites), a new table + migration, a generation bump, and either a new tool (+~100 tokens/turn) or another param. ROI unproven where the agent has Grep. Defer.

### E. Query-result caching

**Implementability: 4/5. Effort: S, 2–4h. Recommendation: skip.**

Once A and B land, every query is an indexed SQLite read — nothing slow left to cache. Caching ranked results adds an invalidation surface that directly fights the never-stale invariant for near-zero benefit. Classic negative-ROI feature.

### F. Token-budget-aware response shaping

**Implementability: 5/5. Effort: S, 3–5h. Recommendation: do it, cheap win.**

Today `search_by_purpose` returns full `exports` arrays per hit and `get_dependency_graph`'s no-path mode returns full node+edge lists. Token estimation machinery already exists (`src/telemetry/tokens.ts`). Optional `max_tokens`/`compact` params on the search tools — optional params on existing tools, exactly per the CLAUDE.md guidance — zero new tool overhead. Risks: essentially none; purely additive.

---

## 2. Top 5 findings

1. **The persisted graph already exists and is 100% unused.** `imports` table: 0 rows in the live DB; `DependencyGraph.load()` has zero callers; both graph tools rebuild from a full repo read on every invocation. The project's biggest perf bug and its cheapest big win simultaneously.
2. **Hidden work: import-target normalization.** Stored targets carry `.js` specifier extensions and bare module names, so they don't join against `files.path`; `getPathVariants` is the smoking gun. Any plan that "just reuses the imports table" without a write-time resolution pass will ship a broken graph.
3. **Hidden work: graph population belongs in the summary write path.** The prewarm CLI and `get_file_summary` already read and hash contents; adding `extractImports` + edge writes there costs ~nothing and gives the graph the same freshness semantics as the summary cache.
4. **FTS5 is in the box, but tokenization is the real task.** Verified `ENABLE_FTS5` in shipped better-sqlite3. The engineering is preserving recall: identifier splitting at index time + prefix queries + substring fallback + FTS query sanitization. "Swap in MATCH" estimates will underdeliver.
5. **Sequencing: B's and A's write hooks land in the same files — batch them.** Both index types are maintained from the same CacheStore choke points and the `getFileSummary` write path; both want a migration + generation-keyed backfill. One milestone saves ~20% of combined effort. C blocks nothing (skip); D-shallow rides on A and B; F is independent and can ship first.

## 3. Recommendations

**Build, in order:**
1. **B — persisted dependency graph** (M, 8–14h): biggest latency/IO reduction; lazy per-neighborhood hash refresh honors the correctness invariant.
2. **A — FTS5/BM25** (M, 6–10h) with **D-shallow** folded in (symbol columns + `import_specifiers` table): same migration window as B.
3. **F — token-budget shaping** (S, 3–5h): can also go first as a quick win; zero coupling.

**Skip:** E (query caching) and C (embeddings); revisit C only with telemetry evidence of FTS recall failures.

Total recommended scope: roughly **20–30 hours** across two PR-sized milestones (B, then A+D-shallow+F).

## 4. Overall rating

**4/5 — strong candidate set, one trap, two skips.** The codebase is in unusually good shape for this work: a clean append-only migration system, a single choke point for cache writes, an FTS5-enabled SQLite already shipping, and a dependency-graph persistence layer that is fully built but never wired up — meaning the two highest-value improvements are mostly plumbing plus two genuinely hidden tasks (import-target resolution to real file paths, identifier-aware FTS tokenization) that this audit has now surfaced. The trap is overbuilding: embeddings and query-result caching both fail honest cost/benefit at 100–2,000 files, and a deep symbol index should wait for evidence that the shallow FTS-column version is insufficient.
