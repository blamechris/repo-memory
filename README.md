# repo-memory

An MCP server that gives AI coding agents persistent memory about your codebase. Stop wasting tokens re-reading files your agent already understands.

## Why?

Every time an AI agent explores your project, it re-reads files from scratch — burning tokens on code it's already seen. On a 200-file project, that's **~43,000 tokens wasted per exploration pass**.

repo-memory fixes this:
- **Caches file summaries** — exports, imports, purpose, declarations, line count
- **Tracks changes** — only re-reads files that actually changed (SHA-256 hash comparison)
- **Dependency graphs** — understands which files depend on which
- **Task memory** — remembers what's been explored across conversation turns
- **Token telemetry** — measures and proves the savings

## Quick Start

### With Claude Code
Add to your Claude Code MCP settings:
```json
{
  "mcpServers": {
    "repo-memory": {
      "command": "npx",
      "args": ["-y", "@blamechris/repo-memory"]
    }
  }
}
```

### Manual
```bash
npm install -g @blamechris/repo-memory
repo-memory  # starts MCP server on stdio
```

## How It Works

### The problem
Your agent wants to understand `src/server.ts`. Normally it reads the whole file — 300 lines, ~800 tokens. But it really just needs: "what does this file export, import, and do?" That answer is ~200 tokens.

### The flow

**First access (cache miss):**
1. Agent calls `get_file_summary("src/server.ts")`
2. repo-memory reads the file, SHA-256 hashes it, extracts a summary via regex (exports, imports, purpose, declarations, line count)
3. Stores the hash + summary in SQLite (`.repo-memory/cache.db` in your project)
4. Returns the compact summary
5. No savings yet — we had to read the file anyway

**Every subsequent access (cache hit):**
1. Agent calls `get_file_summary("src/server.ts")` again
2. repo-memory reads and hashes the file — hash matches what's stored
3. Returns the cached summary instantly, without re-parsing
4. Savings logged: `(full file tokens) - (summary tokens)` = tokens your agent didn't consume

**When files change:**
- The hash won't match, so repo-memory generates a fresh summary automatically
- You never get stale data

The savings compound fast. An agent exploring a project touches the same files 3-5 times per session. First pass costs full price. Every subsequent hit returns a tiny summary instead of the full file — that's where the ~3.6x compression ratio comes from.

## Tools

| Tool | Description |
|------|-------------|
| `get_file_summary` | Cached file summary (exports, imports, purpose) |
| `batch_file_summaries` | Get summaries for multiple files at once |
| `get_changed_files` | Files changed since last check |
| `get_project_map` | Structural overview of project |
| `search_by_purpose` | Search files by purpose/exports keywords |
| `get_related_files` | Find related files ranked by relevance |
| `get_dependency_graph` | File dependency relationships |
| `create_task` / `get_task_context` / `mark_explored` | Track investigation progress across turns |
| `get_token_report` | Token usage and savings report |
| `force_reread` | Force fresh summary generation |
| `invalidate` | Clear cache entries |

## Token Savings Tracking

repo-memory tracks every cache interaction so you can measure exactly how many tokens you're saving. Call `get_token_report` at any time to see your stats.

### What gets tracked

| Event | When | Tokens Recorded |
|-------|------|-----------------|
| `cache_hit` | Summary served from cache (hash unchanged) | Tokens saved (raw file - summary) |
| `cache_miss` | File changed or first access | 0 (no savings on first read) |
| `force_reread` | Explicit re-read requested | Raw file token count |
| `invalidation` | Cache entry cleared | — |
| `summary_served` | File matched via `search_by_purpose` | Estimated raw file tokens |

### How savings are calculated

Token estimates use the standard heuristic of **~4 characters per token**, which closely matches major LLM tokenizers (cl100k_base, o200k_base).

For each cache hit:
```
tokensSaved = ceil(rawFileChars / 4) - ceil(summaryJsonChars / 4)
```

- **rawFileChars** — the full file contents your agent would have consumed
- **summaryJsonChars** — the compact summary served instead (purpose, exports, imports, declarations, line count)

The reported savings represent real tokens that never entered your context window.

### Querying your savings

```
# All-time stats
get_token_report()

# Last 24 hours
get_token_report(period: "last_n_hours", hours: 24)

# Current session only
get_token_report(period: "session", session_id: "<id>")

# With cache health diagnostics
get_token_report(include_diagnostics: true)
```

The report includes:
- **Cache hit ratio** — percentage of requests served from cache
- **Estimated tokens saved** — cumulative tokens your agent didn't consume
- **Top files** — most frequently accessed files and their token impact
- **Event breakdown** — counts by event type

## Performance

Benchmarks measured on synthetic TypeScript projects with realistic imports and class structures:

| Scenario | Files | Raw Size | Summary Size | Compression | Tokens Saved | Speed |
|----------|-------|----------|--------------|-------------|--------------|-------|
| Explore project | 10 | 11.7 KB | 3.3 KB | 3.6x | ~2,100 | 3.7 ms/file |
| Explore project | 50 | 58.0 KB | 16.2 KB | 3.6x | ~10,700 | 0.7 ms/file |
| Explore project | 100 | 116.1 KB | 32.3 KB | 3.6x | ~21,500 | 0.4 ms/file |
| Explore project | 200 | 233.4 KB | 65.7 KB | 3.6x | ~42,900 | 0.3 ms/file |

~3.6x compression ratio at all scales. Sub-millisecond per file on cached reads.

Run benchmarks yourself: `npm run benchmark`

## Architecture

```
MCP Server (stdio transport)
├── Cache Engine (hash, store, invalidation, ranking, GC)
├── Indexer Pipeline (scanner, summarizer, imports, diff-analyzer)
├── Dependency Graph (in-memory adjacency maps backed by SQLite)
├── Task Memory (CRUD, exploration tracking, frontier)
├── Telemetry (token tracking, sampling, export, retention)
├── Session Manager (cross-turn persistence)
└── Persistence Layer (SQLite with WAL mode)
```

## Configuration

Create a `.repo-memory.json` in your project root to customize behavior:

```json
{
  "ignore": ["dist", "node_modules", "*.generated.ts"],
  "maxFiles": 5000,
  "gc": {
    "cacheMaxAgeDays": 30
  }
}
```

## Language Support

Summaries are extracted via regex analysis. Supported languages:
- **TypeScript / JavaScript** — exports, imports, declarations, purpose classification
- **Python** — functions, classes, `__all__`, `from`/`import` statements
- **Go** — exported names (uppercase), imports, type/func/var/const declarations
- **Rust** — `pub` items, `use`/`mod` statements, structs/enums/traits/impls

Config files (JSON, YAML, TOML) and other file types get basic classification.

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
