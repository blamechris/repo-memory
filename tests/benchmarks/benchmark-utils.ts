import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

export interface BenchmarkReport {
  scenario: string;
  fileCount: number;
  rawBytes: number;
  summaryBytes: number;
  compressionRatio: number;
  cacheHits: number;
  cacheMisses: number;
  hitRatio: number;
  estimatedTokensSaved: number;
}

/**
 * Creates a temp directory with a git repo containing `fileCount` TypeScript files
 * with realistic content (imports between files, exports, classes, functions).
 */
export function createBenchmarkFixture(fileCount: number): string {
  const dir = mkdtempSync(join(tmpdir(), 'repo-memory-bench-'));

  // Initialize a git repo
  execFileSync('git', ['init'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'bench@test.com'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'Benchmark'], { cwd: dir });

  // Create directory structure
  const dirs = ['src', 'src/models', 'src/services', 'src/utils', 'src/controllers'];
  for (const d of dirs) {
    mkdirSync(join(dir, d), { recursive: true });
  }

  const filePaths: string[] = [];

  // Generate files spread across directories
  for (let i = 0; i < fileCount; i++) {
    const dirIndex = i % dirs.length;
    const parentDir = dirs[dirIndex];
    const fileName = `file-${i}.ts`;
    const relativePath = `${parentDir}/${fileName}`;
    filePaths.push(relativePath);
  }

  // Write each file with realistic content and inter-file imports
  for (let i = 0; i < filePaths.length; i++) {
    const content = generateFileContent(i, filePaths);
    writeFileSync(join(dir, filePaths[i]), content, 'utf-8');
  }

  // Create a tsconfig.json
  writeFileSync(
    join(dir, 'tsconfig.json'),
    JSON.stringify(
      {
        compilerOptions: {
          target: 'ES2022',
          module: 'NodeNext',
          moduleResolution: 'NodeNext',
          strict: true,
          outDir: 'dist',
          rootDir: 'src',
        },
        include: ['src/**/*'],
      },
      null,
      2,
    ),
    'utf-8',
  );

  // Create a package.json
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify(
      {
        name: 'benchmark-fixture',
        version: '1.0.0',
        type: 'module',
      },
      null,
      2,
    ),
    'utf-8',
  );

  // Commit everything
  execFileSync('git', ['add', '.'], { cwd: dir });
  execFileSync('git', ['commit', '-m', 'initial'], { cwd: dir });

  return dir;
}

function generateFileContent(index: number, allPaths: string[]): string {
  const lines: string[] = [];
  const className = `Component${index}`;
  const funcName = `process${index}`;
  const helperName = `helper${index}`;

  // Add imports from other files (up to 3)
  const importCount = Math.min(3, Math.max(0, index));
  for (let j = 0; j < importCount; j++) {
    const targetIndex = (index - j - 1 + allPaths.length) % allPaths.length;
    if (targetIndex !== index) {
      const targetClass = `Component${targetIndex}`;
      // Use a relative-style import (won't resolve but looks realistic for the summarizer)
      lines.push(`import { ${targetClass} } from './${getRelativeImport(targetIndex)}';`);
    }
  }

  if (lines.length > 0) lines.push('');

  // Export an interface
  lines.push(`export interface ${className}Config {`);
  lines.push(`  name: string;`);
  lines.push(`  enabled: boolean;`);
  lines.push(`  maxRetries: number;`);
  lines.push(`  timeout: number;`);
  lines.push(`}`);
  lines.push('');

  // Export a class
  lines.push(`export class ${className} {`);
  lines.push(`  private config: ${className}Config;`);
  lines.push(`  private state: Map<string, unknown> = new Map();`);
  lines.push('');
  lines.push(`  constructor(config: ${className}Config) {`);
  lines.push(`    this.config = config;`);
  lines.push(`  }`);
  lines.push('');
  lines.push(`  async initialize(): Promise<void> {`);
  lines.push(`    console.log(\`Initializing \${this.config.name}\`);`);
  lines.push(`    this.state.set('initialized', true);`);
  lines.push(`  }`);
  lines.push('');
  lines.push(`  getState(key: string): unknown {`);
  lines.push(`    return this.state.get(key);`);
  lines.push(`  }`);
  lines.push('');
  lines.push(`  setState(key: string, value: unknown): void {`);
  lines.push(`    this.state.set(key, value);`);
  lines.push(`  }`);

  // Add some extra methods to larger-indexed files for variety
  if (index % 3 === 0) {
    lines.push('');
    lines.push(`  async process(input: string[]): Promise<string[]> {`);
    lines.push(`    const results: string[] = [];`);
    lines.push(`    for (const item of input) {`);
    lines.push(`      if (this.config.enabled) {`);
    lines.push(`        results.push(item.toUpperCase());`);
    lines.push(`      }`);
    lines.push(`    }`);
    lines.push(`    return results;`);
    lines.push(`  }`);
  }

  lines.push(`}`);
  lines.push('');

  // Export a standalone function
  lines.push(`export function ${funcName}(data: Record<string, unknown>): string {`);
  lines.push(`  const keys = Object.keys(data);`);
  lines.push(`  return keys.map(k => \`\${k}=\${String(data[k])}\`).join(', ');`);
  lines.push(`}`);
  lines.push('');

  // Export a helper
  lines.push(`export function ${helperName}(value: number): number {`);
  lines.push(`  if (value <= 0) return 0;`);
  lines.push(`  return Math.round(value * 100) / 100;`);
  lines.push(`}`);
  lines.push('');

  // Add some type exports for variety
  if (index % 2 === 0) {
    lines.push(`export type ${className}Status = 'active' | 'inactive' | 'error';`);
    lines.push('');
    lines.push(`export const DEFAULT_CONFIG: ${className}Config = {`);
    lines.push(`  name: '${className}',`);
    lines.push(`  enabled: true,`);
    lines.push(`  maxRetries: 3,`);
    lines.push(`  timeout: 5000,`);
    lines.push(`};`);
    lines.push('');
  }

  return lines.join('\n');
}

function getRelativeImport(index: number): string {
  return `file-${index}`;
}

/**
 * Generates a markdown-formatted summary table from benchmark reports.
 */
export function generateReport(reports: BenchmarkReport[]): string {
  const lines: string[] = [];

  lines.push('# Benchmark Results: Token Savings vs Baseline');
  lines.push('');
  lines.push(
    '| Scenario | Files | Raw Bytes | Summary Bytes | Compression | ' +
      'Cache Hits | Hit Ratio | Est. Tokens Saved |',
  );
  lines.push(
    '|----------|-------|-----------|---------------|-------------|' +
      '-----------|-----------|-------------------|',
  );

  for (const r of reports) {
    lines.push(
      `| ${r.scenario} | ${r.fileCount} | ${formatBytes(r.rawBytes)} | ` +
        `${formatBytes(r.summaryBytes)} | ${r.compressionRatio.toFixed(1)}x | ` +
        `${r.cacheHits}/${r.cacheHits + r.cacheMisses} | ` +
        `${(r.hitRatio * 100).toFixed(0)}% | ${r.estimatedTokensSaved.toLocaleString()} |`,
    );
  }

  lines.push('');
  lines.push(`*Generated at ${new Date().toISOString()}*`);

  return lines.join('\n');
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
