# Relevance Ranking — Signals and Algorithm

Design spike for ranking files by relevance to an agent's current context, so retrieval tools surface the most useful files first.

## Approach: Weighted Scoring with Configurable Signals

Each candidate file receives a composite score:

```
relevanceScore(file, context) = Σ(weight_i × signal_i)
```

Every signal is normalized to `[0, 1]`. Files are returned sorted by score descending.

### Context Object

```ts
interface RankingContext {
  taskId?: string;       // current task — enables task-proximity signal
  queryFile?: string;    // file the agent is currently viewing
  searchTerms?: string;  // free-text keywords for name/path matching
}
```

## Signals

Listed in priority order with default weights (sum = 1.0).

| # | Signal | Weight | Source | Normalization |
|---|--------|--------|--------|---------------|
| 1 | **Task proximity** | 0.35 | Files imported by, or importing, files already explored in the current task (`task_explored_files`) | 1.0 if directly connected, 0.5 if two hops, 0.0 otherwise |
| 2 | **Dependency proximity** | 0.25 | Shortest path in the dependency graph from `queryFile` or working set | `1 / (1 + distance)` — closer files score higher |
| 3 | **Recency** | 0.15 | `mtime` of the file on disk (or `last_accessed` from task memory) | Linear decay: most recent file = 1.0, oldest = 0.0 |
| 4 | **File type** | 0.10 | Extension / purpose classification from file summaries | source = 1.0, types = 0.8, config = 0.6, test = 0.4, docs = 0.2, assets = 0.0 |
| 5 | **Change frequency** | 0.10 | `git log --format='' --follow <file> | wc -l` (cached) | Percentile rank among all project files |
| 6 | **Name/path match** | 0.05 | Simple substring / token overlap against `searchTerms` | Jaccard similarity of path tokens vs. query tokens |

Weights are configurable at the call site so agents can boost signals that matter for their current task (e.g. boost recency during debugging, boost dependency proximity during refactoring).

## Integration

### New Module

`src/cache/ranking.ts`

```ts
interface RankedFile {
  path: string;
  score: number;
  signals: Record<string, number>; // per-signal breakdown for debugging
}

function rankFiles(
  files: string[],
  context: RankingContext,
  projectRoot: string,
  weights?: Partial<Record<string, number>>
): RankedFile[];
```

### New MCP Tool

`get_relevant_files` — returns the top-N most relevant files for a given context.

```
get_relevant_files(context: RankingContext, limit?: number)
  -> { files: RankedFile[] }
```

Default `limit`: 20.

### Existing Tool Enhancement

Add an optional `ranked: boolean` parameter to `get_project_map`. When true, the file list is sorted by relevance score instead of alphabetically.

## Data Dependencies

| Signal | Requires |
|--------|----------|
| Task proximity | task memory tables (`tasks`, `task_explored_files`) + dependency graph |
| Dependency proximity | dependency graph (`file_dependencies`) |
| Recency | `fs.stat` or task memory `last_accessed` |
| File type | file summaries (`purpose` field) or extension heuristic |
| Change frequency | git history (cache in SQLite, refresh on scan) |
| Name/path match | no additional storage |

All dependencies already exist or are trivially derivable. No new tables required — change frequency can be stored as a column on `file_summaries`.

## Evaluation

A good ranking means the agent reads top-ranked files early instead of scanning broadly. To validate:

1. **Offline**: replay real agent sessions. For each task, compare the ranked order against the files the agent actually opened. Measure precision\@k (k = 5, 10, 20).
2. **Online**: log which files are returned by `get_relevant_files` and which the agent subsequently reads. Track hit rate over time.
3. **Baseline**: compare against alphabetical order and recency-only sorting to confirm the composite score adds value.

Target: precision\@10 >= 0.6 (at least 6 of the top 10 ranked files are ones the agent would have read).
