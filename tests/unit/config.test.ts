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
    // The only key is invalid, so it's dropped and nothing valid remains.
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

  it('loads tools config from config file', () => {
    writeFileSync(
      join(tempDir, '.repo-memory.json'),
      JSON.stringify({ tools: { summaries: true, tasks: false } }),
    );
    const config = loadConfig(tempDir);
    expect(config.tools).toEqual({ summaries: true, tasks: false });
  });

  it('defaults to no tools config when not specified', () => {
    writeFileSync(join(tempDir, '.repo-memory.json'), JSON.stringify({ maxFiles: 100 }));
    const config = loadConfig(tempDir);
    expect(config.tools).toBeUndefined();
  });

  it('rejects invalid tools value (not object)', () => {
    writeFileSync(join(tempDir, '.repo-memory.json'), JSON.stringify({ tools: true }));
    const config = loadConfig(tempDir);
    expect(config).toEqual({});
  });

  it('rejects invalid tools group value (not boolean)', () => {
    writeFileSync(
      join(tempDir, '.repo-memory.json'),
      JSON.stringify({ tools: { summaries: 'yes' } }),
    );
    const config = loadConfig(tempDir);
    expect(config).toEqual({});
  });

  it('ignores unknown tool group keys', () => {
    writeFileSync(
      join(tempDir, '.repo-memory.json'),
      JSON.stringify({ tools: { summaries: true, unknown: true } }),
    );
    const config = loadConfig(tempDir);
    expect(config.tools).toEqual({ summaries: true });
  });

  it('keeps valid keys when another top-level key is invalid', () => {
    writeFileSync(
      join(tempDir, '.repo-memory.json'),
      JSON.stringify({ maxFiles: -1, ignore: ['*.log'], tools: { tasks: true } }),
    );
    const config = loadConfig(tempDir);
    // maxFiles is dropped (invalid); the valid ignore + tools are still applied.
    expect(config).toEqual({ ignore: ['*.log'], tools: { tasks: true } });
  });

  it('keeps valid gc subkeys and drops only the invalid one', () => {
    writeFileSync(
      join(tempDir, '.repo-memory.json'),
      JSON.stringify({ gc: { cacheMaxAgeDays: 7, taskMaxAgeDays: 0 } }),
    );
    const config = loadConfig(tempDir);
    expect(config.gc).toEqual({ cacheMaxAgeDays: 7 });
  });

  it('keeps valid tool groups and drops only the invalid one', () => {
    writeFileSync(
      join(tempDir, '.repo-memory.json'),
      JSON.stringify({ tools: { summaries: true, tasks: 'no' } }),
    );
    const config = loadConfig(tempDir);
    expect(config.tools).toEqual({ summaries: true });
  });

  it('loads summarizer mode from config file', () => {
    writeFileSync(
      join(tempDir, '.repo-memory.json'),
      JSON.stringify({ summarizer: 'ast' }),
    );
    const config = loadConfig(tempDir);
    expect(config.summarizer).toBe('ast');
  });

  it('accepts the explicit regex summarizer mode', () => {
    writeFileSync(
      join(tempDir, '.repo-memory.json'),
      JSON.stringify({ summarizer: 'regex' }),
    );
    const config = loadConfig(tempDir);
    expect(config.summarizer).toBe('regex');
  });

  it('defaults to no summarizer mode when not specified', () => {
    writeFileSync(join(tempDir, '.repo-memory.json'), JSON.stringify({ maxFiles: 100 }));
    const config = loadConfig(tempDir);
    expect(config.summarizer).toBeUndefined();
  });

  it('rejects invalid summarizer value and keeps other keys', () => {
    writeFileSync(
      join(tempDir, '.repo-memory.json'),
      JSON.stringify({ summarizer: 'llm', maxFiles: 50 }),
    );
    const config = loadConfig(tempDir);
    expect(config).toEqual({ maxFiles: 50 });
  });

  it('rejects non-string summarizer value', () => {
    writeFileSync(
      join(tempDir, '.repo-memory.json'),
      JSON.stringify({ summarizer: true }),
    );
    const config = loadConfig(tempDir);
    expect(config).toEqual({});
  });

  it('warns on stderr when a key is skipped', () => {
    const writes: string[] = [];
    const original = process.stderr.write;
    process.stderr.write = ((chunk: string | Uint8Array) => {
      writes.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      writeFileSync(
        join(tempDir, '.repo-memory.json'),
        JSON.stringify({ maxFiles: -1, ignore: ['*.log'] }),
      );
      const config = loadConfig(tempDir);
      expect(config).toEqual({ ignore: ['*.log'] });
    } finally {
      process.stderr.write = original;
    }
    expect(writes.join('')).toMatch(/maxFiles/);
  });
});
