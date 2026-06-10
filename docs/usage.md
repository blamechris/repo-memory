# Usage Guide

Detailed documentation for each repo-memory MCP tool, with example inputs and outputs.

## CLI

By default `repo-memory` starts the MCP server on stdio. One subcommand is available:

### `repo-memory index [projectRoot] [--quiet]`

Prewarms the summary cache: scans the project, hashes every indexable file, and generates summaries for entries that are missing or stale. Unchanged files are left untouched, so it is cheap to run repeatedly (post-pull hook, CI step). Respects `.repo-memory.json` (ignore patterns, `maxFiles`, summarizer mode).

- `projectRoot` (optional): directory to index. Default: current directory.
- `--quiet` / `-q`: print nothing on success.

```
$ repo-memory index
Indexed /path/to/project
  scanned:       128
  summarized:    126
  already fresh: 2
  skipped:       0
  elapsed:       0.42s
  cache db:      /path/to/project/.repo-memory/cache.db
```

Exits `0` on success, `1` on error (message on stderr).

To keep the cache warm automatically, run it from a git `post-merge` hook so every pull/merge re-indexes only what changed:

```sh
#!/bin/sh
# .git/hooks/post-merge (chmod +x)
(npx -y @blamechris/repo-memory index . --quiet >/dev/null 2>&1 &)
```

The subshell-and-background form keeps pulls fast; with `--quiet` the run is silent. Note `post-merge` does not fire on rebase pulls (`git pull --rebase`).

## Tools Reference

### `get_file_summary`

Returns a cached summary of a file. If the file has not changed since last read, returns the cached summary without re-reading.

**Input:**
```json
{
  "path": "src/server.ts"
}
```

**Output (cache hit):**
```json
{
  "path": "src/server.ts",
  "summary": {
    "purpose": "entry point",
    "exports": ["main"],
    "imports": ["@modelcontextprotocol/sdk/server/mcp.js", "zod", "./tools/get-file-summary.js"],
    "lineCount": 219,
    "topLevelDeclarations": ["server", "main"],
    "confidence": "high"
  },
  "fromCache": true,
  "cacheAge": 42,
  "suggestFullRead": false
}
```

**Output (cache miss):**
```json
{
  "path": "src/server.ts",
  "summary": {
    "purpose": "entry point",
    "exports": ["main"],
    "imports": ["@modelcontextprotocol/sdk/server/mcp.js"],
    "lineCount": 219,
    "topLevelDeclarations": ["server", "main"],
    "confidence": "high"
  },
  "fromCache": false,
  "suggestFullRead": false
}
```

**Notes:**
- `suggestFullRead` is `true` when the summary confidence is `"low"`, indicating the agent should read the full file for accuracy.
- `cacheAge` is in seconds since the cached entry was last validated; it is only present on cache hits.
- Summary quality depends on the `summarizer` setting in `.repo-memory.json`: `"ast"` (default) or `"regex"`. AST mode (TS/JS, Python, Go, Rust, Kotlin, Java) yields more accurate exports and a semantic `purpose` line naming the dominant symbols; other languages and files that fail to parse fall back to the regex engine automatically. See the README's Configuration section.

---

### `batch_file_summaries`

Returns summaries for multiple files in one call. Each file goes through the same cache-or-summarize flow as `get_file_summary`.

**Input:**
```json
{
  "paths": ["src/server.ts", "src/cache/store.ts", "src/missing.ts"]
}
```

**Output:**
```json
{
  "results": [
    { "path": "src/server.ts", "fromCache": true, "summary": { "...": "..." } },
    { "path": "src/cache/store.ts", "fromCache": false, "summary": { "...": "..." } }
  ],
  "cacheHits": 1,
  "cacheMisses": 1,
  "errors": [
    { "path": "src/missing.ts", "error": "File not found" }
  ]
}
```

**Notes:**
- Each entry in `results` has the same shape as a `get_file_summary` response.
- A failing path (missing file, invalid path) lands in `errors` without failing the batch.

---

### `search_by_purpose`

Searches cached file summaries by keyword. Matches against each file's purpose, exports, and top-level declarations. Only files that have been summarized before (via `get_file_summary`, `batch_file_summaries`, or `force_reread`) are searchable.

**Input:**
```json
{
  "query": "cache invalidation",
  "limit": 10,
  "pathPrefix": "src/cache"
}
```

**Output:**
```json
{
  "results": [
    {
      "path": "src/cache/invalidation.ts",
      "purpose": "source",
      "exports": ["CacheInvalidator"],
      "confidence": "high"
    }
  ],
  "totalCached": 12,
  "scope": "src/cache"
}
```

**Parameters:**
- `query` (required): Space-separated keywords. Purpose matches are weighted highest, then exports, then declarations.
- `limit` (optional): Max results. Default: 20.
- `pathPrefix` (optional): Restrict results to files at or under this path (e.g. `"src/cache"`). Matched on a path boundary, so `"src/cache"` excludes `src/cache-utils.ts`.

**Notes:**
- `totalCached` is the number of summarized files in scope (after `pathPrefix` filtering), not the number of matches. If it is 0, warm the cache with `repo-memory index` first.
- `scope` is present only when `pathPrefix` was given, echoing the normalized prefix.
- `exports` is capped at 5 entries per result; when capped, `exportsTruncated` carries the total export count.

---

### `get_changed_files`

Returns files that have changed, been added, or been deleted since the last check.

**Input:**
```json
{
  "since": "last_check"
}
```

Or with an ISO timestamp:
```json
{
  "since": "2025-01-15T10:00:00Z"
}
```

Or omit `since` entirely to compare all files against their cached hashes:
```json
{}
```

**Output:**
```json
{
  "changed": ["src/tools/get-file-summary.ts", "src/cache/store.ts"],
  "added": ["src/utils/new-helper.ts"],
  "deleted": ["src/old-module.ts"],
  "checkedAt": "2025-01-15T12:30:00.000Z"
}
```

**Notes:**
- On first run (empty cache), all files appear in `added`.
- Running this tool updates the cache hashes, so the next call only shows changes since this call.

---

### `get_project_map`

Returns a structural overview of the project including directory tree, entry points, and language breakdown.

**Input:**
```json
{
  "depth": 2
}
```

**Output:**
```json
{
  "tree": {
    "name": "repo-memory",
    "files": [
      { "name": "server.ts", "purpose": "entry point" }
    ],
    "children": [
      {
        "name": "cache",
        "files": [
          { "name": "hash.ts", "purpose": "utility" },
          { "name": "store.ts", "purpose": "data access" }
        ],
        "children": [],
        "fileCount": 5
      }
    ],
    "fileCount": 25
  },
  "entryPoints": ["src/server.ts"],
  "totalFiles": 25,
  "languageBreakdown": {
    ".ts": 22,
    ".json": 2,
    ".md": 1
  }
}
```

**Notes:**
- `project_root` (optional): Absolute path to the project root. Defaults to the server's working directory, like every other tool.
- `depth` limits how deep the directory tree is traversed. Defaults to 2; pass a larger value for deeper structure.
- `entryPoints` lists files whose summarized purpose is `"entry point"`.
- File entries are kept compact (`name`, `purpose`). A directory's path is derivable from its nesting. Per-file confidence is available via `get_file_summary`; recency is covered by `get_changed_files`.
- Zero-byte `.gitkeep` placeholder files are omitted from the tree.

---

### `force_reread`

Re-reads a file from disk, generates a fresh summary, and updates the cache. Use when you know a file has changed or want guaranteed-fresh data.

**Input:**
```json
{
  "path": "src/cache/store.ts"
}
```

**Output:**
```json
{
  "path": "src/cache/store.ts",
  "hash": "abc123def456...",
  "summary": {
    "purpose": "data access",
    "exports": ["CacheStore"],
    "imports": ["better-sqlite3", "../persistence/db.js"],
    "lineCount": 95,
    "topLevelDeclarations": ["CacheStore"],
    "confidence": "high"
  },
  "reread": true,
  "reason": "force_reread: explicitly requested"
}
```

---

### `invalidate`

Invalidates cached entries. Can target a single file or clear the entire cache.

**Input (single file):**
```json
{
  "path": "src/cache/store.ts"
}
```

**Output:**
```json
{
  "invalidated": "src/cache/store.ts",
  "entriesRemoved": 1
}
```

**Input (all entries):**
```json
{}
```

**Output:**
```json
{
  "invalidated": "all",
  "entriesRemoved": 47
}
```

---

### `get_dependency_graph`

Returns dependency graph information as adjacency maps. Can query a specific file's dependencies/dependents or get a summary of the most connected files. Calling without `path` returns a large whole-repo summary — prefer passing `path`.

**Input (specific file):**
```json
{
  "path": "src/server.ts",
  "direction": "both",
  "depth": 1
}
```

**Output:**
```json
{
  "deps": {
    "src/server.ts": [
      "src/tools/get-changed-files.ts",
      "src/tools/get-file-summary.ts",
      "src/tools/invalidate.ts"
    ]
  },
  "dependents": {
    "src/server.ts": []
  },
  "stats": {
    "totalFiles": 4,
    "totalEdges": 3
  }
}
```

**Input (whole-repo summary):**
```json
{}
```

**Output (whole-repo summary):**
```json
{
  "deps": {
    "src/cache/store.ts": ["src/persistence/db.js", "src/types.ts"],
    "src/types.ts": []
  },
  "stats": {
    "totalFiles": 118,
    "totalEdges": 284,
    "mostConnected": [
      { "path": "src/types.ts", "connections": 12 },
      { "path": "src/cache/store.ts", "connections": 8 }
    ]
  },
  "truncated": true
}
```

**Parameters:**
- `path` (optional): File to query. Omit only when you want the whole-repo summary.
- `direction` (optional): `"dependencies"`, `"dependents"`, or `"both"` (default: `"both"`). `deps` is present when the direction includes dependencies; `dependents` when it includes dependents.
- `depth` (optional): Max traversal depth for transitive queries.
- `symbol` (optional): Filter edges by import specifier (e.g. `"UserService"`), returning only edges that import that symbol (as a `deps` adjacency map).
- `limit` (optional, no-path summary mode only): Max files included in `deps`, ranked by connectivity (default: 50).

**Notes:**
- `stats.mostConnected` appears only in the no-path summary mode.
- In summary mode, `stats.totalFiles`/`stats.totalEdges` are whole-graph counts; `truncated: true` flags that `deps` was capped by `limit`.

---

### `get_related_files`

Returns files related to a given file, ranked by relevance. Candidates come from direct imports/importers, transitive dependencies (depth 2), and same-directory files, then get scored by ranking signals (dependency proximity, recency, file type, task context, change frequency).

**Input:**
```json
{
  "path": "src/cache/store.ts",
  "limit": 5,
  "task_id": "550e8400-e29b-41d4-a716-446655440000"
}
```

**Output:**
```json
{
  "path": "src/cache/store.ts",
  "relatedFiles": [
    { "path": "src/persistence/db.ts", "score": 0.82, "relationship": "imports" },
    { "path": "src/cache/invalidation.ts", "score": 0.74, "relationship": "imported-by" },
    { "path": "src/cache/gc.ts", "score": 0.61, "relationship": "same-directory" },
    { "path": "src/types.ts", "score": 0.55, "relationship": "transitive-dependency" }
  ]
}
```

**Parameters:**
- `path` (required): File to find relations for.
- `limit` (optional): Max results. Default: 10.
- `task_id` (optional): A task whose explored/flagged files should influence ranking (unexplored files rank higher; flagged files get a boost).

**Notes:**
- `relationship` is one of `"imports"`, `"imported-by"`, `"transitive-dependency"`, or `"same-directory"`.

---

### `create_task`

Creates a new investigation task for tracking file exploration progress.

**Input:**
```json
{
  "name": "investigate auth flow"
}
```

**Output:**
```json
{
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "name": "investigate auth flow",
  "state": "created",
  "createdAt": 1705312200000,
  "updatedAt": 1705312200000,
  "sessionId": null,
  "metadata": null
}
```

---

### `get_task_context`

Returns task state, explored files, and the unexplored frontier. If no `task_id` is given, returns a list of all tasks.

**Input (specific task):**
```json
{
  "task_id": "550e8400-e29b-41d4-a716-446655440000"
}
```

**Output:**
```json
{
  "task": {
    "id": "550e8400-e29b-41d4-a716-446655440000",
    "name": "investigate auth flow",
    "state": "created",
    "createdAt": 1705312200000,
    "updatedAt": 1705312200000,
    "sessionId": null,
    "metadata": null
  },
  "exploredFiles": [
    {
      "taskId": "550e8400-e29b-41d4-a716-446655440000",
      "filePath": "src/auth/login.ts",
      "status": "explored",
      "notes": "Main login handler, uses JWT",
      "exploredAt": 1705312300000
    }
  ],
  "frontier": ["src/auth/middleware.ts", "src/auth/tokens.ts"]
}
```

**Input (list all tasks):**
```json
{}
```

**Output:**
```json
{
  "tasks": [
    {
      "id": "550e8400-e29b-41d4-a716-446655440000",
      "name": "investigate auth flow",
      "state": "created",
      "createdAt": 1705312200000,
      "updatedAt": 1705312200000,
      "sessionId": null,
      "metadata": null
    }
  ]
}
```

---

### `mark_explored`

Marks a file as explored for a given task, with optional status and notes.

**Input:**
```json
{
  "task_id": "550e8400-e29b-41d4-a716-446655440000",
  "path": "src/auth/login.ts",
  "status": "explored",
  "notes": "Main login handler, uses JWT tokens"
}
```

**Output:**
```json
{
  "marked": true,
  "taskId": "550e8400-e29b-41d4-a716-446655440000",
  "path": "src/auth/login.ts",
  "status": "explored"
}
```

**Parameters:**
- `status` (optional): `"explored"`, `"skipped"`, or `"flagged"`. Default: `"explored"`.
- `notes` (optional): Free-text notes about the file.

---

### `get_token_report`

Returns aggregated token usage telemetry showing cache efficiency and token savings.

**Input:**
```json
{
  "period": "last_n_hours",
  "hours": 4
}
```

**Output:**
```json
{
  "period": "last_n_hours",
  "totalEvents": 156,
  "cacheHits": 132,
  "cacheMisses": 24,
  "cacheHitRatio": 0.846,
  "estimatedTokensSaved": 482000,
  "topFiles": [
    { "path": "src/server.ts", "accessCount": 12, "tokensEstimated": 8400 },
    { "path": "src/cache/store.ts", "accessCount": 9, "tokensEstimated": 3600 }
  ],
  "eventBreakdown": {
    "cache_hit": 132,
    "cache_miss": 24
  }
}
```

**Parameters:**
- `period` (optional): `"session"`, `"all"`, or `"last_n_hours"`. Default: `"all"`.
- `hours` (optional): Number of hours to look back (only for `last_n_hours`).
- `session_id` (optional): Session ID (only for `session` period).
- `include_diagnostics` (optional): Include cache health diagnostics (entry counts, stale entries, database size) in the report.
