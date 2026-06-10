# Master Assessment: Agent-Facing Search & Retrieval Efficiency

**Target:** "How agents search via repo-memory" — efficiency/quality gains available on the retrieval path (`search_by_purpose`, `get_related_files`, `get_dependency_graph`, `get_project_map`, ranking), evaluated against six candidate ideas from the wild: FTS5/BM25, embeddings, persisted dependency graph, symbol index, query-result caching, token-budget shaping.
**Panel:** 6 agents (core 4 + Protocol + Historian)
**Date:** 2026-06-09
**Aggregate Rating: 2.6 / 5** (weighted: core ×1.0, extended ×0.8)

---

## a. Auditor Panel

| Agent | Lens | Rating | Key contribution |
|---|---|---|---|
| Skeptic | Claims vs reality | 2.0 | Measured everything: 1–3ms search at max scale; ranking emits a constant (all results tie at 0.325); phantom `.js` paths; FTS/embeddings solve a non-problem |
| Builder | Implementability | 4.0 | FTS5 verified present in shipped better-sqlite3; effort estimates per candidate; the two hidden work items (import-target resolution, identifier tokenization); sequencing plan |
| Guardian | Safety / staleness | 2.0 | **Critical bug: `get_changed_files` poisons the cache** (new hash + old summary → permanent confident stale hits); generation split-brain; migration race; 10 testable invariants for any new index |
| Minimalist | YAGNI | 2.0 | The fix is net-negative LOC: wire `load()`, delete the rebuild loops; 5 things not to build; "this is a cache for your cache" |
| Protocol | MCP token economics | 3.0 | Measured response sizes: no-path dep graph = 5.3k tokens, map = 3.6k; exploration sequence can drop 3×; tool descriptions lose the selection contest vs grep |
| Historian | Prior art | 3.0 | repo-memory = "Aider's repo-map as an MCP server" (proven lineage); embeddings = Cody's documented retreat; nobody in 30 years rebuilds an index per query |

## b. Consensus Findings (4+ agents agree)

**C1 — The persisted dependency graph exists, is never used, and the rebuild corrupts the DB it ignores.** (6/6 agents — the unanimous headline.) `DependencyGraph.load()` has zero production callers; both graph tools re-read every project file per call and rewrite the entire `imports` table as a side effect of a read (4.1MB WAL observed after 3 read-only calls; DELETE outside the insert transaction → torn states). The `imports` table held 0 rows in this repo's own cache until an auditor's benchmark populated it. **Action: make `load()` the read path; populate edges from the summary write path (get_file_summary/prewarm); refresh only hash-changed files; transactional edge replacement. Net LOC negative.**

**C2 — Import-target resolution is the prerequisite for everything graph-shaped.** (5/6) Stored edge targets keep specifier extensions (`./store.js` → phantom `src/cache/store.js`) and bare module names; consequences measured: `get_related_files` returns paths that don't exist on disk (agents' follow-up reads ENOENT), `getDependents` on real keys returns `[]`, transitive traversal dead-ends at one hop, `mostConnected` lists `vitest`/`fs`/phantom paths. **Action: resolve targets to real file paths at write time; tag externals; delete the `getPathVariants` hack.**

**C3 — Skip embeddings and query-result caching.** (6/6) Embeddings: the industry's documented dead end for this use case (Cody's 2023–24 retreat; Claude Code's grep-first stance), disproportionate infra for a single-user offline tool over one-line template purposes, and an inherent staleness window. Query caching: protects a measured 1ms computation while creating exactly the invalidation surface the project's first invariant forbids. **Action: record as explicit non-goals.**

**C4 — The real scarce resource is tokens, not milliseconds — and the navigation tier is bleeding them.** (5/6) Measured: search 1–3ms even at 2,000 files (latency is a non-problem), but no-path `get_dependency_graph` = ~5,328 tokens with every path serialized three times; no-depth `get_project_map` = ~3,622; per-result `hash`/`reason`/`matchedOn` debug fields agents can't act on. A standard exploration sequence: ~5,160 → ~1,640 tokens (3×) with field deletions, two defaults, and optional params — zero new tools. **Action: response-shaping pass + description rewrites so tools win the selection contest vs grep.**

**C5 — Extension-list drift: the two graph tools disagree about which languages exist.** (6/6) `.kt/.kts/.java` in `get_related_files` but not `get_dependency_graph` — Kotlin/Java repos silently get empty graphs from one tool. **Action: one shared extension constant (falls out of C1's single graph builder).**

**C6 — The 5-signal ranking doesn't rank.** (4/6) In the only production path: `cacheStore` never passed (recency = constant), `changeFrequency` = hardcoded placeholder, no `taskId` in the common case (proximity = 0, task relevance = floor). Score collapses to file-type buckets; all top results tie. **Action: pass `cacheStore`, delete dead signals, use the already-computed relationship type as a signal; degree centrality as a cheap importance prior (Aider's PageRank direction).**

## c. Contested Points

**FTS5/BM25** — the only genuine split. *For:* Builder (5/5 implementable, 6–10h, verified FTS5 ships in better-sqlite3; quality not speed) and Historian (the lexical-survivor lineage; hand-rolled scorer is a weaker BM25). *Against:* Skeptic and Minimalist (replaces a measured 1ms scan; BM25 normalization is meaningless over one-line near-uniform documents; adds triggers, escaping bugs, migration). Protocol is lukewarm (3/5 — bounded headroom on sparse text). **Assessment: the antis win the timing argument, the pros win the eventual one. Don't build it in the first milestone; first ship the 5-line relevance fixes (word-boundary bonus, drop short-token noise matches). Revisit FTS5 only with telemetry evidence of bad-ranking queries.**

**Symbol index** — *For a shallow version:* Builder, Protocol, Historian (exports/declarations already stored; `symbol` param already exists; just make it fast and complete — no new tool). *Against any version:* Minimalist, Skeptic (grep/LSP own definition lookup; third copy of data). **Assessment: no new tool and no new table; fold a normalized `import_specifiers` lookup into the C1 graph work to fix `getEdgesBySymbol`'s full-scan + stale reads, and stop there.**

## d. Factual Corrections

| Claim in circulation | Reality | Found by |
|---|---|---|
| "Search will get slow as repos grow" | 1.08ms at 164 files; 3.17ms at 2,000 (measured) — latency is a non-problem at stated scale | Skeptic, Minimalist |
| "We persist the dependency graph" (implied by architecture doc) | Persisted write-only; `load()` has zero production callers; table held 0 rows | All |
| "5-signal relevance ranking" | One live signal in the default path; all top results tie at 0.325 | Skeptic, Minimalist |
| "Hash comparison guarantees freshness" | `get_changed_files` writes new hash + old summary, defeating the hash check from inside | Guardian |
| "Telemetry measures real savings" | `summary_served` books `lineCount × 10` tokens per search hit — phantom savings corrupting the ROI metric | Skeptic, Protocol |

## e. Risk Heatmap

```
              IMPACT →
  LIKELIHOOD  low            medium            high
  ↓
  high        matchedOn      map/graph         get_changed_files
              token waste    token dumps       CACHE POISONING (fix now)
  medium      param-name     phantom .js       multi-version generation
              drift          paths to agents   split-brain / clear-storm
  low         telemetry      migration race    torn imports table
              SQLITE_BUSY    on fresh clone    (symbol queries)
```

## f. Recommended Action Plan (priority order)

| # | Item | Why | Effort |
|---|---|---|---|
| 1 | **Fix `get_changed_files` cache poisoning** (write `null` summary on hash change) + regression test | Critical correctness bug, violates core invariant, one-line fix | XS |
| 2 | **Resolve import targets to real file paths at write time** | Prerequisite for all graph work (C2) | S–M |
| 3 | **Wire the persisted graph**: `load()` as read path, populate from summary/prewarm writes, hash-gated refresh, transactional edges, shared extension constant, indexed `import_specifiers` | The unanimous fix (C1, C5, symbol staleness); net-negative LOC | M |
| 4 | **Hash-validate search results + `ensureSummaryGeneration` on the search path**; drop deleted files | Never-stale invariant on the discovery path (Guardian I5) | S |
| 5 | **Token-shaping pass**: graph adjacency shape, map depth default, drop `hash`/`reason`/`matchedOn`/`query` echo, exports cap, description rewrites | 3× cheaper exploration sequence (C4); zero new tools | S–M |
| 6 | **Fix telemetry inflation** (once-per-query realistic estimate; best-effort writes on read paths) | The ROI metric gates future features — it must not lie | XS–S |
| 7 | **Concurrency hardening**: generation monotonic + per-write recheck, atomic clear+tag, `BEGIN IMMEDIATE` migrations, explicit busy_timeout | Real workflows (server + hooks, mixed versions) hit these | M |
| 8 | **Ranking cleanup**: pass `cacheStore`, delete dead signals, relationship-as-signal, centrality prior | Make the ranking rank (C6) | S |

**Explicit non-goals:** embeddings/semantic search; query-result caching; new search MCP tools; deep per-symbol index; FTS5 (deferred pending telemetry evidence).

## g. Final Verdict

**2.6 / 5 — the feature set is the right shape; the plumbing between its own pieces was never connected, and one bug actively poisons the cache.** The investigation that prompted this audit asked "what should we add?"; the panel's answer is overwhelmingly "connect what exists, then shrink what it says." The trendy candidates (embeddings, FTS5, caching) target a millisecond-scale non-problem, while the measured problems are: a critical staleness bug in `get_changed_files`, a dependency graph that ignores its own persistence and corrupts it as a side effect of reads, a ranking that outputs constants, and orientation tools that cost 3–5k tokens a call. Items 1–6 of the action plan are roughly a week of work, mostly deletions and wiring, and would leave the project a faithful instance of the one retrieval pattern the industry has actually kept (Aider-style summaries + persisted graph + token budgets). Ready for implementation — as targeted fixes, not as a feature program.

## h. Appendix: Individual Reports

| Report | Agent | Rating |
|---|---|---|
| [01-skeptic.md](01-skeptic.md) | Skeptic | 2.0/5 |
| [02-builder.md](02-builder.md) | Builder | 4.0/5 |
| [03-guardian.md](03-guardian.md) | Guardian | 2.0/5 |
| [04-minimalist.md](04-minimalist.md) | Minimalist | 2.0/5 |
| [05-protocol.md](05-protocol.md) | Protocol | 3.0/5 |
| [06-historian.md](06-historian.md) | Historian | 3.0/5 |
