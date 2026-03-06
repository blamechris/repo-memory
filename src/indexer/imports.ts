import { dirname, join, normalize, relative } from 'path';
import type { ImportRef } from '../types.js';

function isRelativeImport(specifier: string): boolean {
  return specifier.startsWith('./') || specifier.startsWith('../');
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

export function extractImports(
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
