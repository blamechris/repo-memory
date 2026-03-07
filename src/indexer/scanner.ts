import { execFile } from 'child_process';
import { readdir } from 'fs/promises';
import { join, relative } from 'path';
import { promisify } from 'util';
import { loadConfig } from '../config.js';

const execFileAsync = promisify(execFile);

export interface ScanOptions {
  include?: string[];
  exclude?: string[];
  maxFiles?: number;
}

const BINARY_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.ico', '.bmp', '.webp',
  '.woff', '.woff2', '.ttf', '.eot', '.otf',
  '.pdf', '.zip', '.tar', '.gz', '.bz2', '.7z',
  '.exe', '.dll', '.so', '.dylib',
  '.mp3', '.mp4', '.wav', '.avi', '.mov',
]);

const ALWAYS_SKIP = new Set(['.git', '.repo-memory', 'node_modules']);

function isBinaryPath(filePath: string): boolean {
  const dotIndex = filePath.lastIndexOf('.');
  if (dotIndex === -1) return false;
  return BINARY_EXTENSIONS.has(filePath.slice(dotIndex).toLowerCase());
}

function matchesPattern(filePath: string, pattern: string): boolean {
  if (pattern.startsWith('*.')) {
    return filePath.endsWith(pattern.slice(1));
  }
  if (pattern.endsWith('/') || pattern.endsWith('/*')) {
    const dir = pattern.replace(/\/?\*?$/, '');
    return filePath.startsWith(dir + '/') || filePath === dir;
  }
  return filePath.includes(pattern);
}

function shouldInclude(
  filePath: string,
  include?: string[],
  exclude?: string[],
): boolean {
  if (include && include.length > 0) {
    const matched = include.some((p) => matchesPattern(filePath, p));
    if (!matched) return false;
  }
  if (exclude && exclude.length > 0) {
    const matched = exclude.some((p) => matchesPattern(filePath, p));
    if (matched) return false;
  }
  return true;
}

async function isGitRepo(rootDir: string): Promise<boolean> {
  try {
    await execFileAsync('git', ['rev-parse', '--git-dir'], { cwd: rootDir });
    return true;
  } catch {
    return false;
  }
}

async function scanWithGit(rootDir: string): Promise<string[]> {
  const [tracked, untracked] = await Promise.all([
    execFileAsync('git', ['ls-files'], { cwd: rootDir, maxBuffer: 10 * 1024 * 1024 }),
    execFileAsync(
      'git',
      ['ls-files', '--others', '--exclude-standard'],
      { cwd: rootDir, maxBuffer: 10 * 1024 * 1024 },
    ),
  ]);

  const files = new Set<string>();

  for (const line of tracked.stdout.split('\n')) {
    const trimmed = line.trim();
    if (trimmed) files.add(trimmed);
  }

  for (const line of untracked.stdout.split('\n')) {
    const trimmed = line.trim();
    if (trimmed) files.add(trimmed);
  }

  return [...files];
}

async function scanWithFs(rootDir: string): Promise<string[]> {
  const files: string[] = [];

  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (ALWAYS_SKIP.has(entry.name)) continue;

      const fullPath = join(dir, entry.name);

      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (entry.isFile()) {
        files.push(relative(rootDir, fullPath));
      }
    }
  }

  await walk(rootDir);
  return files;
}

export async function scanProject(
  rootDir: string,
  options?: ScanOptions,
): Promise<string[]> {
  const config = loadConfig(rootDir);
  const useGit = await isGitRepo(rootDir);
  const rawFiles = useGit ? await scanWithGit(rootDir) : await scanWithFs(rootDir);

  // Merge config ignore patterns with explicit exclude options
  const exclude = [...(options?.exclude ?? []), ...(config.ignore ?? [])];

  let filtered = rawFiles.filter((f) => {
    const parts = f.split('/');
    if (parts.some((p) => ALWAYS_SKIP.has(p))) return false;
    if (isBinaryPath(f)) return false;
    if (!shouldInclude(f, options?.include, exclude.length > 0 ? exclude : undefined)) return false;
    return true;
  });

  filtered.sort((a, b) => a.localeCompare(b));

  const maxFiles = options?.maxFiles ?? config.maxFiles;
  if (maxFiles && filtered.length > maxFiles) {
    filtered = filtered.slice(0, maxFiles);
  }

  return filtered;
}
