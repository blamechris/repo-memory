# Dependency Graph — Data Model & Query Patterns

## Storage

SQLite adjacency list in the existing `cache.db`. Each import edge is a row in an `imports` table. On server startup, the full graph is rebuilt in memory from this table for fast traversal.

### Schema (Migration v2)

```sql
CREATE TABLE imports (
  source      TEXT NOT NULL,   -- file that contains the import
  target      TEXT NOT NULL,   -- resolved import target (project-relative path or bare specifier)
  specifiers  TEXT NOT NULL,   -- JSON array of imported names, e.g. '["Foo","Bar"]'
  import_type TEXT NOT NULL,   -- 'static' | 'dynamic' | 're-export'
  PRIMARY KEY (source, target, import_type)
);

CREATE INDEX idx_imports_target ON imports (target);
```

The composite primary key allows a file to import the same target via different mechanisms (e.g. a static import and a re-export) while preventing duplicates.

## Query Patterns

| Function | Description |
|---|---|
| `getDependencies(path)` | Direct outgoing edges (what does this file import?) |
| `getDependents(path)` | Direct incoming edges (what files import this one?) |
| `getTransitiveDependencies(path, maxDepth?)` | BFS/DFS over outgoing edges up to `maxDepth` (default: unbounded) |
| `getTransitiveDependents(path, maxDepth?)` | BFS/DFS over incoming edges up to `maxDepth` (default: unbounded) |
| `getMostConnected(limit)` | Files ranked by in-degree + out-degree; surfaces hub modules |

Direct lookups hit the in-memory adjacency map (two maps: `outgoing` and `incoming`). Transitive queries use iterative BFS with a visited set to handle cycles.

## Update Strategy

**Incremental.** When a file changes (detected by hash mismatch during scan):

1. `DELETE FROM imports WHERE source = ?` — remove stale outgoing edges.
2. Run `extractImports(filePath, contents, projectRoot)` on the new contents.
3. `INSERT INTO imports` for each returned `ImportRef`.
4. Update the in-memory adjacency maps accordingly.

No full rebuild is needed. Bulk initial indexing uses the same per-file path inside a transaction for performance.

## Multi-Language Extensibility

Import extraction is regex-based and per-language. The current `extractImports` handles TypeScript/JavaScript (ESM imports, CJS require, re-exports, dynamic imports). New languages can be supported by:

1. Adding a new extractor function with the same `(filePath, contents, projectRoot) => ImportRef[]` signature.
2. Dispatching on file extension in the scanner.

The storage layer and query patterns are language-agnostic — they operate on `ImportRef` edges regardless of source language.
