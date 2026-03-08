/**
 * Token estimation utilities for telemetry tracking.
 *
 * Uses the widely-accepted heuristic of ~4 characters per token for English
 * text and code. This matches OpenAI's documentation and empirical analysis
 * across major LLM tokenizers (cl100k_base, o200k_base).
 *
 * For cache hit savings, we calculate:
 *   tokensAvoided = rawFileTokens - summaryTokens
 *
 * This represents the tokens the agent would have consumed reading the full
 * file, minus the (much smaller) summary that was served instead.
 */

import type { FileSummary } from '../types.js';

const CHARS_PER_TOKEN = 4;

/** Estimate token count from a string's character length. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/** Estimate tokens saved by serving a summary instead of raw file contents. */
export function estimateTokensSaved(rawContents: string, summary: FileSummary): number {
  const rawTokens = estimateTokens(rawContents);
  const summaryTokens = estimateTokens(JSON.stringify(summary));
  return Math.max(0, rawTokens - summaryTokens);
}
