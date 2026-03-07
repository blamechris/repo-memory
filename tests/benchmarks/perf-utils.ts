import { execFileSync } from 'child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';

export interface PerfFixtureOptions {
  fileCount: number;
  avgLinesPerFile?: number;
  importDensity?: number;
}

const FUNCTION_NAMES = [
  'processData', 'validateInput', 'transformOutput', 'handleRequest',
  'parseConfig', 'formatResult', 'computeHash', 'mergeObjects',
  'filterItems', 'sortEntries', 'buildIndex', 'renderView',
  'fetchResource', 'updateState', 'initModule', 'cleanupSession',
  'encodePayload', 'decodeResponse', 'normalizeValue', 'aggregateStats',
];

const CLASS_NAMES = [
  'DataProcessor', 'RequestHandler', 'ConfigManager', 'StateContainer',
  'EventEmitter', 'Logger', 'Validator', 'Formatter',
  'CacheLayer', 'Router', 'Middleware', 'Controller',
];

const TYPE_NAMES = [
  'Options', 'Config', 'Result', 'Payload',
  'Context', 'Metadata', 'Entry', 'Record',
];

function randomInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function randomPick<T>(arr: T[]): T {
  return arr[randomInt(0, arr.length - 1)];
}

function generateFileContent(
  fileIndex: number,
  totalFiles: number,
  avgLines: number,
  importDensity: number,
  filePaths: string[],
): string {
  const lines: string[] = [];

  // Generate imports from other files based on importDensity
  if (fileIndex > 0 && Math.random() < importDensity) {
    const importCount = randomInt(1, Math.min(3, fileIndex));
    const imported = new Set<number>();
    for (let i = 0; i < importCount; i++) {
      const targetIndex = randomInt(0, fileIndex - 1);
      if (imported.has(targetIndex)) continue;
      imported.add(targetIndex);

      const targetPath = filePaths[targetIndex].replace(/\.ts$/, '.js');
      const relativePath = targetPath.startsWith('src/')
        ? `./${targetPath.slice(4)}`
        : `./${targetPath}`;
      lines.push(`import { item${targetIndex} } from '${relativePath}';`);
    }
  }

  lines.push('');

  // Generate a type/interface
  const typeName = `${randomPick(TYPE_NAMES)}${fileIndex}`;
  lines.push(`export interface ${typeName} {`);
  lines.push(`  id: string;`);
  lines.push(`  value: number;`);
  lines.push(`  label: string;`);
  lines.push(`}`);
  lines.push('');

  // Generate a function
  const funcName = `${randomPick(FUNCTION_NAMES)}${fileIndex}`;
  lines.push(`export function ${funcName}(input: ${typeName}): ${typeName} {`);

  // Add some body lines to reach the target line count
  const bodyLines = Math.max(1, avgLines - lines.length - 4);
  for (let i = 0; i < bodyLines; i++) {
    if (i % 3 === 0) {
      lines.push(`  const step${i} = input.value + ${i};`);
    } else if (i % 3 === 1) {
      lines.push(`  // Processing step ${i} for ${funcName}`);
    } else {
      lines.push(`  const check${i} = step${i - 2} > 0 ? 'yes' : 'no';`);
    }
  }
  lines.push(`  return { ...input, value: input.value + 1 };`);
  lines.push(`}`);
  lines.push('');

  // Optionally add a class
  if (fileIndex % 3 === 0) {
    const className = `${randomPick(CLASS_NAMES)}${fileIndex}`;
    lines.push(`export class ${className} {`);
    lines.push(`  private data: ${typeName}[] = [];`);
    lines.push('');
    lines.push(`  add(item: ${typeName}): void {`);
    lines.push(`    this.data.push(item);`);
    lines.push(`  }`);
    lines.push('');
    lines.push(`  getAll(): ${typeName}[] {`);
    lines.push(`    return [...this.data];`);
    lines.push(`  }`);
    lines.push(`}`);
    lines.push('');
  }

  // Export a const for import targets
  lines.push(`export const item${fileIndex} = '${funcName}';`);
  lines.push('');

  return lines.join('\n');
}

/**
 * Create a temporary project with realistic TypeScript files,
 * initialized as a git repository with an initial commit.
 */
export function createPerfFixture(options: PerfFixtureOptions): string {
  const { fileCount, avgLinesPerFile = 30, importDensity = 0.5 } = options;
  const tempDir = mkdtempSync(join(tmpdir(), 'repo-memory-perf-'));

  // Plan file paths
  const filePaths: string[] = [];
  for (let i = 0; i < fileCount; i++) {
    const subDir = i % 5 === 0 ? 'src/utils' : i % 3 === 0 ? 'src/core' : 'src';
    filePaths.push(`${subDir}/file${i}.ts`);
  }

  // Create files
  for (let i = 0; i < fileCount; i++) {
    const fullPath = join(tempDir, filePaths[i]);
    mkdirSync(dirname(fullPath), { recursive: true });
    const content = generateFileContent(
      i,
      fileCount,
      avgLinesPerFile,
      importDensity,
      filePaths,
    );
    writeFileSync(fullPath, content, 'utf-8');
  }

  // Initialize git repo and commit
  execFileSync('git', ['init'], { cwd: tempDir, stdio: 'pipe' });
  execFileSync('git', ['add', '.'], { cwd: tempDir, stdio: 'pipe' });
  execFileSync(
    'git',
    ['commit', '-m', 'initial fixture', '--no-gpg-sign'],
    {
      cwd: tempDir,
      stdio: 'pipe',
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'test',
        GIT_AUTHOR_EMAIL: 'test@test.com',
        GIT_COMMITTER_NAME: 'test',
        GIT_COMMITTER_EMAIL: 'test@test.com',
      },
    },
  );

  return tempDir;
}
