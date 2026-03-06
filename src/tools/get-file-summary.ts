import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { hashContents } from '../cache/hash.js';
import { CacheStore } from '../cache/store.js';
import { summarizeFile } from '../indexer/summarizer.js';
import type { FileSummary } from '../types.js';
import { validatePath } from '../utils/validate-path.js';

export async function getFileSummary(
  projectRoot: string,
  relativePath: string,
): Promise<{ path: string; hash: string; summary: FileSummary; fromCache: boolean }> {
  relativePath = validatePath(projectRoot, relativePath);
  const store = new CacheStore(projectRoot);
  const absolutePath = join(projectRoot, relativePath);

  // Read and hash the file
  const contents = await readFile(absolutePath, 'utf-8');
  const currentHash = hashContents(contents);

  // Check cache
  const cached = store.getEntry(relativePath);
  if (cached && cached.hash === currentHash && cached.summary) {
    return { path: relativePath, hash: currentHash, summary: cached.summary, fromCache: true };
  }

  // Generate fresh summary
  const summary = summarizeFile(relativePath, contents);
  store.setEntry(relativePath, currentHash, summary);

  return { path: relativePath, hash: currentHash, summary, fromCache: false };
}
