import type { FileSummary } from '../types.js';

const TS_JS_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);

const PYTHON_EXTENSIONS = new Set(['.py']);

const GO_EXTENSIONS = new Set(['.go']);

const RUST_EXTENSIONS = new Set(['.rs']);

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
  const dir = filePath.replace(/\\/g, '/');

  if (ext === '.d.ts') return 'types';
  if (/\.(?:test|spec)\.[tj]sx?$/.test(basename)) return 'test';
  if (/\.config\.[tj]sx?$/.test(basename) || /\.config\.mjs$/.test(basename)) return 'config';
  if (basename === 'types.ts' || basename === 'interfaces.ts') return 'types';
  if (basename === 'index.ts' || basename === 'index.js') return 'entry point';

  // Python-specific
  if (ext === '.py') {
    if (basename.startsWith('test_') || basename.endsWith('_test.py')) return 'test';
    if (dir.includes('/tests/') || dir.includes('/test/')) return 'test';
    if (basename === 'conftest.py') return 'test';
    if (basename === 'setup.py' || basename === 'settings.py' || basename === 'config.py') return 'config';
    if (basename === '__init__.py') return 'entry point';
    if (basename === '__main__.py') return 'entry point';
    if (/\bif\s+__name__\s*==\s*['"]__main__['"]\s*:/.test(contents)) return 'entry point';
    return 'source';
  }

  // Go-specific
  if (ext === '.go') {
    if (basename.endsWith('_test.go')) return 'test';
    if (basename === 'main.go' || /\bfunc\s+main\s*\(/.test(contents)) return 'entry point';
    return 'source';
  }

  // Rust-specific
  if (ext === '.rs') {
    if (dir.includes('/tests/') || basename.startsWith('test_')) return 'test';
    if (basename === 'main.rs') return 'entry point';
    if (basename === 'lib.rs') return 'entry point';
    if (basename === 'mod.rs') return 'entry point';
    if (basename === 'build.rs') return 'config';
    if (/\bfn\s+main\s*\(/.test(contents)) return 'entry point';
    return 'source';
  }

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

// Python extraction helpers
function extractPyExports(contents: string): string[] {
  // Python doesn't have exports per se, but top-level defs/classes are the public API
  const results: string[] = [];
  const re = /^(?:async\s+)?(?:def|class)\s+(\w+)/gm;
  let match: RegExpExecArray | null;
  while ((match = re.exec(contents)) !== null) {
    // Skip private names (leading underscore)
    if (!match[1].startsWith('_')) {
      results.push(match[1]);
    }
  }
  // __all__ defines explicit exports
  const allMatch = contents.match(/__all__\s*=\s*\[([^\]]*)\]/);
  if (allMatch) {
    const names = allMatch[1]
      .split(',')
      .map((s) => s.trim().replace(/['"]/g, ''))
      .filter(Boolean);
    return [...new Set(names)];
  }
  return [...new Set(results)];
}

function extractPyImports(contents: string): string[] {
  const results: string[] = [];
  const fromRe = /^from\s+(\S+)\s+import/gm;
  let match: RegExpExecArray | null;
  while ((match = fromRe.exec(contents)) !== null) {
    results.push(match[1]);
  }
  const importRe = /^import\s+([\w.]+)/gm;
  while ((match = importRe.exec(contents)) !== null) {
    results.push(match[1]);
  }
  return [...new Set(results)];
}

function extractPyDeclarations(contents: string): string[] {
  const results: string[] = [];
  const re = /^(async\s+def|def|class)\s+(\w+)/gm;
  let match: RegExpExecArray | null;
  while ((match = re.exec(contents)) !== null) {
    const kind = match[1] === 'class' ? 'class' : 'def';
    results.push(`${kind} ${match[2]}`);
  }
  return [...new Set(results)];
}

// Go extraction helpers
function extractGoExports(contents: string): string[] {
  // In Go, exported names start with an uppercase letter
  const results: string[] = [];
  const funcRe = /^func\s+(?:\([^)]*\)\s+)?([A-Z]\w*)/gm;
  const typeRe = /^type\s+([A-Z]\w*)\s+(?:struct|interface)/gm;
  const varRe = /^var\s+([A-Z]\w*)/gm;
  const constRe = /^const\s+([A-Z]\w*)/gm;
  let match: RegExpExecArray | null;
  for (const re of [funcRe, typeRe, varRe, constRe]) {
    while ((match = re.exec(contents)) !== null) {
      results.push(match[1]);
    }
  }
  return [...new Set(results)];
}

function extractGoImports(contents: string): string[] {
  const results: string[] = [];
  // Grouped imports
  const groupRe = /\bimport\s*\(([\s\S]*?)\)/g;
  let match: RegExpExecArray | null;
  while ((match = groupRe.exec(contents)) !== null) {
    const lineRe = /"([^"]+)"/g;
    let lineMatch: RegExpExecArray | null;
    while ((lineMatch = lineRe.exec(match[1])) !== null) {
      results.push(lineMatch[1]);
    }
  }
  // Single imports
  const singleRe = /\bimport\s+(?:\w+\s+)?"([^"]+)"/g;
  while ((match = singleRe.exec(contents)) !== null) {
    if (!results.includes(match[1])) {
      results.push(match[1]);
    }
  }
  return [...new Set(results)];
}

function extractGoDeclarations(contents: string): string[] {
  const results: string[] = [];
  const re = /^(?:func\s+(?:\([^)]*\)\s+)?(\w+)|type\s+(\w+)\s+(struct|interface)|var\s+(\w+)|const\s+(\w+))/gm;
  let match: RegExpExecArray | null;
  while ((match = re.exec(contents)) !== null) {
    if (match[1]) results.push(`func ${match[1]}`);
    else if (match[2] && match[3]) results.push(`type ${match[2]} ${match[3]}`);
    else if (match[4]) results.push(`var ${match[4]}`);
    else if (match[5]) results.push(`const ${match[5]}`);
  }
  return [...new Set(results)];
}

// Rust extraction helpers
function extractRustExports(contents: string): string[] {
  // Public items are exports in Rust
  const results: string[] = [];
  const re = /^pub\s+(?:async\s+)?(?:fn|struct|enum|trait|type|const|static|mod)\s+(\w+)/gm;
  let match: RegExpExecArray | null;
  while ((match = re.exec(contents)) !== null) {
    results.push(match[1]);
  }
  return [...new Set(results)];
}

function extractRustImports(contents: string): string[] {
  const results: string[] = [];
  const useRe = /^(?:pub\s+)?use\s+([\w:]+(?:::\{[^}]*\})?)\s*;/gm;
  let match: RegExpExecArray | null;
  while ((match = useRe.exec(contents)) !== null) {
    results.push(match[1]);
  }
  const modRe = /^\s*mod\s+(\w+)\s*;/gm;
  while ((match = modRe.exec(contents)) !== null) {
    results.push(match[1]);
  }
  return [...new Set(results)];
}

function extractRustDeclarations(contents: string): string[] {
  const results: string[] = [];
  const re = /^(?:pub\s+)?(?:async\s+)?(fn|struct|enum|trait|impl|type|const|static|mod)\s+(\w+)/gm;
  let match: RegExpExecArray | null;
  while ((match = re.exec(contents)) !== null) {
    results.push(`${match[1]} ${match[2]}`);
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

  // Python files
  if (PYTHON_EXTENSIONS.has(ext)) {
    const exports = extractPyExports(contents);
    const imports = extractPyImports(contents);
    const topLevelDeclarations = extractPyDeclarations(contents);
    const purpose = classifyPurpose(filePath, contents, ext);
    const confidence = calculateConfidence(purpose, exports, imports, topLevelDeclarations, lineCount);
    return { purpose, exports, imports, lineCount, topLevelDeclarations, confidence };
  }

  // Go files
  if (GO_EXTENSIONS.has(ext)) {
    const exports = extractGoExports(contents);
    const imports = extractGoImports(contents);
    const topLevelDeclarations = extractGoDeclarations(contents);
    const purpose = classifyPurpose(filePath, contents, ext);
    const confidence = calculateConfidence(purpose, exports, imports, topLevelDeclarations, lineCount);
    return { purpose, exports, imports, lineCount, topLevelDeclarations, confidence };
  }

  // Rust files
  if (RUST_EXTENSIONS.has(ext)) {
    const exports = extractRustExports(contents);
    const imports = extractRustImports(contents);
    const topLevelDeclarations = extractRustDeclarations(contents);
    const purpose = classifyPurpose(filePath, contents, ext);
    const confidence = calculateConfidence(purpose, exports, imports, topLevelDeclarations, lineCount);
    return { purpose, exports, imports, lineCount, topLevelDeclarations, confidence };
  }

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
