import { readFile } from 'node:fs/promises';
import { join } from 'path';
import { CacheStore } from '../cache/store.js';
import { hashContents } from '../cache/hash.js';
import { DependencyGraph } from '../graph/dependency-graph.js';
import { isGraphIndexable } from '../indexer/source-extensions.js';
import { scanProject } from '../indexer/scanner.js';

export interface ChangedFilesResult {
  changed: string[];
  added: string[];
  deleted: string[];
  checkedAt: string;
}

export async function getChangedFiles(
  projectRoot: string,
  since?: string,
): Promise<ChangedFilesResult> {
  const store = new CacheStore(projectRoot);
  const scannedFiles = await scanProject(projectRoot);
  const allEntries = store.getAllEntries();

  const cachedByPath = new Map(allEntries.map((e) => [e.path, e]));
  const scannedSet = new Set(scannedFiles);

  const sinceTimestamp = parseSince(since);

  const changed: string[] = [];
  const added: string[] = [];
  const graph = new DependencyGraph(projectRoot);

  await Promise.all(
    scannedFiles.map(async (relativePath) => {
      const absolutePath = join(projectRoot, relativePath);
      let contents: string;
      try {
        contents = await readFile(absolutePath, 'utf-8');
      } catch {
        return;
      }
      const currentHash = hashContents(contents);

      const cached = cachedByPath.get(relativePath);

      if (!cached) {
        added.push(relativePath);
      } else if (cached.hash !== currentHash) {
        if (sinceTimestamp === null || cached.lastChecked >= sinceTimestamp) {
          changed.push(relativePath);
        }
      }

      // Update the cache entry with current hash and timestamp. A summary may
      // only be stored under the hash it was computed from — when the file
      // changed, store null so the summary regenerates on next access instead
      // of masquerading as a fresh cache hit. Import edges follow the same
      // rule: recording a new hash without re-extracting edges would let the
      // graph serve stale edges as fresh.
      const summaryStillValid = cached !== undefined && cached.hash === currentHash;
      if (!summaryStillValid && isGraphIndexable(relativePath)) {
        graph.updateFile(relativePath, contents);
      }
      store.setEntry(relativePath, currentHash, summaryStillValid ? cached.summary : null);
    }),
  );

  // Files in cache but not in scan are deleted
  const deleted: string[] = [];
  for (const [path, entry] of cachedByPath) {
    if (!scannedSet.has(path)) {
      if (sinceTimestamp === null || entry.lastChecked >= sinceTimestamp) {
        deleted.push(path);
      }
      store.deleteEntry(path);
    }
  }

  changed.sort();
  added.sort();
  deleted.sort();

  return {
    changed,
    added,
    deleted,
    checkedAt: new Date().toISOString(),
  };
}

function parseSince(since: string | undefined): number | null {
  if (!since || since === 'last_check') {
    return null;
  }

  const parsed = Date.parse(since);
  if (!isNaN(parsed)) {
    return parsed;
  }

  return null;
}
