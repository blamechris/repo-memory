# Task Memory Data Model

Design spike for per-investigation context tracking, so agents don't repeat exploration work across turns.

## Task Lifecycle

```
created --> active --> completed --> archived
```

- **created** — task registered but not yet worked on.
- **active** — agent is exploring files for this task.
- **completed** — investigation finished; results retained for reference.
- **archived** — stale; eligible for garbage collection.

Transition to `archived` happens automatically after a configurable inactivity period (default: 7 days with no `updated_at` change).

## Schema

Two tables. Minimal by design — extend later if needed.

```sql
CREATE TABLE tasks (
  id            TEXT PRIMARY KEY,   -- UUID, auto-generated
  name          TEXT NOT NULL,      -- human-readable, required
  state         TEXT NOT NULL DEFAULT 'created',  -- created | active | completed | archived
  created_at    INTEGER NOT NULL,   -- epoch ms
  updated_at    INTEGER NOT NULL,   -- epoch ms, drives auto-archive
  session_id    TEXT,               -- MCP server session that owns the task
  metadata_json TEXT                -- arbitrary JSON blob for extensions
);

CREATE TABLE task_files (
  task_id     TEXT NOT NULL,
  file_path   TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'explored',  -- explored | skipped | flagged
  notes       TEXT,
  explored_at INTEGER NOT NULL,     -- epoch ms
  PRIMARY KEY (task_id, file_path),
  FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
);
```

## Task Identification

- `id` is a UUID, auto-generated on creation.
- `name` is a short human-readable label (required). Agents use this to resume tasks by name across turns.

## Frontier (Computed)

The frontier is the set of files worth exploring next. It is **not stored** — it is computed on read:

```
frontier = imports_of(explored_files) - explored_files - skipped_files
```

This keeps the schema simple and avoids stale frontier data.

## Cross-Turn Persistence

Already handled by the existing SQLite WAL-mode setup. No additional mechanism needed. `session_id` on the task tracks which MCP server session a task belongs to, enabling multi-session awareness without extra infrastructure.

## Garbage Collection

| State | Rule |
|---|---|
| `active` | Never auto-purged. |
| `created` | Auto-archive after 7 days of inactivity. |
| `completed` / `archived` | Purge after 7 days in that state. |

GC runs lazily (on task creation or listing) rather than on a timer — no background threads needed in an MCP server.

The 7-day threshold is configurable via server config.
