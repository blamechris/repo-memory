# Agent Patterns

Recommended patterns for AI agents using repo-memory. These patterns reduce token usage and improve investigation efficiency.

## First-Visit Pattern

When encountering a new codebase for the first time, start with the structural overview before diving into individual files.

**Steps:**
1. Call `get_project_map` to get the directory tree, entry points, and language breakdown.
2. Identify entry points and key modules from the map.
3. Call `get_file_summary` for each entry point to understand the top-level architecture.
4. Follow imports from entry points to understand the dependency flow.

**Example flow:**
```
get_project_map { project_root: "/path/to/project" }
  -> identifies src/server.ts as entry point

get_file_summary { path: "src/server.ts" }
  -> sees imports: tools/*, cache/store, indexer/summarizer

get_file_summary { path: "src/cache/store.ts" }
  -> understands cache layer without reading 95 lines of code
```

**Why this works:** Instead of reading every file (potentially thousands of tokens), you get structured summaries of only the files that matter. A typical 200-line file summary is ~50 tokens vs ~800 tokens for the full file.

## Investigation Pattern

When investigating a specific feature or bug, use task memory to track progress and avoid re-exploring files.

**Steps:**
1. Call `create_task` with a descriptive name.
2. Use `get_dependency_graph` to find related files.
3. Call `get_file_summary` for each candidate file.
4. Call `mark_explored` after examining each file, with notes about findings.
5. Call `get_task_context` to see the frontier of unexplored files.
6. Repeat until the investigation is complete.

**Example flow:**
```
create_task { name: "fix cache invalidation bug" }
  -> task_id: "abc-123"

get_dependency_graph { path: "src/cache/invalidation.ts", direction: "dependents" }
  -> finds src/cache/store.ts, src/tools/invalidate.ts depend on it

get_file_summary { path: "src/cache/invalidation.ts" }
  -> read summary, understand the module

mark_explored {
  task_id: "abc-123",
  path: "src/cache/invalidation.ts",
  status: "flagged",
  notes: "Possible race condition in batch invalidation"
}

get_task_context { task_id: "abc-123" }
  -> shows explored files and remaining frontier
```

**Why this works:** Task memory persists across conversation turns. If the conversation is interrupted or the context window fills up, the agent can resume by checking `get_task_context` to see what has already been explored.

## Change Awareness Pattern

At the start of each conversation turn (or after a user makes edits), check what has changed before doing any work.

**Steps:**
1. Call `get_changed_files` to detect modifications.
2. Only call `get_file_summary` for files that actually changed.
3. Skip unchanged files -- their cached summaries are still valid.

**Example flow:**
```
get_changed_files {}
  -> changed: ["src/cache/store.ts"], added: [], deleted: []

get_file_summary { path: "src/cache/store.ts" }
  -> fresh summary generated (hash changed)

# No need to re-read src/server.ts, src/types.ts, etc.
```

**Why this works:** In a typical development session, only 1-5 files change between turns. Checking hashes is fast and avoids re-reading the 95% of files that did not change.

## When to Bypass the Cache

The cache is optimized for token savings, but sometimes you need the full file content. Watch for these signals:

### `suggestFullRead` flag

When `get_file_summary` returns `suggestFullRead: true`, the summary confidence is low. This happens when:
- The file has unusual syntax or structure
- The regex-based summarizer could not extract meaningful information
- The file is not a standard TypeScript/JavaScript module

In these cases, read the full file directly instead of relying on the summary.

### `force_reread` for critical files

Use `force_reread` when:
- You are about to modify a file and need guaranteed-fresh data
- The user reports that a file's summary seems wrong
- You suspect the cache may be stale (e.g., external tools modified files)

```
force_reread { path: "src/cache/store.ts" }
  -> always reads from disk, never returns cached data
```

### When to read the full file

Even with a valid cache, read the full file when:
- You need to see exact implementation details (not just exports/imports)
- You need to understand control flow or logic within functions
- You are writing code that must match the exact style/patterns of the file
- The summary alone is insufficient for the task at hand

## Token Budget Management

Use `get_token_report` to monitor and prove cache efficiency.

**When to check:**
- At the end of a session, to report savings to the user
- When the conversation is getting long, to identify files being accessed repeatedly
- When deciding whether to read a file fully vs. relying on the summary

**Example flow:**
```
get_token_report { period: "session", session_id: "current-session" }
  -> cacheHitRatio: 0.85
  -> estimatedTokensSaved: 120000
  -> topFiles: shows which files are accessed most
```

**Interpreting the report:**
- **High hit ratio (> 0.8):** Cache is working well. Most files are being served from cache.
- **Low hit ratio (< 0.5):** Many files are being read for the first time, or files are changing frequently. This is normal early in a session.
- **Top files with high access counts:** These are hotspot files. Consider reading them fully once and relying on the summary for subsequent accesses.

## Pattern Combinations

The patterns above work best in combination:

1. **New session:** Change Awareness -> First-Visit (for new files) -> Investigation
2. **Continuing work:** Change Awareness -> get_task_context (resume) -> Investigation
3. **Code review:** Change Awareness -> get_file_summary for each changed file -> get_dependency_graph to check impact
4. **Refactoring:** First-Visit -> Investigation (identify all usage sites) -> Change Awareness (verify changes)
