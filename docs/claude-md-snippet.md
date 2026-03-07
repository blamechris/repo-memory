# Recommended CLAUDE.md Snippet

Copy the section below into your project's `CLAUDE.md` file to teach Claude Code how to use repo-memory effectively.

---

## repo-memory (MCP)

This project has repo-memory configured as an MCP server. Use it to avoid re-reading files and save tokens.

### When starting work
1. Call `get_project_map` to see the project structure, entry points, and file purposes.
2. Call `get_changed_files` to see what changed since last session.
3. Use `batch_file_summaries` to get summaries for a set of related files at once.

### When exploring files
- **Always try `get_file_summary` before reading a file.** It returns exports, imports, purpose, and line count in ~50 tokens vs ~800 for the full file.
- If the summary has `suggestFullRead: true`, the summary is low quality — read the full file instead.
- Use `get_related_files` to find what else to look at when exploring a file.
- Use `search_by_purpose` to find files by concept (e.g., "database", "auth", "validation") instead of grepping.
- Use `get_dependency_graph` to trace imports and find dependents.

### When investigating bugs or features
1. Call `create_task` with a descriptive name.
2. As you explore files, call `mark_explored` with notes about what you found.
3. Call `get_task_context` to see what you've covered and what's left to explore.

### When to read full files
Read the full file (not just the summary) when you need:
- Exact implementation details or control flow
- To write code that must match the file's style
- To see function bodies, not just declarations

### Token efficiency
- Call `get_token_report` at the end of a session to report savings.
- Prefer `batch_file_summaries` over multiple individual `get_file_summary` calls.
- Don't re-read files that haven't changed — the cache handles this automatically.
