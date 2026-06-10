#!/usr/bin/env tsx
/* eslint-disable no-console */
/**
 * Standalone benchmark: AST summarizer vs regex summarizer on this repo's
 * own src/**\/*.ts files.
 * Run with: npx tsx tests/benchmarks/ast-vs-regex.ts
 *
 * Measures:
 *  - one-time WASM startup cost (Parser.init + grammar load)
 *  - per-file summarize time for both engines (warm)
 *  - summary size (JSON chars) for both engines
 *  - accuracy: files where exports/declarations differ between engines
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { summarizeFile } from '../../src/indexer/summarizer.js';
import { summarizeFileAst } from '../../src/indexer/ast-summarizer.js';
import type { FileSummary } from '../../src/types.js';

const WARM_RUNS = 5;

function collectTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...collectTsFiles(full));
    } else if (entry.endsWith('.ts')) {
      out.push(full);
    }
  }
  return out.sort();
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function setDiff(a: string[], b: string[]): string[] {
  const bSet = new Set(b);
  return a.filter((x) => !bSet.has(x));
}

interface FileResult {
  path: string;
  lineCount: number;
  regexMs: number;
  astMs: number;
  regexChars: number;
  astChars: number;
  regex: FileSummary;
  ast: FileSummary;
  exportsAstOnly: string[];
  exportsRegexOnly: string[];
  declsAstOnly: string[];
  declsRegexOnly: string[];
}

async function main(): Promise<void> {
  const root = process.cwd();
  const files = collectTsFiles(join(root, 'src'));
  console.log(`AST vs regex summarizer benchmark — ${files.length} files under src/\n`);

  // Cold start: first AST call pays Parser.init + Language.load.
  const coldStartBegin = performance.now();
  await summarizeFileAst('warmup.ts', 'export const warmup = 1;\n');
  const coldStartMs = performance.now() - coldStartBegin;

  const results: FileResult[] = [];

  for (const absolutePath of files) {
    const relPath = relative(root, absolutePath);
    const contents = readFileSync(absolutePath, 'utf-8');

    const regexTimes: number[] = [];
    const astTimes: number[] = [];
    let regex!: FileSummary;
    let ast!: FileSummary;

    for (let i = 0; i < WARM_RUNS; i++) {
      const r0 = performance.now();
      regex = summarizeFile(relPath, contents);
      regexTimes.push(performance.now() - r0);

      const a0 = performance.now();
      ast = await summarizeFileAst(relPath, contents);
      astTimes.push(performance.now() - a0);
    }

    results.push({
      path: relPath,
      lineCount: regex.lineCount,
      regexMs: median(regexTimes),
      astMs: median(astTimes),
      regexChars: JSON.stringify(regex).length,
      astChars: JSON.stringify(ast).length,
      regex,
      ast,
      exportsAstOnly: setDiff(ast.exports, regex.exports),
      exportsRegexOnly: setDiff(regex.exports, ast.exports),
      declsAstOnly: setDiff(ast.topLevelDeclarations, regex.topLevelDeclarations),
      declsRegexOnly: setDiff(regex.topLevelDeclarations, ast.topLevelDeclarations),
    });
  }

  // --- Speed ---
  const totalRegexMs = results.reduce((s, r) => s + r.regexMs, 0);
  const totalAstMs = results.reduce((s, r) => s + r.astMs, 0);
  const totalLines = results.reduce((s, r) => s + r.lineCount, 0);

  console.log('--- Speed (median of %d warm runs per file) ---', WARM_RUNS);
  console.log(`WASM cold start (init + grammar load + first parse): ${coldStartMs.toFixed(1)} ms (one-time)`);
  console.log(`regex: total ${totalRegexMs.toFixed(2)} ms, avg ${(totalRegexMs / results.length).toFixed(3)} ms/file`);
  console.log(`ast:   total ${totalAstMs.toFixed(2)} ms, avg ${(totalAstMs / results.length).toFixed(3)} ms/file`);
  console.log(`ratio: ast is ${(totalAstMs / totalRegexMs).toFixed(1)}x regex (${totalLines} total lines)`);
  const slowest = [...results].sort((a, b) => b.astMs - a.astMs)[0];
  console.log(`slowest ast file: ${slowest.path} (${slowest.lineCount} lines) ${slowest.astMs.toFixed(2)} ms\n`);

  // --- Size ---
  const totalRegexChars = results.reduce((s, r) => s + r.regexChars, 0);
  const totalAstChars = results.reduce((s, r) => s + r.astChars, 0);
  console.log('--- Summary size (JSON chars) ---');
  console.log(`regex: total ${totalRegexChars}, avg ${Math.round(totalRegexChars / results.length)}/file`);
  console.log(`ast:   total ${totalAstChars}, avg ${Math.round(totalAstChars / results.length)}/file`);
  console.log(`delta: ${(((totalAstChars - totalRegexChars) / totalRegexChars) * 100).toFixed(1)}%\n`);

  // --- Accuracy ---
  const exportDiffs = results.filter(
    (r) => r.exportsAstOnly.length > 0 || r.exportsRegexOnly.length > 0,
  );
  const declDiffs = results.filter(
    (r) => r.declsAstOnly.length > 0 || r.declsRegexOnly.length > 0,
  );
  console.log('--- Accuracy spot-check ---');
  console.log(`files where exports differ:      ${exportDiffs.length}/${results.length}`);
  console.log(`files where declarations differ: ${declDiffs.length}/${results.length}\n`);

  const interesting = [...new Set([...exportDiffs, ...declDiffs])];
  for (const r of interesting) {
    console.log(`  ${r.path}`);
    if (r.exportsAstOnly.length) console.log(`    exports AST-only:   ${r.exportsAstOnly.join(', ')}`);
    if (r.exportsRegexOnly.length) console.log(`    exports regex-only: ${r.exportsRegexOnly.join(', ')}`);
    if (r.declsAstOnly.length) console.log(`    decls AST-only:      ${r.declsAstOnly.join(', ')}`);
    if (r.declsRegexOnly.length) console.log(`    decls regex-only:   ${r.declsRegexOnly.join(', ')}`);
  }

  // --- Purpose examples ---
  console.log('\n--- Purpose lines (before → after) ---');
  for (const r of results) {
    console.log(`  ${r.path}`);
    console.log(`    regex: ${r.regex.purpose}`);
    console.log(`    ast:   ${r.ast.purpose}`);
  }

  // --- Confidence ---
  const astLow = results.filter((r) => r.ast.confidence !== 'high');
  console.log(`\nAST parses with non-high confidence (fell back to regex): ${astLow.length}`);
  for (const r of astLow) console.log(`  ${r.path} (${r.ast.confidence})`);
}

main().catch((err) => {
  console.error('Benchmark failed:', err);
  process.exit(1);
});
