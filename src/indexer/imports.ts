import { statSync } from 'fs';
import { dirname, extname, join, normalize, relative } from 'path';
import type { ImportRef } from '../types.js';
import { toPosix } from '../utils/posix-path.js';

function isRelativeImport(specifier: string): boolean {
  return specifier === '.' || specifier === '..' ||
    specifier.startsWith('./') || specifier.startsWith('../');
}

interface ResolvedTarget {
  target: string;
  external: boolean;
}

function isFile(absPath: string): boolean {
  try {
    return statSync(absPath).isFile();
  } catch {
    return false;
  }
}

/** Extensions probed when a specifier has no extension (TS first — most likely in source). */
const JS_PROBE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'];

/** ESM specifiers reference output extensions; map them back to source extensions. */
const JS_EXTENSION_SWAPS: Record<string, string[]> = {
  '.js': ['.ts', '.tsx'],
  '.jsx': ['.tsx'],
  '.mjs': ['.mts'],
  '.cjs': ['.cts'],
};

/**
 * Probe the filesystem for the real file behind a JS/TS specifier base path:
 * exact match, extension swaps (.js → .ts/.tsx, …), appended extensions, and
 * directory index files. Returns the absolute path of the match, or null.
 */
function probeJsTs(absBase: string): string | null {
  if (isFile(absBase)) return absBase;

  const ext = extname(absBase);
  const swaps = JS_EXTENSION_SWAPS[ext];
  if (swaps) {
    const stem = absBase.slice(0, -ext.length);
    for (const swap of swaps) {
      if (isFile(stem + swap)) return stem + swap;
    }
  }

  if (!ext) {
    for (const probeExt of JS_PROBE_EXTENSIONS) {
      if (isFile(absBase + probeExt)) return absBase + probeExt;
    }
  }

  // Directory import: <dir>/index.{ts,tsx,...}
  for (const probeExt of JS_PROBE_EXTENSIONS) {
    const candidate = join(absBase, 'index' + probeExt);
    if (isFile(candidate)) return candidate;
  }

  return null;
}

/** Probe for a Python module file: foo.py or foo/__init__.py. */
function probePython(absBase: string): string | null {
  if (isFile(absBase)) return absBase;
  if (isFile(absBase + '.py')) return absBase + '.py';
  const initFile = join(absBase, '__init__.py');
  if (isFile(initFile)) return initFile;
  return null;
}

/** Probe for a Rust module file: foo.rs or foo/mod.rs. */
function probeRust(absBase: string): string | null {
  if (isFile(absBase)) return absBase;
  if (isFile(absBase + '.rs')) return absBase + '.rs';
  const modFile = join(absBase, 'mod.rs');
  if (isFile(modFile)) return modFile;
  return null;
}

/**
 * Resolve a relative specifier against the importing file's directory and
 * probe the filesystem for the real file. Unresolvable specifiers keep the
 * normalized project-relative path but are tagged external.
 */
function resolveRelative(
  importSpecifier: string,
  filePath: string,
  projectRoot: string,
  probe: (absBase: string) => string | null,
): ResolvedTarget {
  const fileDir = dirname(join(projectRoot, filePath));
  const resolvedAbs = normalize(join(fileDir, importSpecifier));
  const found = probe(resolvedAbs);
  if (found) {
    return { target: toPosix(relative(projectRoot, found)), external: false };
  }
  return { target: toPosix(relative(projectRoot, resolvedAbs)), external: true };
}

function resolveTarget(
  importSpecifier: string,
  filePath: string,
  projectRoot: string,
): ResolvedTarget {
  if (!isRelativeImport(importSpecifier)) {
    // Bare specifier: package, builtin, or alias — external by definition.
    return { target: importSpecifier, external: true };
  }
  return resolveRelative(importSpecifier, filePath, projectRoot, probeJsTs);
}

function makeRef(
  source: string,
  resolved: ResolvedTarget,
  specifiers: string[],
  type: ImportRef['type'],
): ImportRef {
  const ref: ImportRef = { source, target: resolved.target, specifiers, type };
  if (resolved.external) ref.external = true;
  return ref;
}

/** Resolve an absolute (non-relative) Python module path against the project root. */
function resolvePythonModule(modulePath: string, projectRoot: string): ResolvedTarget {
  const found = probePython(join(projectRoot, modulePath));
  if (found) {
    return { target: toPosix(relative(projectRoot, found)), external: false };
  }
  return { target: modulePath, external: true };
}

/** Resolve a Rust crate:: module path against the project root (and conventional src/). */
function resolveRustModule(modulePath: string, projectRoot: string): ResolvedTarget {
  const direct = probeRust(join(projectRoot, modulePath));
  if (direct) {
    return { target: toPosix(relative(projectRoot, direct)), external: false };
  }
  const inSrc = probeRust(join(projectRoot, 'src', modulePath));
  if (inSrc) {
    return { target: toPosix(relative(projectRoot, inSrc)), external: false };
  }
  return { target: modulePath, external: true };
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
    results.push(
      makeRef(source, resolveTarget(match[2], filePath, projectRoot), specifiers, 'static'),
    );
  }

  // Default imports: import Foo from './module'
  const defaultImportRe =
    /import\s+([A-Za-z_$][\w$]*)\s+from\s+['"]([^'"]+)['"]/g;
  while ((match = defaultImportRe.exec(contents)) !== null) {
    // Skip if this is a type import or already caught by named/namespace
    const fullMatch = match[0];
    if (fullMatch.includes('{') || fullMatch.includes('*')) continue;
    results.push(
      makeRef(source, resolveTarget(match[2], filePath, projectRoot), [match[1]], 'static'),
    );
  }

  // Namespace imports: import * as Foo from './module'
  const namespaceImportRe =
    /import\s+\*\s+as\s+([A-Za-z_$][\w$]*)\s+from\s+['"]([^'"]+)['"]/g;
  while ((match = namespaceImportRe.exec(contents)) !== null) {
    results.push(
      makeRef(
        source,
        resolveTarget(match[2], filePath, projectRoot),
        [`* as ${match[1]}`],
        'static',
      ),
    );
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
    results.push(makeRef(source, resolveTarget(match[1], filePath, projectRoot), [], 'static'));
  }

  // Dynamic imports: import('./module')
  const dynamicImportRe = /import\(\s*['"]([^'"]+)['"]\s*\)/g;
  while ((match = dynamicImportRe.exec(contents)) !== null) {
    results.push(makeRef(source, resolveTarget(match[1], filePath, projectRoot), [], 'dynamic'));
  }

  // Re-exports: export { Foo } from './module'
  const reExportNamedRe =
    /export\s+\{([^}]*)\}\s+from\s+['"]([^'"]+)['"]/g;
  while ((match = reExportNamedRe.exec(contents)) !== null) {
    const specifiers = match[1]
      .split(',')
      .map((s) => s.trim().split(/\s+as\s+/)[0].trim())
      .filter(Boolean);
    results.push(
      makeRef(source, resolveTarget(match[2], filePath, projectRoot), specifiers, 're-export'),
    );
  }

  // Re-exports: export * from './module'
  const reExportAllRe = /export\s+\*\s+from\s+['"]([^'"]+)['"]/g;
  while ((match = reExportAllRe.exec(contents)) !== null) {
    results.push(
      makeRef(source, resolveTarget(match[1], filePath, projectRoot), ['*'], 're-export'),
    );
  }

  // require() calls
  const requireRe = /require\(\s*['"]([^'"]+)['"]\s*\)/g;
  while ((match = requireRe.exec(contents)) !== null) {
    results.push(makeRef(source, resolveTarget(match[1], filePath, projectRoot), [], 'static'));
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
      const resolved = resolvePythonModule(mod.replace(/\./g, '/'), projectRoot);
      results.push(makeRef(source, resolved, [], 'static'));
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
    let resolved: ResolvedTarget;
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
      // Trim trailing slash but ensure we have at least './' for resolveRelative
      const cleaned = fullSpecifier.endsWith('/') ? fullSpecifier.slice(0, -1) : fullSpecifier;
      resolved = resolveRelative(cleaned || './', filePath, projectRoot, probePython);
    } else {
      resolved = resolvePythonModule(fromModule.replace(/\./g, '/'), projectRoot);
    }

    results.push(makeRef(source, resolved, specifiers, 'static'));
  }

  return results;
}

// ────────────────────────────────────────────────────────────────────────────
// Go parser
// ────────────────────────────────────────────────────────────────────────────

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

    // Go import paths are package paths, not file paths — treated as external.
    results.push({
      source,
      target: match[2],
      specifiers: match[1] ? [match[1]] : [],
      type: 'static',
      external: true,
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
        external: true,
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
    let resolved: ResolvedTarget;
    if (rawTarget.startsWith('crate/')) {
      // crate:: refers to the crate root — resolve relative to project root
      resolved = resolveRustModule(rawTarget.replace(/^crate\//, ''), projectRoot);
    } else if (rawTarget.startsWith('super/')) {
      // super:: means parent module
      const rest = rawTarget.replace(/^(super\/)+/, '');
      const superCount = (rawTarget.match(/super\//g) ?? []).length;
      const relPrefix = '../'.repeat(superCount);
      resolved = resolveRelative(relPrefix + rest, filePath, projectRoot, probeRust);
    } else if (rawTarget.startsWith('self/')) {
      // self:: means current module
      const rest = rawTarget.replace(/^self\//, '');
      resolved = resolveRelative('./' + rest, filePath, projectRoot, probeRust);
    } else {
      // External crate path (std::, serde::, ...)
      resolved = { target: rawTarget, external: true };
    }

    results.push(makeRef(source, resolved, specifiers, 'static'));
  }

  // mod declarations: mod foo; (not mod foo { ... })
  const modRe = /\bmod\s+(\w+)\s*;/g;
  while ((match = modRe.exec(cleaned)) !== null) {
    const modName = match[1];
    // mod foo; declares a submodule — could be foo.rs or foo/mod.rs
    const fileDir = dirname(filePath);
    const base = fileDir === '.' ? modName : fileDir + '/' + modName;
    const found = probeRust(join(projectRoot, base));
    const resolved: ResolvedTarget = found
      ? { target: toPosix(relative(projectRoot, found)), external: false }
      : { target: base, external: true };

    results.push(makeRef(source, resolved, [], 'static'));
  }

  return results;
}

// ────────────────────────────────────────────────────────────────────────────
// Kotlin / Java parsers
// ────────────────────────────────────────────────────────────────────────────

/**
 * Strip C-style comments and string literals (shared by Kotlin and Java) so
 * import regexes don't match inside them. Preserves line structure.
 */
function stripCStyleNonCode(contents: string): string {
  let result = contents;

  // Remove block comments (incl. KDoc/Javadoc)
  result = result.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));

  // Remove triple-quoted (Kotlin raw) strings, then regular strings
  result = result.replace(/"""[\s\S]*?"""/g, (m) => m.replace(/[^\n]/g, ' '));
  result = result.replace(/"(?:[^"\\\n]|\\.)*"/g, (m) => ' '.repeat(m.length));

  // Remove line comments
  result = result.replace(/\/\/.*/g, (m) => ' '.repeat(m.length));

  return result;
}

export function extractKotlinImports(
  filePath: string,
  contents: string,
  _projectRoot: string,
): ImportRef[] {
  const results: ImportRef[] = [];
  const source = filePath;
  const cleaned = stripCStyleNonCode(contents);

  // import a.b.C / import a.b.* / import a.b.C as D (optional semicolon)
  const importRe = /^[ \t]*import\s+([\w.]+?)(\.\*)?(?:\s+as\s+(\w+))?\s*;?\s*$/gm;
  let match: RegExpExecArray | null;
  while ((match = importRe.exec(cleaned)) !== null) {
    // Kotlin import paths are package paths, not file paths — treated as external.
    results.push({
      source,
      target: match[1].replace(/\./g, '/'),
      specifiers: match[2] ? ['*'] : match[3] ? [match[3]] : [],
      type: 'static',
      external: true,
    });
  }

  return results;
}

export function extractJavaImports(
  filePath: string,
  contents: string,
  _projectRoot: string,
): ImportRef[] {
  const results: ImportRef[] = [];
  const source = filePath;
  const cleaned = stripCStyleNonCode(contents);

  // import a.b.C; / import a.b.*; / import static a.b.Type.member;
  const importRe = /^[ \t]*import\s+(static\s+)?([\w.]+?)(\.\*)?\s*;/gm;
  let match: RegExpExecArray | null;
  while ((match = importRe.exec(cleaned)) !== null) {
    const isStatic = Boolean(match[1]);
    const isWildcard = Boolean(match[3]);
    let path = match[2];
    let specifiers: string[] = isWildcard ? ['*'] : [];
    if (isStatic && !isWildcard) {
      // `import static a.b.Type.member` — the file-level target is the type.
      const lastDot = path.lastIndexOf('.');
      if (lastDot !== -1) {
        specifiers = [path.slice(lastDot + 1)];
        path = path.slice(0, lastDot);
      }
    }
    // Java import paths are package paths, not file paths — treated as external.
    results.push({
      source,
      target: path.replace(/\./g, '/'),
      specifiers,
      type: 'static',
      external: true,
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
    case '.kt':
    case '.kts':
      return extractKotlinImports(filePath, contents, projectRoot);
    case '.java':
      return extractJavaImports(filePath, contents, projectRoot);
    default:
      return extractJsTsImports(filePath, contents, projectRoot);
  }
}
