import { dirname, join, normalize, relative } from 'path';
import type { ImportRef } from '../types.js';

function isRelativeImport(specifier: string): boolean {
  return specifier === '.' || specifier === '..' ||
    specifier.startsWith('./') || specifier.startsWith('../');
}

function resolveTarget(
  importSpecifier: string,
  filePath: string,
  projectRoot: string,
): string {
  if (!isRelativeImport(importSpecifier)) {
    return importSpecifier;
  }
  const fileDir = dirname(join(projectRoot, filePath));
  const resolved = normalize(join(fileDir, importSpecifier));
  return relative(projectRoot, resolved);
}

function getExtension(filePath: string): string {
  const dot = filePath.lastIndexOf('.');
  return dot === -1 ? '' : filePath.slice(dot);
}

// ────────────────────────────────────────────────────────────────────────────
// JS / TS parser (original)
// ────────────────────────────────────────────────────────────────────────────

function extractJsTsImports(
  filePath: string,
  contents: string,
  projectRoot: string,
): ImportRef[] {
  const results: ImportRef[] = [];
  const source = filePath;

  // Static imports: import { Foo, Bar } from './module'
  const namedImportRe =
    /import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+['"]([^'"]+)['"]/g;
  let match: RegExpExecArray | null;
  while ((match = namedImportRe.exec(contents)) !== null) {
    const specifiers = match[1]
      .split(',')
      .map((s) => s.trim().split(/\s+as\s+/)[0].trim())
      .filter(Boolean);
    results.push({
      source,
      target: resolveTarget(match[2], filePath, projectRoot),
      specifiers,
      type: 'static',
    });
  }

  // Default imports: import Foo from './module'
  const defaultImportRe =
    /import\s+([A-Za-z_$][\w$]*)\s+from\s+['"]([^'"]+)['"]/g;
  while ((match = defaultImportRe.exec(contents)) !== null) {
    // Skip if this is a type import or already caught by named/namespace
    const fullMatch = match[0];
    if (fullMatch.includes('{') || fullMatch.includes('*')) continue;
    results.push({
      source,
      target: resolveTarget(match[2], filePath, projectRoot),
      specifiers: [match[1]],
      type: 'static',
    });
  }

  // Namespace imports: import * as Foo from './module'
  const namespaceImportRe =
    /import\s+\*\s+as\s+([A-Za-z_$][\w$]*)\s+from\s+['"]([^'"]+)['"]/g;
  while ((match = namespaceImportRe.exec(contents)) !== null) {
    results.push({
      source,
      target: resolveTarget(match[2], filePath, projectRoot),
      specifiers: [`* as ${match[1]}`],
      type: 'static',
    });
  }

  // Side-effect imports: import './module'
  const sideEffectRe = /import\s+['"]([^'"]+)['"]/g;
  while ((match = sideEffectRe.exec(contents)) !== null) {
    // Make sure this isn't part of a larger import statement
    // Check that the character before 'import' is not a word char or }
    const beforeIndex = match.index - 1;
    if (beforeIndex >= 0) {
      const before = contents[beforeIndex];
      if (before && /\w/.test(before)) continue;
    }
    // Ensure it's not from-style import (those have "from" before the string)
    const precedingText = contents.slice(Math.max(0, match.index - 5), match.index);
    if (/from\s*$/.test(precedingText)) continue;
    results.push({
      source,
      target: resolveTarget(match[1], filePath, projectRoot),
      specifiers: [],
      type: 'static',
    });
  }

  // Dynamic imports: import('./module')
  const dynamicImportRe = /import\(\s*['"]([^'"]+)['"]\s*\)/g;
  while ((match = dynamicImportRe.exec(contents)) !== null) {
    results.push({
      source,
      target: resolveTarget(match[1], filePath, projectRoot),
      specifiers: [],
      type: 'dynamic',
    });
  }

  // Re-exports: export { Foo } from './module'
  const reExportNamedRe =
    /export\s+\{([^}]*)\}\s+from\s+['"]([^'"]+)['"]/g;
  while ((match = reExportNamedRe.exec(contents)) !== null) {
    const specifiers = match[1]
      .split(',')
      .map((s) => s.trim().split(/\s+as\s+/)[0].trim())
      .filter(Boolean);
    results.push({
      source,
      target: resolveTarget(match[2], filePath, projectRoot),
      specifiers,
      type: 're-export',
    });
  }

  // Re-exports: export * from './module'
  const reExportAllRe = /export\s+\*\s+from\s+['"]([^'"]+)['"]/g;
  while ((match = reExportAllRe.exec(contents)) !== null) {
    results.push({
      source,
      target: resolveTarget(match[1], filePath, projectRoot),
      specifiers: ['*'],
      type: 're-export',
    });
  }

  // require() calls
  const requireRe = /require\(\s*['"]([^'"]+)['"]\s*\)/g;
  while ((match = requireRe.exec(contents)) !== null) {
    results.push({
      source,
      target: resolveTarget(match[1], filePath, projectRoot),
      specifiers: [],
      type: 'static',
    });
  }

  return results;
}

// ────────────────────────────────────────────────────────────────────────────
// Python parser
// ────────────────────────────────────────────────────────────────────────────

/**
 * Strip Python comments and string literals so import regexes don't match
 * inside them. Replaces their content with spaces to preserve line structure.
 */
function stripPythonNonCode(contents: string): string {
  // First strip triple-quoted strings (both """ and '''), then line comments
  let result = contents;

  // Remove triple-quoted strings (greedy-safe with non-greedy match)
  result = result.replace(/"""[\s\S]*?"""/g, (m) => ' '.repeat(m.length));
  result = result.replace(/'''[\s\S]*?'''/g, (m) => ' '.repeat(m.length));

  // Remove single-line strings (to avoid matching import inside strings)
  result = result.replace(/"(?:[^"\\]|\\.)*"/g, (m) => ' '.repeat(m.length));
  result = result.replace(/'(?:[^'\\]|\\.)*'/g, (m) => ' '.repeat(m.length));

  // Remove line comments
  result = result.replace(/#.*/g, (m) => ' '.repeat(m.length));

  return result;
}

export function extractPythonImports(
  filePath: string,
  contents: string,
  projectRoot: string,
): ImportRef[] {
  const results: ImportRef[] = [];
  const source = filePath;
  const cleaned = stripPythonNonCode(contents);

  // "import foo" and "import foo.bar"
  const simpleImportRe = /^import\s+([\w.]+(?:\s*,\s*[\w.]+)*)/gm;
  let match: RegExpExecArray | null;
  while ((match = simpleImportRe.exec(cleaned)) !== null) {
    const modules = match[1].split(',').map((s) => s.trim()).filter(Boolean);
    for (const mod of modules) {
      results.push({
        source,
        target: mod.replace(/\./g, '/'),
        specifiers: [],
        type: 'static',
      });
    }
  }

  // "from foo import bar, baz" and "from . import foo" and "from ..bar import baz"
  const fromImportRe = /^from\s+(\.{0,3}[\w.]*)\s+import\s+(.+)/gm;
  while ((match = fromImportRe.exec(cleaned)) !== null) {
    const fromModule = match[1];
    const importsPart = match[2];

    // Parse specifiers — handle continuation lines and parenthesized imports
    let specStr = importsPart.trim();
    // If it starts with '(', grab until ')'
    if (specStr.startsWith('(')) {
      const parenEnd = cleaned.indexOf(')', match.index + match[0].indexOf('('));
      if (parenEnd !== -1) {
        specStr = cleaned.slice(match.index + match[0].indexOf('(') + 1, parenEnd);
      }
    }

    const specifiers = specStr
      .split(',')
      .map((s) => s.trim().split(/\s+as\s+/)[0].trim())
      .filter((s) => s.length > 0 && s !== '\\');

    // Determine target
    let target: string;
    if (fromModule === '.' || fromModule === '..' || fromModule.startsWith('.')) {
      // Relative import
      const dotCount = fromModule.match(/^\.+/)?.[0].length ?? 0;
      const rest = fromModule.slice(dotCount);
      // Build relative path: '.' = './', '..' = '../', '...' = '../../'
      let relPrefix = './';
      if (dotCount > 1) {
        relPrefix = '../'.repeat(dotCount - 1);
      }
      const modulePath = rest ? rest.replace(/\./g, '/') : '';
      const fullSpecifier = relPrefix + modulePath;
      // Trim trailing slash but ensure we have at least './' for resolveTarget
      const cleaned = fullSpecifier.endsWith('/') ? fullSpecifier.slice(0, -1) : fullSpecifier;
      target = resolveTarget(
        cleaned || './',
        filePath,
        projectRoot,
      );
    } else {
      target = fromModule.replace(/\./g, '/');
    }

    results.push({
      source,
      target,
      specifiers,
      type: 'static',
    });
  }

  return results;
}

// ────────────────────────────────────────────────────────────────────────────
// Go parser
// ────────────────────────────────────────────────────────────────────────────

/**
 * Strip Go comments and string literals.
 */
function stripGoNonCode(contents: string): string {
  let result = contents;

  // Remove block comments
  result = result.replace(/\/\*[\s\S]*?\*\//g, (m) => ' '.repeat(m.length));

  // Remove raw string literals (backtick)
  result = result.replace(/`[^`]*`/g, (m) => ' '.repeat(m.length));

  // Remove regular string literals
  result = result.replace(/"(?:[^"\\]|\\.)*"/g, (m) => {
    // Preserve the quotes for import parsing — only blank out non-import strings
    // Actually, we need the import strings. Let's be smarter: only strip strings
    // that are NOT part of import statements.
    return m;
  });

  // Remove line comments
  result = result.replace(/\/\/.*/g, (m) => ' '.repeat(m.length));

  return result;
}

/**
 * A more targeted approach: strip comments and raw strings, but keep
 * double-quoted strings intact (since Go imports use them).
 * Then verify imports by matching the import keyword context.
 */
function stripGoCommentsOnly(contents: string): string {
  let result = contents;

  // Remove block comments
  result = result.replace(/\/\*[\s\S]*?\*\//g, (m) => {
    // Preserve newlines to keep line structure
    return m.replace(/[^\n]/g, ' ');
  });

  // Remove line comments
  result = result.replace(/\/\/.*/g, (m) => ' '.repeat(m.length));

  // Remove raw string literals
  result = result.replace(/`[^`]*`/g, (m) => m.replace(/[^\n]/g, ' '));

  return result;
}

export function extractGoImports(
  filePath: string,
  contents: string,
  _projectRoot: string,
): ImportRef[] {
  const results: ImportRef[] = [];
  const source = filePath;
  const cleaned = stripGoCommentsOnly(contents);

  // Single import: import "path/to/pkg" or import alias "path/to/pkg"
  const singleImportRe = /\bimport\s+(?:(\w+)\s+)?"([^"]+)"/g;
  let match: RegExpExecArray | null;
  while ((match = singleImportRe.exec(cleaned)) !== null) {
    // Make sure this isn't inside a grouped import (check if we're between parens)
    // Simple heuristic: check if there's an unclosed '(' before this match
    const before = cleaned.slice(0, match.index);
    const lastImportParen = before.lastIndexOf('import');
    if (lastImportParen !== -1) {
      const afterImport = cleaned.slice(lastImportParen, match.index);
      if (afterImport.includes('(') && !afterImport.includes(')')) {
        continue; // Inside grouped import, skip
      }
    }

    results.push({
      source,
      target: match[2],
      specifiers: match[1] ? [match[1]] : [],
      type: 'static',
    });
  }

  // Grouped import: import ( "path/to/pkg" \n alias "other/pkg" )
  const groupedImportRe = /\bimport\s*\(([\s\S]*?)\)/g;
  while ((match = groupedImportRe.exec(cleaned)) !== null) {
    const block = match[1];
    // Match each line in the import block: optional alias then quoted string
    const lineRe = /(?:(\w+)\s+)?"([^"]+)"/g;
    let lineMatch: RegExpExecArray | null;
    while ((lineMatch = lineRe.exec(block)) !== null) {
      results.push({
        source,
        target: lineMatch[2],
        specifiers: lineMatch[1] ? [lineMatch[1]] : [],
        type: 'static',
      });
    }
  }

  return results;
}

// ────────────────────────────────────────────────────────────────────────────
// Rust parser
// ────────────────────────────────────────────────────────────────────────────

/**
 * Strip Rust comments and string literals.
 */
function stripRustNonCode(contents: string): string {
  let result = contents;

  // Remove block comments (Rust supports nested, but a simple approach works for most cases)
  result = result.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));

  // Remove line comments
  result = result.replace(/\/\/.*/g, (m) => ' '.repeat(m.length));

  // Remove raw string literals r#"..."# (simplified — handle r"...", r#"..."#, etc.)
  result = result.replace(/r#+"[\s\S]*?"#+/g, (m) => m.replace(/[^\n]/g, ' '));
  result = result.replace(/r"[^"]*"/g, (m) => ' '.repeat(m.length));

  // Remove regular string literals
  result = result.replace(/"(?:[^"\\]|\\.)*"/g, (m) => ' '.repeat(m.length));

  return result;
}

/**
 * Parse a Rust use-tree to extract specifiers from grouped imports like {bar, baz}.
 * Handles `use foo::{bar, baz};`
 */
function parseRustUseTree(useExpr: string): { target: string; specifiers: string[] } {
  // Check for grouped imports: foo::{bar, baz}
  const groupMatch = useExpr.match(/^(.*?)::?\{([^}]*)\}$/);
  if (groupMatch) {
    const basePath = groupMatch[1].trim();
    const specs = groupMatch[2]
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    return { target: basePath.replace(/::/g, '/'), specifiers: specs };
  }

  // Simple path: foo::bar::baz → target is foo/bar/baz
  return { target: useExpr.replace(/::/g, '/'), specifiers: [] };
}

export function extractRustImports(
  filePath: string,
  contents: string,
  projectRoot: string,
): ImportRef[] {
  const results: ImportRef[] = [];
  const source = filePath;
  const cleaned = stripRustNonCode(contents);

  // use statements: use crate::foo::bar; use super::foo; use self::foo;
  // Also: pub use ...; use foo::{bar, baz};
  const useRe = /\b(?:pub\s+)?use\s+([\w:]+(?:::\{[^}]*\})?)\s*;/g;
  let match: RegExpExecArray | null;
  while ((match = useRe.exec(cleaned)) !== null) {
    const rawUse = match[1].trim();
    const { target: rawTarget, specifiers } = parseRustUseTree(rawUse);

    // Determine if this is relative (crate::, super::, self::)
    let target = rawTarget;
    if (rawTarget.startsWith('crate/')) {
      // crate:: refers to the crate root — resolve relative to project root
      target = rawTarget.replace(/^crate\//, '');
    } else if (rawTarget.startsWith('super/')) {
      // super:: means parent module
      const rest = rawTarget.replace(/^(super\/)+/, '');
      const superCount = (rawTarget.match(/super\//g) ?? []).length;
      const relPrefix = '../'.repeat(superCount);
      target = resolveTarget(relPrefix + rest, filePath, projectRoot);
    } else if (rawTarget.startsWith('self/')) {
      // self:: means current module
      const rest = rawTarget.replace(/^self\//, '');
      target = resolveTarget('./' + rest, filePath, projectRoot);
    }

    results.push({
      source,
      target,
      specifiers,
      type: 'static',
    });
  }

  // mod declarations: mod foo; (not mod foo { ... })
  const modRe = /\bmod\s+(\w+)\s*;/g;
  while ((match = modRe.exec(cleaned)) !== null) {
    const modName = match[1];
    // mod foo; declares a submodule — could be foo.rs or foo/mod.rs
    const fileDir = dirname(filePath);
    const target = fileDir === '.' ? modName : fileDir + '/' + modName;

    results.push({
      source,
      target,
      specifiers: [],
      type: 'static',
    });
  }

  return results;
}

// ────────────────────────────────────────────────────────────────────────────
// Dispatcher
// ────────────────────────────────────────────────────────────────────────────

const JS_TS_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);

export function extractImports(
  filePath: string,
  contents: string,
  projectRoot: string,
): ImportRef[] {
  const ext = getExtension(filePath);

  if (JS_TS_EXTENSIONS.has(ext)) {
    return extractJsTsImports(filePath, contents, projectRoot);
  }

  switch (ext) {
    case '.py':
      return extractPythonImports(filePath, contents, projectRoot);
    case '.go':
      return extractGoImports(filePath, contents, projectRoot);
    case '.rs':
      return extractRustImports(filePath, contents, projectRoot);
    default:
      return extractJsTsImports(filePath, contents, projectRoot);
  }
}
