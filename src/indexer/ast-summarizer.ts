import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Parser, Language, type Node } from 'web-tree-sitter';
import { summarizeFile } from './summarizer.js';
import type { FileSummary } from '../types.js';

/**
 * AST-based summarizer for TypeScript/JavaScript using web-tree-sitter (WASM).
 *
 * Same contract as `summarizeFile` in summarizer.ts, but exports/imports/
 * declarations come from a real parse tree instead of line-anchored regexes,
 * and `purpose` is a template-generated semantic one-liner derived from the
 * dominant symbols (class/function names, method counts, JSDoc first lines).
 *
 * Unsupported extensions and files that fail to parse fall back to the regex
 * summarizer, so this is a strict superset in coverage.
 */

type GrammarName = 'typescript' | 'tsx' | 'javascript';

const EXT_TO_GRAMMAR: Record<string, GrammarName> = {
  '.ts': 'typescript',
  '.mts': 'typescript',
  '.cts': 'typescript',
  '.d.ts': 'typescript',
  '.tsx': 'tsx',
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
};

const MAX_PURPOSE_LENGTH = 160;

const require = createRequire(import.meta.url);
const moduleDir = dirname(fileURLToPath(import.meta.url));

/**
 * Locate a grammar's .wasm file. Vendored grammars in `dist/grammars/`
 * (copied by `scripts/copy-grammars.mjs` at build time) take precedence, so
 * the published package works without `tree-sitter-wasms` installed. In dev
 * and under vitest the code runs from `src/`, where no vendored copy exists,
 * so we fall back to resolving the `tree-sitter-wasms` devDependency.
 */
function resolveGrammarWasm(grammar: GrammarName): string {
  const vendored = join(moduleDir, '..', 'grammars', `tree-sitter-${grammar}.wasm`);
  if (existsSync(vendored)) return vendored;
  return require.resolve(`tree-sitter-wasms/out/tree-sitter-${grammar}.wasm`);
}

let initPromise: Promise<void> | null = null;
let runtimeBroken = false;
const languageCache = new Map<GrammarName, Promise<Language>>();
const parserCache = new Map<GrammarName, Parser>();

function getExtension(filePath: string): string {
  if (filePath.endsWith('.d.ts')) return '.d.ts';
  const dot = filePath.lastIndexOf('.');
  return dot === -1 ? '' : filePath.slice(dot);
}

function getBasename(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/');
  const slash = normalized.lastIndexOf('/');
  return slash === -1 ? normalized : normalized.slice(slash + 1);
}

async function getParser(grammar: GrammarName): Promise<Parser> {
  if (!initPromise) {
    initPromise = Parser.init();
  }
  await initPromise;

  const cached = parserCache.get(grammar);
  if (cached) return cached;

  let languagePromise = languageCache.get(grammar);
  if (!languagePromise) {
    languagePromise = Language.load(resolveGrammarWasm(grammar));
    languageCache.set(grammar, languagePromise);
  }

  const language = await languagePromise;
  const parser = new Parser();
  parser.setLanguage(language);
  parserCache.set(grammar, parser);
  return parser;
}

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

interface ClassInfo {
  name: string;
  methodCount: number;
  doc: string | null;
  exported: boolean;
}

interface FunctionInfo {
  name: string;
  doc: string | null;
  exported: boolean;
}

interface ExtractionResult {
  exports: string[];
  imports: string[];
  topLevelDeclarations: string[];
  classes: ClassInfo[];
  functions: FunctionInfo[];
  typeNames: string[];
  constNames: string[];
  fileDoc: string | null;
}

function stripQuotes(text: string): string {
  return text.replace(/^['"`]|['"`]$/g, '');
}

/** First meaningful line of a comment, with `/**`, `*` and `//` markers removed. */
function commentFirstLine(text: string): string | null {
  const cleaned = text
    .replace(/^\/\*+/, '')
    .replace(/\*+\/$/, '');
  for (const rawLine of cleaned.split('\n')) {
    const line = rawLine.replace(/^\s*(?:\*|\/\/)?\s*/, '').trim();
    if (line.length > 0 && !line.startsWith('@') && !line.startsWith('eslint')) {
      // Keep only the first sentence so multi-sentence doc lines stay short.
      const sentenceEnd = line.indexOf('. ');
      return sentenceEnd === -1 ? line : line.slice(0, sentenceEnd + 1);
    }
  }
  return null;
}

/** JSDoc-style block comment immediately preceding `node` at the same level. */
function precedingDoc(node: Node): string | null {
  const prev = node.previousNamedSibling;
  if (prev && prev.type === 'comment' && prev.text.startsWith('/**')) {
    return commentFirstLine(prev.text);
  }
  return null;
}

function countMethods(classNode: Node): number {
  const body = classNode.childForFieldName('body');
  if (!body) return 0;
  let count = 0;
  for (const child of body.namedChildren) {
    if (!child) continue;
    if (child.type === 'method_definition' || child.type === 'abstract_method_signature') {
      const name = child.childForFieldName('name')?.text;
      if (name !== 'constructor') count++;
    }
  }
  return count;
}

function hasDefaultKeyword(exportStatement: Node): boolean {
  return exportStatement.children.some((c) => c !== null && c.type === 'default');
}

/** Handles one top-level declaration node; doc comes from the outermost statement. */
function collectDeclaration(node: Node, exported: boolean, doc: string | null, out: ExtractionResult): void {
  switch (node.type) {
    case 'lexical_declaration':
    case 'variable_declaration': {
      const kindNode = node.children.find(
        (c) => c !== null && (c.type === 'const' || c.type === 'let' || c.type === 'var'),
      );
      const kind = kindNode?.text ?? 'const';
      for (const declarator of node.namedChildren) {
        if (!declarator || declarator.type !== 'variable_declarator') continue;
        const nameNode = declarator.childForFieldName('name');
        if (!nameNode || nameNode.type !== 'identifier') continue;
        const name = nameNode.text;
        out.topLevelDeclarations.push(`${kind} ${name}`);
        if (kind === 'const') out.constNames.push(name);
        if (exported) out.exports.push(name);
      }
      break;
    }
    case 'function_declaration':
    case 'generator_function_declaration': {
      const name = node.childForFieldName('name')?.text;
      if (name) {
        out.topLevelDeclarations.push(`function ${name}`);
        out.functions.push({ name, doc, exported });
        if (exported) out.exports.push(name);
      }
      break;
    }
    case 'class_declaration':
    case 'abstract_class_declaration': {
      const name = node.childForFieldName('name')?.text;
      if (name) {
        out.topLevelDeclarations.push(`class ${name}`);
        out.classes.push({ name, methodCount: countMethods(node), doc, exported });
        if (exported) out.exports.push(name);
      }
      break;
    }
    case 'interface_declaration': {
      const name = node.childForFieldName('name')?.text;
      if (name) {
        out.topLevelDeclarations.push(`interface ${name}`);
        out.typeNames.push(name);
        if (exported) out.exports.push(name);
      }
      break;
    }
    case 'type_alias_declaration': {
      const name = node.childForFieldName('name')?.text;
      if (name) {
        out.topLevelDeclarations.push(`type ${name}`);
        out.typeNames.push(name);
        if (exported) out.exports.push(name);
      }
      break;
    }
    case 'enum_declaration': {
      const name = node.childForFieldName('name')?.text;
      if (name) {
        out.topLevelDeclarations.push(`enum ${name}`);
        out.typeNames.push(name);
        if (exported) out.exports.push(name);
      }
      break;
    }
    case 'ambient_declaration': {
      // `declare const x: number;` — recurse into the inner declaration.
      for (const inner of node.namedChildren) {
        if (inner) collectDeclaration(inner, exported, doc, out);
      }
      break;
    }
    default:
      break;
  }
}

function collectExportStatement(node: Node, out: ExtractionResult): void {
  const doc = precedingDoc(node);
  const source = node.childForFieldName('source');
  if (source) {
    // Re-export: `export { a, b as c } from './x.js'` / `export * from './x.js'`.
    out.imports.push(stripQuotes(source.text));
  }

  const declaration = node.childForFieldName('declaration');
  if (declaration) {
    collectDeclaration(declaration, true, doc, out);
    if (hasDefaultKeyword(node)) out.exports.push('default');
    return;
  }

  const value = node.childForFieldName('value');
  if (value) {
    // `export default <expression>;`
    out.exports.push('default');
    return;
  }

  for (const child of node.namedChildren) {
    if (!child) continue;
    if (child.type === 'export_clause') {
      for (const spec of child.namedChildren) {
        if (!spec || spec.type !== 'export_specifier') continue;
        const alias = spec.childForFieldName('alias')?.text;
        const name = spec.childForFieldName('name')?.text;
        const visible = alias ?? name;
        if (visible) out.exports.push(visible);
      }
    } else if (child.type === 'namespace_export') {
      // `export * as ns from './x.js'`
      const name = child.namedChildren.find((c) => c !== null)?.text;
      if (name) out.exports.push(name);
    }
  }
}

function extract(root: Node): ExtractionResult {
  const out: ExtractionResult = {
    exports: [],
    imports: [],
    topLevelDeclarations: [],
    classes: [],
    functions: [],
    typeNames: [],
    constNames: [],
    fileDoc: null,
  };

  let seenCode = false;
  for (const child of root.namedChildren) {
    if (!child) continue;
    switch (child.type) {
      case 'comment':
        if (!seenCode && out.fileDoc === null) {
          out.fileDoc = commentFirstLine(child.text);
        }
        break;
      case 'import_statement': {
        seenCode = true;
        const source = child.childForFieldName('source');
        if (source) out.imports.push(stripQuotes(source.text));
        break;
      }
      case 'export_statement':
        seenCode = true;
        collectExportStatement(child, out);
        break;
      default:
        seenCode = true;
        collectDeclaration(child, false, precedingDoc(child), out);
        break;
    }
  }

  out.exports = [...new Set(out.exports)];
  out.imports = [...new Set(out.imports)];
  out.topLevelDeclarations = [...new Set(out.topLevelDeclarations)];
  return out;
}

// ---------------------------------------------------------------------------
// Purpose line generation
// ---------------------------------------------------------------------------

function fileCategory(filePath: string): string | null {
  const basename = getBasename(filePath);
  if (filePath.endsWith('.d.ts')) return 'types';
  if (/\.(?:test|spec)\.[tj]sx?$/.test(basename)) return 'test';
  if (/\.config\.[tj]sx?$/.test(basename) || /\.config\.mjs$/.test(basename)) return 'config';
  if (basename === 'types.ts' || basename === 'interfaces.ts') return 'types';
  if (/^index\.[tj]sx?$/.test(basename)) return 'entry point';
  return null;
}

function listNames(names: string[], max: number): string {
  if (names.length <= max) return names.join(', ');
  return `${names.slice(0, max).join(', ')} (+${names.length - max} more)`;
}

function buildPurpose(filePath: string, contents: string, info: ExtractionResult): string {
  let category = fileCategory(filePath);
  // Executable entry points: shebang line or a top-level main() function.
  if (
    category === null &&
    (contents.startsWith('#!') || info.functions.some((f) => f.name === 'main'))
  ) {
    category = 'entry point';
  }
  let detail: string;

  const exportedClasses = info.classes.filter((c) => c.exported);
  const classes = exportedClasses.length > 0 ? exportedClasses : info.classes;
  const exportedFns = info.functions.filter((f) => f.exported);
  const fns = exportedFns.length > 0 ? exportedFns : info.functions;

  if (classes.length > 0) {
    const primary = [...classes].sort((a, b) => b.methodCount - a.methodCount)[0];
    const desc = primary.doc ?? info.fileDoc;
    const head = `class ${primary.name} (${primary.methodCount} method${primary.methodCount === 1 ? '' : 's'})`;
    const rest = classes.filter((c) => c !== primary).map((c) => c.name);
    const suffix = rest.length > 0 ? ` +${listNames(rest, 2)}` : '';
    detail = desc ? `${head}${suffix}: ${desc}` : `${head}${suffix}`;
  } else if (fns.length > 0) {
    const desc = fns[0].doc ?? info.fileDoc;
    const head =
      fns.length === 1
        ? `function ${fns[0].name}`
        : `functions: ${listNames(
            fns.map((f) => f.name),
            3,
          )}`;
    detail = desc ? `${head} — ${desc}` : head;
  } else if (info.typeNames.length > 0) {
    const head = `types: ${listNames(info.typeNames, 4)}`;
    detail = info.fileDoc ? `${head} — ${info.fileDoc}` : head;
  } else if (info.constNames.length > 0) {
    const head = `constants: ${listNames(info.constNames, 4)}`;
    detail = info.fileDoc ? `${head} — ${info.fileDoc}` : head;
  } else if (info.fileDoc) {
    detail = info.fileDoc;
  } else {
    detail = 'source';
  }

  // Avoid "types: types: ..." when the detail already leads with the category.
  let purpose = category && !detail.startsWith(category) ? `${category}: ${detail}` : detail;
  if (purpose.length > MAX_PURPOSE_LENGTH) {
    purpose = `${purpose.slice(0, MAX_PURPOSE_LENGTH - 1)}…`;
  }
  return purpose;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Summarize a TS/JS file from its syntax tree. Falls back to the regex
 * summarizer for unsupported extensions, empty files, parse errors, or when
 * the WASM runtime cannot be loaded.
 */
export async function summarizeFileAst(filePath: string, contents: string): Promise<FileSummary> {
  const grammar = EXT_TO_GRAMMAR[getExtension(filePath)];
  if (!grammar || runtimeBroken || contents.trim() === '') {
    return summarizeFile(filePath, contents);
  }

  let parser: Parser;
  try {
    parser = await getParser(grammar);
  } catch {
    // WASM runtime or grammar failed to load; don't retry per file.
    runtimeBroken = true;
    return summarizeFile(filePath, contents);
  }

  const tree = parser.parse(contents);
  if (!tree) return summarizeFile(filePath, contents);

  try {
    if (tree.rootNode.hasError) {
      return summarizeFile(filePath, contents);
    }

    const info = extract(tree.rootNode);
    return {
      purpose: buildPurpose(filePath, contents, info),
      exports: info.exports,
      imports: info.imports,
      lineCount: contents.split('\n').length,
      topLevelDeclarations: info.topLevelDeclarations,
      confidence: 'high',
    };
  } finally {
    tree.delete();
  }
}

/** True when the AST summarizer handles this file natively (vs regex fallback). */
export function isAstSupported(filePath: string): boolean {
  return getExtension(filePath) in EXT_TO_GRAMMAR;
}
