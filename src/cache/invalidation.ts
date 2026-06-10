import { join, relative } from 'node:path';
import { hashFile } from './hash.js';
import type { CacheStore } from './store.js';
import { toPosix } from '../utils/posix-path.js';

export class CacheInvalidator {
  private readonly projectRoot: string;
  private readonly store: CacheStore;

  constructor(projectRoot: string, store: CacheStore) {
    this.projectRoot = projectRoot;
    this.store = store;
  }

  /**
   * Hash the file at `absolutePath` and compare to the stored hash.
   * Returns whether the cached entry is still valid and the current hash.
   */
  async validateEntry(
    absolutePath: string,
  ): Promise<{ valid: boolean; currentHash: string | null }> {
    const currentHash = await hashFile(absolutePath);
    // Stored cache keys are POSIX-normalized project-relative paths; derive
    // the key the same way on every platform (the old slice-and-strip-'/'
    // left a leading backslash on Windows, so lookups always missed).
    const relativePath = absolutePath.startsWith(this.projectRoot)
      ? toPosix(relative(this.projectRoot, absolutePath))
      : toPosix(absolutePath);

    const entry = this.store.getEntry(relativePath);

    if (currentHash === null || entry === null) {
      return { valid: false, currentHash };
    }

    return { valid: entry.hash === currentHash, currentHash };
  }

  /**
   * Delete the cache entry for the given relative path.
   */
  invalidate(relativePath: string): void {
    this.store.deleteEntry(relativePath);
  }

  /**
   * Delete all cache entries in one atomic statement — entries written by a
   * concurrent process cannot slip through the way they could with a
   * snapshot-then-delete loop.
   */
  invalidateAll(): void {
    this.store.deleteAllEntries();
  }

  /**
   * Given a list of relative paths, return those whose current hash
   * differs from the cached hash. Includes new files (no cache entry)
   * and deleted files (hash is null).
   */
  async findChangedFiles(trackedPaths: string[]): Promise<string[]> {
    const changed: string[] = [];

    for (const relativePath of trackedPaths) {
      const absolutePath = join(this.projectRoot, relativePath);
      const currentHash = await hashFile(absolutePath);
      const entry = this.store.getEntry(relativePath);

      if (entry === null || currentHash === null || entry.hash !== currentHash) {
        changed.push(relativePath);
      }
    }

    return changed;
  }
}
