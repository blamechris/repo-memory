# repo-memory

An MCP server that gives AI coding agents persistent memory about your codebase.

## Why?

AI agents waste tokens re-reading files they've already seen. repo-memory fixes this by:
- **Caching file summaries** -- exports, imports, purpose, line count
- **Tracking changes** -- only re-read files that actually changed (SHA-256 hash comparison)
- **Dependency graphs** -- understand which files depend on which
- **Task memory** -- remember what's been explored across conversation turns
- **Token telemetry** -- measure and prove the savings

## Quick Start

### With Claude Code
Add to your Claude Code MCP settings:
```json
{
  "mcpServers": {
    "repo-memory": {
      "command": "npx",
      "args": ["-y", "repo-memory"]
    }
  }
}
```

### Manual
```bash
npm install -g repo-memory
repo-memory  # starts MCP server on stdio
```

## Tools

| Tool | Description |
|------|-------------|
| `get_file_summary` | Cached file summary (exports, imports, purpose) |
| `get_changed_files` | Files changed since last check |
| `get_project_map` | Structural overview of project |
| `force_reread` | Force fresh summary generation |
| `invalidate` | Clear cache entries |
| `get_dependency_graph` | File dependency relationships |
| `create_task` | Create investigation task |
| `get_task_context` | Task state and explored files |
| `mark_explored` | Mark file as explored for task |
| `get_token_report` | Token usage telemetry report |

## How It Works

1. Files are hashed (SHA-256) on first access
2. Summaries extracted via regex analysis (exports, imports, purpose, declarations)
3. Cached in SQLite (`.repo-memory/cache.db` in your project)
4. Subsequent requests return cached data if hash unchanged
5. ~96% token reduction vs reading full files

## Architecture

```
MCP Server (stdio transport)
├── Cache Engine (hash, store, invalidation, ranking, GC)
├── Indexer Pipeline (scanner, summarizer, imports, diff-analyzer)
├── Dependency Graph (in-memory adjacency maps backed by SQLite)
├── Task Memory (CRUD, exploration tracking, frontier)
├── Telemetry (token tracking, sampling, export)
├── Session Manager (cross-turn persistence)
└── Persistence Layer (SQLite with WAL mode)
```

## Development

```bash
git clone https://github.com/blamechris/repo-memory.git
cd repo-memory
npm install
npm test           # unit tests
npm run test:integration  # integration tests
npm run typecheck  # TypeScript check
npm run lint       # ESLint
npm run build      # compile
```

## License
MIT
