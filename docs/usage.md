# Usage Guide

Detailed documentation for each repo-memory MCP tool, with example inputs and outputs.

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
  "hash": "a1b2c3d4e5f6...",
  "summary": {
    "purpose": "entry point",
    "exports": ["main"],
    "imports": ["@modelcontextprotocol/sdk/server/mcp.js", "zod", "./tools/get-file-summary.js"],
    "lineCount": 219,
    "topLevelDeclarations": ["server", "main"],
    "confidence": "high"
  },
  "fromCache": true,
  "reason": "cache_hit: hash unchanged",
  "cacheAge": 42,
  "suggestFullRead": false
}
```

**Output (cache miss):**
```json
{
  "path": "src/server.ts",
  "hash": "f6e5d4c3b2a1...",
  "summary": {
    "purpose": "entry point",
    "exports": ["main"],
    "imports": ["@modelcontextprotocol/sdk/server/mcp.js"],
    "lineCount": 219,
    "topLevelDeclarations": ["server", "main"],
    "confidence": "high"
  },
  "fromCache": false,
  "reason": "cache_miss: hash changed",
  "cacheAge": null,
  "suggestFullRead": false
}
```

**Notes:**
- `suggestFullRead` is `true` when the summary confidence is `"low"`, indicating the agent should read the full file for accuracy.
- `cacheAge` is in seconds since last check, or `null` if no prior cache entry exists.

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
  "project_root": "/absolute/path/to/project",
  "depth": 2
}
```

**Output:**
```json
{
  "tree": {
    "name": "repo-memory",
    "path": ".",
    "files": [
      { "name": "server.ts", "purpose": "entry point" }
    ],
    "children": [
      {
        "name": "cache",
        "path": "src/cache",
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
- `depth` limits how deep the directory tree is traversed. Omit for full depth.
- `entryPoints` lists files whose summarized purpose is `"entry point"`.

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

Returns dependency graph information. Can query a specific file's dependencies/dependents or get a summary of the most connected files.

**Input (specific file):**
```json
{
  "path": "src/server.ts",
  "direction": "dependencies",
  "depth": 1
}
```

**Output:**
```json
{
  "nodes": [
    "src/server.ts",
    "src/tools/get-file-summary.ts",
    "src/tools/get-changed-files.ts",
    "src/tools/invalidate.ts"
  ],
  "edges": [
    { "from": "src/server.ts", "to": "src/tools/get-file-summary.ts" },
    { "from": "src/server.ts", "to": "src/tools/get-changed-files.ts" },
    { "from": "src/server.ts", "to": "src/tools/invalidate.ts" }
  ],
  "stats": {
    "totalFiles": 4,
    "totalEdges": 3,
    "mostConnected": [
      { "path": "src/types.ts", "connections": 12 },
      { "path": "src/cache/store.ts", "connections": 8 }
    ]
  }
}
```

**Input (full graph summary):**
```json
{}
```

**Parameters:**
- `path` (optional): File to query. Omit for full graph summary.
- `direction` (optional): `"dependencies"`, `"dependents"`, or `"both"` (default: `"both"`).
- `depth` (optional): Max traversal depth for transitive queries.

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
