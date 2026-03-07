import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { loadConfig, clearConfigCache } from '../../src/config.js';

describe('loadConfig', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'config-test-'));
    clearConfigCache();
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
    clearConfigCache();
  });

  it('returns empty config when no config file exists', () => {
    const config = loadConfig(tempDir);
    expect(config).toEqual({});
  });

  it('loads ignore patterns from config file', () => {
    writeFileSync(
      join(tempDir, '.repo-memory.json'),
      JSON.stringify({ ignore: ['*.log', 'dist/'] }),
    );
    const config = loadConfig(tempDir);
    expect(config.ignore).toEqual(['*.log', 'dist/']);
  });

  it('loads maxFiles from config file', () => {
    writeFileSync(
      join(tempDir, '.repo-memory.json'),
      JSON.stringify({ maxFiles: 500 }),
    );
    const config = loadConfig(tempDir);
    expect(config.maxFiles).toBe(500);
  });

  it('loads gc options from config file', () => {
    writeFileSync(
      join(tempDir, '.repo-memory.json'),
      JSON.stringify({ gc: { cacheMaxAgeDays: 7, telemetryMaxAgeDays: 30 } }),
    );
    const config = loadConfig(tempDir);
    expect(config.gc).toEqual({ cacheMaxAgeDays: 7, telemetryMaxAgeDays: 30 });
  });

  it('rejects invalid ignore (not array of strings)', () => {
    writeFileSync(
      join(tempDir, '.repo-memory.json'),
      JSON.stringify({ ignore: 'not-an-array' }),
    );
    const config = loadConfig(tempDir);
    // Falls back to empty config on validation error
    expect(config).toEqual({});
  });

  it('rejects invalid maxFiles (not positive number)', () => {
    writeFileSync(
      join(tempDir, '.repo-memory.json'),
      JSON.stringify({ maxFiles: -1 }),
    );
    const config = loadConfig(tempDir);
    expect(config).toEqual({});
  });

  it('rejects invalid gc option (not positive number)', () => {
    writeFileSync(
      join(tempDir, '.repo-memory.json'),
      JSON.stringify({ gc: { cacheMaxAgeDays: 0 } }),
    );
    const config = loadConfig(tempDir);
    expect(config).toEqual({});
  });

  it('handles malformed JSON gracefully', () => {
    writeFileSync(join(tempDir, '.repo-memory.json'), '{bad json');
    const config = loadConfig(tempDir);
    expect(config).toEqual({});
  });

  it('caches config for same project root', () => {
    writeFileSync(
      join(tempDir, '.repo-memory.json'),
      JSON.stringify({ maxFiles: 100 }),
    );
    const config1 = loadConfig(tempDir);
    const config2 = loadConfig(tempDir);
    expect(config1).toBe(config2); // Same reference
  });

  it('ignores unknown keys without error', () => {
    writeFileSync(
      join(tempDir, '.repo-memory.json'),
      JSON.stringify({ ignore: ['*.log'], unknownKey: true }),
    );
    const config = loadConfig(tempDir);
    expect(config.ignore).toEqual(['*.log']);
  });
});
