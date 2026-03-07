# Setting Up repo-memory with Claude Code

## Prerequisites
- Node.js 20+
- Claude Code CLI installed

## Installation

### Option 1: npx (no install needed)
Claude Code can run repo-memory directly via npx. No global install required.

### Option 2: Global install
```bash
npm install -g @blamechris/repo-memory
```

## Configuration

Add repo-memory to your Claude Code MCP settings. You can do this in one of two ways:

### Project-level (recommended)
Create or edit `.claude/settings.json` in your project root:

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

### User-level
Edit `~/.claude/settings.json`:

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

### Using global install
If you installed globally:

```json
{
  "mcpServers": {
    "repo-memory": {
      "command": "repo-memory"
    }
  }
}
```

## Verifying It Works

After adding the configuration, restart Claude Code. You should see repo-memory's tools available:

1. Ask Claude: "What tools do you have from repo-memory?"
2. Claude should list: get_file_summary, get_changed_files, get_project_map, etc.

## Available Tools

Once configured, Claude Code will have access to these tools:

| Tool | What it does | When Claude uses it |
|------|-------------|-------------------|
| `get_file_summary` | Returns cached summary of a file | Instead of reading full files |
| `get_changed_files` | Lists files that changed | When checking what's new |
| `get_project_map` | Shows project structure | When exploring a new project |
| `force_reread` | Forces fresh file read | When cache might be stale |
| `invalidate` | Clears cache | After major changes |
| `get_dependency_graph` | Shows file dependencies | When tracing imports |
| `create_task` | Creates investigation task | When starting deep exploration |
| `get_task_context` | Shows task progress | When resuming investigation |
| `mark_explored` | Marks file as explored | During investigation |
| `get_token_report` | Shows token savings | When reviewing efficiency |

## Storage

repo-memory stores its cache in `.repo-memory/cache.db` in your project root. This is a SQLite database file.

**Recommended**: Add `.repo-memory/` to your `.gitignore`:
```
.repo-memory/
```

## Troubleshooting

### Tools not appearing
- Restart Claude Code after changing settings
- Check that Node.js 20+ is installed: `node --version`
- Try running manually: `npx @blamechris/repo-memory` (should start and wait for input)

### Permission errors
- Ensure the project directory is writable (for .repo-memory/ database)

### Stale cache
- Use `invalidate` tool to clear all cached data
- Or delete `.repo-memory/cache.db` directly
