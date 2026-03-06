import type { FileSummary } from '../types.js';

const TS_JS_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);

const CONFIG_EXTENSIONS = new Set(['.json', '.yaml', '.yml', '.toml']);

const EXPORT_PATTERN =
  /^export\s+(?:default\s+)?(?:const|let|var|function\s*\*?|class|interface|type|enum|abstract\s+class)\s+(\w+)/gm;

const DEFAULT_EXPORT_PATTERN = /^export\s+default\s+/gm;

const IMPORT_FROM_PATTERN = /^import\s+.*?\s+from\s+['"]([^'"]+)['"]/gm;

const IMPORT_SIDE_EFFECT_PATTERN = /^import\s+['"]([^'"]+)['"]/gm;

const TOP_LEVEL_DECLARATION_PATTERN =
  /^(?:export\s+)?(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?(const|let|var|function\s*\*?|class|interface|type|enum)\s+(\w+)/gm;

function getExtension(filePath: string): string {
  if (filePath.endsWith('.d.ts')) return '.d.ts';
  const dot = filePath.lastIndexOf('.');
  return dot === -1 ? '' : filePath.slice(dot);
}

function getBasename(filePath: string): string {
  const slash = filePath.lastIndexOf('/');
  return slash === -1 ? filePath : filePath.slice(slash + 1);
}

function classifyPurpose(filePath: string, contents: string, ext: string): string {
  const basename = getBasename(filePath);

  if (ext === '.d.ts') return 'types';
  if (/\.(?:test|spec)\.[tj]sx?$/.test(basename)) return 'test';
  if (/\.config\.[tj]sx?$/.test(basename) || /\.config\.mjs$/.test(basename)) return 'config';
  if (basename === 'types.ts' || basename === 'interfaces.ts') return 'types';
  if (basename === 'index.ts' || basename === 'index.js') return 'entry point';

  const dir = filePath.replace(/\\/g, '/');
  if (dir.includes('/bin/') || dir.endsWith('/bin')) return 'entry point';
  if (/\bmain\s*\(/.test(contents)) return 'entry point';

  return 'source';
}

function classifyNonCodePurpose(ext: string): string {
  switch (ext) {
    case '.json':
      return 'config';
    case '.md':
      return 'documentation';
    case '.yml':
    case '.yaml':
      return 'config';
    case '.css':
    case '.scss':
    case '.less':
      return 'styles';
    case '.html':
      return 'markup';
    case '.svg':
    case '.png':
    case '.jpg':
    case '.jpeg':
    case '.gif':
      return 'asset';
    case '.sh':
    case '.bash':
      return 'script';
    case '.env':
      return 'config';
    case '.lock':
      return 'lockfile';
    default:
      return 'other';
  }
}

function extractMatches(contents: string, pattern: RegExp, group: number): string[] {
  const results: string[] = [];
  const re = new RegExp(pattern.source, pattern.flags);
  let match: RegExpExecArray | null;
  while ((match = re.exec(contents)) !== null) {
    results.push(match[group]);
  }
  return results;
}

function extractExports(contents: string): string[] {
  const named = extractMatches(contents, EXPORT_PATTERN, 1);
  const defaults = extractMatches(contents, DEFAULT_EXPORT_PATTERN, 0);
  const hasDefault = defaults.some(
    (d) => !EXPORT_PATTERN.test(d.trimEnd()),
  );
  if (hasDefault && !named.includes('default')) {
    named.push('default');
  }
  return [...new Set(named)];
}

function extractImports(contents: string): string[] {
  const fromImports = extractMatches(contents, IMPORT_FROM_PATTERN, 1);
  const sideEffects = extractMatches(contents, IMPORT_SIDE_EFFECT_PATTERN, 1);
  return [...new Set([...fromImports, ...sideEffects])];
}

function extractTopLevelDeclarations(contents: string): string[] {
  const results: string[] = [];
  const re = new RegExp(TOP_LEVEL_DECLARATION_PATTERN.source, TOP_LEVEL_DECLARATION_PATTERN.flags);
  let match: RegExpExecArray | null;
  while ((match = re.exec(contents)) !== null) {
    const kind = match[1].replace(/\s*\*$/, '').trim();
    const name = match[2];
    results.push(`${kind} ${name}`);
  }
  return [...new Set(results)];
}

const CLEAR_PURPOSES = new Set(['entry point', 'config', 'types', 'test']);

function calculateConfidence(
  purpose: string,
  exports: string[],
  imports: string[],
  declarations: string[],
  lineCount: number,
): 'high' | 'medium' | 'low' {
  if (lineCount === 0) return 'low';
  if (exports.length === 0 && imports.length === 0 && declarations.length === 0) return 'low';
  if (exports.length > 0 || CLEAR_PURPOSES.has(purpose)) return 'high';
  return 'medium';
}

export function summarizeFile(filePath: string, contents: string): FileSummary {
  const ext = getExtension(filePath);
  const lineCount = contents === '' ? 0 : contents.split('\n').length;

  if (!TS_JS_EXTENSIONS.has(ext) && ext !== '.d.ts') {
    const confidence: 'high' | 'medium' | 'low' = lineCount === 0
      ? 'low'
      : CONFIG_EXTENSIONS.has(ext)
        ? 'medium'
        : 'low';
    return {
      purpose: classifyNonCodePurpose(ext),
      exports: [],
      imports: [],
      lineCount,
      topLevelDeclarations: [],
      confidence,
    };
  }

  const exports = extractExports(contents);
  const imports = extractImports(contents);
  const topLevelDeclarations = extractTopLevelDeclarations(contents);
  const purpose = classifyPurpose(filePath, contents, ext);
  const confidence = calculateConfidence(purpose, exports, imports, topLevelDeclarations, lineCount);

  return {
    purpose,
    exports,
    imports,
    lineCount,
    topLevelDeclarations,
    confidence,
  };
}
