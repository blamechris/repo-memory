# Protocol's Audit: Agent-Facing Search & Retrieval Efficiency

**Agent**: Protocol -- MCP specialist; tool contracts, stdio hygiene, token-cost ROI of every tool an agent carries
**Overall Rating**: 3.0 / 5
**Date**: 2026-06-09

**Method:** measurements taken by running the built `dist/` tools against this repo's own cache (168 summarized files). Heuristic: ~4 chars/token.

---

## 1. Per-Tool Response Shape Audit (measured, this repo)

| Tool | Call | Measured chars | Est. tokens | Efficiency |
|---|---|---|---|---|
| `get_project_map` | no depth | 14,487 | **~3,622** | 2/5 |
| `get_project_map` | depth=1 | 2,494 | ~624 | — |
| `search_by_purpose` | "cache invalidation" (10 hits) | 2,346 | ~587 | 4/5 |
| `get_related_files` | src/cache/store.ts (10 hits) | 815 | ~204 | 4/5 |
| `get_dependency_graph` | **no path** | 21,310 | **~5,328** | 1/5 |
| `get_dependency_graph` | path-scoped | 428 | ~107 | 3/5 |
| `get_file_summary` | src/cache/store.ts | 443 | ~111 | 3/5 |
| `batch_file_summaries` | 5 paths | 2,983 | ~746 (~149/file) | 3/5 |

**`get_dependency_graph` (no path) — 1/5.** Worst offender (get-dependency-graph.ts:123-148). Every file path serialized **three times**: in `nodes[]` (118 entries), in `edges[]` as `{"from","to"}` objects (284 edges × two full paths), and again in `stats.mostConnected`. `nodes` is 100% derivable from `edges`. An adjacency-map shape halves it. The path-scoped variant **always appends global `mostConnected`** — repo-wide trivia irrelevant to the query.

**`get_project_map` (no depth) — 2/5.** Every `DirectoryNode` carries both `name` and full `path` (derivable from nesting). Per-file `size` in raw bytes is rarely actionable. No default depth means the naive first call costs 3.6k tokens; depth=1 is 6× cheaper and usually sufficient.

**`get_file_summary` — 3/5.** Useful payload is ~60 of 111 tokens. Waste: full 64-hex `hash` (~18 tokens — an agent cannot act on a SHA-256), `reason` (redundant with `fromCache`), `cacheAge` (meaningful only when something is wrong). ~40% overhead per call. **`batch_file_summaries`** inherits this ×N (5 files → ~200 wasted tokens) plus `totalFiles` echo.

**`search_by_purpose` — 4/5.** Tightest shape (~59 tokens/result). Remaining waste: `query` echo and `matchedOn` debug metadata (~10 tokens/result, ~17% of payload). `totalCached` is genuinely useful (index-warm signal).

**`get_related_files` — 4/5 on shape, with a correctness asterisk:** the paths it returns can be **nonexistent files** (e.g. `src/types.js` for `src/types.ts`), converting its token efficiency into negative ROI when the agent's follow-up Read fails.

---

## 2. Descriptions & Schemas — Discoverability vs. Built-in Grep/Read

A tool the agent never picks is pure −100 tokens/turn.

| Tool | Description teaches "when over Grep/Read"? | Rating |
|---|---|---|
| `get_file_summary` | Yes — "Use this instead of reading files directly to save tokens" (server.ts:111). The only one that explicitly competes with a built-in. | 4/5 |
| `batch_file_summaries` | Compares against itself, not against the agent reading 5 files. | 4/5 |
| `search_by_purpose` | **No.** "Search cached file summaries by keyword" (server.ts:173) describes mechanism, not advantage. Never says "use this before grep when you don't know filenames." The caveat "Requires files to have been previously summarized" actively deters selection without telling the agent how to check (`totalCached`) or warm (`repo-memory index`). The flagship retrieval tool under-sells itself. | 2/5 |
| `get_related_files` | Decent but doesn't say it replaces a grep-for-imports + grep-for-usages pair (2+ turns → 1). | 3/5 |
| `get_dependency_graph` | No cost signal — nothing warns that omitting `path` returns a 5k-token dump. Agents discover this by burning the tokens. | 3/5 |
| `get_project_map` | No depth guidance, no cost signal, and the **only tool requiring `project_root`** (server.ts:43) while every sibling resolves `process.cwd()`. Contract inconsistency = failed first calls. | 3/5 |

Schema hygiene: mixed param casing — `pathPrefix` (camelCase) vs `task_id`/`project_root` (snake_case). Standing overhead: default config registers 9 tools ≈ 900 tokens/turn; `invalidate` and `force_reread` are maintenance tools riding in the default set.

---

## 3. Candidate Improvements — Agent-Visible Impact

| Candidate | What the agent experiences | Impact |
|---|---|---|
| **Token-budget response shaping** | Direct context savings on every call; fixes the 5.3k/3.6k dumps. The single highest-leverage item. | **5/5** |
| **Symbol index** | "Where is `CacheStore` defined/used" in 1 turn. The `symbol` param already exists — make it fast/complete rather than per-call full re-parse. Zero new-tool overhead. | **4/5** |
| **FTS5/BM25** | Better ordering, fewer substring false-positives. Real but bounded: corpus is one-line AST purposes — sparse text limits BM25 headroom. | **3/5** |
| **Persisted dependency graph** | Identical response bytes, faster turns; bumps to 3/5 if persistence normalizes `.js`→`.ts` paths, fixing the phantom-path finding. | **2/5** |
| **Embeddings** | Semantic recall over ~10-token structural strings carries little signal; deps, latency, likely a new tool. Negative ROI at current corpus richness. | **2/5** |
| **Query-result caching** | Identical bytes, marginally faster. Pure server internals. | **1/5** |

---

## 4. Top 5 Findings

1. **`get_dependency_graph` with no path is a 5,328-token bomb with triple path redundancy** (get-dependency-graph.ts:123-148); path-scoped queries unconditionally append global `mostConnected` noise.
2. **`get_related_files` returns paths that don't exist on disk** — measured output includes `src/persistence/db.js` and `src/types.js`. Input variants are normalized (`getPathVariants`) but **output candidates are not** (get-related-files.ts:136-140). An agent's follow-up call ENOENTs: a wasted turn manufactured by the tool itself.
3. **Language filter drift between graph tools** — `.kt/.kts/.java` in get-related-files (lines 40-43) but not get-dependency-graph (lines 32-34). The dependency graph silently returns empty results for Kotlin/Java with no error — the agent can't distinguish "no deps" from "not indexed."
4. **`search_by_purpose` telemetry inflates the project's own ROI math** — search-by-purpose.ts:100-106 logs each matched result as `summary_served` worth `lineCount * 10` tokens saved, but the agent received only ~59 tokens per hit, not a summary in lieu of a full read. A 20-result search claims thousands of phantom saved tokens, corrupting the very (frequency × savings) metric used to justify tools.
5. **Contract inconsistencies** — `get_project_map` alone demands `project_root`; mixed param casing; per-result 64-hex `hash` + `reason` strings are debug metadata an agent cannot act on, repeated ×N in batches.

---

## 5. Recommendations (params + shape diffs, no new tools)

**Shape diffs:** drop `hash`/`reason` from summary responses (emit `cacheAge` only when meaningful); adjacency-map shape for the graph + `limit` param + `mostConnected` only in no-path mode; default `depth=2` for the map, drop derivable `path` and raw `size`; drop `query` echo and `matchedOn` from search (or gate behind `verbose`).

**Description rewrites (the cheap, high-leverage fix):**
- `search_by_purpose`: *"Find files by what they do when you don't know filenames — prefer this over grep for concept searches ('where is auth handled'). Check `totalCached` > 0; if 0, run `repo-memory index` first."*
- `get_dependency_graph`: append *"Calling without `path` returns a large whole-repo summary (~5k tokens); prefer passing `path`."*
- `get_related_files`: *"One call replaces grepping for imports and usages separately."*
- `get_project_map`: align to cwd like every other tool; document depth default.

**Token budget: current vs proposed**

| Call | Current | Proposed | Δ |
|---|---|---|---|
| `get_dependency_graph` (no path) | ~5,328 | ~2,300 | **−57%** |
| `get_project_map` (no depth) | ~3,622 | ~640 | **−82%** |
| `batch_file_summaries` (5 files) | ~746 | ~480 | −36% |
| `search_by_purpose` (10 results) | ~587 | ~450 | −23% |
| `get_file_summary` | ~111 | ~70 | −37% |
| `get_dependency_graph` (path) | ~107 | ~60 | −44% |

A typical exploration sequence (map → search → related → 5 summaries) drops from ~5,160 to ~1,640 tokens — **3× improvement with zero new tools and zero schema breaks.**

---

## 6. Overall Rating: **3/5**

The summaries-and-search core is genuinely well-shaped — `search_by_purpose` and `get_related_files` return tight, agent-consumable payloads, and `get_file_summary`'s description is the only one that correctly fights for selection against the agent's built-in Read. But the navigation tier undoes it: the two "orientation" calls an agent makes first are 3.6k and 5.3k token dumps with structurally redundant shapes, `get_related_files` emits paths that don't exist (wasted follow-up turns), and the flagship search tool's description actively discourages use. Of the six candidates, only token-budget shaping and the symbol index meaningfully change what the agent experiences; embeddings and query caching are server-side vanity at this corpus size. The fixes are cheap — field deletions, two defaults, four description rewrites — and would roughly triple the token efficiency of a standard exploration sequence without registering a single new tool.
