import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Parser, Language, type Node } from 'web-tree-sitter';
import { summarizeFile } from './summarizer.js';
import type { FileSummary } from '../types.js';

/**
 * AST-based summarizer for TypeScript/JavaScript, Python, Go, Rust, Kotlin
 * and Java using web-tree-sitter (WASM).
 *
 * Same contract as `summarizeFile` in summarizer.ts, but exports/imports/
 * declarations come from a real parse tree instead of line-anchored regexes,
 * and `purpose` is a template-generated semantic one-liner derived from the
 * dominant symbols (class/function names, method counts, doc-comment first
 * lines).
 *
 * Unsupported extensions and files that fail to parse fall back to the regex
 * summarizer, so this is a strict superset in coverage.
 */

type GrammarName =
  | 'typescript'
  | 'tsx'
  | 'javascript'
  | 'python'
  | 'go'
  | 'rust'
  | 'kotlin'
  | 'java';

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
  '.py': 'python',
  '.go': 'go',
  '.rs': 'rust',
  '.kt': 'kotlin',
  '.kts': 'kotlin',
  '.java': 'java',
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
  /** Display kind for the purpose line: class, struct, enum, type, … */
  kind: string;
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

function emptyResult(): ExtractionResult {
  return {
    exports: [],
    imports: [],
    topLevelDeclarations: [],
    classes: [],
    functions: [],
    typeNames: [],
    constNames: [],
    fileDoc: null,
  };
}

function dedupeResult(out: ExtractionResult): ExtractionResult {
  out.exports = [...new Set(out.exports)];
  out.imports = [...new Set(out.imports)];
  out.topLevelDeclarations = [...new Set(out.topLevelDeclarations)];
  return out;
}

/** Keep only the first sentence so multi-sentence doc lines stay short. */
function firstSentence(line: string): string {
  const sentenceEnd = line.indexOf('. ');
  return sentenceEnd === -1 ? line : line.slice(0, sentenceEnd + 1);
}

/** First meaningful line of a comment, with `/**`, `*` and `//` markers removed. */
function commentFirstLine(text: string): string | null {
  const cleaned = text
    .replace(/^\/\*+/, '')
    .replace(/\*+\/$/, '');
  for (const rawLine of cleaned.split('\n')) {
    const line = rawLine.replace(/^\s*(?:\*|\/\/)?\s*/, '').trim();
    if (line.length > 0 && !line.startsWith('@') && !line.startsWith('eslint')) {
      return firstSentence(line);
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
        out.classes.push({ name, kind: 'class', methodCount: countMethods(node), doc, exported });
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

function extractTsJs(root: Node): ExtractionResult {
  const out = emptyResult();

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

  return dedupeResult(out);
}

// ---------------------------------------------------------------------------
// Python extraction
// ---------------------------------------------------------------------------

/** First line of a Python string literal's content, quotes and prefixes removed. */
function pyStringFirstLine(stringNode: Node): string | null {
  const content = stringNode.namedChildren.find((c) => c?.type === 'string_content');
  if (!content) return null;
  for (const rawLine of content.text.split('\n')) {
    const line = rawLine.trim();
    if (line.length > 0) return firstSentence(line);
  }
  return null;
}

/** Docstring first line of a `block` (or `module`) node, when present. */
function pyDocstring(body: Node | null): string | null {
  const first = body?.namedChildren.find((c) => c !== null && c.type !== 'comment');
  if (first && first.type === 'expression_statement') {
    const str = first.namedChildren.find((c) => c?.type === 'string');
    if (str) return pyStringFirstLine(str);
  }
  return null;
}

function countPyMethods(classNode: Node): number {
  const body = classNode.childForFieldName('body');
  if (!body) return 0;
  let count = 0;
  for (let child of body.namedChildren) {
    if (!child) continue;
    if (child.type === 'decorated_definition') {
      child = child.childForFieldName('definition') ?? child;
    }
    if (child.type === 'function_definition') {
      if (child.childForFieldName('name')?.text !== '__init__') count++;
    }
  }
  return count;
}

function extractPython(root: Node): ExtractionResult {
  const out = emptyResult();
  out.fileDoc = pyDocstring(root);

  let allList: string[] | null = null;
  const publicNames: string[] = [];

  for (let child of root.namedChildren) {
    if (!child) continue;
    if (child.type === 'decorated_definition') {
      child = child.childForFieldName('definition') ?? child;
    }
    switch (child.type) {
      case 'import_statement': {
        for (const item of child.namedChildren) {
          if (!item) continue;
          if (item.type === 'dotted_name') out.imports.push(item.text);
          else if (item.type === 'aliased_import') {
            const name = item.childForFieldName('name');
            if (name) out.imports.push(name.text);
          }
        }
        break;
      }
      case 'import_from_statement': {
        const module = child.childForFieldName('module_name');
        if (module) out.imports.push(module.text);
        break;
      }
      case 'function_definition': {
        const name = child.childForFieldName('name')?.text;
        if (name) {
          const isPublic = !name.startsWith('_');
          out.topLevelDeclarations.push(`def ${name}`);
          out.functions.push({
            name,
            doc: pyDocstring(child.childForFieldName('body')),
            exported: isPublic,
          });
          if (isPublic) publicNames.push(name);
        }
        break;
      }
      case 'class_definition': {
        const name = child.childForFieldName('name')?.text;
        if (name) {
          const isPublic = !name.startsWith('_');
          out.topLevelDeclarations.push(`class ${name}`);
          out.classes.push({
            name,
            kind: 'class',
            methodCount: countPyMethods(child),
            doc: pyDocstring(child.childForFieldName('body')),
            exported: isPublic,
          });
          if (isPublic) publicNames.push(name);
        }
        break;
      }
      case 'expression_statement': {
        const assignment = child.namedChildren.find((c) => c?.type === 'assignment');
        const left = assignment?.childForFieldName('left');
        if (!assignment || !left || left.type !== 'identifier') break;
        const name = left.text;
        if (name === '__all__') {
          const right = assignment.childForFieldName('right');
          if (right && (right.type === 'list' || right.type === 'tuple')) {
            allList = [];
            for (const item of right.namedChildren) {
              if (item?.type !== 'string') continue;
              const content = item.namedChildren.find((c) => c?.type === 'string_content');
              if (content) allList.push(content.text);
            }
          }
        } else if (!name.startsWith('_')) {
          publicNames.push(name);
          if (/^[A-Z0-9_]+$/.test(name)) out.constNames.push(name);
        }
        break;
      }
      default:
        break;
    }
  }

  // `__all__` is the explicit export list; otherwise every public top-level
  // binding (def/class/assignment without a leading underscore) is exported.
  out.exports = allList ?? publicNames;
  return dedupeResult(out);
}

// ---------------------------------------------------------------------------
// Go extraction
// ---------------------------------------------------------------------------

function isGoExported(name: string): boolean {
  return /^[A-Z]/.test(name);
}

/**
 * First line of the contiguous `//` comment block directly above `node`
 * (Go doc-comment convention: no blank line between comment and declaration).
 */
function goDocComment(node: Node): string | null {
  let expectedRow = node.startPosition.row;
  let current = node.previousNamedSibling;
  let top: Node | null = null;
  while (current && current.type === 'comment' && current.endPosition.row === expectedRow - 1) {
    top = current;
    expectedRow = current.startPosition.row;
    current = current.previousNamedSibling;
  }
  return top ? commentFirstLine(top.text) : null;
}

function goImportPath(spec: Node, out: ExtractionResult): void {
  const path = spec.childForFieldName('path');
  if (path) out.imports.push(stripQuotes(path.text));
}

/** Names declared in a `var_spec` / `const_spec` (may bind several identifiers). */
function goSpecNames(spec: Node): string[] {
  const names: string[] = [];
  for (const child of spec.namedChildren) {
    if (child?.type === 'identifier') names.push(child.text);
    else break; // identifiers come first; stop at the type/value part
  }
  return names;
}

interface NamedTypeEntry {
  name: string;
  kind: string;
  doc: string | null;
  exported: boolean;
}

/** Promote named types with methods to class-like entries, the rest to typeNames. */
function resolveNamedTypes(
  types: NamedTypeEntry[],
  methodCounts: Map<string, number>,
  out: ExtractionResult,
): void {
  for (const entry of types) {
    const methodCount = methodCounts.get(entry.name) ?? 0;
    if (methodCount > 0) {
      out.classes.push({ ...entry, methodCount });
    } else {
      out.typeNames.push(entry.name);
    }
  }
}

function extractGo(root: Node): ExtractionResult {
  const out = emptyResult();
  const types: NamedTypeEntry[] = [];
  const methodCounts = new Map<string, number>();

  for (const child of root.namedChildren) {
    if (!child) continue;
    switch (child.type) {
      case 'package_clause':
        out.fileDoc = goDocComment(child);
        break;
      case 'import_declaration': {
        for (const inner of child.namedChildren) {
          if (!inner) continue;
          if (inner.type === 'import_spec') goImportPath(inner, out);
          else if (inner.type === 'import_spec_list') {
            for (const spec of inner.namedChildren) {
              if (spec?.type === 'import_spec') goImportPath(spec, out);
            }
          }
        }
        break;
      }
      case 'function_declaration': {
        const name = child.childForFieldName('name')?.text;
        if (name) {
          out.topLevelDeclarations.push(`func ${name}`);
          out.functions.push({ name, doc: goDocComment(child), exported: isGoExported(name) });
          if (isGoExported(name)) out.exports.push(name);
        }
        break;
      }
      case 'method_declaration': {
        const name = child.childForFieldName('name')?.text;
        if (name) {
          out.topLevelDeclarations.push(`func ${name}`);
          if (isGoExported(name)) out.exports.push(name);
          // Attribute the method to its receiver's named type.
          const receiver = child.childForFieldName('receiver');
          const receiverType = receiver?.descendantsOfType('type_identifier')[0]?.text;
          if (receiverType) {
            methodCounts.set(receiverType, (methodCounts.get(receiverType) ?? 0) + 1);
          }
        }
        break;
      }
      case 'type_declaration': {
        for (const spec of child.namedChildren) {
          if (!spec || (spec.type !== 'type_spec' && spec.type !== 'type_alias')) continue;
          const name = spec.childForFieldName('name')?.text;
          if (!name) continue;
          const typeNode = spec.childForFieldName('type');
          const kind =
            typeNode?.type === 'struct_type'
              ? 'struct'
              : typeNode?.type === 'interface_type'
                ? 'interface'
                : 'type';
          out.topLevelDeclarations.push(
            kind === 'type' ? `type ${name}` : `type ${name} ${kind}`,
          );
          types.push({ name, kind, doc: goDocComment(child), exported: isGoExported(name) });
          if (isGoExported(name)) out.exports.push(name);
        }
        break;
      }
      case 'var_declaration':
      case 'const_declaration': {
        const keyword = child.type === 'var_declaration' ? 'var' : 'const';
        for (const spec of child.namedChildren) {
          if (!spec || (spec.type !== 'var_spec' && spec.type !== 'const_spec')) continue;
          for (const name of goSpecNames(spec)) {
            out.topLevelDeclarations.push(`${keyword} ${name}`);
            if (keyword === 'const') out.constNames.push(name);
            if (isGoExported(name)) out.exports.push(name);
          }
        }
        break;
      }
      default:
        break;
    }
  }

  resolveNamedTypes(types, methodCounts, out);
  return dedupeResult(out);
}

// ---------------------------------------------------------------------------
// Rust extraction
// ---------------------------------------------------------------------------

/** Plain `pub` only — `pub(crate)` / `pub(super)` are not part of the public API. */
function isRustPub(node: Node): boolean {
  return node.namedChildren.some((c) => c?.type === 'visibility_modifier' && c.text === 'pub');
}

/**
 * First line of the contiguous `///` doc-comment block directly above `node`,
 * skipping any `#[...]` attributes between the docs and the item.
 */
function rustDocComment(node: Node): string | null {
  let expectedRow = node.startPosition.row;
  let current = node.previousNamedSibling;
  while (current && current.type === 'attribute_item' && current.endPosition.row === expectedRow - 1) {
    expectedRow = current.startPosition.row;
    current = current.previousNamedSibling;
  }
  let top: Node | null = null;
  while (
    current &&
    current.type === 'line_comment' &&
    current.text.startsWith('///') &&
    current.endPosition.row === expectedRow - 1
  ) {
    top = current;
    expectedRow = current.startPosition.row;
    current = current.previousNamedSibling;
  }
  if (top) {
    const line = top.text.replace(/^\/\/\/\s*/, '').trim();
    return line.length > 0 ? firstSentence(line) : null;
  }
  if (current && current.type === 'block_comment' && current.text.startsWith('/**')) {
    return commentFirstLine(current.text);
  }
  return null;
}

/** Module path of a `use` argument, with grouped/aliased/glob tails removed. */
function rustUseBasePath(argument: Node): string {
  switch (argument.type) {
    case 'scoped_use_list': {
      const path = argument.childForFieldName('path');
      return path ? path.text : argument.text;
    }
    case 'use_as_clause': {
      const path = argument.childForFieldName('path');
      return path ? path.text : argument.text;
    }
    case 'use_wildcard': {
      const inner = argument.namedChildren.find((c) => c !== null);
      return inner ? inner.text : argument.text;
    }
    default:
      return argument.text;
  }
}

/** Visible names introduced by a `pub use` argument (re-exports). */
function rustUseNames(argument: Node, out: string[]): void {
  switch (argument.type) {
    case 'identifier':
    case 'crate':
    case 'self':
    case 'super':
      out.push(argument.text);
      break;
    case 'scoped_identifier': {
      const name = argument.childForFieldName('name');
      if (name) out.push(name.text);
      break;
    }
    case 'use_as_clause': {
      const alias = argument.childForFieldName('alias');
      if (alias) out.push(alias.text);
      break;
    }
    case 'scoped_use_list': {
      const list = argument.childForFieldName('list');
      for (const item of list?.namedChildren ?? []) {
        if (item) rustUseNames(item, out);
      }
      break;
    }
    case 'use_list': {
      for (const item of argument.namedChildren) {
        if (item) rustUseNames(item, out);
      }
      break;
    }
    default:
      break;
  }
}

const RUST_TYPE_ITEMS: Record<string, string> = {
  struct_item: 'struct',
  enum_item: 'enum',
  trait_item: 'trait',
  union_item: 'union',
};

function extractRust(root: Node): ExtractionResult {
  const out = emptyResult();
  const types: NamedTypeEntry[] = [];
  const methodCounts = new Map<string, number>();

  let seenCode = false;
  for (const child of root.namedChildren) {
    if (!child) continue;
    const pub = isRustPub(child);
    switch (child.type) {
      case 'line_comment':
        if (!seenCode && out.fileDoc === null && child.text.startsWith('//!')) {
          const line = child.text.replace(/^\/\/!\s*/, '').trim();
          if (line.length > 0) out.fileDoc = firstSentence(line);
        }
        continue; // comments don't count as code
      case 'block_comment':
        continue;
      case 'use_declaration': {
        const argument = child.childForFieldName('argument');
        if (argument) {
          out.imports.push(rustUseBasePath(argument));
          if (pub) rustUseNames(argument, out.exports); // `pub use` re-exports
        }
        break;
      }
      case 'mod_item': {
        const name = child.childForFieldName('name')?.text;
        if (name) {
          out.topLevelDeclarations.push(`mod ${name}`);
          if (!child.childForFieldName('body')) out.imports.push(name); // `mod x;`
          if (pub) out.exports.push(name);
        }
        break;
      }
      case 'function_item': {
        const name = child.childForFieldName('name')?.text;
        if (name) {
          out.topLevelDeclarations.push(`fn ${name}`);
          out.functions.push({ name, doc: rustDocComment(child), exported: pub });
          if (pub) out.exports.push(name);
        }
        break;
      }
      case 'struct_item':
      case 'enum_item':
      case 'trait_item':
      case 'union_item': {
        const name = child.childForFieldName('name')?.text;
        if (name) {
          const kind = RUST_TYPE_ITEMS[child.type];
          out.topLevelDeclarations.push(`${kind} ${name}`);
          types.push({ name, kind, doc: rustDocComment(child), exported: pub });
          if (pub) out.exports.push(name);
        }
        break;
      }
      case 'impl_item': {
        // Strip generic params so `impl Config<T>` matches `struct Config`.
        const typeName = child.childForFieldName('type')?.text.replace(/<.*$/s, '');
        if (typeName) {
          out.topLevelDeclarations.push(`impl ${typeName}`);
          const body = child.childForFieldName('body');
          let methods = 0;
          for (const item of body?.namedChildren ?? []) {
            if (item?.type === 'function_item') methods++;
          }
          if (methods > 0) {
            methodCounts.set(typeName, (methodCounts.get(typeName) ?? 0) + methods);
          }
        }
        break;
      }
      case 'type_item': {
        const name = child.childForFieldName('name')?.text;
        if (name) {
          out.topLevelDeclarations.push(`type ${name}`);
          out.typeNames.push(name);
          if (pub) out.exports.push(name);
        }
        break;
      }
      case 'const_item':
      case 'static_item': {
        const name = child.childForFieldName('name')?.text;
        if (name) {
          out.topLevelDeclarations.push(
            `${child.type === 'const_item' ? 'const' : 'static'} ${name}`,
          );
          out.constNames.push(name);
          if (pub) out.exports.push(name);
        }
        break;
      }
      default:
        break;
    }
    seenCode = true;
  }

  resolveNamedTypes(types, methodCounts, out);
  return dedupeResult(out);
}

// ---------------------------------------------------------------------------
// Kotlin extraction
// ---------------------------------------------------------------------------

/**
 * True unless the declaration carries a `private`/`internal`/`protected`
 * visibility modifier (`public` is the Kotlin default).
 */
function ktIsPublic(node: Node): boolean {
  const mods = node.namedChildren.find((c) => c?.type === 'modifiers');
  for (const m of mods?.namedChildren ?? []) {
    if (m?.type === 'visibility_modifier' && m.text !== 'public') return false;
  }
  return true;
}

/** The Kotlin grammar exposes keywords (`interface`, `enum`, …) as anonymous tokens. */
function ktHasToken(node: Node, token: string): boolean {
  return node.children.some((c) => c !== null && c.type === token);
}

function ktHasClassModifier(node: Node, modifier: string): boolean {
  const mods = node.namedChildren.find((c) => c?.type === 'modifiers');
  return (mods?.namedChildren ?? []).some(
    (m) => m !== null && m.type === 'class_modifier' && m.text === modifier,
  );
}

/**
 * KDoc block immediately above `node`. The Kotlin grammar attaches the
 * comment preceding the first declaration after the imports as the trailing
 * descendant of the import list, so that path is checked too.
 */
function ktPrecedingDoc(node: Node): string | null {
  let prev = node.previousNamedSibling;
  if (prev && (prev.type === 'import_list' || prev.type === 'package_header')) {
    let tail: Node = prev;
    while (tail.lastNamedChild) tail = tail.lastNamedChild;
    prev = tail;
  }
  if (prev && prev.type === 'multiline_comment' && prev.text.startsWith('/**')) {
    return commentFirstLine(prev.text);
  }
  return null;
}

/** Method count of a class/object body, including companion-object functions. */
function ktCountMethods(body: Node | null | undefined): number {
  let count = 0;
  for (const child of body?.namedChildren ?? []) {
    if (!child) continue;
    if (child.type === 'function_declaration') count++;
    else if (child.type === 'companion_object') {
      count += ktCountMethods(child.namedChildren.find((c) => c?.type === 'class_body'));
    }
  }
  return count;
}

function extractKotlin(root: Node): ExtractionResult {
  const out = emptyResult();

  let seenCode = false;
  for (const child of root.namedChildren) {
    if (!child) continue;
    switch (child.type) {
      case 'multiline_comment':
        if (!seenCode && out.fileDoc === null && child.text.startsWith('/**')) {
          out.fileDoc = commentFirstLine(child.text);
        }
        continue;
      case 'line_comment':
        continue;
      case 'package_header':
        break;
      case 'import_list': {
        for (const header of child.namedChildren) {
          if (header?.type !== 'import_header') continue;
          // `identifier` is the dotted path; a trailing `.*` (wildcard_import)
          // and `as` aliases sit outside it, so they are stripped for free.
          const path = header.namedChildren.find((c) => c?.type === 'identifier');
          if (path) out.imports.push(path.text.replace(/\s/g, ''));
        }
        break;
      }
      case 'class_declaration': {
        const name = child.namedChildren.find((c) => c?.type === 'type_identifier')?.text;
        if (!name) break;
        const pub = ktIsPublic(child);
        const doc = ktPrecedingDoc(child);
        const body = child.namedChildren.find((c) => c?.type === 'class_body');
        if (ktHasToken(child, 'interface')) {
          out.topLevelDeclarations.push(`interface ${name}`);
          out.classes.push({
            name,
            kind: 'interface',
            methodCount: ktCountMethods(body),
            doc,
            exported: pub,
          });
        } else if (ktHasToken(child, 'enum')) {
          out.topLevelDeclarations.push(`enum class ${name}`);
          out.typeNames.push(name);
        } else {
          const kind = ktHasClassModifier(child, 'data') ? 'data class' : 'class';
          out.topLevelDeclarations.push(`${kind} ${name}`);
          out.classes.push({ name, kind, methodCount: ktCountMethods(body), doc, exported: pub });
        }
        if (pub) out.exports.push(name);
        break;
      }
      case 'object_declaration': {
        const name = child.namedChildren.find((c) => c?.type === 'type_identifier')?.text;
        if (name) {
          const pub = ktIsPublic(child);
          const body = child.namedChildren.find((c) => c?.type === 'class_body');
          out.topLevelDeclarations.push(`object ${name}`);
          out.classes.push({
            name,
            kind: 'object',
            methodCount: ktCountMethods(body),
            doc: ktPrecedingDoc(child),
            exported: pub,
          });
          if (pub) out.exports.push(name);
        }
        break;
      }
      case 'function_declaration': {
        const name = child.namedChildren.find((c) => c?.type === 'simple_identifier')?.text;
        if (name) {
          const pub = ktIsPublic(child);
          out.topLevelDeclarations.push(`fun ${name}`);
          out.functions.push({ name, doc: ktPrecedingDoc(child), exported: pub });
          if (pub) out.exports.push(name);
        }
        break;
      }
      case 'property_declaration': {
        const kind =
          child.namedChildren.find((c) => c?.type === 'binding_pattern_kind')?.text ?? 'val';
        const decl = child.namedChildren.find((c) => c?.type === 'variable_declaration');
        const name = decl?.namedChildren.find((c) => c?.type === 'simple_identifier')?.text;
        if (name) {
          out.topLevelDeclarations.push(`${kind} ${name}`);
          if (kind === 'val') out.constNames.push(name);
          if (ktIsPublic(child)) out.exports.push(name);
        }
        break;
      }
      case 'type_alias': {
        const name = child.namedChildren.find((c) => c?.type === 'type_identifier')?.text;
        if (name) {
          out.topLevelDeclarations.push(`typealias ${name}`);
          out.typeNames.push(name);
          if (ktIsPublic(child)) out.exports.push(name);
        }
        break;
      }
      default:
        break;
    }
    seenCode = true;
  }

  return dedupeResult(out);
}

// ---------------------------------------------------------------------------
// Java extraction
// ---------------------------------------------------------------------------

/** Javadoc block immediately preceding `node`. */
function javaPrecedingDoc(node: Node): string | null {
  const prev = node.previousNamedSibling;
  if (prev && prev.type === 'block_comment' && prev.text.startsWith('/**')) {
    return commentFirstLine(prev.text);
  }
  return null;
}

/** Java modifiers (`public`, `static`, …) are anonymous tokens under `modifiers`. */
function javaHasModifier(node: Node, modifier: string): boolean {
  const mods = node.namedChildren.find((c) => c?.type === 'modifiers');
  return (mods?.children ?? []).some((c) => c !== null && c.type === modifier);
}

/**
 * Collect the public members of a top-level type into `out.exports` (when the
 * type itself is public) and return its method count. Interface members are
 * implicitly public. A `static main` method is recorded as a function so the
 * purpose generator can mark the file as an entry point.
 */
function javaCollectMembers(
  typeNode: Node,
  kind: string,
  typePublic: boolean,
  out: ExtractionResult,
): number {
  const body = typeNode.childForFieldName('body');
  let methods = 0;
  for (const member of body?.namedChildren ?? []) {
    if (!member) continue;
    if (member.type === 'method_declaration') {
      methods++;
      const name = member.childForFieldName('name')?.text;
      if (!name) continue;
      const memberPublic = kind === 'interface' || javaHasModifier(member, 'public');
      if (name === 'main' && javaHasModifier(member, 'static')) {
        out.functions.push({ name, doc: null, exported: memberPublic });
      }
      if (typePublic && memberPublic) out.exports.push(name);
    } else if (member.type === 'field_declaration') {
      if (!typePublic) continue;
      if (kind !== 'interface' && !javaHasModifier(member, 'public')) continue;
      for (const decl of member.namedChildren) {
        if (decl?.type !== 'variable_declarator') continue;
        const name = decl.childForFieldName('name')?.text;
        if (!name) continue;
        out.exports.push(name);
        if (/^[A-Z0-9_]+$/.test(name)) out.constNames.push(name);
      }
    }
  }
  return methods;
}

function extractJava(root: Node): ExtractionResult {
  const out = emptyResult();

  let seenCode = false;
  for (const child of root.namedChildren) {
    if (!child) continue;
    switch (child.type) {
      case 'block_comment':
        if (!seenCode && out.fileDoc === null && child.text.startsWith('/**')) {
          out.fileDoc = commentFirstLine(child.text);
        }
        continue;
      case 'line_comment':
        continue;
      case 'package_declaration':
        break;
      case 'import_declaration': {
        // The dotted path; a trailing `.*` is a separate `asterisk` node, so
        // wildcard imports already arrive stripped.
        const path = child.namedChildren.find(
          (c) => c?.type === 'scoped_identifier' || c?.type === 'identifier',
        );
        if (path) out.imports.push(path.text.replace(/\s/g, ''));
        break;
      }
      case 'class_declaration':
      case 'interface_declaration':
      case 'record_declaration': {
        const name = child.childForFieldName('name')?.text;
        if (!name) break;
        const kind =
          child.type === 'class_declaration'
            ? 'class'
            : child.type === 'interface_declaration'
              ? 'interface'
              : 'record';
        const pub = javaHasModifier(child, 'public');
        out.topLevelDeclarations.push(`${kind} ${name}`);
        const methodCount = javaCollectMembers(child, kind, pub, out);
        out.classes.push({ name, kind, methodCount, doc: javaPrecedingDoc(child), exported: pub });
        if (pub) out.exports.push(name);
        break;
      }
      case 'enum_declaration':
      case 'annotation_type_declaration': {
        const name = child.childForFieldName('name')?.text;
        if (name) {
          const kind = child.type === 'enum_declaration' ? 'enum' : 'annotation';
          out.topLevelDeclarations.push(`${kind} ${name}`);
          out.typeNames.push(name);
          if (javaHasModifier(child, 'public')) out.exports.push(name);
        }
        break;
      }
      default:
        break;
    }
    seenCode = true;
  }

  return dedupeResult(out);
}

function extract(root: Node, grammar: GrammarName): ExtractionResult {
  switch (grammar) {
    case 'python':
      return extractPython(root);
    case 'go':
      return extractGo(root);
    case 'rust':
      return extractRust(root);
    case 'kotlin':
      return extractKotlin(root);
    case 'java':
      return extractJava(root);
    default:
      return extractTsJs(root);
  }
}

// ---------------------------------------------------------------------------
// Purpose line generation
// ---------------------------------------------------------------------------

function fileCategory(filePath: string, contents: string): string | null {
  const basename = getBasename(filePath);
  const ext = getExtension(filePath);
  const dir = filePath.replace(/\\/g, '/');

  const inTestsDir =
    dir.includes('/tests/') || dir.includes('/test/') || /^tests?\//.test(dir);

  if (ext === '.py') {
    if (basename.startsWith('test_') || basename.endsWith('_test.py')) return 'test';
    if (basename === 'conftest.py') return 'test';
    if (inTestsDir) return 'test';
    if (basename === 'setup.py' || basename === 'settings.py' || basename === 'config.py') {
      return 'config';
    }
    if (basename === '__init__.py' || basename === '__main__.py') return 'entry point';
    if (/\bif\s+__name__\s*==\s*['"]__main__['"]\s*:/.test(contents)) return 'entry point';
    return null;
  }
  if (ext === '.go') {
    if (basename.endsWith('_test.go')) return 'test';
    if (basename === 'main.go') return 'entry point';
    return null;
  }
  if (ext === '.rs') {
    if (inTestsDir || basename.startsWith('test_')) return 'test';
    if (basename === 'main.rs' || basename === 'lib.rs' || basename === 'mod.rs') {
      return 'entry point';
    }
    if (basename === 'build.rs') return 'config';
    return null;
  }

  if (ext === '.kt' || ext === '.kts') {
    if (/Test\.kts?$/.test(basename) || inTestsDir || dir.includes('/androidTest/')) return 'test';
    if (basename.endsWith('.gradle.kts')) return 'config';
    if (basename === 'Main.kt') return 'entry point';
    return null;
  }
  if (ext === '.java') {
    if (/Tests?\.java$/.test(basename) || inTestsDir) return 'test';
    if (basename === 'Main.java') return 'entry point';
    return null;
  }

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
  let category = fileCategory(filePath, contents);
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
    const head = `${primary.kind} ${primary.name} (${primary.methodCount} method${primary.methodCount === 1 ? '' : 's'})`;
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
 * Summarize a TS/JS, Python, Go, Rust, Kotlin or Java file from its syntax
 * tree. Falls back to the regex summarizer for unsupported extensions, empty
 * files, parse errors, or when the WASM runtime cannot be loaded.
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

  // Some grammars (Go) need a statement terminator after the last declaration;
  // parse with a trailing newline so files missing one don't report errors.
  const tree = parser.parse(contents.endsWith('\n') ? contents : `${contents}\n`);
  if (!tree) return summarizeFile(filePath, contents);

  try {
    if (tree.rootNode.hasError) {
      return summarizeFile(filePath, contents);
    }

    const info = extract(tree.rootNode, grammar);
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
