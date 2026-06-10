# Guardian's Audit: Agent-Facing Search & Retrieval Efficiency

**Agent**: Guardian -- paranoid security/SRE who designs for 3am pages; finds race conditions and nuclear scenarios
**Overall Rating**: 2.0 / 5
**Date**: 2026-06-09

**Scope:** `search_by_purpose`, `get_related_files`, `get_dependency_graph`, ranking, GC, summary-generation invalidation, multi-process/multi-version concurrency, and the six candidate improvements — judged against the core invariant: **never return stale data**.

---

## 1. Ratings by Area

### 1.1 Staleness exposure of `search_by_purpose` as-is — **2/5**

`src/tools/search-by-purpose.ts` reads cached rows and serves them with **zero freshness checks**:

- **No hash validation anywhere on the search path.** Line 37 (`store.getAllEntries()`) through line 92 never touches `hashFile`/`CacheInvalidator`. A file edited 5 seconds ago surfaces with its old `purpose`, old `exports`, old `confidence`.
- **It skips `ensureSummaryGeneration` entirely.** Compare `get-file-summary.ts:37` and `force-reread.ts:16`, which call it; `search-by-purpose.ts:20-37` does not. If the summarizer mode/generation changed and no summary tool has run yet in this process, search serves summaries from a **wrong generation** the rest of the system has already declared invalid.
- **Deleted files surface as results.** Entries for removed files persist until the startup-only background GC (`server.ts:327`) runs; an agent can be handed a path that no longer exists.
- **It also writes telemetry on a read path** (lines 101-107): a concurrent write lock can turn a "read" into an SQLITE_BUSY failure after the 5s default timeout.

### 1.2 `get_related_files` / `get_dependency_graph` freshness — **3/5** (fresh but expensive, with a torn-write tax)

Both rebuild the graph from live file reads each call, so in-memory results are fresh. But:

- Each call **rewrites the entire `imports` table** (`dependency-graph.ts:31-68`) — a full DELETE+INSERT per scanned file, per query. Massive write amplification under WAL and pointless lock contention with any concurrent process.
- **The DELETE is outside the transaction.** `dependency-graph.ts:50` deletes a file's rows, then lines 60-67 insert inside `db.transaction`. A crash (or a concurrent reader) between the two leaves/sees a file with **zero imports**. `getEdgesBySymbol` (lines 83-105) reads the table directly, so symbol queries can return torn, non-deterministic edge sets.
- **Extension-list drift:** `get-dependency-graph.ts:32-34` omits `.kt/.kts/.java`, which `get-related-files.ts:31-44` includes. The persisted `imports` content depends on *which tool ran last*. Non-deterministic by construction.

### 1.3 Concurrency story (WAL, multi-process, multi-version) — **2/5**

- WAL + better-sqlite3's default lock timeout (`db.ts:163-165`; no explicit `busy_timeout`) is an adequate baseline for one writer + readers. Above that baseline:
- **Generation-tag ping-pong / split-brain (`summarize.ts:30, 56-74`).** The check is memoized **per process** (`generationChecked` map). Scenario: a long-running MCP server at generation 3 has memoized `ast:3`. A post-merge hook runs a newer CLI at generation 4 → `clearAllSummaries()`, meta set to `ast:4`. The server, memoized, keeps **writing generation-3 summaries into a database tagged `ast:4`** — and the next gen-4 run sees a matching tag and does nothing. Mixed-generation summaries are now permanent. Run the *old* CLI after the *new* server and you get the mirror image: each alternation wipes the entire cache (clear-storm). There is no "never downgrade" rule and no per-transaction recheck.
- **`clearAllSummaries()` + `setMeta()` are not atomic** (`summarize.ts:69-71`, `store.ts:110-113`). A concurrent process can insert an old-generation summary between the clear and the tag write; it survives under the new tag.
- **First-run migration race (`db.ts:109-138`).** Two processes opening a fresh DB (MCP server starting + post-merge hook — a documented real workflow) both read `currentVersion = 0` and both run the migration transaction; the loser hits the `schema_version` PRIMARY KEY constraint and **throws out of `getDatabase`**, crashing that process at startup. No `BEGIN IMMEDIATE`, no re-read inside the transaction, no conflict tolerance.
- **GC vs. concurrent writers (`gc.ts`).** Step 1/2 deletes are computed from a snapshot and applied one-by-one outside any transaction (lines 57-61) — a file re-indexed by a concurrent prewarm after the snapshot gets its fresh entry deleted (perf loss, safe direction). Step 5 (lines 99-113) races a concurrent `get_related_files` and can delete freshly written edges.
- **`invalidateAll` (`invalidation.ts:45-50`)** is a non-transactional snapshot loop — entries written concurrently survive a tool whose contract is "invalidate everything."

### 1.4 NEW, found while auditing — `get_changed_files` **poisons the cache** — **1/5**

This is the worst defect in the audit and it sits on the freshness tool itself. `get-changed-files.ts:39-46`:

```ts
} else if (cached.hash !== currentHash) {
  ...
}
// Update the cache entry with current hash and timestamp
store.setEntry(relativePath, currentHash, cached?.summary ?? null);
```

When a file **has changed**, it writes the **new hash** with the **old summary**. From that moment, `get-file-summary.ts:53` (`cached.hash === currentHash && cached.summary`) reports a confident `cache_hit: hash unchanged` and serves the stale summary — **the hash check, the system's only freshness defense, has been defeated by its own sibling tool.** Edit a file → call `get_changed_files` (the natural post-merge step) → every subsequent summary/search for that file is stale until the file changes *again* or someone force-rereads. This directly violates the core invariant and silently inflates "tokens saved" telemetry with stale hits.

### 1.5 Candidate improvements vs. the never-stale invariant

| Candidate | Risk | Rating if built naively |
|---|---|---|
| FTS5/BM25 over summaries | `summary_json` is mutated at **four** choke points: `setEntry`, `setEntries`, `clearAllSummaries` raw `UPDATE` (store.ts:112), `deleteEntry` — plus the generation clear and GC. App-level FTS sync will miss the raw UPDATE; an FTS index not cleared by `ensureSummaryGeneration` serves wrong-generation text forever. Must be trigger-maintained (external-content FTS5 with INSERT/UPDATE/DELETE triggers); the multi-version split-brain (1.3) means an old package version without triggers can still desync anything app-maintained. | 1/5 naive, 3-4/5 with triggers + hash-stamped rows |
| Embeddings / semantic search | Async vector generation creates an inherent window where the vector describes old content. A vector store keyed by path alone is a stale-data time bomb. Must store `(path, content_hash)` and join against `files.hash` at query time, dropping mismatches. | 1/5 naive |
| Persisted dependency graph | **Already exists and is already broken** — torn writes (1.2), no hash stamping, extension drift, GC orphan race. Persisting "more" without fixing the DELETE-outside-transaction institutionalizes non-determinism. | 2/5 today |
| Symbol-level index | Same class as FTS: derived from file content, must carry `content_hash` and be written in the same transaction as the `files` row. | 1/5 naive |
| Query-result caching | The most dangerous idea on the list: a cached result set is stale the moment *any* file changes, and there is no global version signal today. Only acceptable keyed by `(query, PRAGMA data_version, generation tag)`. | 1/5 naive |
| Token-budget response shaping | Pure presentation; only requirement is deterministic truncation. | 4/5 |

---

## 2. Top 5 Failure Modes (with trigger scenarios)

1. **Cache poisoning via `get_changed_files`** (`get-changed-files.ts:46`). *Trigger:* dev merges a refactor; post-merge automation or the agent calls `get_changed_files`; every changed file now has new-hash/old-summary. Agent then gets a confident stale hit and edits code based on exports that no longer exist. Silent, persistent, self-concealing.
2. **Multi-version generation split-brain** (`summarize.ts:30, 56-74`). *Trigger:* MCP server (gen 3) stays up while a post-merge hook runs a newer CLI (gen 4). Tag flips, server keeps memoized gen-3 state and writes gen-3 summaries under the gen-4 tag — permanently mixed generations; or version alternation wipes the whole cache on every flip.
3. **`search_by_purpose` serves unvalidated rows** (`search-by-purpose.ts:37-92`). *Trigger:* agent searches mid-task after editing files; gets pre-edit purposes/exports plus a path deleted yesterday. Agent navigates to a ghost file at 3am.
4. **Torn `imports` table → non-deterministic symbol queries** (`dependency-graph.ts:50`; `gc.ts:99-113`; extension drift). *Trigger:* `get_dependency_graph?symbol=X` while a concurrent rebuild is mid-rewrite — file appears with zero imports; or Kotlin edges stale because only the tool that skips `.kt` has run since the edit.
5. **Concurrent first-run crash** (`db.ts:117-137`). *Trigger:* fresh clone; post-merge hook prewarm and MCP server start simultaneously; both apply migration 1; loser throws `SQLITE_CONSTRAINT` and the MCP server dies on startup — exactly when the agent first needs it.

---

## 3. Invariants Any New Index/Cache Must Satisfy (testable rules)

- **I1 — Hash-stamped derivation.** Every derived row (FTS doc, embedding, symbol, import edge) carries the `content_hash` of the source it was computed from. *Test:* mutate a file, bypass re-indexing, query the derived index → row must be filtered out or recomputed; never returned.
- **I2 — Single transactional choke point.** A `files` row and all its derived rows change in the same SQLite transaction; for FTS use external-content triggers so even the raw `UPDATE` in `clearAllSummaries` stays in sync. *Test:* crash-injection asserting both-or-neither.
- **I3 — Generation checked per read, never memoized across the process against external writers; monotonic with no downgrade.** A process whose generation is *lower* than the stored one must refuse to clear and refuse to write summaries (read-through only). *Test:* interleave two store handles at gen N and N+1; final DB contains only gen-N+1 summaries and exactly one clear.
- **I4 — Clear+tag atomicity.** `clearAllSummaries` and the meta tag write occur in one transaction. *Test:* crash between them must be unobservable.
- **I5 — Searches validate before serving.** `search_by_purpose` (and any FTS successor) calls `ensureSummaryGeneration` and re-hashes its top-N results (N≤20 — cheap) before returning, dropping or regenerating mismatches; missing files never returned. *Test:* edit/delete a file post-index, search → file absent or fresh.
- **I6 — Query caches keyed by global version.** Any memoized result set is keyed by `(query, PRAGMA data_version, generation tag)`. *Test:* commit from a second connection → next query must miss.
- **I7 — Never persist a summary under a hash it wasn't computed from.** Fixes `get-changed-files.ts:46`: when `cached.hash !== currentHash`, write `setEntry(path, currentHash, null)`. *Test:* change file → `get_changed_files` → `get_file_summary` must report `cache_miss`, never `cache_hit`.
- **I8 — Reads never fail on telemetry.** Telemetry writes on read paths are best-effort (try/catch), ideally batched.
- **I9 — Concurrent-safe migrations.** `BEGIN IMMEDIATE`, re-read `schema_version` inside the transaction, tolerate the loser. *Test:* two processes against a fresh DB; both exit 0.
- **I10 — One source of truth for indexable extensions**, shared by all graph builders.

---

## 4. Overall Rating & Verdict

## Overall: 2/5

The fresh-but-expensive paths honor the never-stale invariant in-memory while quietly corrupting the persisted `imports` table they sit on, and the cheap path (`search_by_purpose`) ignores the invariant outright — no hash validation, no generation check, ghost files served until a startup-only GC. But the disqualifying finding is that the system's own freshness tooling is the staleness vector: `get_changed_files` rewrites changed files' entries with the new hash and the old summary, converting every subsequent lookup into a confident stale `cache_hit` — the one defense the architecture has (SHA-256 comparison) is defeated from inside. Layered on top is a multi-process/multi-version story (memoized generation checks, non-atomic clear+tag, racy first-run migrations) that the project's documented workflows — long-running MCP server plus post-merge CLI hooks at potentially different package versions — exercise routinely, not hypothetically. Every candidate improvement is buildable, but each multiplies the derived-state surface; until I7 (the poisoning fix), I3 (generation monotonicity), and I2 (transactional derivation) are in place and tested, any new index inherits and amplifies the existing stale-data time bombs. Fix the poisoning bug today — it is a one-line change with a one-test proof — then gate every new index behind the invariants above.
