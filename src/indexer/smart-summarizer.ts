import type { FileSummary } from '../types.js';
import { analyzeDiff } from './diff-analyzer.js';
import { summarizeFile } from './summarizer.js';

export function smartSummarize(
  filePath: string,
  contents: string,
  oldSummary: FileSummary | null,
  projectRoot: string,
): { summary: FileSummary; source: 'full' | 'diff-partial' } {
  if (!oldSummary) {
    return {
      summary: summarizeFile(filePath, contents),
      source: 'full',
    };
  }

  const analysis = analyzeDiff(filePath, projectRoot);

  if (analysis.structural) {
    return {
      summary: summarizeFile(filePath, contents),
      source: 'full',
    };
  }

  const lineCount = contents === '' ? 0 : contents.split('\n').length;

  return {
    summary: {
      ...oldSummary,
      lineCount,
    },
    source: 'diff-partial',
  };
}
