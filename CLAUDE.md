# Claude Development Notes -- repo-memory

## Project Overview

**repo-memory** is an MCP (Model Context Protocol) server that maintains persistent, structured memory about a codebase. It reduces token waste and repeated repo scanning by caching file summaries, tracking changes, and providing intelligent retrieval for agentic coding workflows.

- **Tech:** TypeScript, Node.js 20+, MCP SDK, SQLite (better-sqlite3)
- **Repo:** blamechris/repo-memory
- **Main branch:** main
- **License:** MIT

## Architecture

```
MCP Server Layer (stdio transport)
  -> Cache Engine (hash, store, invalidation)
  -> Indexer Pipeline (scanner, summarizer, imports)
  -> Task Memory (V2)
  -> Dependency Graph (V2)
  -> Telemetry (V3)
  -> Persistence Layer (SQLite)
```

Storage location: `.repo-memory/cache.db` in the target project root.

## Key Commands

```bash
npm run build        # Compile TypeScript
npm run typecheck    # Type check without emitting
npm test             # Run unit tests (vitest)
npm run test:integration  # Run integration tests
npm run test:coverage     # Run tests with coverage
npm run lint         # ESLint
npm run format       # Prettier
```

## Code Conventions

- TypeScript strict mode, ES2022 target, NodeNext modules
- ESM only (`"type": "module"` in package.json)
- Single quotes, trailing commas, 100 char line width
- No `console.log` in production code (use structured logging via MCP)
- Cache correctness over cache performance — never return stale data
- Deterministic file hashing (SHA-256)

## Git Workflow

- `main` branch, PR-based development
- Commit format: `type(scope): description`
- Types: feat, fix, refactor, test, docs, chore
- Scopes: server, cache, indexer, memory, graph, telemetry, infra
- No force pushes to main

## Testing

- vitest for unit and integration tests
- Tests in `tests/unit/` and `tests/integration/`
- Fixtures in `tests/fixtures/`
- Benchmarks in `tests/benchmarks/`
- All PRs must pass typecheck + lint + test + build

## Project Structure

```
src/
  server.ts           # MCP server entry point
  types.ts            # Shared type definitions
  tools/              # MCP tool handlers
  cache/              # Hash, store, invalidation
  indexer/            # Scanner, summarizer, imports
  persistence/        # SQLite connection, schema, migrations
  graph/              # Dependency graph (V2)
  memory/             # Task memory (V2)
  telemetry/          # Token tracking (V3)
```
