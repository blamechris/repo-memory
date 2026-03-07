import { getFileSummary, type FileSummaryResult } from './get-file-summary.js';
import { validatePath } from '../utils/validate-path.js';

export interface BatchFileSummariesResult {
  results: FileSummaryResult[];
  totalFiles: number;
  cacheHits: number;
  cacheMisses: number;
  errors: Array<{ path: string; error: string }>;
}

export async function batchFileSummaries(
  projectRoot: string,
  paths: string[],
): Promise<BatchFileSummariesResult> {
  const results: FileSummaryResult[] = [];
  const errors: Array<{ path: string; error: string }> = [];
  let cacheHits = 0;
  let cacheMisses = 0;

  for (const rawPath of paths) {
    try {
      const validPath = validatePath(projectRoot, rawPath);
      const result = await getFileSummary(projectRoot, validPath);
      results.push(result);
      if (result.fromCache) cacheHits++;
      else cacheMisses++;
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push({ path: rawPath, error: message });
    }
  }

  return { results, totalFiles: paths.length, cacheHits, cacheMisses, errors };
}
