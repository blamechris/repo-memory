import { readFile, stat } from 'node:fs/promises';
import { join, dirname, basename, extname } from 'node:path';
import { scanProject } from './scanner.js';
import { summarizeFile } from './summarizer.js';
import { CacheStore } from '../cache/store.js';
import { hashContents } from '../cache/hash.js';
import type { FileSummary } from '../types.js';

export interface DirectoryNode {
  name: string;
  path: string;
  files: Array<{
    name: string;
    purpose: string;
    confidence: string;
    size: number;
    lastModified: number;
  }>;
  children: DirectoryNode[];
  fileCount: number;
}

export interface ProjectMap {
  tree: DirectoryNode;
  entryPoints: string[];
  totalFiles: number;
  languageBreakdown: Record<string, number>;
}

interface FileSummaryEntry {
  relativePath: string;
  summary: FileSummary;
  size: number;
  lastModified: number;
}

async function getSummaries(
  projectRoot: string,
  files: string[],
): Promise<FileSummaryEntry[]> {
  const cache = new CacheStore(projectRoot);
  const entries: FileSummaryEntry[] = [];

  for (const relativePath of files) {
    const absolutePath = join(projectRoot, relativePath);
    const cached = cache.getEntry(relativePath);
    if (cached?.summary) {
      try {
        const stats = await stat(absolutePath);
        entries.push({ relativePath, summary: cached.summary, size: stats.size, lastModified: stats.mtimeMs });
      } catch {
        entries.push({ relativePath, summary: cached.summary, size: 0, lastModified: 0 });
      }
      continue;
    }

    let contents: string;
    try {
      contents = await readFile(absolutePath, 'utf-8');
    } catch {
      continue;
    }

    const summary = summarizeFile(relativePath, contents);
    const hash = hashContents(contents);
    cache.setEntry(relativePath, hash, summary);
    const stats = await stat(absolutePath);
    entries.push({ relativePath, summary, size: stats.size, lastModified: stats.mtimeMs });
  }

  return entries;
}

function buildTree(
  entries: FileSummaryEntry[],
  rootName: string,
  maxDepth?: number,
): DirectoryNode {
  const root: DirectoryNode = {
    name: rootName,
    path: '.',
    files: [],
    children: [],
    fileCount: 0,
  };

  const dirMap = new Map<string, DirectoryNode>();
  dirMap.set('.', root);

  function getOrCreateDir(dirPath: string, currentDepth: number): DirectoryNode | null {
    if (dirPath === '.') return root;
    if (maxDepth !== undefined && currentDepth > maxDepth) return null;

    const existing = dirMap.get(dirPath);
    if (existing) return existing;

    const parentPath = dirname(dirPath);
    const parentDepth = parentPath === '.' ? 0 : parentPath.split('/').length;
    const parent = getOrCreateDir(parentPath, parentDepth);
    if (!parent) return null;

    const node: DirectoryNode = {
      name: basename(dirPath),
      path: dirPath,
      files: [],
      children: [],
      fileCount: 0,
    };

    dirMap.set(dirPath, node);
    parent.children.push(node);
    return node;
  }

  for (const entry of entries) {
    const dirPath = dirname(entry.relativePath);
    const depth = dirPath === '.' ? 0 : dirPath.split('/').length;
    const dir = getOrCreateDir(dirPath, depth);
    if (!dir) continue;

    dir.files.push({
      name: basename(entry.relativePath),
      purpose: entry.summary.purpose,
      confidence: entry.summary.confidence,
      size: entry.size,
      lastModified: entry.lastModified,
    });
  }

  function computeFileCounts(node: DirectoryNode): number {
    let count = node.files.length;
    for (const child of node.children) {
      count += computeFileCounts(child);
    }
    node.fileCount = count;
    return count;
  }

  computeFileCounts(root);

  function sortTree(node: DirectoryNode): void {
    node.files.sort((a, b) => a.name.localeCompare(b.name));
    node.children.sort((a, b) => a.name.localeCompare(b.name));
    for (const child of node.children) {
      sortTree(child);
    }
  }

  sortTree(root);

  return root;
}

function computeLanguageBreakdown(files: string[]): Record<string, number> {
  const breakdown: Record<string, number> = {};
  for (const file of files) {
    const ext = extname(file) || '(no extension)';
    breakdown[ext] = (breakdown[ext] ?? 0) + 1;
  }
  return breakdown;
}

function findEntryPoints(entries: FileSummaryEntry[]): string[] {
  return entries
    .filter((e) => e.summary.purpose === 'entry point')
    .map((e) => e.relativePath)
    .sort();
}

export async function buildProjectMap(
  projectRoot: string,
  options?: { depth?: number },
): Promise<ProjectMap> {
  const files = await scanProject(projectRoot);
  const entries = await getSummaries(projectRoot, files);
  const rootName = basename(projectRoot);

  return {
    tree: buildTree(entries, rootName, options?.depth),
    entryPoints: findEntryPoints(entries),
    totalFiles: files.length,
    languageBreakdown: computeLanguageBreakdown(files),
  };
}
