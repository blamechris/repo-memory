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

    // Extract new imports
    const imports = extractImports(filePath, contents, this.projectRoot);

    const insert = db.prepare(
      'INSERT OR REPLACE INTO imports (source, target, specifiers, import_type) VALUES (?, ?, ?, ?)',
    );

    // Delete + insert in ONE transaction so concurrent readers never observe a
    // torn state where the file's old edges are gone but the new ones are not
    // yet written (audit invariant I2).
    const replaceAll = db.transaction(() => {
      db.prepare('DELETE FROM imports WHERE source = ?').run(filePath);
      for (const ref of imports) {
        // External targets (bare modules, builtins, unresolvable paths) are not
        // repo files — persisting them would pollute traversal and mostConnected.
        if (ref.external) continue;
        insert.run(ref.source, ref.target, JSON.stringify(ref.specifiers), ref.type);
        this.addEdge(ref.source, ref.target);
      }
    });

    replaceAll();
  }

  /**
   * Remove a file from the graph entirely: every persisted edge where it is
   * the source or the target, plus the in-memory adjacency for both
   * directions. Used when a file no longer exists on disk.
   */
  removeFile(filePath: string): void {
    const db = getDatabase(this.projectRoot);
    const remove = db.transaction(() => {
      db.prepare('DELETE FROM imports WHERE source = ?').run(filePath);
      db.prepare('DELETE FROM imports WHERE target = ?').run(filePath);
    });
    remove();
    this.removeNode(filePath);
  }

  /**
   * Remove every graph node (and its edges, in both directions) that is not
   * in the given set of existing files. Call after load() so the in-memory
   * maps reflect the persisted state.
   */
  prune(existingFiles: ReadonlySet<string>): void {
    const missing = new Set<string>();
    for (const node of this.outgoing.keys()) {
      if (!existingFiles.has(node)) missing.add(node);
    }
    for (const node of this.incoming.keys()) {
      if (!existingFiles.has(node)) missing.add(node);
    }
    for (const node of missing) {
      this.removeFile(node);
    }
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

  /** Get edges where specifiers contain the given symbol. */
  getEdgesBySymbol(symbol: string, sourcePath?: string): Array<{ source: string; target: string; specifiers: string[] }> {
    const db = getDatabase(this.projectRoot);
    let rows: Array<{ source: string; target: string; specifiers: string }>;

    if (sourcePath) {
      rows = db
        .prepare('SELECT source, target, specifiers FROM imports WHERE (source = ? OR target = ?)')
        .all(sourcePath, sourcePath) as Array<{ source: string; target: string; specifiers: string }>;
    } else {
      rows = db
        .prepare('SELECT source, target, specifiers FROM imports')
        .all() as Array<{ source: string; target: string; specifiers: string }>;
    }

    const results: Array<{ source: string; target: string; specifiers: string[] }> = [];
    for (const row of rows) {
      const specifiers: string[] = JSON.parse(row.specifiers);
      if (specifiers.includes(symbol)) {
        results.push({ source: row.source, target: row.target, specifiers });
      }
    }
    return results;
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

  /** Drop a node from the in-memory adjacency maps, in both directions. */
  private removeNode(node: string): void {
    const targets = this.outgoing.get(node);
    if (targets) {
      for (const target of targets) {
        const sources = this.incoming.get(target);
        if (sources) {
          sources.delete(node);
          if (sources.size === 0) this.incoming.delete(target);
        }
      }
      this.outgoing.delete(node);
    }

    const sources = this.incoming.get(node);
    if (sources) {
      for (const source of sources) {
        const targets = this.outgoing.get(source);
        if (targets) {
          targets.delete(node);
          if (targets.size === 0) this.outgoing.delete(source);
        }
      }
      this.incoming.delete(node);
    }
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
