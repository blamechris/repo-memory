#!/usr/bin/env node
/**
 * Copies the tree-sitter grammar .wasm files used by the AST summarizer from
 * the installed `tree-sitter-wasms` package (a devDependency) into
 * `dist/grammars/`, so the published package carries its own grammars and the
 * 49 MB grammar bundle never ships to consumers.
 *
 * Runs as part of `npm run build`. Fails loudly if a grammar is missing.
 */
import { copyFileSync, mkdirSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const GRAMMARS = [
  'tree-sitter-typescript.wasm',
  'tree-sitter-tsx.wasm',
  'tree-sitter-javascript.wasm',
];

const require = createRequire(import.meta.url);
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(repoRoot, 'dist', 'grammars');

mkdirSync(outDir, { recursive: true });

for (const grammar of GRAMMARS) {
  let source;
  try {
    source = require.resolve(`tree-sitter-wasms/out/${grammar}`);
  } catch (err) {
    console.error(
      `copy-grammars: cannot resolve tree-sitter-wasms/out/${grammar}. ` +
        'Is the tree-sitter-wasms devDependency installed?',
    );
    console.error(String(err));
    process.exit(1);
  }
  const dest = join(outDir, grammar);
  copyFileSync(source, dest);
  const { size } = statSync(dest);
  if (size === 0) {
    console.error(`copy-grammars: copied ${grammar} is empty (${source})`);
    process.exit(1);
  }
  const mb = (size / 1024 / 1024).toFixed(1);
  console.log(`copy-grammars: ${grammar} -> dist/grammars/ (${mb} MB)`);
}
