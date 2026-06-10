# Historian's Audit: Agent-Facing Search & Retrieval Efficiency

**Agent**: Historian -- evaluates ideas against what the industry actually built, kept, and abandoned
**Overall Rating**: 3.0 / 5
**Date**: 2026-06-09

Knowledge is offline; claims are dated where possible and flagged where uncertain.

---

## 1. Prior Art Survey

**ctags / universal-ctags (1992→) and LSP symbol indexes (2016→):** persisted, regenerable symbol-name → location indexes built by cheap parsers. Sourcegraph's LSIF (2019) and SCIP (2022) re-persisted this at cross-repo scale. Symbol-name lookup is the single most durable retrieval primitive in the field — 30+ years, never abandoned, only re-implemented. *Lesson: persist the index; rebuild incrementally. Nobody who survived rebuilds the index per query.*

**Zoekt / Sourcegraph (2016→) and GitHub "Blackbird" (GA 2023):** trigram and sparse-gram inverted indexes for exact/regex *lexical* search with ranking layered on top. Neither uses embeddings on the primary search path. GitHub rebuilt its code search from scratch in 2021–2023 and still chose ngram lexical retrieval. *Lesson: for code, literal/identifier matching with good ranking beats fuzzy semantics. Code is written in identifiers, not prose.*

**Sourcegraph Cody — the documented embeddings retreat (2023→early 2024):** shipped per-repo embeddings indexes for chat context (2023), then publicly deprecated them (announced ~Dec 2023, removed through 2024) in favor of keyword/Zoekt-based context fetching. Stated reasons: indexing cost, index staleness, operational burden — and *measured retrieval quality comparable to keyword search* for code Q&A. *The field's clearest natural experiment.*

**Cursor (2023→) — the counterexample:** chunk-level embeddings (server-side, Merkle-tree sync for incremental indexing). Works for them — with dedicated vector infra at millions-of-users scale, and their agent *also* leans heavily on lexical search and iterative reading. *Not a personal-tool pattern.*

**Aider repo-map (2023→) — the direct ancestor of this project:** tree-sitter extraction of definitions/references → graph linking files via shared identifiers → **personalized PageRank** weighted toward chat-mentioned files → top-ranked symbol signatures packed into a **hard token budget** (default ~1k tokens, binary-search packing), with tags cached in SQLite keyed on mtime. Replaced an earlier ctags-based map; stable since. Aider experimented with embeddings-style retrieval early and did not ship it as the main path. *Lesson: cached AST summaries + graph ranking + token budget is a proven, surviving pattern — exactly repo-memory's niche. The two ingredients Aider considers essential that repo-memory lacks: reference-based ranking and token-budget packing.*

**Claude Code (Anthropic, 2025) — grep-first agentic search:** no index at all; grep/glob/read iterated by the model. Anthropic engineers have described trying RAG/embeddings for code retrieval and abandoning it — *agentic iterative lexical search* produced better results because the model self-corrects across searches. *The bar any MCP search tool must clear: the agent already has grep. A retrieval tool earns its ~100-token/turn cost only if it beats iterative grep on (a) tokens per answer or (b) finding things grep can't name.*

**Copilot context building (2022→):** neighboring-tabs + Jaccard token-window similarity (documented 2023) — cheap lexical similarity, not embeddings, on the latency-critical path.

**tree-sitter outlines (Aider, Zed, Continue.dev, 2023→):** Continue.dev shipped local embeddings (LanceDB) *and* lexical; community experience mixed, many disable embeddings. Tree-sitter outlines universally kept.

---

## 2. Candidate-by-Candidate Verdicts

| Candidate | Precedent verdict | Evidence basis (1–5) | Notes |
|---|---|---|---|
| **SQLite FTS5 / BM25** | **Adopted-and-kept** (the lexical-survivor lineage) | **4** | At 100–2,000 summaries the win is *ranking quality*, not speed. Must split camelCase/snake_case identifiers in the tokenizer or it underperforms substring match. |
| **Embeddings / semantic** | **Tried-and-abandoned** by Cody (2023–24); never adopted by Claude Code or GitHub search; kept only by Cursor with dedicated infra | **4** | For a personal tool over `purpose` strings *already in natural language*, embeddings add a model dependency, refresh pipeline, and staleness risk for marginal gain. Skip. |
| **Persisted dependency graph** | **Universally adopted** (ctags files, LSIF/SCIP, Zoekt shards, Aider's mtime-keyed cache) | **5** | repo-memory already persists imports in SQLite and has `load()` — then doesn't use it. Not a new feature; finishing one. |
| **Symbol-level index** | **Adopted-and-kept** (ctags→LSP→SCIP lineage) | **5** pattern / **3** marginal value here | Exports + declarations already stored (types.ts:8–15); `getEdgesBySymbol` exists. An exact-symbol mode on existing search beats a new tool. |
| **Query-result caching** | **Never-needed-at-small-scale** — no local code tool I know of does it | **4** | The proven thing to cache is the *index* (done). Result caching adds a staleness surface conflicting with the repo's own convention, to save single-digit milliseconds. Skip. |
| **Token-budget shaping** | **Adopted-and-kept** (Aider's `map_tokens` binary-search packing, 2023; Anthropic 2025 tool-design guidance recommending verbosity params) | **5** | The cheapest high-precedent win: repo-memory's entire thesis is token thrift, yet its tools return count-limited, not token-limited, output. |

---

## 3. The Comparison That Matters: Beyond Grep

What successful agent harnesses add beyond grep/glob/read:
1. **A compact repo overview under a token budget** (Aider's repo-map) — `get_project_map` is this pattern, minus the budget.
2. **Symbol → definition jumps** (ctags/LSP) — repo-memory half-has this via exports/declarations matching.
3. **Blast-radius / relationship queries** (dependency graphs, SCIP) — `get_related_files` is this pattern.
4. **Semantic "purpose" search** — the contested one. Cody retreated to keyword; repo-memory's middle path (NL summaries + lexical search over them) is closest to what Cody landed on *after* the retreat: keyword search over context-bearing text.

repo-memory's niche maps onto proven patterns — it is, structurally, "Aider's repo-map as a persistent MCP server." The risk is not the concept; it's that any of these tools answering *slower or staler than grep* trains the agent to stop calling them.

---

## 4. Top 5 Findings (grounded in the code)

**Finding 1 — The cache server doesn't use its own cache for graphs (the single biggest gap vs. prior art).** `get_related_files` re-reads **every source file** and rebuilds the whole graph per call (get-related-files.ts:26–53); `get_dependency_graph` does the same — despite `DependencyGraph.load()` existing precisely to hydrate from the persisted `imports` table (dependency-graph.ts:16–28). Worse, the rebuild *deletes and re-inserts SQLite rows* (dependency-graph.ts:50, 56–67) — a read-only query mutates the database, every call, every file. Every surviving system in the prior art persists and incrementally invalidates; none rebuild per query. This also contradicts the repo's own architecture doc.

**Finding 2 — Duplicated rebuild logic has already drifted.** `.kt/.kts/.java` in get-related-files.ts:40–43 but **not** get-dependency-graph.ts:32–35 — the two graph tools silently see different graphs for Kotlin/Java repos. The classic symptom prior art solves with *one* index builder and many readers.

**Finding 3 — `search_by_purpose` is a hand-rolled, weaker BM25.** Lowercase substring matching with field weights (search-by-purpose.ts:48–92), no identifier tokenization, no document-length normalization — exactly the gaps BM25 closed in 1994 and FTS5 ships for free. The field-weighting instinct is sound and precedented (BM25F). At ≤2k summaries the scan's *speed* is fine; the precedent argument for FTS5 is ranking quality per token returned.

**Finding 4 — The 5-signal ranking is really 4 signals, one dead; vs. Aider's PageRank it ranks locality, not importance.** `changeFrequency` is hardcoded 0.5 with a placeholder comment (ranking.ts:245–246) — a constant adding noise to every score. Dependency proximity is bucketed hop distance; task relevance is directory adjacency. Aider's personalized PageRank over symbol-reference edges captures global importance (hub files) and reference strength. repo-memory already computes degree centrality (`getMostConnected`) but doesn't feed it into ranking. Hand-tuned linear blends are honorable prior art — but dead signals weren't part of the tradition.

**Finding 5 — The token-thrift thesis stops at the tool boundary.** The project's purpose is reducing token waste and telemetry *estimates tokens saved*, yet no tool accepts a token budget — `limit` is result-count. Aider demonstrated in 2023 that the budget, not the count, is the contract that matters to an LLM consumer; Anthropic's 2025 tool guidance says the same. The highest-leverage *missing* precedented feature, and it's an optional-param enhancement.

---

## 5. Recommendations (precedent-weighted order)

1. **Finish the persisted graph (first).** `load()` + refresh only hash-changed files; delete the duplicated rebuild loops (fixes Findings 1 + 2). Precedent: literally everyone. The only candidate where current code actively violates prior art rather than merely lacking it.
2. **Token-budget shaping** as optional `maxTokens` on search/related/map, packing Aider-style (trim summaries before dropping results). Precedent: Aider 2023, MCP guidance 2025.
3. **FTS5/BM25** with camelCase/snake_case-splitting tokenizer, inside the existing tool — no new tool, no API change. Precedent: the lexical-survivor lineage.
4. **Skip embeddings.** Revisit only with concrete queries the lexical path fails on. Precedent: Cody's retreat, Claude Code's grep-first stance; Cursor is the exception that proves the infra cost.
5. **Skip query-result caching.** No precedent at this scale; contradicts the correctness rule.
6. **Fix or drop `changeFrequency`** (git-log churn is cheap at index time); feed degree centrality into ranking as a global-importance prior — the poor man's PageRank, one step along Aider's proven path.
7. **Symbol lookup as an exact-match mode/param on existing search**, not a new tool.

---

## 6. Overall Rating and Verdict

**Rating: 3/5 — right family tree, incomplete inheritance.**

repo-memory has, perhaps without knowing it, chosen the *winning* lineage in agent code retrieval: cached AST-derived summaries plus a dependency graph plus blended ranking is essentially Aider's repo-map (2023, still standing) rebuilt as a persistent MCP server — and notably it has *avoided* the famous dead end, embeddings, which Sourcegraph publicly retreated from in 2023–24 and Claude Code never adopted. But the implementation currently contradicts its own thesis in the one place prior art is unanimous: it caches summaries yet rebuilds (and re-writes!) its dependency graph from a full repo scan on every query, while a `load()` method and a persisted imports table sit unused — no surviving system in thirty years of code search recomputes its index per query. Fix that, add Aider-style token budgets, and let FTS5 replace the hand-rolled substring scorer, and this becomes a faithful instance of the proven pattern; chase embeddings or result caching instead, and it would be adopting exactly the parts of the last three years that the industry has already walked back.
