# Contributing to repo-memory

## Development Setup

### Prerequisites
- Node.js 20+
- npm

### Getting Started
```bash
git clone https://github.com/blamechris/repo-memory.git
cd repo-memory
npm install
```

### Building
```bash
npm run build        # Compile TypeScript to dist/
npm run typecheck    # Type check without emitting files
```

### Running Locally
```bash
npm start            # Runs dist/server.js (must build first)
```

## Testing

Tests use [vitest](https://vitest.dev/) and are organized into unit and integration tests.

```bash
npm test                    # Run unit tests
npm run test:integration    # Run integration tests
npm run test:coverage       # Run tests with coverage report
```

### Test Structure

```
tests/
  unit/               # Unit tests for individual modules
  integration/        # End-to-end MCP flow tests
  fixtures/           # Sample project files used by tests
  benchmarks/         # Performance benchmarks
```

### Writing Tests

- Place unit tests in `tests/unit/<module-name>.test.ts`
- Place integration tests in `tests/integration/`
- Use the fixture project in `tests/fixtures/sample-project/` for file-based tests
- Each test file should be self-contained with its own setup/teardown

## Architecture Overview

```
src/
  server.ts           # MCP server entry point, tool registration
  types.ts            # Shared type definitions (CacheEntry, FileSummary, ImportRef)
  tools/              # MCP tool handlers (one file per tool)
  cache/              # Cache engine
    hash.ts           #   SHA-256 file hashing
    store.ts          #   SQLite-backed cache store
    invalidation.ts   #   Cache invalidation logic
    ranking.ts        #   Access frequency ranking
    gc.ts             #   Garbage collection for stale entries
  indexer/            # File analysis pipeline
    scanner.ts        #   Project file discovery (respects .gitignore)
    summarizer.ts     #   Regex-based file summarization
    smart-summarizer.ts # Enhanced summarization
    imports.ts        #   Import/export extraction
    diff-analyzer.ts  #   Change detection
    project-map.ts    #   Directory tree builder
  persistence/        # Database layer
    db.ts             #   SQLite connection and schema management
  graph/              # Dependency analysis
    dependency-graph.ts # In-memory adjacency maps
  memory/             # Session and task tracking
    session.ts        #   Cross-turn session persistence
    task.ts           #   Investigation task CRUD
  telemetry/          # Usage tracking
    tracker.ts        #   Token savings estimation
  utils/              # Shared utilities
    validate-path.ts  #   Path security validation
```

### Key Design Decisions

- **SQLite with WAL mode:** Enables concurrent reads while writing. Database stored at `.repo-memory/cache.db` in the target project.
- **SHA-256 hashing:** Deterministic file comparison. If the hash has not changed, the cached summary is still valid.
- **Regex-based summarization:** No AST parsing required. Fast extraction of exports, imports, and declarations. Trades some accuracy for speed.
- **ESM only:** The project uses `"type": "module"` and NodeNext module resolution.
- **Cache correctness over performance:** The system never returns stale data. If in doubt, it re-reads the file.

## Code Conventions

- **TypeScript strict mode**, ES2022 target, NodeNext modules
- **Single quotes**, trailing commas, 100 character line width
- **No `console.log`** in production code -- use structured output via MCP responses
- Run `npm run lint` (ESLint) and `npm run format` (Prettier) before committing

## Commit Conventions

Format: `type(scope): description`

**Types:**
- `feat` -- new feature
- `fix` -- bug fix
- `refactor` -- code restructuring without behavior change
- `test` -- adding or updating tests
- `docs` -- documentation changes
- `chore` -- build, CI, dependency updates

**Scopes:**
- `server` -- MCP server and tool registration
- `cache` -- cache engine (hash, store, invalidation, ranking, GC)
- `indexer` -- scanner, summarizer, imports, diff-analyzer
- `memory` -- session and task management
- `graph` -- dependency graph
- `telemetry` -- token tracking
- `infra` -- build, CI, configuration

**Examples:**
```
feat(cache): add LRU eviction to cache store
fix(indexer): handle re-exports in import extraction
test(graph): add cycle detection test cases
docs: add README and usage guide
```

## Pull Request Process

1. Create a feature branch from `main`.
2. Make your changes with appropriate tests.
3. Ensure all checks pass:
   ```bash
   npm run typecheck && npm run lint && npm test && npm run build
   ```
4. Open a PR against `main` using the PR template.
5. PRs require passing CI checks (typecheck + lint + test + build).
6. No force pushes to `main`.

## Reporting Issues

Use GitHub Issues with the provided issue templates. Include:
- Steps to reproduce
- Expected vs. actual behavior
- Node.js version and OS
