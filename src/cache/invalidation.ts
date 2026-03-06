import { join } from 'node:path';
import { hashFile } from './hash.js';
import type { CacheStore } from './store.js';

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
    const relativePath = absolutePath.startsWith(this.projectRoot)
      ? absolutePath.slice(this.projectRoot.length).replace(/^\//, '')
      : absolutePath;

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
   * Delete all cache entries.
   */
  invalidateAll(): void {
    const entries = this.store.getAllEntries();
    for (const entry of entries) {
      this.store.deleteEntry(entry.path);
    }
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
