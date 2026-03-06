import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { getFileSummary } from '../../src/tools/get-file-summary.js';
import { getChangedFiles } from '../../src/tools/get-changed-files.js';
import { createTaskTool, getTaskContext, markExploredTool } from '../../src/tools/task-context.js';
import { getDependencyGraphTool } from '../../src/tools/get-dependency-graph.js';
import { getTokenReport } from '../../src/tools/get-token-report.js';
import { smartSummarize } from '../../src/indexer/smart-summarizer.js';
import { rankFiles } from '../../src/cache/ranking.js';
import { DependencyGraph } from '../../src/graph/dependency-graph.js';
import { TelemetryTracker } from '../../src/telemetry/tracker.js';
import { SessionManager } from '../../src/memory/session.js';
import { CacheStore } from '../../src/cache/store.js';
import { scanProject } from '../../src/indexer/scanner.js';
import { closeDatabase } from '../../src/persistence/db.js';
import type { TaskContextResult } from '../../src/tools/task-context.js';

function createFixtureProject(): string {
  const dir = mkdtempSync(join(tmpdir(), 'repo-memory-v3-e2e-'));

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
    [
      'export function validate(input: string): string {',
      '  return input.trim();',
      '}',
      '',
    ].join('\n'),
  );

  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'v3-fixture' }));

  execFileSync('git', ['add', '.'], { cwd: dir });
  execFileSync('git', ['commit', '-m', 'initial'], { cwd: dir });

  return dir;
}

describe('V3 end-to-end flow', () => {
  let projectDir: string;

  beforeEach(() => {
    projectDir = createFixtureProject();
  });

  afterEach(() => {
    closeDatabase();
    rmSync(projectDir, { recursive: true, force: true });
  });

  it('full V3 flow: session → telemetry → diff-aware → ranking → token report', async () => {
    // === Session 1: Initial exploration ===

    // Step 1: Start a session
    const sessionManager = new SessionManager(projectDir);
    const session1 = sessionManager.startSession({ agent: 'test' });
    expect(session1.id).toBeTruthy();
    expect(session1.endedAt).toBeNull();

    // Step 2: Record telemetry while building summaries
    const tracker = new TelemetryTracker(projectDir);

    // Get file summaries (cache miss on first access)
    const summary1 = await getFileSummary(projectDir, 'src/index.ts');
    tracker.trackEvent('cache_miss', 'src/index.ts', summary1.summary.lineCount * 4);

    const summary2 = await getFileSummary(projectDir, 'src/services/user.ts');
    tracker.trackEvent('cache_miss', 'src/services/user.ts', summary2.summary.lineCount * 4);

    await getFileSummary(projectDir, 'src/utils/format.ts');
    tracker.trackEvent('cache_miss', 'src/utils/format.ts', 4);

    await getFileSummary(projectDir, 'src/utils/validate.ts');
    tracker.trackEvent('cache_miss', 'src/utils/validate.ts', 4);

    // Step 3: Cache hit on second access
    const summary1Again = await getFileSummary(projectDir, 'src/index.ts');
    expect(summary1Again.fromCache).toBe(true);
    tracker.trackEvent('cache_hit', 'src/index.ts', summary1Again.summary.lineCount * 4);

    // Step 4: Create a task and explore files
    const task = createTaskTool(projectDir, 'Investigate formatting issue');
    markExploredTool(projectDir, task.id, 'src/index.ts', 'explored', 'Entry point');
    markExploredTool(projectDir, task.id, 'src/services/user.ts', 'flagged', 'Potential issue');

    // Step 5: Build dependency graph
    const graph = new DependencyGraph(projectDir);
    const allFiles = await scanProject(projectDir);
    for (const file of allFiles) {
      if (file.endsWith('.ts')) {
        const { readFileSync } = await import('fs');
        const contents = readFileSync(join(projectDir, file), 'utf-8');
        graph.updateFile(file, contents);
      }
    }

    // Step 6: Rank files based on task context
    const store = new CacheStore(projectDir);
    const tsFiles = allFiles.filter((f) => f.endsWith('.ts'));
    const ranked = rankFiles(tsFiles, {
      projectRoot: projectDir,
      exploredFiles: ['src/index.ts', 'src/services/user.ts'],
      flaggedFiles: ['src/services/user.ts'],
      graph,
      cacheStore: store,
    });

    expect(ranked.length).toBe(tsFiles.length);
    expect(ranked[0].score).toBeGreaterThan(0);
    // Files in same dir as flagged file should rank higher
    const validateRank = ranked.findIndex((f) => f.path === 'src/utils/validate.ts');
    const formatRank = ranked.findIndex((f) => f.path === 'src/utils/format.ts');
    // validate.ts is a dependency of user.ts (flagged), so should score well
    expect(validateRank).toBeGreaterThanOrEqual(0);
    expect(formatRank).toBeGreaterThanOrEqual(0);

    // Step 7: End session 1
    sessionManager.endSession(session1.id);
    const endedSession = sessionManager.getSession(session1.id);
    expect(endedSession!.endedAt).not.toBeNull();

    // === Simulate server restart ===
    closeDatabase();

    // === Session 2: Verify persistence, diff-aware updates ===

    // Step 8: Start session 2
    const sessionManager2 = new SessionManager(projectDir);
    const session2 = sessionManager2.startSession({ agent: 'test-turn-2' });

    // Step 9: Verify task state persists
    const ctx = getTaskContext(projectDir, task.id) as TaskContextResult;
    expect(ctx.task.name).toBe('Investigate formatting issue');
    expect(ctx.task.state).toBe('active');
    expect(ctx.exploredFiles).toHaveLength(2);
    expect(ctx.exploredFiles.find((f) => f.filePath === 'src/services/user.ts')?.status).toBe(
      'flagged',
    );

    // Step 10: Modify validate.ts with a non-structural change
    // Use a multi-line file so only a body line changes (no export/import/declaration lines)
    writeFileSync(
      join(projectDir, 'src', 'utils', 'validate.ts'),
      [
        'export function validate(input: string): string {',
        '  // Added a comment and lowercase',
        '  return input.trim().toLowerCase();',
        '}',
        '',
      ].join('\n'),
    );
    // Don't stage — git diff HEAD will show the working tree changes

    // Step 11: Diff-aware smart summarize
    const validateContents = [
      'export function validate(input: string): string {',
      '  // Added a comment and lowercase',
      '  return input.trim().toLowerCase();',
      '}',
      '',
    ].join('\n');
    const smartResult = smartSummarize(
      'src/utils/validate.ts',
      validateContents,
      { purpose: 'source', exports: ['validate'], imports: [], lineCount: 4, topLevelDeclarations: ['function validate'] },
      projectDir,
    );
    // Non-structural change (only body lines modified) → should produce diff-partial
    expect(smartResult.source).toBe('diff-partial');
    expect(smartResult.summary.exports).toContain('validate');
    // Line count updated
    expect(smartResult.summary.lineCount).toBe(5);

    // Step 12: Record more telemetry
    const tracker2 = new TelemetryTracker(projectDir);
    tracker2.trackEvent('cache_hit', 'src/index.ts', 28);
    tracker2.trackEvent('cache_hit', 'src/services/user.ts', 20);
    tracker2.trackEvent('cache_miss', 'src/utils/validate.ts', 4);

    // Step 13: Stage and detect changes
    execFileSync('git', ['add', '.'], { cwd: projectDir });
    const changes = await getChangedFiles(projectDir);
    expect(
      changes.changed.includes('src/utils/validate.ts') ||
        changes.added.includes('src/utils/validate.ts'),
    ).toBe(true);

    // Step 14: Query dependents of changed file to assess impact
    const impactGraph = await getDependencyGraphTool(
      projectDir,
      'src/utils/validate.js',
      'dependents',
    );
    expect(impactGraph.nodes).toContain('src/services/user.ts');

    // Step 15: End session 2
    sessionManager2.endSession(session2.id);

    // === Token report across sessions ===

    // Step 16: Global token report
    const globalReport = getTokenReport(projectDir);
    expect(globalReport.period).toBe('all');
    expect(globalReport.totalEvents).toBeGreaterThan(0);
    expect(globalReport.cacheHits).toBeGreaterThan(0);
    expect(globalReport.cacheMisses).toBeGreaterThan(0);
    expect(globalReport.cacheHitRatio).toBeGreaterThan(0);
    expect(globalReport.estimatedTokensSaved).toBeGreaterThan(0);
    expect(globalReport.topFiles.length).toBeGreaterThan(0);

    // Step 17: Session-scoped report (session 2 only)
    const session2Report = getTokenReport(projectDir, 'session', undefined, session2.id);
    expect(session2Report.period).toBe('session');
    // Session 2 had 3 events (2 hits + 1 miss)
    expect(session2Report.totalEvents).toBe(3);
    expect(session2Report.cacheHits).toBe(2);
    expect(session2Report.cacheMisses).toBe(1);
  });

  it('ranking changes based on task exploration progress', async () => {
    // Build summaries
    await getFileSummary(projectDir, 'src/index.ts');
    await getFileSummary(projectDir, 'src/services/user.ts');
    await getFileSummary(projectDir, 'src/utils/format.ts');
    await getFileSummary(projectDir, 'src/utils/validate.ts');

    const store = new CacheStore(projectDir);
    const graph = new DependencyGraph(projectDir);
    const allFiles = await scanProject(projectDir);
    for (const file of allFiles) {
      if (file.endsWith('.ts')) {
        const { readFileSync } = await import('fs');
        const contents = readFileSync(join(projectDir, file), 'utf-8');
        graph.updateFile(file, contents);
      }
    }

    const tsFiles = allFiles.filter((f) => f.endsWith('.ts'));

    // Rank with no task context
    const rankedNoContext = rankFiles(tsFiles, {
      projectRoot: projectDir,
      cacheStore: store,
      graph,
    });

    // Rank with task context (exploring index.ts, flagging user.ts)
    const rankedWithContext = rankFiles(tsFiles, {
      projectRoot: projectDir,
      exploredFiles: ['src/index.ts'],
      flaggedFiles: ['src/services/user.ts'],
      cacheStore: store,
      graph,
    });

    // With context, validate.ts should rank higher (it's a dep of flagged user.ts)
    const validateNoCtx = rankedNoContext.find((f) => f.path === 'src/utils/validate.ts')!;
    const validateWithCtx = rankedWithContext.find((f) => f.path === 'src/utils/validate.ts')!;
    expect(validateWithCtx.score).toBeGreaterThan(validateNoCtx.score);
  });

  it('cross-session persistence: sessions, tasks, telemetry survive restarts', async () => {
    // Session 1
    const sm1 = new SessionManager(projectDir);
    const s1 = sm1.startSession({ turn: 1 });
    const task = createTaskTool(projectDir, 'Persistent investigation');
    markExploredTool(projectDir, task.id, 'src/index.ts');
    const t1 = new TelemetryTracker(projectDir);
    t1.trackEvent('cache_miss', 'src/index.ts', 28);
    sm1.endSession(s1.id);

    closeDatabase();

    // Session 2
    const sm2 = new SessionManager(projectDir);
    const s2 = sm2.startSession({ turn: 2 });
    const t2 = new TelemetryTracker(projectDir);
    t2.trackEvent('cache_hit', 'src/index.ts', 28);

    // Verify session 1 data persists
    const sessions = sm2.listSessions();
    expect(sessions).toHaveLength(2);

    // Verify task persists
    const ctx = getTaskContext(projectDir, task.id) as TaskContextResult;
    expect(ctx.task.name).toBe('Persistent investigation');
    expect(ctx.exploredFiles).toHaveLength(1);

    // Verify telemetry spans both sessions
    const report = getTokenReport(projectDir);
    expect(report.totalEvents).toBe(2);
    expect(report.cacheHits).toBe(1);
    expect(report.cacheMisses).toBe(1);

    sm2.endSession(s2.id);
  });
});
