import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { hashContents } from '../cache/hash.js';
import { CacheStore } from '../cache/store.js';
import { summarizeFile } from '../indexer/summarizer.js';
import type { FileSummary } from '../types.js';
import { validatePath } from '../utils/validate-path.js';

export async function forceReread(
  projectRoot: string,
  relativePath: string,
): Promise<{ path: string; hash: string; summary: FileSummary; reread: true; reason: string }> {
  relativePath = validatePath(projectRoot, relativePath);
  const absolutePath = join(projectRoot, relativePath);
  const contents = await readFile(absolutePath, 'utf-8');
  const hash = hashContents(contents);
  const summary = summarizeFile(relativePath, contents);

  const store = new CacheStore(projectRoot);
  store.setEntry(relativePath, hash, summary);

  return { path: relativePath, hash, summary, reread: true, reason: 'force_reread: explicitly requested' };
}
