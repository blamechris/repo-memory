import { getDatabase } from '../persistence/db.js';
import { extractImports } from '../indexer/imports.js';

export class DependencyGraph {
  private readonly projectRoot: string;
  private outgoing: Map<string, Set<string>>; // source → targets
  private incoming: Map<string, Set<string>>; // target → sources

  constructor(projectRoot: string) {
    this.projectRoot = projectRoot;
    this.outgoing = new Map();
    this.incoming = new Map();
  }

  /** Load graph from SQLite imports table into memory. */
  load(): void {
    const db = getDatabase(this.projectRoot);
    const rows = db
      .prepare('SELECT source, target FROM imports')
      .all() as Array<{ source: string; target: string }>;

    this.outgoing.clear();
    this.incoming.clear();

    for (const row of rows) {
      this.addEdge(row.source, row.target);
    }
  }

  /** Update edges for a single file (incremental). */
  updateFile(filePath: string, contents: string): void {
    const db = getDatabase(this.projectRoot);

    // Remove old outgoing edges from in-memory maps
    const oldTargets = this.outgoing.get(filePath);
    if (oldTargets) {
      for (const target of oldTargets) {
        const sources = this.incoming.get(target);
        if (sources) {
          sources.delete(filePath);
          if (sources.size === 0) {
            this.incoming.delete(target);
          }
        }
      }
      this.outgoing.delete(filePath);
    }

    // Delete old rows from DB
    db.prepare('DELETE FROM imports WHERE source = ?').run(filePath);

    // Extract new imports
    const imports = extractImports(filePath, contents, this.projectRoot);

    // Insert new rows and update in-memory maps
    const insert = db.prepare(
      'INSERT OR REPLACE INTO imports (source, target, specifiers, import_type) VALUES (?, ?, ?, ?)',
    );

    const insertAll = db.transaction(() => {
      for (const ref of imports) {
        insert.run(ref.source, ref.target, JSON.stringify(ref.specifiers), ref.type);
        this.addEdge(ref.source, ref.target);
      }
    });

    insertAll();
  }

  /** Get direct dependencies of a file. */
  getDependencies(path: string): string[] {
    const targets = this.outgoing.get(path);
    return targets ? [...targets] : [];
  }

  /** Get direct dependents of a file. */
  getDependents(path: string): string[] {
    const sources = this.incoming.get(path);
    return sources ? [...sources] : [];
  }

  /** Get transitive dependencies using BFS with optional depth limit. */
  getTransitiveDependencies(path: string, maxDepth?: number): string[] {
    return this.bfs(path, this.outgoing, maxDepth);
  }

  /** Get transitive dependents using BFS with optional depth limit. */
  getTransitiveDependents(path: string, maxDepth?: number): string[] {
    return this.bfs(path, this.incoming, maxDepth);
  }

  /** Get the most connected nodes sorted by total degree (in + out). */
  getMostConnected(limit: number = 10): Array<{ path: string; connections: number }> {
    const allNodes = new Set<string>();
    for (const key of this.outgoing.keys()) allNodes.add(key);
    for (const key of this.incoming.keys()) allNodes.add(key);

    const result: Array<{ path: string; connections: number }> = [];
    for (const node of allNodes) {
      const outDegree = this.outgoing.get(node)?.size ?? 0;
      const inDegree = this.incoming.get(node)?.size ?? 0;
      result.push({ path: node, connections: outDegree + inDegree });
    }

    result.sort((a, b) => b.connections - a.connections);
    return result.slice(0, limit);
  }

  private addEdge(source: string, target: string): void {
    let targets = this.outgoing.get(source);
    if (!targets) {
      targets = new Set();
      this.outgoing.set(source, targets);
    }
    targets.add(target);

    let sources = this.incoming.get(target);
    if (!sources) {
      sources = new Set();
      this.incoming.set(target, sources);
    }
    sources.add(source);
  }

  private bfs(
    start: string,
    adjacency: Map<string, Set<string>>,
    maxDepth?: number,
  ): string[] {
    const visited = new Set<string>();
    const queue: Array<{ node: string; depth: number }> = [];

    const neighbors = adjacency.get(start);
    if (!neighbors) return [];

    for (const neighbor of neighbors) {
      queue.push({ node: neighbor, depth: 1 });
    }

    while (queue.length > 0) {
      const { node, depth } = queue.shift()!;
      if (visited.has(node) || node === start) continue;
      visited.add(node);

      if (maxDepth !== undefined && depth >= maxDepth) continue;

      const next = adjacency.get(node);
      if (next) {
        for (const n of next) {
          if (!visited.has(n) && n !== start) {
            queue.push({ node: n, depth: depth + 1 });
          }
        }
      }
    }

    return [...visited];
  }
}
