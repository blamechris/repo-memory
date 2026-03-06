import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { getDependencyGraphTool } from '../../src/tools/get-dependency-graph.js';
import { createTaskTool, getTaskContext, markExploredTool } from '../../src/tools/task-context.js';
import { getFileSummary } from '../../src/tools/get-file-summary.js';
import { getChangedFiles } from '../../src/tools/get-changed-files.js';
import { scanProject } from '../../src/indexer/scanner.js';
import { closeDatabase } from '../../src/persistence/db.js';
import type { TaskContextResult } from '../../src/tools/task-context.js';

function createFixtureProject(): string {
  const dir = mkdtempSync(join(tmpdir(), 'repo-memory-v2-e2e-'));

  execFileSync('git', ['init'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir });

  mkdirSync(join(dir, 'src', 'utils'), { recursive: true });
  mkdirSync(join(dir, 'src', 'services'), { recursive: true });

  writeFileSync(
    join(dir, 'src', 'index.ts'),
    [
      'import { UserService } from "./services/user.js";',
      'import { format } from "./utils/format.js";',
      '',
      'export function main() {',
      '  const svc = new UserService();',
      '  format(svc.getUser());',
      '}',
    ].join('\n'),
  );

  writeFileSync(
    join(dir, 'src', 'services', 'user.ts'),
    [
      'import { validate } from "../utils/validate.js";',
      '',
      'export class UserService {',
      '  getUser() { return validate("user"); }',
      '}',
    ].join('\n'),
  );

  writeFileSync(
    join(dir, 'src', 'utils', 'format.ts'),
    'export function format(data: unknown): string { return JSON.stringify(data); }\n',
  );

  writeFileSync(
    join(dir, 'src', 'utils', 'validate.ts'),
    'export function validate(input: string): string { return input.trim(); }\n',
  );

  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'v2-fixture' }));

  execFileSync('git', ['add', '.'], { cwd: dir });
  execFileSync('git', ['commit', '-m', 'initial'], { cwd: dir });

  return dir;
}

describe('V2 end-to-end flow', () => {
  let projectDir: string;

  beforeEach(() => {
    projectDir = createFixtureProject();
  });

  afterEach(() => {
    closeDatabase();
    rmSync(projectDir, { recursive: true, force: true });
  });

  it('dependency graph + task memory: full investigation flow', async () => {
    // Step 1: Build summaries for all files (V1 foundation)
    await getFileSummary(projectDir, 'src/index.ts');
    await getFileSummary(projectDir, 'src/services/user.ts');
    await getFileSummary(projectDir, 'src/utils/format.ts');
    await getFileSummary(projectDir, 'src/utils/validate.ts');

    // Step 2: Query dependency graph for index.ts
    const graphResult = await getDependencyGraphTool(
      projectDir,
      'src/index.ts',
      'dependencies',
    );
    expect(graphResult.nodes).toContain('src/index.ts');
    expect(graphResult.edges.length).toBeGreaterThan(0);

    // Step 3: Create a task for investigating a bug
    const task = createTaskTool(projectDir, 'Investigate user validation bug');
    expect(task.state).toBe('created');

    // Step 4: Start exploring based on dependency chain
    markExploredTool(projectDir, task.id, 'src/index.ts', 'explored', 'Entry point, imports UserService');

    // Step 5: Check task context — should be active, 1 file explored
    const allFiles = await scanProject(projectDir);
    const ctx1 = getTaskContext(projectDir, task.id, allFiles) as TaskContextResult;
    expect(ctx1.task.state).toBe('active');
    expect(ctx1.exploredFiles).toHaveLength(1);
    expect(ctx1.frontier.length).toBeGreaterThan(0);

    // Step 6: Follow dependency chain — explore user service
    markExploredTool(projectDir, task.id, 'src/services/user.ts', 'flagged', 'Uses validate — possible issue');

    // Step 7: Explore the validate utility
    markExploredTool(projectDir, task.id, 'src/utils/validate.ts', 'explored', 'Found the bug here');

    // Step 8: Check updated context
    const ctx2 = getTaskContext(projectDir, task.id, allFiles) as TaskContextResult;
    expect(ctx2.exploredFiles).toHaveLength(3);
    expect(ctx2.exploredFiles.find((f) => f.filePath === 'src/services/user.ts')?.status).toBe('flagged');

    // Step 9: Modify validate.ts to "fix the bug"
    writeFileSync(
      join(projectDir, 'src', 'utils', 'validate.ts'),
      'export function validate(input: string): string { return input.trim().toLowerCase(); }\n',
    );

    // Step 10: Detect the change
    const changes = await getChangedFiles(projectDir);
    expect(
      changes.changed.includes('src/utils/validate.ts') ||
      changes.added.includes('src/utils/validate.ts'),
    ).toBe(true);

    // Step 11: Query dependents of the changed file to assess impact
    const impactGraph = await getDependencyGraphTool(
      projectDir,
      'src/utils/validate.js',
      'dependents',
    );
    // user.ts depends on validate
    expect(impactGraph.nodes).toContain('src/services/user.ts');
  });

  it('cross-turn: task state persists after database restart', async () => {
    const task = createTaskTool(projectDir, 'Persistent task');
    markExploredTool(projectDir, task.id, 'src/index.ts');

    // Simulate server restart
    closeDatabase();

    // New "turn" — state should be preserved
    const ctx = getTaskContext(projectDir, task.id) as TaskContextResult;
    expect(ctx.task.name).toBe('Persistent task');
    expect(ctx.task.state).toBe('active');
    expect(ctx.exploredFiles).toHaveLength(1);
    expect(ctx.exploredFiles[0].filePath).toBe('src/index.ts');
  });
});
